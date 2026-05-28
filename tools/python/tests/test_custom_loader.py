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
    """Redirect CUSTOM_DIR to tmp_path for the duration of a test."""
    import custom_loader
    monkeypatch.setattr(custom_loader, "CUSTOM_DIR", tmp_path)
    return tmp_path


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
    is_algorithm = True

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
    is_algorithm = True

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
    is_algorithm = True

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
    is_algorithm = True

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
    is_algorithm = True

    def detect(self, ctx):
        return []
""")
    from custom_loader import scan
    [entry] = scan()
    assert entry.status == "validation_error"
    assert any(e.field == "output_kind" for e in entry.errors)


def test_no_surfacing_flag(isolated_custom_dir: Path):
    write(isolated_custom_dir, "invisible.py", """
from custom_api import CustomDetector

class Invisible(CustomDetector):
    name = "invisible"
    label = "Invisible"
    output_kind = "boundary"
    is_algorithm = False
    is_annotation = False

    def detect(self, ctx):
        return []
""")
    from custom_loader import scan
    [entry] = scan()
    assert entry.status == "validation_error"
    assert any("is_algorithm" in (e.field or "") for e in entry.errors)


def test_default_detect_not_overridden(isolated_custom_dir: Path):
    write(isolated_custom_dir, "abstract.py", """
from custom_api import CustomDetector

class Abstract(CustomDetector):
    name = "abstract"
    label = "Abstract"
    output_kind = "boundary"
    is_algorithm = True
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
    is_algorithm = True

    def detect(self, ctx):
        return []

class B(CustomDetector):
    name = "b"
    label = "B"
    output_kind = "boundary"
    is_algorithm = True

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
    is_algorithm = True

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
    is_algorithm = True

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
    is_algorithm = True

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
    is_algorithm = True

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
    is_algorithm = True

    def detect(self, ctx):
        return []
""")
    from custom_loader import load_detector, DetectorLoadError
    with pytest.raises(DetectorLoadError) as info:
        load_detector("needs_missing2")
    assert info.value.hint is not None
    assert info.value.hint["missing_module"] == _MISSING_MODULE
    assert info.value.hint["suggested_install"] == f"pip install {_MISSING_MODULE}"
