"""Discover and validate user-authored custom detectors.

Scans tools/python/custom/*.py, imports each file in isolation, and produces
a registry where every entry is either:

  - status="ok": the file imported, defined exactly one CustomDetector subclass,
    and every required manifest field passed validation.
  - status="load_error": the import itself raised (syntax error, missing
    dependency, exception at module top-level).
  - status="validation_error": the import succeeded but one or more manifest
    fields were missing/invalid, OR the file defined zero or multiple
    CustomDetector subclasses.

Every error message is structured (file/field/value/message) so the UI can
render it inline next to the file.

Files whose name starts with "_" (e.g. _template.py, _example_energy.py) or
"." are ignored at scan time — they are scaffold / hidden helpers.
"""

from __future__ import annotations

import importlib.util
import inspect
import re
import sys
import traceback
from pathlib import Path
from typing import Optional

# Make `from custom_api import ...` work for user files even when the loader
# is imported from elsewhere. The custom/ folder is a sibling of this file.
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from custom_api import (  # noqa: E402
    CustomDetector,
    RegistryEntry,
    ValidationError,
)

CUSTOM_DIR = _THIS_DIR / "custom"

NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,30}$")
LABEL_MAX = 80
# `loop` and `pattern` validate fine here but are filtered out of the registry
# response by custom_server when the experimentalLoopsAndPatterns flag is off.
ALLOWED_OUTPUT_KIND = {"boundary", "cue", "span", "loop", "pattern"}
# Output kinds gated by the experimentalLoopsAndPatterns UI flag. The server
# filters these from the registry response when the flag is off, mirroring the
# annotation-tab gating in the web app.
EXPERIMENTAL_LOOPS_PATTERNS_KINDS = {"loop", "pattern"}

# Module-name → pip-package-name for the cases where they differ. For modules
# not in this table the install suggestion is just `pip install <module>`.
_MODULE_TO_PACKAGE: dict[str, str] = {
    "cv2":     "opencv-python",
    "sklearn": "scikit-learn",
    "PIL":     "Pillow",
    "yaml":    "pyyaml",
    "bs4":     "beautifulsoup4",
    "skimage": "scikit-image",
    "Crypto":  "pycryptodome",
}


def missing_module_hint(exc: BaseException) -> Optional[dict]:
    """Return {missing_module, suggested_package, suggested_install} for a
    ModuleNotFoundError, else None.

    Used by the loader (top-level import failure) and the runner (lazy import
    failure inside detect()) so the UI can render the same install prompt for
    either path.
    """
    if not isinstance(exc, ModuleNotFoundError):
        return None
    name = (exc.name or "").split(".", 1)[0]
    if not name:
        return None
    package = _MODULE_TO_PACKAGE.get(name, name)
    return {
        "missing_module":    name,
        "suggested_package": package,
        "suggested_install": f"pip install {package}",
    }


# ─── Public API ──────────────────────────────────────────────────────────────


def scan() -> list[RegistryEntry]:
    """Return one RegistryEntry per .py file in CUSTOM_DIR.

    Sorted by (status priority, name) so OK detectors appear first.
    `name` collisions across files yield validation_error on every conflicting
    file (loader does not silently choose a winner).
    """
    if not CUSTOM_DIR.exists():
        return []

    entries: list[RegistryEntry] = []
    for path in sorted(CUSTOM_DIR.iterdir()):
        if not _is_user_file(path):
            continue
        entries.append(_load_one(path))

    # Detect duplicate names across files (only among ok entries).
    name_counts: dict[str, int] = {}
    for e in entries:
        if e.status == "ok":
            name_counts[e.name] = name_counts.get(e.name, 0) + 1
    for e in entries:
        if e.status == "ok" and name_counts.get(e.name, 0) > 1:
            e.status = "validation_error"
            e.errors.append(
                ValidationError(
                    index=None,
                    field="name",
                    value=e.name,
                    message=(
                        f"duplicate detector name: {e.name!r} is also used by "
                        f"another file in tools/python/custom/. Names must be unique."
                    ),
                )
            )

    return sorted(entries, key=lambda e: (_status_rank(e.status), e.name))


