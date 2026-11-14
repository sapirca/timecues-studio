"""Deleting one lane of a "lanes" detector's cached output, keeping the rest."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

import custom_runner  # noqa: E402
from custom_runner import drop_lane  # noqa: E402


def lane(lane_id, label, n):
    return {"id": lane_id, "label": label, "output_kind": "lyrics", "group": "Sounds",
            "items": [{"time_ms": i * 1000, "end_ms": i * 1000 + 500, "text": "la"} for i in range(n)]}


@pytest.fixture
def cache(monkeypatch, tmp_path):
    """One song's cached output, read and written in memory."""
    store = {"env": {"name": "sounds", "slug": "song", "output_kind": "lanes", "items": [],
                     "lanes": [lane("voice", "Voice", 3), lane("animal", "Animals", 2)],
                     "stats": {"accepted": 5, "rejected": 0}}}
    written = []
    monkeypatch.setattr(custom_runner, "get_cached", lambda name, slug: store["env"])
    monkeypatch.setattr(custom_runner, "result_path", lambda name, slug: tmp_path / f"{name}-{slug}.json")
    monkeypatch.setattr(custom_runner, "_persist", lambda env, path: written.append((env, path)))
    return store, written


def test_drops_the_lane_and_keeps_the_rest(cache):
    _, written = cache
    env = drop_lane("sounds", "song", "voice")
    assert [l["id"] for l in env["lanes"]] == ["animal"]
    assert env["stats"] == {"accepted": 2, "rejected": 0}
    assert [d["id"] for d in env["dropped_lanes"]] == ["voice"]
    assert env["dropped_lanes"][0]["label"] == "Voice"
    assert written and written[0][0] is env


def test_unknown_lane_writes_nothing(cache):
    _, written = cache
    with pytest.raises(LookupError):
        drop_lane("sounds", "song", "music")
    assert written == []


def test_a_detector_without_lanes_is_refused(cache):
    store, written = cache
    store["env"] = {"name": "x", "output_kind": "cue", "items": [{"time_ms": 0}]}
    with pytest.raises(LookupError):
        drop_lane("x", "song", "voice")
    store["env"] = None
    with pytest.raises(LookupError):
        drop_lane("x", "song", "voice")
    assert written == []


# ─── A part lane: some of one list's items ───────────────────────────────────


def test_drop_items_keeps_the_rest_and_maps_them(monkeypatch, tmp_path):
    items = [{"start_ms": i, "label": lab} for i, lab in enumerate(["Kick", "Snare", "Kick", "Hat"])]
    monkeypatch.setattr(custom_runner, "get_cached",
                        lambda n, s: {"output_kind": "span", "items": list(items)})
    monkeypatch.setattr(custom_runner, "result_path", lambda n, s: tmp_path / "x.json")
    written = []
    monkeypatch.setattr(custom_runner, "_persist", lambda env, path: written.append(env))
    env, remap, base = custom_runner.drop_items("pulse", "song", [0, 2])
    assert [it["label"] for it in env["items"]] == ["Snare", "Hat"]
    assert remap == {1: 0, 3: 1}
    assert base == items and written
    with pytest.raises(LookupError):
        custom_runner.drop_items("pulse", "song", [9])
