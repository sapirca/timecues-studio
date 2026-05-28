#!/usr/bin/env python3
"""
HPSS percussive-span detector. SPAN-family — emits intervals where the
percussive component of the song's audio is above an energy threshold,
giving a "drums are playing here" view that complements Silero-VAD's
voicing view.

Pure-DSP: librosa.effects.hpss + a threshold on the percussive RMS curve.
No model weights. Same image footprint as the loop sidecar.

Detector
--------
  hpss-percussive   Harmonic-percussive source separation + energy
                    threshold + minimum-duration filter.

Endpoints
---------
  GET  /api/percussive/health             → server up + librosa availability
  GET  /api/percussive/algorithms         → [{ id, name, available, description }]
  GET  /api/percussive/detect/:slug/:algo → cached result, or null
  POST /api/percussive/detect             { slug, algo, force? }

Output schema
-------------
  Same shape as span_server — `spans` list with start/end/label/confidence.

Cache
-----
  data/algorithm-outputs/percussive/<slug>/<algo>.json
"""

from __future__ import annotations

import json
import sys
import warnings
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

warnings.filterwarnings("ignore")

PORT = 8015

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import find_audio, PERCUSSIVE_OUTPUTS_DIR as CACHE_DIR  # noqa: E402

CACHE_DIR.mkdir(parents=True, exist_ok=True)

try:
    import numpy as np
    _NUMPY_OK = True
except ImportError:
    _NUMPY_OK = False

try:
    import librosa
    _LIBROSA_OK = True
except ImportError:
    _LIBROSA_OK = False


def _time_ms(t0_ms: float) -> int:
    return int((datetime.now().timestamp() * 1000) - t0_ms)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _err(algo: str, msg: str) -> dict:
    return {"algorithm": algo, "ok": False, "error": msg, "spans": []}


def detect_hpss_percussive(audio_path: Path) -> dict:
    algo = "hpss-percussive"
    if not (_LIBROSA_OK and _NUMPY_OK):
        return _err(algo, "librosa / numpy not installed")
    t0 = datetime.now().timestamp() * 1000
    try:
        y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
        # HPSS — y_harm + y_perc = y (approximately). The percussive
        # component carries drums + transients + click-y FX.
        _y_harm, y_perc = librosa.effects.hpss(y)
        # Short-window RMS for a frame-level percussive-energy curve.
        hop = 512
        rms = librosa.feature.rms(y=y_perc, frame_length=2048, hop_length=hop)[0]
        frame_sec = hop / sr
        # Normalize to [0, 1] for thresholding. Median-normalize so a song
        # with a steady drum part isn't dominated by occasional kick peaks.
        rms_norm = rms / max(float(np.median(rms)) * 3.0, 1e-6)
        rms_norm = np.clip(rms_norm, 0.0, 1.0)

        THRESH = 0.35
        MIN_DURATION_SEC = 0.5
        active = rms_norm > THRESH
        spans: list[dict] = []
        i = 0
        n = len(active)
        while i < n:
            if not active[i]:
                i += 1; continue
            j = i
            while j < n and active[j]:
                j += 1
            start_t = i * frame_sec
            end_t   = j * frame_sec
            if end_t - start_t >= MIN_DURATION_SEC:
                conf = float(rms_norm[i:j].mean())
                spans.append({
                    "start":      float(start_t),
                    "end":        float(end_t),
                    "label":      "percussive",
                    "confidence": conf,
                })
            i = j
        return {
            "algorithm": algo,
            "ok":        True,
            "spans":     spans,
            "duration":  float(len(y) / sr),
            "ms":        _time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


ALGORITHMS = {
    "hpss-percussive": {
        "name":        "HPSS percussive",
        "description": "Harmonic-percussive source separation + energy threshold. Pure-DSP. Complements Silero-VAD's voicing.",
        "detect":      detect_hpss_percussive,
        "available":   lambda: _LIBROSA_OK and _NUMPY_OK,
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
        "spans":       result.get("spans", []),
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
        if path == "/api/percussive/health":
            self._send(200, {"ok": _LIBROSA_OK and _NUMPY_OK, "librosaOk": _LIBROSA_OK, "numpyOk": _NUMPY_OK})
            return
        if path == "/api/percussive/algorithms":
            self._send(200, [
                {"id": k, "name": v["name"], "description": v["description"], "available": bool(v["available"]())}
                for k, v in ALGORITHMS.items()
            ])
            return
        if path.startswith("/api/percussive/detect/"):
            tail = path[len("/api/percussive/detect/"):].split("/")
            if len(tail) != 2:
                self._send(400, {"error": "expected /api/percussive/detect/<slug>/<algo>"})
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
        if path == "/api/percussive/detect":
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
        if path == "/api/percussive/initialize":
            algo = str(body.get("algo", "")).strip()
            if algo not in ALGORITHMS:
                self._send(400, {"error": f"unknown algorithm: {algo}"})
                return
            self._send(200, {"ok": ALGORITHMS[algo]["available"](), "algorithm": algo})
            return
        self._send(404, {"error": "not found"})


def main():
    import os
    host = os.environ.get("HOST", "localhost")
    print(f"Starting percussive server on http://{host}:{PORT}", file=sys.stderr)
    print(f"  librosa={_LIBROSA_OK}  numpy={_NUMPY_OK}", file=sys.stderr)
    HTTPServer((host, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
