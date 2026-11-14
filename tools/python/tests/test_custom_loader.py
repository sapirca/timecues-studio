"""Loader validation tests.

Each test writes a synthetic .py file into a temporary CUSTOM_DIR (pointed
to via monkeypatching) so we can control exactly what the loader sees.

These tests exercise the load-time contract only — runtime detect() behavior
is covered by test_custom_runner.py.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure tools/python is on sys.path so `import custom_loader` works when
# pytest is invoked from the repo root.
_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))


@pytest.fixture
def isolated_custom_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Redirect CUSTOM_DIR to a tmp dir for the duration of a test, and
    DEFAULT_CUSTOM_DIR to an empty sibling so the shipped examples stay out."""
    import custom_loader
    user, default = tmp_path / "custom", tmp_path / "custom-default"
    user.mkdir()
    default.mkdir()
    monkeypatch.setattr(custom_loader, "CUSTOM_DIR", user)
    monkeypatch.setattr(custom_loader, "DEFAULT_CUSTOM_DIR", default)
    return user


def write(dir_: Path, fname: str, body: str) -> Path:
    p = dir_ / fname
    p.write_text(body)
    return p


# ─── Happy path ──────────────────────────────────────────────────────────────


def test_valid_detector_loads(isolated_custom_dir: Path):
    write(isolated_custom_dir, "good.py", """
from custom_api import Boundary, CustomDetector, DetectionContext

class Good(CustomDetector):
    name = "good"
    label = "Good"
    output_kind = "boundary"

    def detect(self, ctx):
        return []
""")
    from custom_loader import scan
    entries = scan()
    assert len(entries) == 1
    assert entries[0].status == "ok"
    assert entries[0].name == "good"
    assert entries[0].label == "Good"
    assert entries[0].errors == []


def test_init_and_dotfiles_are_skipped(isolated_custom_dir: Path):
    """__init__.py and dotfiles are mechanical, not detectors.

    Leading-underscore filenames are intentionally NOT skipped — the user's
    expectation is that any file in this folder appears in the registry.
    """
    write(isolated_custom_dir, "__init__.py", "x = 1\n")
    write(isolated_custom_dir, ".hidden.py", "x = 1\n")
    from custom_loader import scan
    assert scan() == []


def test_leading_underscore_files_are_loaded(isolated_custom_dir: Path):
    write(isolated_custom_dir, "_legacy.py", """
from custom_api import CustomDetector

class Legacy(CustomDetector):
    name = "legacy"
    label = "Legacy"
    output_kind = "boundary"

    def detect(self, ctx):
        return []
""")
    from custom_loader import scan
    [entry] = scan()
    assert entry.status == "ok"
    assert entry.name == "legacy"


# ─── Manifest validation ─────────────────────────────────────────────────────


def test_missing_name_is_validation_error(isolated_custom_dir: Path):
    write(isolated_custom_dir, "no_name.py", """
from custom_api import CustomDetector

class NoName(CustomDetector):
    name = ""
    label = "No name"
    output_kind = "boundary"

    def detect(self, ctx):
        return []
""")
    from custom_loader import scan
    [entry] = scan()
    assert entry.status == "validation_error"
    assert any(e.field == "name" for e in entry.errors)


def test_invalid_name_charset(isolated_custom_dir: Path):
    write(isolated_custom_dir, "weird.py", """
from custom_api import CustomDetector

class Weird(CustomDetector):
    name = "Has-CAPS-and-SPACE here"
    label = "Weird"
    output_kind = "boundary"

    def detect(self, ctx):
        return []
""")
    from custom_loader import scan
    [entry] = scan()
    assert entry.status == "validation_error"
    assert any("a-z" in e.message for e in entry.errors if e.field == "name")


