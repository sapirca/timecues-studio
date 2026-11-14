"""Switches: yes/no facts about the song a detector declares and the annotator
ticks on its row ("The bass leads this song"). The runner hands them to the
run on ctx.switches, records them on the result, and — a switch being a fact
about the song — keeps the last result's when a run does not mention them."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

from custom_api import DetectionContext  # noqa: E402
from custom_runner import _apply_switches  # noqa: E402

DETECTOR = SimpleNamespace(switches={"bass_leads": "The bass leads this song", "live": "Live set"})


def _ctx() -> DetectionContext:
    z = np.zeros(1, dtype=np.float32)
    return DetectionContext(audio=z, sr=22050, duration_ms=0, stems={}, features=None,
                            energy_curve=z, tension_curve=z, bpm=120.0, beat_times_ms=[])


def test_the_ticked_ones_reach_the_run_and_the_result():
    env: dict = {}
    ctx = _apply_switches(DETECTOR, _ctx(), env, {"bass_leads"}, None)
    assert ctx.switches == {"bass_leads": True, "live": False}
    assert env["switches"] == ctx.switches


def test_a_run_that_names_none_keeps_the_songs_last():
    env: dict = {}
    last = {"switches": {"bass_leads": True, "live": False}}
    ctx = _apply_switches(DETECTOR, _ctx(), env, None, last)
    assert ctx.switches == {"bass_leads": True, "live": False}


def test_naming_none_ticked_unticks_them():
    env: dict = {}
    last = {"switches": {"bass_leads": True}}
    ctx = _apply_switches(DETECTOR, _ctx(), env, set(), last)
    assert ctx.switches == {"bass_leads": False, "live": False}


def test_a_name_the_detector_does_not_declare_is_ignored():
    env: dict = {}
    ctx = _apply_switches(DETECTOR, _ctx(), env, {"nonsense"}, None)
    assert ctx.switches == {"bass_leads": False, "live": False}


def test_a_detector_without_switches_records_nothing():
    env: dict = {}
    ctx = _apply_switches(SimpleNamespace(), _ctx(), env, {"bass_leads"}, None)
    assert ctx.switches == {} and "switches" not in env
