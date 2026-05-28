#!/usr/bin/env python3
"""
Spotify basic-pitch polyphonic note transcription server. Emits CUE-family
items where each cue is the onset of a transcribed note, labelled with the
MIDI pitch name (e.g. "C4", "F#3"). Lives in its own sidecar for install
isolation — basic-pitch ships an ONNX runtime bundle (~5 MB) inside the pip
package, no separate weight download needed at runtime.

Detector
--------
  basic-pitch   Spotify basic-pitch (2022). Apache 2.0. Pure CPU; same
                ONNX model on every architecture. Output: list of note
                events (start, end, pitch, amplitude).

Endpoints
---------
  GET  /api/pitch/health             → server up + dep availability
  GET  /api/pitch/algorithms         → [{ id, name, available, description }]
  GET  /api/pitch/detect/:slug/:algo → cached result, or null
  POST /api/pitch/detect             { slug, algo, force? }
  POST /api/pitch/initialize         { algo }  — warm the ONNX runtime

Output schema
-------------
  {
    "slug":        str,
    "audio_file":  str,
    "algorithm":   str,
    "duration":    float,
    "notes": [
      {
        "time":       float,   # note onset (seconds)
        "end":        float,   # note offset
        "midi":       int,     # MIDI pitch number (0..127)
        "pitch":      str,     # human-readable, e.g. "C4"
        "amplitude":  float    # 0..1, peak velocity-style value
      }
    ],
    "ms":          int,
    "computed_at": str
  }

Cache
-----
  data/algorithm-outputs/pitch/<slug>/<algo>.json
"""

from __future__ import annotations

import json
import sys
import warnings
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

warnings.filterwarnings("ignore")

PORT = 8011

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import find_audio, PITCH_OUTPUTS_DIR as CACHE_DIR  # noqa: E402

CACHE_DIR.mkdir(parents=True, exist_ok=True)

try:
    import numpy as np  # noqa: F401
    _NUMPY_OK = True
except ImportError:
    _NUMPY_OK = False

try:
    import basic_pitch  # noqa: F401
    _BASIC_PITCH_OK = True
except Exception:
    _BASIC_PITCH_OK = False


