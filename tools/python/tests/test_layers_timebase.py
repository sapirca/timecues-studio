"""A Grid Lock layers file stores beats alone; Python readers see seconds.

Mirrors web-app/src/utils/beatTimebase.test.ts for the read side.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from layers_timebase import read_layers, seconds_to_beat, with_seconds  # noqa: E402

# 128 BPM from 0.137 s; a split at beat 64 to 140 BPM (30.137 s).
GRID = {"bpm": 128, "gridOffset": 0.137, "timeSignature": "4/4", "beatsPerBar": 4,
        "gridMode": "mapped",
        "tempoMap": [{"beat": 0, "time": 0.137, "bpm": 128}, {"beat": 64, "time": 30.137, "bpm": 140}]}


def beats_doc():
    return {
        "song": "s", "timebase": "beats", "grid": GRID,
        "layers": [
            {"id": "B", "type": "boundaries", "items": [{"id": "b1", "beat": 0, "label": "intro"},
                                                         {"id": "b2", "beat": 64.5, "label": "drop"}]},
            {"id": "C", "type": "cues", "items": [{"id": "c1", "beat": 12.375, "candidates": [12.5]}]},
            {"id": "S", "type": "spans", "items": [{"id": "s1", "startBeat": 16.25, "endBeat": 20.5}]},
            {"id": "L", "type": "lyrics", "items": [{"id": "w1", "time": 3.21, "end": 3.5, "text": "hey"}]},
        ],
    }


def items(doc, layer_id):
    return next(L for L in doc["layers"] if L["id"] == layer_id)["items"]


def test_beats_become_seconds_on_the_files_own_grid():
    doc = with_seconds(beats_doc())
    b1, b2 = items(doc, "B")
    assert b1["time"] == 0.137
    assert b2["time"] == round(30.137 + 0.5 * 60 / 140, 3)          # past the split: 140 BPM
    c1 = items(doc, "C")[0]
    assert c1["time"] == round(0.137 + 12.375 * 60 / 128, 3)
    assert c1["candidates"] == [round(0.137 + 12.5 * 60 / 128, 3)]
    assert c1["beat"] == 12.375                                        # the annotation, kept
    s1 = items(doc, "S")[0]
    assert (s1["start"], s1["end"]) == (round(0.137 + 16.25 * 60 / 128, 3), round(0.137 + 20.5 * 60 / 128, 3))


def test_lyrics_keep_their_seconds_and_the_input_is_not_changed():
    raw = beats_doc()
    doc = with_seconds(raw)
    assert items(doc, "L")[0] == {"id": "w1", "time": 3.21, "end": 3.5, "text": "hey"}
    assert "time" not in items(raw, "C")[0]


def test_a_seconds_file_is_returned_as_it_is():
    doc = {"song": "s", "layers": [{"type": "cues", "items": [{"time": 1.0, "beat": 2.0}]}]}
    assert with_seconds(doc) is doc


def test_seconds_written_by_a_seconds_only_tool_win():
    raw = beats_doc()
    items(raw, "C")[0]["time"] = 10.0                                  # an external tool moved it
    c1 = items(with_seconds(raw), "C")[0]
    assert c1["time"] == 10.0
    assert c1["beat"] == seconds_to_beat(GRID["tempoMap"], 10.0)


def test_a_beats_file_with_no_grid_is_refused():
    raw = beats_doc()
    del raw["grid"]
    with pytest.raises(ValueError, match="no grid"):
        with_seconds(raw)


def test_the_fraction_comes_back_exactly():
    tm = GRID["tempoMap"]
    t = round(0.137 + 12.375 * 60 / 128, 3)                           # stored to the ms
    assert seconds_to_beat(tm, t) == 12.375


def test_read_layers(tmp_path):
    f = tmp_path / "s.json"
    f.write_text(json.dumps(beats_doc()))
    assert items(read_layers(f), "B")[0]["time"] == 0.137