def test_unknown_output_kind(isolated_custom_dir: Path):
    write(isolated_custom_dir, "bad_kind.py", """
from custom_api import CustomDetector

class BadKind(CustomDetector):
    name = "bad_kind"
    label = "Bad kind"
    output_kind = "section"   # not allowed

    def detect(self, ctx):
        return []
""")
    from custom_loader import scan
    [entry] = scan()
    assert entry.status == "validation_error"
    assert any(e.field == "output_kind" for e in entry.errors)


def test_flags_are_optional_and_legacy_is_algorithm_is_ignored(isolated_custom_dir: Path):
    write(isolated_custom_dir, "bare.py", """
from custom_api import CustomDetector

class Bare(CustomDetector):
    name = "bare"
    label = "Bare"
    output_kind = "boundary"

    def detect(self, ctx):
        return []
""")
    write(isolated_custom_dir, "legacy.py", """
from custom_api import CustomDetector

class Legacy(CustomDetector):
    name = "legacy"
    label = "Legacy"
    output_kind = "boundary"
    is_algorithm = False
    is_annotation = True

    def detect(self, ctx):
        return []
""")
    from custom_loader import scan
    by_name = {e.name: e for e in scan()}
    assert by_name["bare"].status == "ok"
    assert by_name["bare"].to_dict()["is_annotation"] is False
    assert "is_algorithm" not in by_name["bare"].to_dict()
    assert by_name["legacy"].status == "ok"
    assert by_name["legacy"].is_annotation is True


def test_is_annotation_must_be_a_bool(isolated_custom_dir: Path):
    write(isolated_custom_dir, "typo.py", _detector_src("typo", "Typo").replace(
        '    output_kind = "boundary"\n', '    output_kind = "boundary"\n    is_annotation = 1\n'))
    from custom_loader import scan
    [entry] = scan()
    assert entry.status == "validation_error"
    assert [e.field for e in entry.errors] == ["is_annotation"]


def test_default_detect_not_overridden(isolated_custom_dir: Path):
    write(isolated_custom_dir, "abstract.py", """
from custom_api import CustomDetector

class Abstract(CustomDetector):
    name = "abstract"
    label = "Abstract"
    output_kind = "boundary"
""")
    from custom_loader import scan
    [entry] = scan()
    assert entry.status == "validation_error"
    assert any(e.field == "detect" for e in entry.errors)


# ─── Module-level errors ─────────────────────────────────────────────────────


def test_syntax_error(isolated_custom_dir: Path):
    write(isolated_custom_dir, "broken.py", "def oops(:\n  return\n")
    from custom_loader import scan
    [entry] = scan()
    assert entry.status == "load_error"
    assert any("syntax error" in e.message for e in entry.errors)


def test_import_error_in_module(isolated_custom_dir: Path):
    write(isolated_custom_dir, "import_fail.py", """
import this_module_definitely_does_not_exist_xyz  # noqa
""")
    from custom_loader import scan
    [entry] = scan()
    assert entry.status == "load_error"


def test_no_detector_class_in_file(isolated_custom_dir: Path):
    write(isolated_custom_dir, "empty_file.py", "x = 1\n")
    from custom_loader import scan
    [entry] = scan()
    assert entry.status == "validation_error"
    assert any(e.field == "class" for e in entry.errors)


def test_two_detector_classes_in_one_file(isolated_custom_dir: Path):
    write(isolated_custom_dir, "two_classes.py", """
from custom_api import CustomDetector

class A(CustomDetector):
    name = "a"
    label = "A"
    output_kind = "boundary"

    def detect(self, ctx):
        return []

class B(CustomDetector):
    name = "b"
    label = "B"
    output_kind = "boundary"

    def detect(self, ctx):
        return []
""")
    from custom_loader import scan
    [entry] = scan()
    assert entry.status == "validation_error"
    assert any(e.field == "class" and "more than one" in e.message for e in entry.errors)


# ─── Cross-file rules ────────────────────────────────────────────────────────


