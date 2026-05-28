#!/usr/bin/env python3
"""
Whisper-base vocal-transcription sidecar — opens the LYRICS family.

OpenAI Whisper "base" model: ~140 MB checkpoint lazy-downloaded into the
shared `timecues-model-cache` named volume on first detect, then reused.
CPU-only torch wheels keep the image multi-platform.

Output is a `LyricsItem`-compatible list of word-level entries with
start/end times, suitable for the LyricsLayer schema. Word-level
timestamps from base Whisper are coarse (~200 ms granularity); WhisperX
or a forced-aligner refinement is the planned Phase 5 follow-up.

Endpoints
---------
  GET  /api/lyrics/health             → server up + dep availability
  GET  /api/lyrics/algorithms         → [{ id, name, available, description }]
  GET  /api/lyrics/detect/:slug/:algo → cached result, or null
  POST /api/lyrics/detect             { slug, algo, force?, language? }
  POST /api/lyrics/initialize         { algo }

Output schema
-------------
  {
    "slug":        str,
    "audio_file":  str,
    "algorithm":   str,
    "duration":    float,
    "language":    str | null,
    "words": [
      {
        "time":   float,    # word onset (seconds)
        "end":    float,    # word offset
        "text":   str,
        "kind":   "word"
      }
    ],
    "lines": [
      {
        "time":   float,    # segment start
        "end":    float,    # segment end
        "text":   str,
        "kind":   "line"
      }
    ],
    "ms":          int,
    "computed_at": str
  }

Cache
-----
  data/algorithm-outputs/lyrics/<slug>/<algo>.json
"""

from __future__ import annotations

import json
import sys
import warnings
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

warnings.filterwarnings("ignore")

PORT = 8016

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import find_audio, LYRICS_OUTPUTS_DIR as CACHE_DIR  # noqa: E402

CACHE_DIR.mkdir(parents=True, exist_ok=True)

try:
    import numpy as np  # noqa: F401
    _NUMPY_OK = True
except ImportError:
    _NUMPY_OK = False

try:
    import torch  # noqa: F401
    _TORCH_OK = True
except ImportError:
    _TORCH_OK = False

try:
    import whisper  # noqa: F401
    _WHISPER_OK = True
except Exception:
    _WHISPER_OK = False


# Process-wide model cache. Whisper-base load takes ~3 s on first call.
_whisper_model = None


def _time_ms(t0_ms: float) -> int:
    return int((datetime.now().timestamp() * 1000) - t0_ms)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _err(algo: str, msg: str) -> dict:
    return {"algorithm": algo, "ok": False, "error": msg, "words": [], "lines": []}


def _ensure_whisper():
    """Lazy-load Whisper-base. Triggers a ~140 MB checkpoint download into
    ~/.cache/whisper/ on first call. Model lives in process memory for
    the lifetime of the container after that."""
    global _whisper_model
    if _whisper_model is not None:
        return
    import whisper
    _whisper_model = whisper.load_model("base")


