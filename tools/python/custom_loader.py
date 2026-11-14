"""Discover and validate user-authored custom detectors.

Scans tools/python/custom/*.py and tools/python/custom-default/*.py, imports
each file in isolation, and produces a registry where every entry is either:

  - status="ok": the file imported, defined exactly one CustomDetector subclass,
    and every required manifest field passed validation.
  - status="load_error": the import itself raised (syntax error, missing
    dependency, exception at module top-level).
  - status="validation_error": the import succeeded but one or more manifest
    fields were missing/invalid, OR the file defined zero or multiple
    CustomDetector subclasses.

Every error message is structured (file/field/value/message) so the UI can
render it inline next to the file.

Detectors may also sit one level down, in a package folder
(custom/<package>/<file>.py) — a folder of related detectors with a
package.json that titles it, shared between people as a plain folder or zip.
Only the .py files directly inside the package folder are detectors; code in
its subfolders is helper code they import. See custom_packages.py.
"""

from __future__ import annotations

import dataclasses
import importlib.util
import inspect
import json
import os
import re
import sys
import time
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
from paths import cache_name  # noqa: E402

# Two folders, the same split as data/ and data-default/. custom-default/
# holds the shipped examples and template — tracked, read-only from the app,
# and part of the public bundle. custom/ is where every detector a user writes
# lands (the editor saves there); it is export-ignored, so a maintainer's own
# detectors stay in the private repo and never reach the public mirror.
CUSTOM_DIR = _THIS_DIR / "custom"
DEFAULT_CUSTOM_DIR = _THIS_DIR / "custom-default"

# A package is a folder inside either detector folder. Its package.json is
# optional: without one the folder name is the title.
PACKAGE_MANIFEST = "package.json"
PACKAGE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")

# The detectors archived from the Playground — custom/archived.json — by the `name` written in their
# file: {"detectors": ["old_pulse", …]}. A list beside the files rather than a
# flag in them, so archiving never rewrites a detector's source, a shipped
# example can be archived too, and restoring puts it back exactly where it was.
ARCHIVE_FILE_NAME = "archived.json"

NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,30}$")
LABEL_MAX = 80
# `loop` and `riff` validate fine here but are filtered out of the registry
# response by custom_server when the experimentalLoopsAndPatterns flag is off.
ALLOWED_OUTPUT_KIND = {"boundary", "cue", "span", "loop", "riff", "lyrics", "lanes"}
# Demucs stem a detector reads from, surfaced so the UI can label a layer with
# its source stem and light it up while that stem is auditioned. "mix" means the
# whole track (no single stem). Optional — None when the detector declares none.
ALLOWED_STEM = {"vocals", "drums", "bass", "other", "guitar", "piano", "mix"}
# Filed apart from every stem: a detector that reads several stems into ONE lane
# and never the full mix (Pulse, Call & response). Filing it under "mix" said it
# read the mix; under one of its stems, that the rest of its lane came from
# there. Only as a single `stem` — never in a per-stem list or in stem_parts.
SEVERAL_STEMS = "stems"
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
    """Return one RegistryEntry per detector file (see detector_files()).

    Sorted by (status priority, name) so OK detectors appear first.
    `name` collisions across files yield validation_error on every conflicting
    file (loader does not silently choose a winner).
    """
    # The registry imports every detector, so a generator edited since the
    # server started has to be dropped here too, not only before a run — or
    # the list the sidebar draws marks every detector that imports a renamed
    # or added generator function as failing to load.
    _evict_stale_generators()
    entries: list[RegistryEntry] = []
    for entry in (_load_one(path) for path in detector_files()):
        if not entry.base_name:
            entry.base_name = entry.name
        entries.extend(_per_stem(entry))
    titles: dict[str, str] = {}
    archived = archived_names()
    for e in entries:
        e.archived = (e.base_name or e.name) in archived
        e.is_default = is_default_file(Path(e.file))
        pkg = package_of(Path(e.file))
        if pkg is not None:
            e.package = pkg.name
            if pkg.name not in titles:
                titles[pkg.name] = read_package(pkg.name)["title"]
            e.package_title = titles[pkg.name]

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
                        f"another detector file. Names must be unique."
                    ),
                )
            )

    return sorted(entries, key=lambda e: (_status_rank(e.status), e.name))