def test_duplicate_names_across_files(isolated_custom_dir: Path):
    body_template = """
from custom_api import CustomDetector

class _Det(CustomDetector):
    name = "shared"
    label = "Shared"
    output_kind = "boundary"

    def detect(self, ctx):
        return []
"""
    write(isolated_custom_dir, "first.py", body_template)
    write(isolated_custom_dir, "second.py", body_template)
    from custom_loader import scan
    entries = scan()
    assert len(entries) == 2
    # Both should be flagged.
    assert all(e.status == "validation_error" for e in entries)
    assert all(any("duplicate" in err.message for err in e.errors) for e in entries)


# ─── load_detector helper ───────────────────────────────────────────────────


def test_load_detector_returns_instance(isolated_custom_dir: Path):
    write(isolated_custom_dir, "good.py", """
from custom_api import CustomDetector

class Good(CustomDetector):
    name = "good"
    label = "Good"
    output_kind = "boundary"

    def detect(self, ctx):
        return []
""")
    from custom_loader import load_detector
    inst = load_detector("good")
    assert inst.name == "good"
    assert inst.detect.__qualname__.endswith("Good.detect")


def test_load_detector_raises_on_validation_failure(isolated_custom_dir: Path):
    write(isolated_custom_dir, "bad.py", """
from custom_api import CustomDetector

class Bad(CustomDetector):
    name = ""
    label = "Bad"
    output_kind = "boundary"

    def detect(self, ctx):
        return []
""")
    from custom_loader import load_detector
    with pytest.raises(ValueError):
        load_detector("bad")


def test_load_detector_raises_on_unknown_name(isolated_custom_dir: Path):
    from custom_loader import load_detector
    with pytest.raises(ValueError):
        load_detector("does_not_exist")


# ─── Missing-module hint ─────────────────────────────────────────────────────


_MISSING_MODULE = "definitely_not_a_real_module_xyz123"


def test_missing_module_at_import_carries_hint(isolated_custom_dir: Path):
    """ModuleNotFoundError at top-level import → load_error with structured
    hint (missing_module + suggested_install) inside errors[0].value."""
    write(isolated_custom_dir, "needs_missing.py", f"""
import {_MISSING_MODULE}  # noqa: F401

from custom_api import Boundary, CustomDetector

class NeedsMissing(CustomDetector):
    name = "needs_missing"
    label = "Needs missing"
    output_kind = "boundary"

    def detect(self, ctx):
        return []
""")
    from custom_loader import scan
    entries = scan()
    assert len(entries) == 1
    e = entries[0]
    assert e.status == "load_error"
    assert len(e.errors) == 1
    hint = e.errors[0].value
    assert isinstance(hint, dict)
    assert hint["missing_module"] == _MISSING_MODULE
    assert hint["suggested_install"] == f"pip install {_MISSING_MODULE}"


def test_module_to_package_aliasing():
    """sklearn/cv2/PIL/yaml are imported under names that differ from their
    pip package — the hint surfaces the correct install command."""
    from custom_loader import missing_module_hint

    # Build a synthetic ModuleNotFoundError as if `import cv2` failed.
    exc = ModuleNotFoundError("No module named 'cv2'", name="cv2")
    hint = missing_module_hint(exc)
    assert hint == {
        "missing_module":    "cv2",
        "suggested_package": "opencv-python",
        "suggested_install": "pip install opencv-python",
    }

    exc = ModuleNotFoundError("No module named 'sklearn.cluster'", name="sklearn.cluster")
    hint = missing_module_hint(exc)
    assert hint and hint["missing_module"] == "sklearn"
    assert hint["suggested_install"] == "pip install scikit-learn"