def detect_whisper_base(audio_path: Path, language: str | None = None) -> dict:
    algo = "whisper-base"
    if not (_WHISPER_OK and _TORCH_OK and _NUMPY_OK):
        return _err(algo, "whisper / torch / numpy not installed")
    t0 = datetime.now().timestamp() * 1000
    try:
        _ensure_whisper()
        # word_timestamps=True triggers Whisper's cross-attention DTW pass
        # to estimate per-word timing — coarse but real.
        kwargs = {"word_timestamps": True}
        if language:
            kwargs["language"] = language
        result = _whisper_model.transcribe(str(audio_path), **kwargs)  # type: ignore[union-attr]

        words: list[dict] = []
        lines: list[dict] = []
        for seg in result.get("segments", []):
            seg_start = float(seg.get("start", 0.0))
            seg_end   = float(seg.get("end", seg_start))
            seg_text  = str(seg.get("text", "")).strip()
            if seg_text:
                lines.append({
                    "time": seg_start, "end": seg_end,
                    "text": seg_text, "kind": "line",
                })
            for w in seg.get("words", []) or []:
                wt = float(w.get("start", seg_start))
                we = float(w.get("end", wt))
                wtxt = str(w.get("word", "")).strip()
                if not wtxt:
                    continue
                words.append({
                    "time": wt, "end": we,
                    "text": wtxt, "kind": "word",
                })

        return {
            "algorithm": algo,
            "ok":        True,
            "words":     words,
            "lines":     lines,
            "language":  result.get("language"),
            "duration":  float(lines[-1]["end"]) if lines else 0.0,
            "ms":        _time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


ALGORITHMS = {
    "whisper-base": {
        "name":        "Whisper base",
        "description": "OpenAI Whisper base model — multilingual vocal transcription with coarse word-level timestamps.",
        "detect":      detect_whisper_base,
        "available":   lambda: _WHISPER_OK and _TORCH_OK and _NUMPY_OK,
    },
}


def detect_one(slug: str, algo: str, force: bool = False, language: str | None = None) -> dict:
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
    # Only `whisper-base` exists right now; passing language threads through.
    result = ALGORITHMS[algo]["detect"](audio_path, language)  # type: ignore[misc]
    payload = {
        "slug":        slug,
        "audio_file":  audio_path.name,
        "algorithm":   algo,
        "duration":    result.get("duration", 0.0),
        "language":    result.get("language"),
        "words":       result.get("words", []),
        "lines":       result.get("lines", []),
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
        if path == "/api/lyrics/health":
            self._send(200, {
                "ok":         _WHISPER_OK and _TORCH_OK and _NUMPY_OK,
                "whisperOk":  _WHISPER_OK,
                "torchOk":    _TORCH_OK,
                "numpyOk":    _NUMPY_OK,
            })
            return
        if path == "/api/lyrics/algorithms":
            self._send(200, [
                {"id": k, "name": v["name"], "description": v["description"], "available": bool(v["available"]())}
                for k, v in ALGORITHMS.items()
            ])
            return
        if path.startswith("/api/lyrics/detect/"):
            tail = path[len("/api/lyrics/detect/"):].split("/")
            if len(tail) != 2:
                self._send(400, {"error": "expected /api/lyrics/detect/<slug>/<algo>"})
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
        if path == "/api/lyrics/detect":
            slug = str(body.get("slug", "")).strip()
            algo = str(body.get("algo", "")).strip()
            force = bool(body.get("force", False))
            language = body.get("language") or None
            if not slug or not algo:
                self._send(400, {"error": "slug and algo are required"})
                return
            try:
                self._send(200, detect_one(slug, algo, force=force, language=language))
            except FileNotFoundError as e:
                self._send(404, {"error": str(e)})
            except ValueError as e:
                self._send(400, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": f"detection failed: {type(e).__name__}: {e}"})
            return
        if path == "/api/lyrics/initialize":
            algo = str(body.get("algo", "")).strip()
            if algo not in ALGORITHMS:
                self._send(400, {"error": f"unknown algorithm: {algo}"})
                return
            try:
                if not ALGORITHMS[algo]["available"]():
                    self._send(503, {"ok": False, "error": "whisper deps missing"})
                    return
                _ensure_whisper()
                self._send(200, {"ok": True, "algorithm": algo})
            except Exception as e:
                self._send(500, {"ok": False, "error": f"init failed: {type(e).__name__}: {e}"})
            return
        self._send(404, {"error": "not found"})


def main():
    import os
    host = os.environ.get("HOST", "localhost")
    print(f"Starting Whisper lyrics server on http://{host}:{PORT}", file=sys.stderr)
    print(f"  whisper={_WHISPER_OK}  torch={_TORCH_OK}  numpy={_NUMPY_OK}", file=sys.stderr)
    HTTPServer((host, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
