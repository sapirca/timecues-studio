"""Detector packages: share a folder of detectors, install someone else's.

A package is nothing more than a folder inside tools/python/custom/:

    custom/visualizer/
        package.json        {"title": "Visualizer", "description": "…",
                             "author": "…", "version": "1.0"}   (all optional)
        pulse.py            one detector per top-level .py, exactly as a
        energy_arcs.py      loose detector in custom/ would be
        lib/…               anything in a subfolder is helper code the
                            detectors import (`from lib.bars import …`)

Sharing it means zipping that folder; installing a zip means unpacking it back
into custom/. There is no other format and nothing to register — a folder
copied in by hand is installed the moment the registry is re-scanned. This
module only makes the round trip safe from the app: a zip can't write outside
its folder, can't replace another package or take a detector name already in
use, and a package being replaced or removed goes to custom/.trash, not away.

`bundle` in package.json names folders under tools/python/ that the package's
detectors import from but that another TimeCues install may not have. Sharing
copies in only the modules the detectors actually reach, so the zip works
where that folder is absent.
"""

from __future__ import annotations

import ast
import io
import json
import re
import shutil
import stat
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Optional

import custom_loader
from custom_loader import PACKAGE_ID_RE, PACKAGE_MANIFEST, package_folders, read_package, scan

MAX_PACKAGE_BYTES = 20 * 1024 * 1024        # the zip as uploaded
MAX_UNPACKED_BYTES = 60 * 1024 * 1024       # everything in it, unpacked
MAX_PACKAGE_FILES = 1000

# Never shipped, never installed: build droppings and OS litter.
_SKIP_PARTS = {"__pycache__", "__MACOSX", ".DS_Store"}


class PackageError(ValueError):
    """A request the package store refuses. `status` is the HTTP code."""

    def __init__(self, message: str, status: int = 400, **extra: object) -> None:
        super().__init__(message)
        self.status = status
        self.extra = extra


# ─── Listing ─────────────────────────────────────────────────────────────────


def list_packages() -> list[dict]:
    """Every package with its manifest and the detectors it holds — the
    archived ones listed apart, since its zip leaves them out."""
    members: dict[str, list[str]] = {}
    archived: dict[str, list[str]] = {}
    for entry in scan():
        if entry.package:
            (archived if entry.archived else members).setdefault(entry.package, []).append(entry.name)
    out = []
    for pkg_id in custom_loader.package_ids():
        info = read_package(pkg_id)
        info["detectors"] = sorted(members.get(pkg_id, []))
        info["archived"] = sorted(archived.get(pkg_id, []))
        out.append(info)
    return out


# ─── Making and editing ──────────────────────────────────────────────────────

# The manifest fields the app edits, with read_package's length limits.
_EDITABLE_TEXT = {"title": 80, "description": 500, "author": 120, "version": 40}