def _per_stem(entry: RegistryEntry) -> list[RegistryEntry]:
    """A detector declaring several stems, as one entry per stem.

    Each is `<name>__<stem>` ("mix" keeps the bare name), reads that stem, and
    is otherwise the same detector — so everything keyed by detector name (the
    cache, lanes, annotations, the batch runner) treats each stem as its own
    detector without knowing this happened."""
    if entry.status != "ok" or not entry.stems:
        return [entry]
    return [
        dataclasses.replace(entry, name=cache_name(entry.base_name, s), stem=s,
                            errors=list(entry.errors))
        for s in entry.stems
    ]


class DetectorLoadError(ValueError):
    """Raised by load_detector when the entry can't be loaded.

    Carries an optional `hint` dict (with missing_module / suggested_install)
    so the runner can surface install instructions in the fatal envelope.
    """

    def __init__(self, message: str, hint: Optional[dict] = None) -> None:
        super().__init__(message)
        self.hint = hint


GENERATORS_DIR = _THIS_DIR / "generators"
# When the `generators` package now in sys.modules was imported — process start
# until the first eviction below.
_generators_loaded_at = time.time()


def _evict_stale_generators() -> None:
    """Drop every cached `generators.*` module once any of their files changes.

    A detector file is re-imported per run, but the `generators` modules it
    imports are cached for the life of the server, and every run is forked
    from that cache. Editing one generator while the server is up then leaves
    the old copy answering, and a sibling imported fresh from disk asks it for
    a function it doesn't have: `pulse` failed with "cannot import name
    'hit_verdicts' from 'generators.pulse'" until the server was restarted.
    All of them go at once, so the next import sees one consistent version.
    """
    global _generators_loaded_at
    try:
        newest = max(f.stat().st_mtime for f in GENERATORS_DIR.glob("*.py"))
    except (OSError, ValueError):
        return
    if newest <= _generators_loaded_at:
        return
    for mod_name in [m for m in sys.modules if m == "generators" or m.startswith("generators.")]:
        sys.modules.pop(mod_name, None)
    importlib.invalidate_caches()
    _generators_loaded_at = time.time()


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
        _evict_stale_generators()
        cls = _import_detector_class(Path(entry.file))
        if cls is None:
            raise DetectorLoadError(f"detector {name!r} class not found in {entry.file}")
        detector = cls()  # type: ignore[abstract]
        # One run of a detector that declares several stems: this instance
        # reads only the stem its entry stands for.
        detector.stem = entry.stem
        return detector
    raise DetectorLoadError(f"detector {name!r} not found in {CUSTOM_DIR}")


def detector_files() -> list[Path]:
    """Every candidate detector file, custom/ first and then custom-default/:
    the loose files at the top of each folder, and the top-level files of every
    package folder inside it.

    A file in custom/ shadows the shipped one at the same relative path, the
    way data/ shadows data-default/ — that is what editing an example from the
    app leaves behind (see custom_server.write_script), and it keeps the Docker
    volume's older seeded copies of the examples from colliding by name.
    """
    files: dict[str, Path] = {}
    for folder in (CUSTOM_DIR, DEFAULT_CUSTOM_DIR):
        if not folder.is_dir():
            continue
        for path in folder.iterdir():
            if _is_user_file(path):
                files.setdefault(path.name, path)
            elif _is_package_dir(path):
                for inner in path.iterdir():
                    if _is_user_file(inner):
                        files.setdefault(f"{path.name}/{inner.name}", inner)
    return [files[k] for k in sorted(files)]


def is_default_file(path: Path) -> bool:
    """True when `path` is one of the shipped files in custom-default/."""
    parent = path.resolve().parent
    root = DEFAULT_CUSTOM_DIR.resolve()
    return parent == root or parent.parent == root


# ─── Archive ─────────────────────────────────────────────────────────────────