class DetectorLoadError(ValueError):
    """Raised by load_detector when the entry can't be loaded.

    Carries an optional `hint` dict (with missing_module / suggested_install)
    so the runner can surface install instructions in the fatal envelope.
    """

    def __init__(self, message: str, hint: Optional[dict] = None) -> None:
        super().__init__(message)
        self.hint = hint


def load_detector(name: str) -> CustomDetector:
    """Re-import the detector for `name` and return an instance.

    Raises DetectorLoadError if not found or the file fails validation. The
    runner calls this immediately before invoking detect() so user edits to a
    file take effect on the next run without restarting the server.
    """
    for entry in scan():
        if entry.name != name:
            continue
        if entry.status != "ok":
            msgs = "; ".join(e.message for e in entry.errors) or entry.status
            # Surface a missing-module hint from the entry's errors so the
            # runner can render install instructions instead of a raw stack.
            hint = next(
                (e.value for e in entry.errors
                 if isinstance(e.value, dict) and "missing_module" in e.value),
                None,
            )
            raise DetectorLoadError(
                f"detector {name!r} did not load cleanly: {msgs}",
                hint=hint,
            )
        cls = _import_detector_class(Path(entry.file))
        if cls is None:
            raise DetectorLoadError(f"detector {name!r} class not found in {entry.file}")
        return cls()  # type: ignore[abstract]
    raise DetectorLoadError(f"detector {name!r} not found in {CUSTOM_DIR}")


# ─── Internals ───────────────────────────────────────────────────────────────


def _status_rank(s: str) -> int:
    return {"ok": 0, "validation_error": 1, "load_error": 2}.get(s, 3)


def _is_user_file(path: Path) -> bool:
    """Every .py file in tools/python/custom/ is a candidate detector.

    Skips only mechanical files: __init__.py and dotfiles. The leading-
    underscore convention is intentionally NOT used to hide files — anything
    a user dropped in this folder shows up in the registry, even if it later
    fails validation. That matches the user's mental model: 'I put a file
    here, it should appear.'
    """
    if not path.is_file() or path.suffix != ".py":
        return False
    if path.name == "__init__.py" or path.name.startswith("."):
        return False
    return True


def _load_one(path: Path) -> RegistryEntry:
    file_stem = path.stem
    try:
        cls = _import_detector_class(path, raise_on_class_count=True)
    except _LoadError as exc:
        return RegistryEntry(
            name=file_stem,
            file=str(path),
            status="load_error",
            errors=[ValidationError(index=None, field=None, message=exc.message, value=exc.value)],
        )
    except _ClassCountError as exc:
        return RegistryEntry(
            name=file_stem,
            file=str(path),
            status="validation_error",
            errors=[ValidationError(index=None, field="class", message=exc.message, value=exc.value)],
        )
    except Exception as exc:  # absolute backstop; should not be reached
        tb = traceback.format_exc()
        return RegistryEntry(
            name=file_stem,
            file=str(path),
            status="load_error",
            errors=[ValidationError(index=None, field=None, message=f"unexpected loader error: {exc}", value=tb)],
        )

    assert cls is not None  # appeases mypy; class-count check guarantees
    return _validate_class(cls, path)


class _LoadError(Exception):
    def __init__(self, message: str, value: object = None) -> None:
        super().__init__(message)
        self.message = message
        self.value = value


class _ClassCountError(Exception):
    def __init__(self, message: str, value: object = None) -> None:
        super().__init__(message)
        self.message = message
        self.value = value