def test_load_detector_attaches_hint_to_error(isolated_custom_dir: Path):
    """Clicking Run on a detector that imports a missing module →
    DetectorLoadError carrying the same hint so the runner can render install
    instructions in the fatal envelope."""
    write(isolated_custom_dir, "needs_missing2.py", f"""
import {_MISSING_MODULE}  # noqa: F401

from custom_api import Boundary, CustomDetector

class NeedsMissing2(CustomDetector):
    name = "needs_missing2"
    label = "Needs missing 2"
    output_kind = "boundary"

    def detect(self, ctx):
        return []
""")
    from custom_loader import load_detector, DetectorLoadError
    with pytest.raises(DetectorLoadError) as info:
        load_detector("needs_missing2")
    assert info.value.hint is not None
    assert info.value.hint["missing_module"] == _MISSING_MODULE
    assert info.value.hint["suggested_install"] == f"pip install {_MISSING_MODULE}"


# ─── custom/ over custom-default/ ────────────────────────────────────────────


def _detector_src(name: str, label: str) -> str:
    return f"""
from custom_api import CustomDetector, Boundary

class D(CustomDetector):
    name = "{name}"
    label = "{label}"
    output_kind = "boundary"

    def detect(self, ctx):
        return [Boundary(time_ms=1000)]
"""


def test_scan_includes_shipped_defaults(isolated_custom_dir):
    from custom_loader import DEFAULT_CUSTOM_DIR, scan
    write(DEFAULT_CUSTOM_DIR, "shipped.py", _detector_src("shipped", "Shipped"))
    write(isolated_custom_dir, "mine.py", _detector_src("mine", "Mine"))
    assert sorted(e.name for e in scan()) == ["mine", "shipped"]


def test_user_file_shadows_default_with_same_filename(isolated_custom_dir):
    from custom_loader import DEFAULT_CUSTOM_DIR, scan
    write(DEFAULT_CUSTOM_DIR, "shipped.py", _detector_src("shipped", "Original"))
    write(isolated_custom_dir, "shipped.py", _detector_src("shipped", "Edited"))
    entries = scan()
    assert len(entries) == 1
    assert entries[0].status == "ok"
    assert entries[0].label == "Edited"
    assert Path(entries[0].file).parent == isolated_custom_dir


def test_editing_a_default_writes_a_copy_and_leaves_the_original(isolated_custom_dir, monkeypatch):
    import custom_loader
    import custom_server
    monkeypatch.setattr(custom_server, "CUSTOM_DIR", isolated_custom_dir)
    original = write(custom_loader.DEFAULT_CUSTOM_DIR, "shipped.py", _detector_src("shipped", "Original"))

    entry = custom_server.write_script("shipped", _detector_src("shipped", "Edited"))

    assert Path(entry["file"]) == isolated_custom_dir / "shipped.py"
    assert entry["label"] == "Edited"
    assert "Original" in original.read_text()


def test_deleting_a_default_is_refused_but_its_copy_can_go(isolated_custom_dir, monkeypatch):
    import custom_loader
    import custom_server
    monkeypatch.setattr(custom_server, "CUSTOM_DIR", isolated_custom_dir)
    monkeypatch.setattr(custom_server, "TRASH_DIR", isolated_custom_dir / ".trash")
    monkeypatch.setattr(custom_server, "delete_results_for", lambda name: None)
    original = write(custom_loader.DEFAULT_CUSTOM_DIR, "shipped.py", _detector_src("shipped", "Original"))

    with pytest.raises(custom_server.ShippedDetectorError):
        custom_server.delete_script("shipped")
    assert original.is_file()

    write(isolated_custom_dir, "shipped.py", _detector_src("shipped", "Edited"))
    assert custom_server.delete_script("shipped") is not None
    [entry] = custom_loader.scan()
    assert entry.label == "Original"


# ─── review flag ─────────────────────────────────────────────────────────────