def archived_names() -> set[str]:
    """The names in custom/archived.json. A missing or unreadable file archives nothing."""
    try:
        raw = json.loads((CUSTOM_DIR / ARCHIVE_FILE_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    names = raw.get("detectors") if isinstance(raw, dict) else None
    return {n for n in names if isinstance(n, str)} if isinstance(names, list) else set()


def write_archived_names(names: set[str]) -> None:
    CUSTOM_DIR.mkdir(parents=True, exist_ok=True)
    path = CUSTOM_DIR / ARCHIVE_FILE_NAME
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"detectors": sorted(names)}, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


# ─── Packages ────────────────────────────────────────────────────────────────


def _is_package_dir(path: Path) -> bool:
    """A subfolder of custom/ or custom-default/ that holds detectors. Dotted
    and underscored folders are machinery (.trash, __pycache__), not packages."""
    return path.is_dir() and not path.name.startswith((".", "_"))


def package_of(path: Path) -> Optional[Path]:
    """The package folder a detector file sits in, or None for a loose file."""
    parent = path.resolve().parent
    for root in (CUSTOM_DIR, DEFAULT_CUSTOM_DIR):
        if parent.parent == root.resolve() and _is_package_dir(parent):
            return parent
    return None


def package_folders(package_id: str) -> list[Path]:
    """Where package `package_id` lives: its custom/ folder, its shipped one,
    or both (an edited shipped package keeps its edits in custom/)."""
    return [root / package_id for root in (CUSTOM_DIR, DEFAULT_CUSTOM_DIR)
            if _is_package_dir(root / package_id)]


def package_ids() -> list[str]:
    ids: set[str] = set()
    for root in (CUSTOM_DIR, DEFAULT_CUSTOM_DIR):
        if root.is_dir():
            ids.update(p.name for p in root.iterdir() if _is_package_dir(p))
    return sorted(ids)


def read_package(package_id: str) -> dict:
    """The package's manifest, normalised. Every field is optional in the file;
    a missing or broken package.json falls back to the folder name as title,
    and a broken one says why in `manifest_error`."""
    folders = package_folders(package_id)
    raw: dict = {}
    error: Optional[str] = None
    for folder in folders:
        manifest = folder / PACKAGE_MANIFEST
        if not manifest.is_file():
            continue
        try:
            loaded = json.loads(manifest.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                raw = loaded
            else:
                error = f"{PACKAGE_MANIFEST} must be a JSON object."
        except (OSError, ValueError) as exc:
            error = f"{PACKAGE_MANIFEST} could not be read: {exc}"
        break

    def text(key: str, limit: int) -> str:
        v = raw.get(key)
        return v.strip()[:limit] if isinstance(v, str) else ""

    bundle = raw.get("bundle")
    return {
        "id": package_id,
        "title": text("title", 80) or package_id.replace("_", " ").replace("-", " ").capitalize(),
        "description": text("description", 500),
        "author": text("author", 120),
        "version": text("version", 40),
        "bundle": [b for b in bundle if isinstance(b, str)] if isinstance(bundle, list) else [],
        # "public": false keeps a package to signed-in team members: a demo or
        # anonymous caller never sees its detectors, their source or their
        # outputs (custom_server.py). For a package whose licences allow
        # private use only — the server is ours, the demo is everyone's.
        "public": raw.get("public") is not False,
        "is_default": bool(folders) and all(
            f.resolve().parent == DEFAULT_CUSTOM_DIR.resolve() for f in folders),
        "manifest_error": error,
    }


# The package folder currently on sys.path. Detectors import their helpers
# from their own package folder, so only one package's folder is on the path
# at a time — two packages can each carry a helper module with the same name.
_active_package: Optional[Path] = None


_REALPATHS: dict[str, str] = {}


def _realpath(file: str) -> str:
    """os.path.realpath, remembered: a loaded module's file stays where it is."""
    real = _REALPATHS.get(file)
    if real is None:
        real = _REALPATHS[file] = os.path.realpath(file)
    return real


def _activate_package(pkg: Optional[Path]) -> None:
    """Put `pkg` (or no package, for a loose file) on sys.path for the next
    import, and drop cached modules that would answer in its place: anything
    imported from another package's folder, and any module named like one this
    package carries but loaded from elsewhere. The folder stays on the path
    after the import, for imports that detect() makes lazily."""
    global _active_package
    if _active_package is not None and str(_active_package) in sys.path:
        sys.path.remove(str(_active_package))
    _active_package = None

    provided: set[str] = set()
    if pkg is not None:
        for child in pkg.iterdir():
            if child.name.startswith((".", "__")):
                continue
            if child.is_dir():
                provided.add(child.name)
            elif child.suffix == ".py":
                provided.add(child.stem)
    # Plain string prefixes, not Path.parents: this runs once per detector
    # file on every registry read, over every module the server has loaded
    # (~1,900 once numpy, librosa and torch are in), and the Path version was
    # 95% of a scan — 3.5 s of the Playground's wait.
    roots = [str(r.resolve()) + os.sep for r in (CUSTOM_DIR, DEFAULT_CUSTOM_DIR)]
    pkg_prefix = str(pkg.resolve()) + os.sep if pkg is not None else None

    for mod_name, mod in list(sys.modules.items()):
        mod_file = getattr(mod, "__file__", None)
        if not mod_file:
            continue
        where = _realpath(mod_file)
        if pkg_prefix is not None and where.startswith(pkg_prefix):
            # The package's own helpers go too, and are imported fresh — as its
            # detector files are on every run. Kept, they answer from whatever
            # the server first loaded: a package's split.py was edited to write WAV
            # and a manifest, and the running server went on writing FLAC.
            # Nothing they cache is lost by it: detect() runs in a forked
            # child, so the server only ever holds their import-time state.
            sys.modules.pop(mod_name, None)
            continue
        in_other_package = any(
            where.startswith(root) and os.sep in where[len(root):]
            for root in roots
        )
        if in_other_package or mod_name.split(".", 1)[0] in provided:
            sys.modules.pop(mod_name, None)

    if pkg is not None:
        sys.path.insert(0, str(pkg))
        _active_package = pkg
    importlib.invalidate_caches()


# ─── Internals ───────────────────────────────────────────────────────────────


def _status_rank(s: str) -> int:
    return {"ok": 0, "validation_error": 1, "load_error": 2}.get(s, 3)


def _is_user_file(path: Path) -> bool:
    """Every .py file in either detector folder is a candidate detector.

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
    _activate_package(package_of(path))
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

    # `is_algorithm` is gone: every detector shows in Algorithm Inspect. A file
    # that still sets it loads as before — the attribute is simply not read.
    is_annotation = getattr(cls, "is_annotation", False)
    if not isinstance(is_annotation, bool):
        errors.append(_err("is_annotation", is_annotation, "must be True or False (or omitted)."))

    # Must be a real bool: `review = "yes"` would otherwise read as True.
    review = getattr(cls, "review", False)
    if not isinstance(review, bool):
        errors.append(_err("review", review, "must be True or False (or omitted)."))

    windowable = getattr(cls, "windowable", False)
    if not isinstance(windowable, bool):
        errors.append(_err("windowable", windowable, "must be True or False (or omitted)."))

    strictness = getattr(cls, "strictness", False)
    if not isinstance(strictness, bool):
        errors.append(_err("strictness", strictness, "must be True or False (or omitted)."))

    drum_source = getattr(cls, "drum_source", False)
    if not isinstance(drum_source, bool):
        errors.append(_err("drum_source", drum_source, "must be True or False (or omitted)."))

    section_source = getattr(cls, "section_source", False)
    if not isinstance(section_source, bool):
        errors.append(_err("section_source", section_source, "must be True or False (or omitted)."))

    sources = getattr(cls, "sources", None) or None
    if sources is not None and not (
        isinstance(sources, dict)
        and all(isinstance(k, str) and NAME_RE.match(k) for k in sources)
        and all(isinstance(v, (tuple, list)) and len(v) in (2, 3)
                and all(isinstance(x, str) for x in v) and 0 < len(v[0].strip()) <= 24
                for v in sources.values())
    ):
        errors.append(_err("sources", sources,
                           "must be a dict of name → (label, hint[, group]): names like detector names, "
                           "labels 1-24 characters (or omitted)."))
        sources = None

    lane_sources = getattr(cls, "lane_sources", None) or None
    if lane_sources is not None and not (isinstance(lane_sources, str) and NAME_RE.match(lane_sources)
                                         and sources):
        errors.append(_err("lane_sources", lane_sources,
                           "must be a layer type such as \"lyrics\", on a detector that declares "
                           "sources (or omitted)."))
        lane_sources = None

    reads_layers = getattr(cls, "reads_layers", False)
    if not isinstance(reads_layers, bool):
        errors.append(_err("reads_layers", reads_layers, "must be True or False (or omitted)."))

    switches = getattr(cls, "switches", None) or None
    if switches is not None and not (
        isinstance(switches, dict)
        and all(isinstance(k, str) and NAME_RE.match(k) for k in switches)
        and all(isinstance(v, str) and 0 < len(v.strip()) <= 80 for v in switches.values())
    ):
        errors.append(_err("switches", switches,
                           "must be a dict of name → label: names like detector names, "
                           "labels 1-80 characters (or omitted)."))
        switches = None

    stem_parts = getattr(cls, "stem_parts", None)
    if stem_parts is not None and not (
        isinstance(stem_parts, dict) and stem_parts
        and all(k in ALLOWED_STEM and k != "mix" for k in stem_parts)
        and all(isinstance(v, list) and v and all(isinstance(p, str) and p.strip() for p in v)
                for v in stem_parts.values())
    ):
        errors.append(_err(
            "stem_parts", stem_parts,
            "must map stems (not 'mix') to non-empty lists of label prefixes, "
            "e.g. {'drums': ['Kick', 'Snare'], 'bass': ['Bass']} (or be omitted).",
        ))
        stem_parts = None

    # A "lanes" detector returns several lanes at once. Strictness, section
    # runs (merged lane by lane), a run per stem and is_annotation (each lane
    # with a layer to copy into is copied) work as for any detector; the
    # features that act on ONE list of items — ✓/✗ on each item, parts of one
    # lane — have nothing to act on.
    if output_kind == "lanes":
        if review is True:
            errors.append(_err("review", review, 'is not available with output_kind = "lanes".'))
        if stem_parts is not None:
            errors.append(_err("stem_parts", stem_parts,
                               'is not available with output_kind = "lanes" — use one Lane per part.'))

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

    # Optional source stem — one, or a list to be run once per stem. Reject
    # unknown values rather than silently dropping them, so a typo surfaces
    # the same way a bad output_kind would.
    stem = getattr(cls, "stem", None)
    stems: Optional[list[str]] = None
    if isinstance(stem, (list, tuple)):
        declared = list(stem)
        stem = None
        if not declared or any(not isinstance(s, str) or s not in ALLOWED_STEM for s in declared):
            errors.append(_err(
                "stem", declared,
                f"a list of stems must be non-empty and hold only {sorted(ALLOWED_STEM)}.",
            ))
        elif len(set(declared)) != len(declared):
            errors.append(_err("stem", declared, "lists a stem more than once."))
        elif stem_parts:
            errors.append(_err(
                "stem", declared,
                "a detector with stem_parts already reads several stems into ONE lane; "
                "it cannot also be run once per stem. Use one or the other.",
            ))
        else:
            stems = declared
            # Every per-stem run is addressed as `<name>__<stem>` by the same
            # routes that address a whole detector, so it must fit their name.
            too_long = [cache_name(name, s) for s in declared
                        if isinstance(name, str) and not NAME_RE.match(cache_name(name, s))]
            if too_long:
                errors.append(_err(
                    "name", name,
                    f"is too long to run per stem: {', '.join(too_long)} exceed 31 characters. "
                    "Shorten the name.",
                ))
    elif stem is not None and (not isinstance(stem, str)
                               or (stem not in ALLOWED_STEM and stem != SEVERAL_STEMS)):
        errors.append(_err(
            "stem", stem,
            f"must be one of {sorted(ALLOWED_STEM)}, a list of them, "
            f"'{SEVERAL_STEMS}' for one lane read from several stems, or omitted.",
        ))

    # Optional family/group label (free-form string, max 40 chars).
    group_raw = getattr(cls, "group", None)
    group = str(group_raw).strip()[:40] if isinstance(group_raw, str) and group_raw.strip() else None

    status = "ok" if not errors else "validation_error"
    return RegistryEntry(
        name=name if isinstance(name, str) and name else path.stem,
        file=str(path),
        status=status,
        label=label if isinstance(label, str) else "",
        output_kind=output_kind if output_kind in ALLOWED_OUTPUT_KIND else "boundary",
        is_annotation=is_annotation is True,
        description=description,
        version=version,
        stem=stem if isinstance(stem, str) and (stem in ALLOWED_STEM or stem == SEVERAL_STEMS) else None,
        stems=stems,
        base_name=name if isinstance(name, str) and name else path.stem,
        group=group,
        review=review is True,
        windowable=windowable is True,
        stem_parts={k: list(v) for k, v in stem_parts.items()} if stem_parts else None,
        strictness=strictness is True,
        drum_source=drum_source is True,
        section_source=section_source is True,
        switches=dict(switches) if switches else None,
        sources=[{"name": k, "label": v[0], "hint": v[1], **({"group": v[2]} if len(v) == 3 else {})}
                 for k, v in sources.items()]
        if sources else None,
        lane_sources=lane_sources,
        errors=errors,
    )


def _err(field: str, value: object, message: str) -> ValidationError:
    return ValidationError(index=None, field=field, value=value, message=message)