def create_package(title: str, *, package_id: str = "", description: str = "") -> dict:
    """Make an empty package: custom/<id>/ with a package.json naming it. The
    id is `package_id`, else the title as a folder name."""
    title = (title or "").strip()
    if not title:
        raise PackageError("a package needs a title")
    if len(title) > _EDITABLE_TEXT["title"]:
        raise PackageError(f"the title is longer than {_EDITABLE_TEXT['title']} characters")
    pkg_id = (package_id or "").strip() or _slug(title)
    if not PACKAGE_ID_RE.match(pkg_id):
        raise PackageError(
            "the package's folder name must be lowercase letters, digits, _ and - "
            "(starting with a letter or digit, at most 48 characters)")
    if pkg_id in custom_loader.package_ids() or (custom_loader.CUSTOM_DIR / pkg_id).exists():
        raise PackageError(f"a package named {pkg_id!r} already exists", status=409)
    folder = custom_loader.CUSTOM_DIR / pkg_id
    folder.mkdir(parents=True)
    manifest = {"title": title}
    if description.strip():
        manifest["description"] = description.strip()[:_EDITABLE_TEXT["description"]]
    (folder / PACKAGE_MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    info = read_package(pkg_id)
    info["detectors"] = []
    info["archived"] = []
    return info


def update_package(package_id: str, fields: dict) -> dict:
    """Rewrite the editable fields of a package's package.json — title,
    description, author, version, public — keeping every other key in it
    (bundle, licenses …) exactly as it was. An empty text field is dropped."""
    if not PACKAGE_ID_RE.match(package_id) or package_id not in custom_loader.package_ids():
        raise PackageError(f"no package named {package_id!r}", status=404)
    folder = custom_loader.CUSTOM_DIR / package_id
    if not folder.is_dir():
        raise PackageError(f"{package_id!r} ships with TimeCues and can't be edited from the app", status=409)
    manifest_path = folder / PACKAGE_MANIFEST
    raw: dict = {}
    if manifest_path.is_file():
        try:
            raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise PackageError(f"{PACKAGE_MANIFEST} could not be read ({exc}) — fix it by hand first", status=409)
        if not isinstance(raw, dict):
            raise PackageError(f"{PACKAGE_MANIFEST} is not a JSON object — fix it by hand first", status=409)
    for key, limit in _EDITABLE_TEXT.items():
        if key not in fields:
            continue
        value = fields[key]
        if not isinstance(value, str):
            raise PackageError(f"{key} must be text")
        value = value.strip()
        if len(value) > limit:
            raise PackageError(f"the {key} is longer than {limit} characters")
        if value:
            raw[key] = value
        elif key == "title":
            raise PackageError("a package needs a title")
        else:
            raw.pop(key, None)
    if "public" in fields:
        if not isinstance(fields["public"], bool):
            raise PackageError("public must be true or false")
        if fields["public"]:
            raw.pop("public", None)
        else:
            raw["public"] = False
    manifest_path.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return next(p for p in list_packages() if p["id"] == package_id)


# ─── Sharing ─────────────────────────────────────────────────────────────────


def export_package(package_id: str) -> tuple[str, bytes]:
    """Zip package `package_id` as `<id>/…` and return (filename, bytes),
    without its archived detectors."""
    folders = package_folders(package_id) if PACKAGE_ID_RE.match(package_id) else []
    if not folders:
        raise PackageError(f"no package named {package_id!r}", status=404)

    # The shipped folder first, the user's edits over it.
    files: dict[str, Path] = {}
    for folder in reversed(folders):
        for path in sorted(folder.rglob("*")):
            rel = path.relative_to(folder)
            if path.is_file() and not path.is_symlink() and not _skipped(rel.parts) and path.suffix != ".pyc":
                files[rel.as_posix()] = path

    # An archived detector stays home: the zip is what the package offers now.
    archived = {Path(e.file).name for e in scan() if e.package == package_id and e.archived}
    for rel in archived:
        files.pop(rel, None)

    info = read_package(package_id)
    detector_sources = [p for rel, p in files.items() if "/" not in rel and p.suffix == ".py"]
    for rel, path in _bundle_closure(detector_sources, info["bundle"]).items():
        files.setdefault(rel, path)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        if PACKAGE_MANIFEST not in files:
            zf.writestr(f"{package_id}/{PACKAGE_MANIFEST}", _manifest_text(info))
        for rel in sorted(files):
            zf.write(files[rel], f"{package_id}/{rel}")
    return f"{package_id}.zip", buf.getvalue()


def _bundle_closure(sources: list[Path], bundle: list[str]) -> dict[str, Path]:
    """The modules under tools/python/<bundle>/ that `sources` import, directly
    or through each other, keyed by path relative to tools/python/. Each comes
    with the __init__.py of every folder above it, so it imports as a package."""
    py_dir = custom_loader._THIS_DIR
    roots = {b for b in bundle if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", b) and (py_dir / b).is_dir()}
    if not roots:
        return {}
    found: dict[str, Path] = {}
    queue = list(sources)
    seen: set[Path] = set()
    while queue:
        src = queue.pop()
        if src in seen:
            continue
        seen.add(src)
        try:
            tree = ast.parse(src.read_text(encoding="utf-8"))
        except (OSError, SyntaxError, UnicodeDecodeError):
            continue
        for module in _imported_modules(tree):
            if module.split(".", 1)[0] not in roots:
                continue
            parts = module.split(".")
            for candidate in (py_dir.joinpath(*parts).with_suffix(".py"), py_dir.joinpath(*parts, "__init__.py")):
                if not candidate.is_file():
                    continue
                for i in range(1, len(parts)):
                    init = py_dir.joinpath(*parts[:i], "__init__.py")
                    if init.is_file():
                        found[init.relative_to(py_dir).as_posix()] = init
                found[candidate.relative_to(py_dir).as_posix()] = candidate
                queue.append(candidate)
    return found


def _imported_modules(tree: ast.AST) -> set[str]:
    """Absolute module names an AST imports — at the top or inside functions.
    `from a.b import c` yields both a.b and a.b.c, since c may be a module."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module)
            names.update(f"{node.module}.{a.name}" for a in node.names if a.name != "*")
    return names


def helpers_left_behind(source: Path, dest: Path) -> list[str]:
    """The helper modules detector file `source` imports from its own package
    folder that folder `dest` doesn't carry — what moving it there would break.
    Only a packaged detector has any: its package folder is on sys.path while
    it runs (custom_loader._activate_package), a loose file's folder is not."""
    home = custom_loader.package_of(source)
    if home is None:
        return []

    def provided(folder: Path) -> set[str]:
        if not folder.is_dir():
            return set()
        out = set()
        for child in folder.iterdir():
            if child.name.startswith((".", "__")) or child == source:
                continue
            if child.is_dir():
                out.add(child.name)
            elif child.suffix == ".py":
                out.add(child.stem)
        return out

    try:
        tree = ast.parse(source.read_text(encoding="utf-8"))
    except (OSError, SyntaxError, UnicodeDecodeError):
        return []
    tops = {m.split(".", 1)[0] for m in _imported_modules(tree)}
    here = set().union(*(provided(f) for f in package_folders(home.name)))
    there = provided(dest) if dest != custom_loader.CUSTOM_DIR else set()
    return sorted((tops & here) - there)


def _manifest_text(info: dict) -> str:
    keys = ("title", "description", "author", "version", "bundle")
    return json.dumps({k: info[k] for k in keys if info.get(k)}, indent=2) + "\n"


# ─── Installing ──────────────────────────────────────────────────────────────


def install_package(data: bytes, *, filename: str = "", replace: bool = False) -> dict:
    """Unpack a package zip into custom/<id>/ and return its listing entry.

    The zip may hold the package folder (what Share produces, and what zipping
    a folder by hand produces) or the folder's contents directly. The id is
    the folder's name, else the zip's filename. Refuses — without touching
    disk — a zip that escapes its folder, holds no detector, reuses a
    detector name from outside the package, or lands on an existing package
    when `replace` is off.
    """
    if len(data) > MAX_PACKAGE_BYTES:
        raise PackageError(f"package is larger than {MAX_PACKAGE_BYTES // (1024 * 1024)} MB", status=413)
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise PackageError("not a zip file — share a package as a .zip of its folder")

    with zf:
        members = _checked_members(zf)
        tops = {parts[0] for parts, _ in members}
        wrapped = len(tops) == 1 and all(len(parts) > 1 for parts, _ in members)
        if wrapped:
            package_id = _slug(next(iter(tops)))
            members = [(parts[1:], info) for parts, info in members]
        else:
            package_id = _slug(PurePosixPath(filename).stem)
        if not package_id:
            raise PackageError("could not tell the package's name — zip its folder, not just the files in it")

        detectors = [info for parts, info in members if len(parts) == 1 and parts[0].endswith(".py")
                     and parts[0] != "__init__.py"]
        if not detectors:
            raise PackageError("no detector in this package — its .py files must sit at the top of the package folder")

        user_dir = custom_loader.CUSTOM_DIR / package_id
        shipped_dir = custom_loader.DEFAULT_CUSTOM_DIR / package_id
        if shipped_dir.is_dir():
            raise PackageError(f"{package_id!r} is the name of a package that ships with TimeCues — rename the folder and zip it again",
                               status=409)
        if user_dir.exists() and not replace:
            raise PackageError(f"a package named {package_id!r} is already installed", status=409,
                               exists=True, package=package_id)

        incoming_names = {n for info in detectors for n in _declared_names(zf.read(info))}
        taken = {e.name: e for e in scan() if e.package != package_id}
        clashes = sorted(n for n in incoming_names if n in taken)
        if clashes:
            raise PackageError(
                "detector name(s) already in use: " + ", ".join(clashes)
                + " — two detectors can't share a name; rename or remove one first",
                status=409, clashes=clashes,
            )

        custom_loader.CUSTOM_DIR.mkdir(parents=True, exist_ok=True)
        staging = custom_loader.CUSTOM_DIR / f".incoming-{uuid.uuid4().hex[:8]}"
        try:
            for parts, info in members:
                target = staging.joinpath(*parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(zf.read(info))
            if not (staging / PACKAGE_MANIFEST).is_file():
                (staging / PACKAGE_MANIFEST).write_text(
                    json.dumps({"title": package_id.replace("_", " ").replace("-", " ").capitalize()}, indent=2) + "\n",
                    encoding="utf-8",
                )
            if user_dir.exists():
                _to_trash(user_dir)
            staging.rename(user_dir)
        finally:
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)

    return next(p for p in list_packages() if p["id"] == package_id)


def _checked_members(zf: zipfile.ZipFile) -> list[tuple[tuple[str, ...], zipfile.ZipInfo]]:
    """The zip's files as path parts, refusing anything that could land outside
    the package folder. Directories and OS litter are dropped."""
    out = []
    total = 0
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = info.filename.replace("\\", "/")
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or re.match(r"^[A-Za-z]:", name):
            raise PackageError(f"refusing {info.filename!r}: it points outside the package folder")
        if stat.S_ISLNK(info.external_attr >> 16):
            raise PackageError(f"refusing {info.filename!r}: links aren't allowed in a package")
        parts = tuple(p for p in path.parts if p not in ("", "."))
        if not parts or _skipped(parts) or parts[-1].endswith(".pyc"):
            continue
        total += info.file_size
        out.append((parts, info))
    if len(out) > MAX_PACKAGE_FILES:
        raise PackageError(f"package has more than {MAX_PACKAGE_FILES} files")
    if total > MAX_UNPACKED_BYTES:
        raise PackageError(f"package unpacks to more than {MAX_UNPACKED_BYTES // (1024 * 1024)} MB", status=413)
    if not out:
        raise PackageError("the zip is empty")
    return out


def _declared_names(source: bytes) -> set[str]:
    """Detector names a file declares (`name = "…"` in a class body), read
    without running it — the clash check happens before anything is installed."""
    try:
        tree = ast.parse(source.decode("utf-8"))
    except (SyntaxError, UnicodeDecodeError, ValueError):
        return set()
    names = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        for stmt in node.body:
            if (isinstance(stmt, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "name" for t in stmt.targets)
                    and isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, str)):
                names.add(stmt.value.value)
    return names


# ─── Removing ────────────────────────────────────────────────────────────────


def uninstall_package(package_id: str) -> tuple[Path, list[str]]:
    """Move custom/<id>/ to the trash. Returns (where it went, the detector
    names it held) so the caller can wipe their cached results."""
    if not PACKAGE_ID_RE.match(package_id):
        raise PackageError(f"no package named {package_id!r}", status=404)
    user_dir = custom_loader.CUSTOM_DIR / package_id
    if not user_dir.is_dir():
        if (custom_loader.DEFAULT_CUSTOM_DIR / package_id).is_dir():
            raise PackageError(f"{package_id!r} ships with TimeCues and can't be removed from the app", status=409)
        raise PackageError(f"no package named {package_id!r}", status=404)
    names = [e.name for e in scan() if e.package == package_id and not e.is_default]
    return _to_trash(user_dir), names


def _to_trash(folder: Path) -> Path:
    trash = custom_loader.CUSTOM_DIR / ".trash"
    trash.mkdir(parents=True, exist_ok=True)
    dest = trash / f"{folder.name}.package"
    n = 1
    while dest.exists():
        dest = trash / f"{folder.name}.package.{n}"
        n += 1
    folder.rename(dest)
    return dest


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _skipped(parts: tuple[str, ...]) -> bool:
    return any(p in _SKIP_PARTS or p.startswith(".") for p in parts)


def _slug(raw: str) -> str:
    """A folder name → a package id: lowercase, `-` for anything else."""
    s = re.sub(r"[^a-z0-9_-]+", "-", raw.strip().lower()).strip("-_")
    s = s[:48]
    return s if PACKAGE_ID_RE.match(s) else ""
