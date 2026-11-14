"""Read a layers file as seconds, whatever it stores.

A layers file saved under Grid Lock stores a stamped item by its musical
position alone (`timebase: "beats"`): `beat`, or `startBeat` / `endBeat`, and
no `time` / `start` / `end`. Its `grid.tempoMap` is what turns a beat back into
a second. Python never needs to know: every reader of a layers file goes
through `with_seconds` (or `read_layers`) and sees the seconds it always saw.

Twin of web-app/src/utils/beatTimebase.ts (`withSecondsFromBeats` on the
file's own grid) — keep the two in step. Lyrics are never stamped and keep
their seconds; so do the fields that describe the sound (decay, envelope).
In a beats file an item that DOES carry seconds was written by a tool that
does not speak beats (an external sync tool), so its seconds win.
"""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path

#: Every snap the grid offers (1/2, 1/3, 1/4, 1/6, 1/8 beat) is a whole number
#: of these steps. Mirrors BEAT_FRACTION_STEPS in utils/beatAnchoring.ts.
BEAT_FRACTION_STEPS = 24


def _finite(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _tempo_map(doc: dict) -> list[dict] | None:
    m = ((doc.get("grid") or {}).get("tempoMap")) or []
    ok = [e for e in m if isinstance(e, dict) and _finite(e.get("beat")) and _finite(e.get("time"))
          and _finite(e.get("bpm")) and e["bpm"] > 0]
    return ok if ok and len(ok) == len(m) else None


def beat_to_seconds(tempo_map: list[dict], beat: float) -> float:
    e = tempo_map[0]
    for x in tempo_map:
        if beat >= x["beat"]:
            e = x
        else:
            break
    return round(e["time"] + (beat - e["beat"]) * 60.0 / e["bpm"], 3)


def seconds_to_beat(tempo_map: list[dict], t: float) -> float:
    e = tempo_map[0]
    for x in tempo_map:
        if t >= x["time"] - 1e-6:
            e = x
        else:
            break
    per_sec = e["bpm"] / 60.0
    b = e["beat"] + (t - e["time"]) * per_sec
    step = round(b * BEAT_FRACTION_STEPS) / BEAT_FRACTION_STEPS
    return step if abs(step - b) <= 0.001 * per_sec else round(b, 6)


def _candidates(c, f):
    if not isinstance(c, list):
        return c
    return [[f(v[0]), f(v[1])] if isinstance(v, list) else f(v) for v in c]


def with_seconds(doc):
    """`doc` with seconds on every item. A seconds file comes back as it is;
    a beats file comes back as a new dict (the input is not changed). Raises
    ValueError on a beats file with no tempo map — marks with no place."""
    if not isinstance(doc, dict) or doc.get("timebase") != "beats":
        return doc
    tm = _tempo_map(doc)
    if tm is None:
        raise ValueError("layers file stores beats but carries no grid")
    out = copy.deepcopy(doc)
    sec = lambda b: max(0.0, beat_to_seconds(tm, b))  # noqa: E731
    for layer in out.get("layers") or []:
        if not isinstance(layer, dict) or layer.get("type") == "lyrics":
            continue
        for it in layer.get("items") or []:
            if not isinstance(it, dict):
                continue
            if _finite(it.get("beat")):
                if _finite(it.get("time")):
                    it["beat"] = seconds_to_beat(tm, it["time"])
                    continue
                it["time"] = sec(it["beat"])
                if "candidates" in it:
                    it["candidates"] = _candidates(it["candidates"], sec)
            elif _finite(it.get("startBeat")):
                if _finite(it.get("start")):
                    it["startBeat"] = seconds_to_beat(tm, it["start"])
                    if _finite(it.get("end")):
                        it["endBeat"] = seconds_to_beat(tm, it["end"])
                    continue
                it["start"] = sec(it["startBeat"])
                it["end"] = max(sec(it["endBeat"]), it["start"]) if _finite(it.get("endBeat")) else it["start"]
                if "candidates" in it:
                    it["candidates"] = _candidates(it["candidates"], sec)
    return out


def read_layers(path: Path):
    """json.loads + with_seconds, for a layers file on disk."""
    return with_seconds(json.loads(Path(path).read_text()))
