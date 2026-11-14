"""A detector run once per stem: `stem = ["vocals", "other"]`.

The loader registers one entry per stem, `<name>__<stem>` ("mix" keeps the
bare name), so everything keyed by detector name — the result cache, lanes,
annotations, the batch runner — treats each stem as its own detector. Each
run is told its stem in `ctx.stem`. The file is still addressed by the name
written in it, which is what the editor saves, renames and deletes by.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

from custom_api import DetectionContext  # noqa: E402


def _src(stem: str, name: str = "trade", extra: str = "") -> str:
    return f'''
from custom_api import CustomDetector, Span

class Trade(CustomDetector):
    name = "{name}"
    label = "Trade"
    output_kind = "span"
    stem = {stem}
{extra}
    def detect(self, ctx):
        return []
'''


@pytest.fixture
def custom_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import custom_loader
    user, default = tmp_path / "custom", tmp_path / "custom-default"
    user.mkdir()
    default.mkdir()
    monkeypatch.setattr(custom_loader, "CUSTOM_DIR", user)
    monkeypatch.setattr(custom_loader, "DEFAULT_CUSTOM_DIR", default)
    return user


@pytest.fixture
def server(custom_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import custom_runner
    import custom_server
    monkeypatch.setattr(custom_server, "CUSTOM_DIR", custom_dir)
    monkeypatch.setattr(custom_server, "TRASH_DIR", custom_dir / ".trash")
    dirs = {k: tmp_path / k for k in ("results", "annotations", "outputs")}
    monkeypatch.setattr(custom_runner, "CUSTOM_RESULTS_DIR", dirs["results"])
    monkeypatch.setattr(custom_server, "CUSTOM_ANNOTATIONS_DIR", dirs["annotations"])
    monkeypatch.setattr(custom_server, "DETECTOR_OUTPUTS_DIR", dirs["outputs"])
    return custom_server, dirs


def _scan():
    from custom_loader import scan
    return {e.name: e for e in scan()}


# ─── Registry ────────────────────────────────────────────────────────────────


def test_a_stem_list_registers_one_detector_per_stem(custom_dir: Path):
    (custom_dir / "trade.py").write_text(_src('["vocals", "other"]'))
    entries = _scan()
    assert sorted(entries) == ["trade__other", "trade__vocals"]
    for stem in ("vocals", "other"):
        e = entries[f"trade__{stem}"]
        assert e.status == "ok"
        assert e.stem == stem
        d = e.to_dict()
        assert d["base_name"] == "trade"
        assert d["stems"] == ["vocals", "other"]


def test_mix_in_the_list_keeps_the_bare_name(custom_dir: Path):
    (custom_dir / "trade.py").write_text(_src('["mix", "vocals"]'))
    entries = _scan()
    assert sorted(entries) == ["trade", "trade__vocals"]
    assert entries["trade"].stem == "mix"


def test_a_single_stem_is_unchanged(custom_dir: Path):
    (custom_dir / "trade.py").write_text(_src('"vocals"'))
    [(name, e)] = _scan().items()
    assert name == "trade" and e.stem == "vocals"
    assert e.to_dict()["base_name"] == "trade" and e.to_dict()["stems"] is None


def test_one_lane_read_from_several_stems_is_filed_under_stems(custom_dir: Path):
    """Pulse reads drums, bass, other … into one lane and never the mix: it is
    filed under "stems", not under "mix" nor under any one of its stems."""
    (custom_dir / "trade.py").write_text(
        _src('"stems"', extra='    stem_parts = {"drums": ["Kick"], "bass": ["Bass"]}\n'))
    [(name, e)] = _scan().items()
    assert name == "trade" and e.status == "ok" and e.stem == "stems"


@pytest.mark.parametrize("bad", ['["stems", "vocals"]', '{"stems": ["Kick"]}'])
def test_stems_is_a_filing_not_a_stem_to_run_on(custom_dir: Path, bad: str):
    """Never in a per-stem list, never a key of stem_parts: there is no
    "stems" audio to read."""
    stem, extra = (bad, "") if bad.startswith("[") else ('"stems"', f"    stem_parts = {bad}\n")
    (custom_dir / "trade.py").write_text(_src(stem, extra=extra))
    [e] = _scan().values()
    assert e.status == "validation_error"


@pytest.mark.parametrize("bad", ['[]', '["vocals", "vox"]', '["vocals", "vocals"]', '["vocals", 3]', '{"vocals"}'])
def test_a_bad_stem_list_is_a_validation_error(custom_dir: Path, bad: str):
    (custom_dir / "trade.py").write_text(_src(bad))
    [e] = _scan().values()
    assert e.status == "validation_error"
    assert any(err.field == "stem" for err in e.errors)


def test_a_stem_list_cannot_combine_with_stem_parts(custom_dir: Path):
    (custom_dir / "trade.py").write_text(
        _src('["vocals", "other"]', extra='    stem_parts = {"drums": ["Kick"]}\n'))
    [e] = _scan().values()
    assert e.status == "validation_error"
    assert any("stem_parts" in err.message for err in e.errors)


def test_a_name_too_long_to_carry_a_stem_suffix_is_refused(custom_dir: Path):
    long_name = "a" * 28                     # fits alone, not as <name>__vocals
    (custom_dir / "trade.py").write_text(_src('["vocals", "other"]', name=long_name))
    [e] = _scan().values()
    assert e.status == "validation_error"
    assert any(err.field == "name" and "too long" in err.message for err in e.errors)


# ─── A run is told its stem ──────────────────────────────────────────────────


def _ctx() -> DetectionContext:
    return DetectionContext(
        audio=np.zeros(10, dtype=np.float32), sr=22050, duration_ms=1, stems={},
        features=None, energy_curve=np.zeros(1), tension_curve=np.zeros(1),
        bpm=120.0, beat_times_ms=[],
    )


def test_each_run_sees_its_own_stem(custom_dir: Path):
    import custom_runner
    from custom_loader import load_detector
    (custom_dir / "trade.py").write_text(_src('["mix", "vocals", "other"]'))
    for name, want in (("trade", None), ("trade__vocals", "vocals"), ("trade__other", "other")):
        detector = load_detector(name)
        assert custom_runner._apply_stem(detector, _ctx()).stem == want


def test_a_single_stem_detector_sees_its_stem_too(custom_dir: Path):
    import custom_runner
    from custom_loader import load_detector
    (custom_dir / "trade.py").write_text(_src('"bass"'))
    assert custom_runner._apply_stem(load_detector("trade"), _ctx()).stem == "bass"


def test_a_several_stems_detector_runs_for_no_single_stem(custom_dir: Path):
    import custom_runner
    from custom_loader import load_detector
    (custom_dir / "trade.py").write_text(_src('"stems"'))
    assert custom_runner._apply_stem(load_detector("trade"), _ctx()).stem is None


# ─── The file is addressed by the name written in it ─────────────────────────


def test_saving_by_the_file_name_rewrites_that_file(custom_dir: Path, server):
    custom_server, _ = server
    pkg = custom_dir / "band"
    pkg.mkdir()
    path = pkg / "trade.py"
    path.write_text(_src('["vocals", "other"]'))

    entry = custom_server.write_script("trade", _src('["vocals", "other", "guitar"]'))

    assert Path(entry["file"]) == path, "a save must not create a second trade.py"
    assert not (custom_dir / "trade.py").exists()
    assert sorted(_scan()) == ["trade__guitar", "trade__other", "trade__vocals"]
    assert custom_server.read_script("trade") == _src('["vocals", "other", "guitar"]')


def test_rename_carries_every_stem_s_runs(custom_dir: Path, server):
    custom_server, dirs = server
    (custom_dir / "old.py").write_text(_src('["vocals", "other"]', name="old"))
    for run in ("old__vocals", "old__other"):
        (dirs["results"] / run).mkdir(parents=True)
        (dirs["results"] / run / "song.json").write_text(json.dumps({"name": run, "items": []}))

    custom_server.copy_script("old", "new", move=True)

    assert sorted(_scan()) == ["new__other", "new__vocals"]
    for stem in ("vocals", "other"):
        moved = dirs["results"] / f"new__{stem}" / "song.json"
        assert json.loads(moved.read_text())["name"] == f"new__{stem}"
        assert not (dirs["results"] / f"old__{stem}").exists()


def test_delete_wipes_every_stem_s_runs(custom_dir: Path, server):
    custom_server, dirs = server
    (custom_dir / "trade.py").write_text(_src('["vocals", "other"]'))
    for run in ("trade__vocals", "trade__other"):
        (dirs["results"] / run).mkdir(parents=True)
        (dirs["results"] / run / "song.json").write_text("{}")

    assert custom_server.delete_script("trade") is not None
    assert _scan() == {}
    assert not any((dirs["results"] / run).exists() for run in ("trade__vocals", "trade__other"))