def test_review_is_off_unless_the_detector_asks(isolated_custom_dir):
    from custom_loader import scan
    write(isolated_custom_dir, "plain.py", _detector_src("plain", "Plain"))
    write(isolated_custom_dir, "asks.py", _detector_src("asks", "Asks").replace(
        '    output_kind = "boundary"\n', '    output_kind = "boundary"\n    review = True\n'))
    by_name = {e.name: e for e in scan()}
    assert by_name["plain"].review is False
    assert by_name["plain"].to_dict()["review"] is False
    assert by_name["asks"].review is True


def test_review_must_be_a_bool(isolated_custom_dir):
    from custom_loader import scan
    write(isolated_custom_dir, "typo.py", _detector_src("typo", "Typo").replace(
        '    output_kind = "boundary"\n', '    output_kind = "boundary"\n    review = \"yes\"\n'))
    [entry] = scan()
    assert entry.status == "validation_error"
    assert [e.field for e in entry.errors] == ["review"]


def test_strictness_is_offered_only_when_the_detector_asks(isolated_custom_dir):
    from custom_loader import scan
    write(isolated_custom_dir, "plain.py", _detector_src("plain", "Plain"))
    write(isolated_custom_dir, "asks.py", _detector_src("asks", "Asks").replace(
        '    output_kind = "boundary"\n', '    output_kind = "boundary"\n    strictness = True\n'))
    write(isolated_custom_dir, "typo.py", _detector_src("typo", "Typo").replace(
        '    output_kind = "boundary"\n', '    output_kind = "boundary"\n    strictness = \"loose\"\n'))
    by_name = {e.name: e for e in scan()}
    assert by_name["plain"].to_dict()["strictness"] is False
    assert by_name["asks"].to_dict()["strictness"] is True
    assert by_name["typo"].status == "validation_error"
    assert [e.field for e in by_name["typo"].errors] == ["strictness"]


def test_flags_patch_adds_missing_lines_then_flips_them(isolated_custom_dir, monkeypatch):
    import custom_server
    monkeypatch.setattr(custom_server, "CUSTOM_DIR", isolated_custom_dir)
    path = write(isolated_custom_dir, "flip.py", _detector_src("flip", "Flip"))

    entry = custom_server.patch_script_flags("flip", is_annotation=True, review=True)
    assert entry["is_annotation"] is True and entry["review"] is True
    assert '    output_kind = "boundary"\n    is_annotation = True\n    review = True\n' in path.read_text()

    entry = custom_server.patch_script_flags("flip", review=False)
    assert entry["review"] is False and entry["is_annotation"] is True
    assert path.read_text().count("review =") == 1

    # A flag left out of the call leaves the file's line alone.
    custom_server.patch_script_flags("flip", is_annotation=False)
    text = path.read_text()
    assert "    is_annotation = False\n" in text and "    review = False\n" in text


def test_flags_patch_never_anchors_inside_a_method(isolated_custom_dir, monkeypatch):
    import custom_server
    monkeypatch.setattr(custom_server, "CUSTOM_DIR", isolated_custom_dir)
    src = _detector_src("deep", "Deep").replace(
        "        return [Boundary(time_ms=1000)]\n",
        "        label = 'x'\n        return [Boundary(time_ms=1000)]\n")
    path = write(isolated_custom_dir, "deep.py", src)
    custom_server.patch_script_flags("deep", is_annotation=True)
    text = path.read_text()
    assert '    output_kind = "boundary"\n    is_annotation = True\n' in text
    assert "        label = 'x'\n        return" in text


def test_changed_generator_is_reloaded_not_served_from_cache(monkeypatch):
    """A generator edited while the server is up must not keep answering from
    the old copy — pulse failed with an ImportError between two versions of
    the `generators` package until the server was restarted."""
    import custom_loader
    pytest.importorskip("generators.common")  # private; absent from the public bundle
    import generators.common  # noqa: F401 — puts the package in sys.modules
    before = sys.modules["generators.common"]

    custom_loader._evict_stale_generators()
    assert sys.modules.get("generators.common") is before, "nothing changed, nothing evicted"

    monkeypatch.setattr(custom_loader, "_generators_loaded_at", 0.0)
    custom_loader._evict_stale_generators()
    assert "generators.common" not in sys.modules
    import generators.common as after
    assert after is not before



