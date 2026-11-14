"""Managing packages from the Playground: make one, edit its package.json,
move detectors between packages, and archive / restore a detector.

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
    import custom_runner
    import custom_server
    user, default = tmp_path / "custom", tmp_path / "custom-default"
    user.mkdir()
    default.mkdir()
    monkeypatch.setattr(custom_loader, "CUSTOM_DIR", user)
    monkeypatch.setattr(custom_loader, "DEFAULT_CUSTOM_DIR", default)
    # Rename and delete reach past the detector folders: the trash, the cached
    # runs and the annotators' copies all move or go with the detector.
    monkeypatch.setattr(custom_server, "TRASH_DIR", user / ".trash")
    monkeypatch.setattr(custom_runner, "CUSTOM_RESULTS_DIR", tmp_path / "results")
    monkeypatch.setattr(custom_server, "CUSTOM_ANNOTATIONS_DIR", tmp_path / "annotations")
    monkeypatch.setattr(custom_server, "DETECTOR_OUTPUTS_DIR", tmp_path / "outputs")
    monkeypatch.setattr(custom_server, "_private_names", None)
    yield user, default
    custom_loader._activate_package(None)


def detector(name: str, *, imports: str = "") -> str:
    return (
        "from custom_api import CustomDetector\n"
        f"{imports}\n"
        "class D(CustomDetector):\n"
        f"    name = {name!r}\n"
        f"    label = {name!r}\n"
        "    output_kind = 'cue'\n"
        "    def detect(self, ctx):\n"
        "        return []\n"
    )


def put(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def entry(name: str) -> dict:
    import custom_server
    return next(d for d in custom_server._filtered_registry(
        hide_private=False, include_archived=True)
        if d["name"] == name)


# ─── Making and editing packages ─────────────────────────────────────────────


def test_create_package_makes_an_empty_titled_folder(dirs):
    import custom_packages
    user, _ = dirs
    pkg = custom_packages.create_package("Light Show", description="For the rig")
    assert pkg["id"] == "light-show"
    assert pkg["title"] == "Light Show" and pkg["detectors"] == []
    assert json.loads((user / "light-show" / "package.json").read_text()) == {
        "title": "Light Show", "description": "For the rig"}
    assert "light-show" in {p["id"] for p in custom_packages.list_packages()}


def test_create_package_refuses_a_taken_name(dirs):
    import custom_packages
    custom_packages.create_package("Mine")
    with pytest.raises(custom_packages.PackageError) as exc:
        custom_packages.create_package("mine")
    assert exc.value.status == 409


def test_update_package_keeps_keys_it_does_not_edit(dirs):
    import custom_packages
    user, _ = dirs
    put(user / "viz" / "package.json", json.dumps(
        {"title": "Viz", "bundle": ["generators"], "licenses": [{"name": "x"}], "author": "A"}))
    pkg = custom_packages.update_package("viz", {"title": "Visualizer", "author": "", "public": False})
    raw = json.loads((user / "viz" / "package.json").read_text())
    assert raw == {"title": "Visualizer", "bundle": ["generators"], "licenses": [{"name": "x"}], "public": False}
    assert pkg["title"] == "Visualizer" and pkg["public"] is False
    custom_packages.update_package("viz", {"public": True})
    assert "public" not in json.loads((user / "viz" / "package.json").read_text())


def test_a_shipped_package_cannot_be_edited(dirs):
    import custom_packages
    _, default = dirs
    put(default / "shipped" / "a.py", detector("a"))
    with pytest.raises(custom_packages.PackageError):
        custom_packages.update_package("shipped", {"title": "X"})


# ─── Moving between packages ─────────────────────────────────────────────────


def test_move_into_a_package_and_back_out(dirs):
    import custom_server
    user, _ = dirs
    put(user / "loose.py", detector("loose"))
    put(user / "pkg" / "package.json", json.dumps({"title": "Pkg"}))
    moved = custom_server.move_script("loose", "pkg")
    assert moved["package"] == "pkg" and (user / "pkg" / "loose.py").is_file()
    assert not (user / "loose.py").exists()
    back = custom_server.move_script("loose", None)
    assert back["package"] is None and (user / "loose.py").is_file()


def test_move_refuses_to_strand_a_package_helper(dirs):
    import custom_server
    user, _ = dirs
    put(user / "viz" / "kitsep" / "__init__.py", "X = 1\n")
    put(user / "viz" / "uses.py", detector("uses", imports="from kitsep import X"))
    put(user / "other" / "package.json", "{}")
    with pytest.raises(ValueError, match="kitsep"):
        custom_server.move_script("uses", "other")
    assert (user / "viz" / "uses.py").is_file()


def test_move_refuses_a_shipped_example_and_a_name_clash(dirs):
    import custom_server
    user, default = dirs
    put(default / "shipped.py", detector("shipped"))
    put(user / "pkg" / "package.json", "{}")
    with pytest.raises(custom_server.ShippedDetectorError):
        custom_server.move_script("shipped", "pkg")
    put(user / "a.py", detector("a"))
    put(user / "pkg" / "a.py", detector("a_other"))
    with pytest.raises(ValueError, match="already exists"):
        custom_server.move_script("a", "pkg")


# ─── Archiving ───────────────────────────────────────────────────────────────


def test_archived_leaves_the_registry_but_not_the_playground(dirs):
    import custom_server
    user, _ = dirs
    put(user / "keep.py", detector("keep"))
    put(user / "old.py", detector("old"))
    custom_server.set_archived("old", True)
    assert json.loads((user / "archived.json").read_text()) == {"detectors": ["old"]}
    plain = {d["name"] for d in custom_server._filtered_registry(
        hide_private=False)}
    assert plain == {"keep"}
    assert entry("old")["archived"] is True and entry("keep")["archived"] is False
    assert custom_server.read_script("old") is not None
    custom_server.set_archived("old", False)
    assert entry("old")["archived"] is False


def test_an_archived_detector_stays_out_of_its_package_zip(dirs):
    import custom_packages
    import custom_server
    user, _ = dirs
    put(user / "pkg" / "package.json", json.dumps({"title": "Pkg"}))
    put(user / "pkg" / "live.py", detector("live"))
    put(user / "pkg" / "old.py", detector("old"))
    custom_server.set_archived("old", True)
    _, data = custom_packages.export_package("pkg")
    assert sorted(zipfile.ZipFile(io.BytesIO(data)).namelist()) == ["pkg/live.py", "pkg/package.json"]
    pkg = next(p for p in custom_packages.list_packages() if p["id"] == "pkg")
    assert pkg["detectors"] == ["live"] and pkg["archived"] == ["old"]


def test_rename_carries_the_archive_and_delete_drops_it(dirs):
    import custom_loader
    import custom_server
    user, _ = dirs
    put(user / "old.py", detector("old"))
    custom_server.set_archived("old", True)
    custom_server.copy_script("old", "older", move=True)
    assert custom_loader.archived_names() == {"older"}
    assert custom_server.delete_script("older") == user / ".trash" / "older.py"
    assert custom_loader.archived_names() == set()
