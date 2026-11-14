"""Detector packages: folders of detectors, shared as a zip and installed back.

Every test points custom/ and custom-default/ at temp folders, so nothing
here reads or writes the real detector folders.
"""

from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path

import pytest

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))


@pytest.fixture
def dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import custom_loader
    user, default = tmp_path / "custom", tmp_path / "custom-default"
    user.mkdir()
    default.mkdir()
    monkeypatch.setattr(custom_loader, "CUSTOM_DIR", user)
    monkeypatch.setattr(custom_loader, "DEFAULT_CUSTOM_DIR", default)
    yield user, default
    custom_loader._activate_package(None)


def detector(name: str, *, body: str = "return []", imports: str = "") -> str:
    return (
        "from custom_api import CustomDetector\n"
        f"{imports}\n"
        f"class D(CustomDetector):\n"
        f"    name = {name!r}\n"
        f"    label = {name!r}\n"
        "    output_kind = 'cue'\n"
        "    def detect(self, ctx):\n"
        f"        {body}\n"
    )


def put(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def zip_of(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, text in files.items():
            zf.writestr(name, text)
    return buf.getvalue()


# ─── Discovery ───────────────────────────────────────────────────────────────


def test_detectors_in_a_package_folder_carry_its_title(dirs):
    from custom_loader import scan
    user, _ = dirs
    put(user / "loose.py", detector("loose"))
    put(user / "viz" / "package.json", json.dumps({"title": "Visualizer"}))
    put(user / "viz" / "pulse.py", detector("pulse"))
    put(user / "viz" / "lib" / "helpers.py", "X = 1\n")  # a helper, not a detector

    by_name = {e.name: e for e in scan()}
    assert set(by_name) == {"loose", "pulse"}
    assert (by_name["pulse"].package, by_name["pulse"].package_title) == ("viz", "Visualizer")
    assert by_name["loose"].package is None
    assert by_name["pulse"].status == "ok"


def test_package_without_manifest_is_titled_by_its_folder(dirs):
    from custom_loader import read_package
    user, _ = dirs
    put(user / "light_show" / "a.py", detector("a"))
    assert read_package("light_show")["title"] == "Light show"


def test_machinery_folders_are_not_packages(dirs):
    from custom_loader import package_ids
    user, _ = dirs
    put(user / ".trash" / "old.py", detector("old"))
    put(user / "__pycache__" / "x.py", detector("x"))
    assert package_ids() == []


def test_each_package_imports_its_own_helpers(dirs):
    """Two packages both ship lib/tone.py; each detector must get its own."""
    from custom_loader import load_detector
    user, _ = dirs
    for pkg, value in (("one", "1"), ("two", "2")):
        put(user / pkg / "lib" / "__init__.py", "")
        put(user / pkg / "lib" / "tone.py", f"VALUE = {value}\n")
        put(user / pkg / f"det_{pkg}.py",
            detector(f"det_{pkg}", imports="from lib.tone import VALUE", body="return VALUE"))

    assert load_detector("det_one").detect(None) == 1
    assert load_detector("det_two").detect(None) == 2
    assert load_detector("det_one").detect(None) == 1


def test_an_edited_helper_is_read_fresh(dirs):
    """A package's helpers are imported again on every load, so an edit to one
    reaches the next run without a server restart (kitsep/split.py once kept
    writing FLAC after it was changed to write WAV)."""
    import os
    from custom_loader import load_detector
    user, _ = dirs
    put(user / "pkg" / "lib" / "__init__.py", "")
    tone = put(user / "pkg" / "lib" / "tone.py", "VALUE = 'old'\n")
    put(user / "pkg" / "det.py", detector("det", imports="from lib.tone import VALUE", body="return VALUE"))
    assert load_detector("det").detect(None) == "old"

    tone.write_text("VALUE = 'new'\n")
    st = tone.stat()
    os.utime(tone, (st.st_atime, st.st_mtime + 5))  # past the .pyc's mtime check
    assert load_detector("det").detect(None) == "new"


def test_lazy_imports_inside_detect_see_the_package(dirs):
    from custom_loader import load_detector
    user, _ = dirs
    put(user / "pkg" / "lib" / "__init__.py", "")
    put(user / "pkg" / "lib" / "late.py", "VALUE = 'late'\n")
    put(user / "pkg" / "det.py", detector("det", body="from lib.late import VALUE; return VALUE"))
    put(user / "other.py", detector("other"))

    det = load_detector("det")  # scan() imports `other` too, then det again
    assert det.detect(None) == "late"


# ─── Share → install round trip ──────────────────────────────────────────────


def test_share_then_install_elsewhere(dirs, tmp_path, monkeypatch):
    import custom_loader
    from custom_loader import scan
    from custom_packages import export_package, install_package
    user, _ = dirs
    put(user / "viz" / "package.json", json.dumps({"title": "Visualizer", "author": "A"}))
    put(user / "viz" / "pulse.py", detector("pulse"))
    put(user / "viz" / "lib" / "helpers.py", "X = 1\n")
    put(user / "viz" / "__pycache__" / "pulse.cpython-312.pyc", "junk")

    filename, data = export_package("viz")
    assert filename == "viz.zip"
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        assert sorted(zf.namelist()) == ["viz/lib/helpers.py", "viz/package.json", "viz/pulse.py"]

    # A colleague's install: a fresh, empty custom/.
    theirs = tmp_path / "theirs"
    theirs.mkdir()
    monkeypatch.setattr(custom_loader, "CUSTOM_DIR", theirs)
    pkg = install_package(data, filename="viz.zip")
    assert (pkg["id"], pkg["title"], pkg["author"], pkg["detectors"]) == ("viz", "Visualizer", "A", ["pulse"])
    assert (theirs / "viz" / "lib" / "helpers.py").read_text() == "X = 1\n"
    assert [e.status for e in scan()] == ["ok"]


def test_a_zip_of_loose_files_is_named_by_the_zip(dirs):
    from custom_packages import install_package
    user, _ = dirs
    pkg = install_package(zip_of({"a.py": detector("a"), "b.py": detector("b")}), filename="My Beats.zip")
    assert pkg["id"] == "my-beats"
    assert pkg["detectors"] == ["a", "b"]
    assert json.loads((user / "my-beats" / "package.json").read_text())["title"] == "My beats"


def test_sharing_bundles_only_the_helper_modules_it_reaches(dirs, tmp_path, monkeypatch):
    import custom_loader
    from custom_packages import export_package
    user, _ = dirs
    py = tmp_path / "py"
    put(py / "mylib" / "__init__.py", "")
    put(py / "mylib" / "a.py", "from mylib.b import thing\n")
    put(py / "mylib" / "b.py", "thing = 1\n")
    put(py / "mylib" / "unused.py", "raise SystemExit\n")
    monkeypatch.setattr(custom_loader, "_THIS_DIR", py)

    put(user / "viz" / "package.json", json.dumps({"title": "V", "bundle": ["mylib"]}))
    put(user / "viz" / "det.py", detector("det", body="from mylib import a; return []"))

    _, data = export_package("viz")
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = set(zf.namelist())
    assert {"viz/mylib/__init__.py", "viz/mylib/a.py", "viz/mylib/b.py"} <= names
    assert "viz/mylib/unused.py" not in names


# ─── What install refuses ────────────────────────────────────────────────────


@pytest.mark.parametrize("evil", ["../escape.py", "/abs.py", "pkg/../../escape.py"])
def test_install_refuses_paths_outside_the_folder(dirs, evil):
    from custom_packages import PackageError, install_package
    with pytest.raises(PackageError, match="outside the package"):
        install_package(zip_of({"pkg/a.py": detector("a"), evil: "x"}))


def test_install_refuses_a_detector_name_already_in_use(dirs):
    from custom_packages import PackageError, install_package
    user, _ = dirs
    put(user / "pulse.py", detector("pulse"))
    with pytest.raises(PackageError, match="pulse") as err:
        install_package(zip_of({"viz/pulse.py": detector("pulse")}))
    assert err.value.status == 409
    assert not (user / "viz").exists()


def test_install_over_an_existing_package_needs_replace(dirs):
    from custom_packages import PackageError, install_package
    user, _ = dirs
    install_package(zip_of({"viz/a.py": detector("a")}))
    with pytest.raises(PackageError) as err:
        install_package(zip_of({"viz/a.py": detector("a"), "viz/b.py": detector("b")}))
    assert err.value.status == 409 and err.value.extra.get("exists") is True

    pkg = install_package(zip_of({"viz/a.py": detector("a"), "viz/b.py": detector("b")}), replace=True)
    assert pkg["detectors"] == ["a", "b"]
    assert (user / ".trash" / "viz.package" / "a.py").is_file()


def test_install_needs_a_detector_at_the_top(dirs):
    from custom_packages import PackageError, install_package
    with pytest.raises(PackageError, match="no detector"):
        install_package(zip_of({"viz/lib/helper.py": "X = 1\n"}))


def test_install_refuses_a_non_zip(dirs):
    from custom_packages import PackageError, install_package
    with pytest.raises(PackageError, match="not a zip"):
        install_package(b"print('hi')")


# ─── Removing ────────────────────────────────────────────────────────────────


def test_uninstall_moves_the_folder_to_the_trash(dirs):
    from custom_packages import uninstall_package
    user, _ = dirs
    put(user / "viz" / "a.py", detector("a"))
    trashed, names = uninstall_package("viz")
    assert names == ["a"]
    assert not (user / "viz").exists() and (trashed / "a.py").is_file()


def test_a_shipped_package_cannot_be_uninstalled(dirs):
    from custom_packages import PackageError, uninstall_package
    _, default = dirs
    put(default / "examples" / "a.py", detector("a"))
    with pytest.raises(PackageError, match="ships with TimeCues"):
        uninstall_package("examples")