_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def midi_to_name(midi: int) -> str:
    if midi < 0 or midi > 127:
        return "?"
    octave = (midi // 12) - 1
    return f"{_NOTE_NAMES[midi % 12]}{octave}"


def _time_ms(t0_ms: float) -> int:
    return int((datetime.now().timestamp() * 1000) - t0_ms)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _err(algo: str, msg: str) -> dict:
    return {"algorithm": algo, "ok": False, "error": msg, "notes": []}


# basic-pitch's predict() is module-level — there's no model class to cache
# across calls, but the underlying ONNX session is reused. We pre-import the
# heavy modules on first call so the cold-start cost is paid once.
_basic_pitch_predict = None


def _ensure_basic_pitch():
    global _basic_pitch_predict
    if _basic_pitch_predict is not None:
        return
    from basic_pitch.inference import predict
    _basic_pitch_predict = predict


def detect_basic_pitch(audio_path: Path) -> dict:
    algo = "basic-pitch"
    if not (_BASIC_PITCH_OK and _NUMPY_OK):
        return _err(algo, "basic_pitch / numpy not installed")
    t0 = datetime.now().timestamp() * 1000
    try:
        _ensure_basic_pitch()
        # basic_pitch.inference.predict accepts a file path and returns
        # (model_output, midi_data, note_events).
        # note_events is a list of tuples (start_time, end_time, pitch_midi, amplitude, pitch_bends).
        _model_output, _midi_data, note_events = _basic_pitch_predict(str(audio_path))  # type: ignore[misc]
        notes = []
        max_end = 0.0
        for ev in note_events:
            start_t = float(ev[0])
            end_t   = float(ev[1])
            midi    = int(ev[2])
            amp     = float(ev[3])
            notes.append({
                "time":      start_t,
                "end":       end_t,
                "midi":      midi,
                "pitch":     midi_to_name(midi),
                "amplitude": amp,
            })
            if end_t > max_end:
                max_end = end_t
        notes.sort(key=lambda n: n["time"])
        return {
            "algorithm": algo,
            "ok":        True,
            "notes":     notes,
            "duration":  max_end,
            "ms":        _time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


ALGORITHMS = {
    "basic-pitch": {
        "name":        "basic-pitch (Spotify)",
        "description": "Polyphonic note transcription. ONNX runtime bundled with the pip package — no separate weight download.",
        "detect":      detect_basic_pitch,
        "available":   lambda: _BASIC_PITCH_OK and _NUMPY_OK,
    },
}


def detect_one(slug: str, algo: str, force: bool = False) -> dict:
    if algo not in ALGORITHMS:
        raise ValueError(f"unknown algorithm: {algo}")
    cache_dir = CACHE_DIR / slug
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{algo}.json"
    if cache_path.exists() and not force:
        return json.loads(cache_path.read_text())
    audio_path = find_audio(slug)
    if audio_path is None:
        raise FileNotFoundError(f"audio not found for slug: {slug}")
    result = ALGORITHMS[algo]["detect"](audio_path)
    payload = {
        "slug":        slug,
        "audio_file":  audio_path.name,
        "algorithm":   algo,
        "duration":    result.get("duration", 0.0),
        "notes":       result.get("notes", []),
        "ok":          result.get("ok", False),
        "error":       result.get("error"),
        "ms":          result.get("ms", 0),
        "computed_at": _now_iso(),
    }
    try:
        cache_path.write_text(json.dumps(payload, indent=2))
    except Exception:
        pass
    return payload


def _cors():
    return {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        code = str(args[1]) if len(args) > 1 else "???"
        if not code.isdigit() or int(code) >= 400:
            super().log_message(fmt, *args)

    def _send(self, code: int, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        for k, v in _cors().items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in _cors().items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/pitch/health":
            self._send(200, {
                "ok":             _BASIC_PITCH_OK and _NUMPY_OK,
                "basicPitchOk":   _BASIC_PITCH_OK,
                "numpyOk":        _NUMPY_OK,
            })
            return
        if path == "/api/pitch/algorithms":
            self._send(200, [
                {"id": k, "name": v["name"], "description": v["description"], "available": bool(v["available"]())}
                for k, v in ALGORITHMS.items()
            ])
            return
        if path.startswith("/api/pitch/detect/"):
            tail = path[len("/api/pitch/detect/"):].split("/")
            if len(tail) != 2:
                self._send(400, {"error": "expected /api/pitch/detect/<slug>/<algo>"})
                return
            slug, algo = tail
            cache_path = CACHE_DIR / slug / f"{algo}.json"
            self._send(200, json.loads(cache_path.read_text()) if cache_path.exists() else None)
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError as e:
            self._send(400, {"error": f"invalid JSON: {e}"})
            return
        if path == "/api/pitch/detect":
            slug = str(body.get("slug", "")).strip()
            algo = str(body.get("algo", "")).strip()
            force = bool(body.get("force", False))
            if not slug or not algo:
                self._send(400, {"error": "slug and algo are required"})
                return
            try:
                self._send(200, detect_one(slug, algo, force=force))
            except FileNotFoundError as e:
                self._send(404, {"error": str(e)})
            except ValueError as e:
                self._send(400, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": f"detection failed: {type(e).__name__}: {e}"})
            return
        if path == "/api/pitch/initialize":
            algo = str(body.get("algo", "")).strip()
            if algo not in ALGORITHMS:
                self._send(400, {"error": f"unknown algorithm: {algo}"})
                return
            try:
                if not ALGORITHMS[algo]["available"]():
                    self._send(503, {"ok": False, "error": "basic_pitch deps missing"})
                    return
                _ensure_basic_pitch()
                self._send(200, {"ok": True, "algorithm": algo})
            except Exception as e:
                self._send(500, {"ok": False, "error": f"init failed: {type(e).__name__}: {e}"})
            return
        self._send(404, {"error": "not found"})


def main():
    import os
    host = os.environ.get("HOST", "localhost")
    print(f"Starting basic-pitch server on http://{host}:{PORT}", file=sys.stderr)
    print(f"  basic_pitch={_BASIC_PITCH_OK}  numpy={_NUMPY_OK}", file=sys.stderr)
    HTTPServer((host, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
