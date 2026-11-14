"""Strictness 0 (Strict) … 100 (Loose): what the runner hands a detector, and
what it caches.

Audio-free: a run that gets past the cache stops at the audio stack (switched
off here), so whether a cached result was served or a new run was started is
all these check.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

import custom_runner  # noqa: E402
from custom_api import DetectionContext, strictness_level  # noqa: E402


def _ctx() -> DetectionContext:
    return DetectionContext(audio=None, sr=22050, duration_ms=1000, stems={}, features=None,
                            energy_curve=None, tension_curve=None, bpm=120.0, beat_times_ms=[])


def test_a_detector_that_offers_it_gets_the_pick_and_the_envelope_records_it():
    env: dict = {}
    ctx = custom_runner._apply_strictness(SimpleNamespace(strictness=True), _ctx(), env, 70)
    assert ctx.strictness == 70 and env["strictness"] == 70


def test_no_pick_is_normal():
    env: dict = {}
    ctx = custom_runner._apply_strictness(SimpleNamespace(strictness=True), _ctx(), env, None)
    assert ctx.strictness == 50 and env["strictness"] == 50


def test_a_detector_that_does_not_offer_it_runs_as_it_always_has():
    env: dict = {}
    ctx = custom_runner._apply_strictness(SimpleNamespace(strictness=False), _ctx(), env, 100)
    assert ctx.strictness == 50 and "strictness" not in env


def test_names_numbers_and_numeric_strings_are_one_scale():
    assert [strictness_level(v) for v in ("strict", "normal", "loose", None, "70", 72.4)] \
        == [0, 50, 100, 50, 70, 72]


@pytest.mark.parametrize("bad", ["lax", -1, 101, "nan", True])
def test_an_unknown_level_is_refused(bad):
    with pytest.raises(ValueError):
        custom_runner.run("pulse", "song", strictness=bad)


@pytest.fixture
def cached(monkeypatch, tmp_path):
    """A cached result on disk, and an audio stack that is off — so a cache
    miss comes back as the ImportError envelope instead of a real run."""
    def put(envelope: dict) -> None:
        monkeypatch.setattr(custom_runner, "result_path", lambda name, slug: tmp_path / "r.json")
        monkeypatch.setattr(custom_runner, "cached_result", lambda *a, **k: envelope)
        monkeypatch.setattr(custom_runner, "_AUDIO_OK", False)
        monkeypatch.setattr(custom_runner, "_AUDIO_ERR", "off in this test")
        monkeypatch.setattr(custom_runner, "_persist", lambda env, path: None)
    return put


def served(env: dict) -> bool:
    return not env.get("fatal")


def test_the_cached_result_is_served_at_its_own_strictness(cached):
    cached({"name": "pulse", "strictness": 70, "items": [], "fatal": None})
    assert served(custom_runner.run("pulse", "song", strictness=70))
    assert served(custom_runner.run("pulse", "song", strictness="70"))
    assert served(custom_runner.run("pulse", "song"))


def test_another_strictness_is_a_new_run(cached):
    cached({"name": "pulse", "strictness": 70, "items": [], "fatal": None})
    assert not served(custom_runner.run("pulse", "song", strictness=75))


def test_a_result_from_before_the_slider_counts_as_its_number(cached):
    cached({"name": "pulse", "strictness": "loose", "items": [], "fatal": None})
    assert served(custom_runner.run("pulse", "song", strictness=100))
    assert not served(custom_runner.run("pulse", "song", strictness=90))


def test_a_result_from_before_the_choice_counts_as_normal(cached):
    cached({"name": "pulse", "items": [], "fatal": None})
    assert served(custom_runner.run("pulse", "song", strictness="normal"))
    assert served(custom_runner.run("pulse", "song", strictness=50))
    assert not served(custom_runner.run("pulse", "song", strictness="loose"))