def test_the_registry_scan_reloads_a_changed_generator_too(monkeypatch, isolated_custom_dir: Path):
    """The sidebar's list is a scan, not a run. A generator edited while the
    server was up (a helper moved into generators.bar_grid) left the scan
    importing detectors against the old copy, and both detectors that used the
    helper showed as load errors and vanished from the sidebar."""
    import custom_loader
    pytest.importorskip("generators.common")  # private; absent from the public bundle
    import generators.common  # noqa: F401
    before = sys.modules["generators.common"]
    monkeypatch.setattr(custom_loader, "_generators_loaded_at", 0.0)
    custom_loader.scan()
    assert sys.modules.get("generators.common") is not before

STEM_PARTS_SRC = """
from custom_api import CustomDetector

class Parts(CustomDetector):
    name = "parts"
    label = "Parts"
    output_kind = "span"
    stem_parts = {stem_parts}

    def detect(self, ctx):
        return []
"""


def test_stem_parts_reach_the_registry(isolated_custom_dir: Path):
    write(isolated_custom_dir, "parts.py",
          STEM_PARTS_SRC.format(stem_parts='{"drums": ["Kick", "Snare"], "bass": ["Bass"]}'))
    from custom_loader import scan
    [entry] = scan()
    assert entry.status == "ok"
    assert entry.to_dict()["stem_parts"] == {"drums": ["Kick", "Snare"], "bass": ["Bass"]}


@pytest.mark.parametrize("bad", ['{"mix": ["All"]}', '{"drums": []}', '{"drums": "Kick"}', '["Kick"]'])
def test_malformed_stem_parts_is_validation_error(isolated_custom_dir: Path, bad: str):
    write(isolated_custom_dir, "parts.py", STEM_PARTS_SRC.format(stem_parts=bad))
    from custom_loader import scan
    [entry] = scan()
    assert entry.status == "validation_error"
    assert any(e.field == "stem_parts" for e in entry.errors)
    assert entry.stem_parts is None


# ─── duplicate / rename ──────────────────────────────────────────────────────


def _copy_env(isolated_custom_dir, monkeypatch, tmp_path):
    import custom_runner
    import custom_server
    monkeypatch.setattr(custom_server, "CUSTOM_DIR", isolated_custom_dir)
    dirs = {k: tmp_path / k for k in ("results", "annotations", "outputs")}
    monkeypatch.setattr(custom_runner, "CUSTOM_RESULTS_DIR", dirs["results"])
    monkeypatch.setattr(custom_server, "CUSTOM_ANNOTATIONS_DIR", dirs["annotations"])
    monkeypatch.setattr(custom_server, "DETECTOR_OUTPUTS_DIR", dirs["outputs"])
    return custom_server, dirs


def test_duplicate_writes_a_renamed_copy_beside_the_original(isolated_custom_dir, monkeypatch, tmp_path):
    import custom_loader
    custom_server, _ = _copy_env(isolated_custom_dir, monkeypatch, tmp_path)
    pkg = isolated_custom_dir / "band"
    pkg.mkdir()
    original = write(pkg, "kick.py", _detector_src("kick", "Kick"))

    entry = custom_server.copy_script("kick", "kick_two")

    assert Path(entry["file"]) == pkg / "kick_two.py"
    assert entry["status"] == "ok" and entry["label"] == "Kick (copy)"
    assert 'name = "kick"' in original.read_text()
    assert sorted(e.name for e in custom_loader.scan()) == ["kick", "kick_two"]