def _import_detector_class(
    path: Path,
    *,
    raise_on_class_count: bool = False,
) -> Optional[type[CustomDetector]]:
    """Import `path` as a one-off module, return its single CustomDetector subclass.

    Each call uses a unique module name to avoid Python caching stale code
    after the user edits the file.
    """
    mod_name = f"_custom_{path.stem}_{abs(hash(str(path))) & 0xFFFFFFFF}"
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        raise _LoadError(f"could not create import spec for {path.name}")

    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    try:
        spec.loader.exec_module(module)
    except SyntaxError as exc:
        raise _LoadError(
            f"syntax error: {exc.msg} (line {exc.lineno})",
            value={"line": exc.lineno, "offset": exc.offset, "text": exc.text},
        )
    except ImportError as exc:
        raise _LoadError(f"import failed: {exc}", value=missing_module_hint(exc))
    except Exception as exc:
        tb = traceback.format_exc()
        raise _LoadError(f"{type(exc).__name__} while importing: {exc}", value=tb)
    finally:
        # Don't pollute sys.modules permanently — we'll re-import on next scan.
        sys.modules.pop(mod_name, None)

    classes: list[type[CustomDetector]] = []
    for _, member in inspect.getmembers(module, inspect.isclass):
        if member is CustomDetector:
            continue
        if not issubclass(member, CustomDetector):
            continue
        # Filter out classes imported from elsewhere (only count locally defined).
        if member.__module__ != mod_name:
            continue
        classes.append(member)

    if not raise_on_class_count:
        return classes[0] if len(classes) == 1 else None

    if len(classes) == 0:
        raise _ClassCountError(
            "no CustomDetector subclass defined in this file. Subclass "
            "CustomDetector and set name/label/output_kind."
        )
    if len(classes) > 1:
        names = ", ".join(c.__name__ for c in classes)
        raise _ClassCountError(
            f"more than one CustomDetector subclass in this file ({names}). "
            "Put each detector in its own .py file.",
            value=names,
        )
    return classes[0]


def _validate_class(cls: type[CustomDetector], path: Path) -> RegistryEntry:
    """Check every required manifest field. Build a fully-populated RegistryEntry."""
    errors: list[ValidationError] = []

    name = getattr(cls, "name", "")
    if not isinstance(name, str) or not name:
        errors.append(_err("name", name, "must be a non-empty string."))
    elif not NAME_RE.match(name):
        errors.append(_err(
            "name", name,
            "must match ^[a-z][a-z0-9_-]{0,30}$ — lowercase letters, digits, '-' or '_', "
            "starting with a letter, max 31 chars.",
        ))

    label = getattr(cls, "label", "")
    if not isinstance(label, str) or not label.strip():
        errors.append(_err("label", label, "must be a non-empty string."))
    elif len(label) > LABEL_MAX:
        errors.append(_err("label", label, f"must be at most {LABEL_MAX} characters."))

    output_kind = getattr(cls, "output_kind", None)
    if output_kind not in ALLOWED_OUTPUT_KIND:
        errors.append(_err(
            "output_kind", output_kind,
            f"must be one of {sorted(ALLOWED_OUTPUT_KIND)}.",
        ))

    is_algorithm  = bool(getattr(cls, "is_algorithm", False))
    is_annotation = bool(getattr(cls, "is_annotation", False))
    if not (is_algorithm or is_annotation):
        errors.append(_err(
            "is_algorithm/is_annotation", False,
            "at least one of is_algorithm or is_annotation must be True — "
            "otherwise the detector has nowhere to surface in the UI.",
        ))

    detect_fn = getattr(cls, "detect", None)
    if not callable(detect_fn):
        errors.append(_err("detect", detect_fn, "must be a method (def detect(self, ctx) -> list[...]). "))
    elif detect_fn is CustomDetector.detect:
        errors.append(_err(
            "detect", None,
            "you must override detect() in your subclass; the default raises NotImplementedError.",
        ))

    description = str(getattr(cls, "description", "") or "")
    version     = str(getattr(cls, "version", "") or "0.1")

    status = "ok" if not errors else "validation_error"
    return RegistryEntry(
        name=name if isinstance(name, str) and name else path.stem,
        file=str(path),
        status=status,
        label=label if isinstance(label, str) else "",
        output_kind=output_kind if output_kind in ALLOWED_OUTPUT_KIND else "boundary",
        is_algorithm=is_algorithm,
        is_annotation=is_annotation,
        description=description,
        version=version,
        errors=errors,
    )


def _err(field: str, value: object, message: str) -> ValidationError:
    return ValidationError(index=None, field=field, value=value, message=message)