def test_duplicating_a_shipped_example_lands_in_custom(isolated_custom_dir, monkeypatch, tmp_path):
    import custom_loader
    custom_server, _ = _copy_env(isolated_custom_dir, monkeypatch, tmp_path)
    write(custom_loader.DEFAULT_CUSTOM_DIR, "shipped.py", _detector_src("shipped", "Shipped"))

    entry = custom_server.copy_script("shipped", "mine")
    assert Path(entry["file"]) == isolated_custom_dir / "mine.py"
    with pytest.raises(custom_server.ShippedDetectorError):
        custom_server.copy_script("shipped", "renamed", move=True)


def test_rename_moves_the_file_and_its_runs(isolated_custom_dir, monkeypatch, tmp_path):
    import json
    import custom_loader
    custom_server, dirs = _copy_env(isolated_custom_dir, monkeypatch, tmp_path)
    write(isolated_custom_dir, "old.py", _detector_src("old", "Old"))
    (dirs["results"] / "old").mkdir(parents=True)
    (dirs["results"] / "old" / "song.json").write_text(json.dumps({"name": "old", "items": []}))
    (dirs["outputs"] / "old" / "me").mkdir(parents=True)
    (dirs["outputs"] / "old" / "me" / "song.json").write_text(json.dumps({"name": "old"}))

    entry = custom_server.copy_script("old", "new", move=True)

    assert entry["label"] == "Old" and Path(entry["file"]).name == "new.py"
    assert not (isolated_custom_dir / "old.py").exists()
    assert [e.name for e in custom_loader.scan()] == ["new"]
    assert json.loads((dirs["results"] / "new" / "song.json").read_text())["name"] == "new"
    assert (dirs["outputs"] / "new" / "me" / "song.json").is_file()
    assert not (dirs["results"] / "old").exists()


def test_copy_refuses_a_taken_or_invalid_name(isolated_custom_dir, monkeypatch, tmp_path):
    custom_server, _ = _copy_env(isolated_custom_dir, monkeypatch, tmp_path)
    write(isolated_custom_dir, "a.py", _detector_src("a", "A"))
    write(isolated_custom_dir, "b.py", _detector_src("b", "B"))
    for bad in ("b", "a", "Bad Name", ""):
        with pytest.raises(ValueError):
            custom_server.copy_script("a", bad)


# ─── output_kind = "lanes" ───────────────────────────────────────────────────

_LANES_DETECTOR = """
from custom_api import CustomDetector, Lane

class Many(CustomDetector):
    name = "many"
    label = "Many lanes"
    output_kind = "lanes"
{extra}
    def detect(self, ctx):
        return []
"""


def test_a_lanes_detector_loads(isolated_custom_dir: Path):
    import custom_loader
    write(isolated_custom_dir, "many.py", _LANES_DETECTOR.format(extra=""))
    (entry,) = custom_loader.scan()
    assert entry.status == "ok" and entry.output_kind == "lanes"


@pytest.mark.parametrize("extra, field", [
    ("    review = True", "review"),
    ("    stem_parts = {'drums': ['Kick']}", "stem_parts"),
])
def test_a_lanes_detector_refuses_what_acts_on_one_list_of_items(
        isolated_custom_dir: Path, extra: str, field: str):
    import custom_loader
    write(isolated_custom_dir, "many.py", _LANES_DETECTOR.format(extra=extra))
    (entry,) = custom_loader.scan()
    assert entry.status == "validation_error"
    assert field in [e.field for e in entry.errors]


def test_a_lanes_detector_may_offer_strictness_sections_and_a_run_per_stem(
        isolated_custom_dir: Path):
    import custom_loader
    write(isolated_custom_dir, "many.py", _LANES_DETECTOR.format(
        extra="    strictness = True\n    windowable = True\n    is_annotation = True\n"
              "    stem = ['vocals', 'other']"))
    entries = custom_loader.scan()
    assert {e.name for e in entries} == {"many__vocals", "many__other"}
    assert all(e.status == "ok" and e.strictness and e.windowable and e.is_annotation
               for e in entries)
