#!/usr/bin/env python3
"""
SPAN family detection server — produces voicing / instrument-activity
*intervals* (spans), as opposed to point-in-time cues or section boundaries.

Detectors
---------
  silero-vad        torch.hub snakers4/silero-vad         (~2 MB, MIT)
  jdcnet-voicing    keums/melodyExtraction_JDC weights    (~30 MB, MIT)

  More to come once weights/licensing are verified per integration_plan.md:
  - mirflex-vocal           (200–500 MB bundled, MIT)
  - mirflex-instrument-fam  (bundled, MIT)

Endpoints
---------
  GET  /api/span/health              → server up + per-detector availability
  GET  /api/span/algorithms          → [{ id, name, available, description }]
  GET  /api/span/detect/:slug/:algo  → cached result, or null
  POST /api/span/detect              { slug, algo, force? } — run one detector

Output schema (every detector returns the same shape)
-----------------------------------------------------
  {
    "slug":        str,
    "audio_file":  str,
    "algorithm":   str,            # detector id
    "duration":    float,          # seconds
    "spans": [
      {
        "start":      float,       # seconds
        "end":        float,       # seconds
        "label":      str,         # e.g. "voice", "instrumental"
        "confidence": float | None # 0..1 if the model exposes one
      }
    ],
    "ms":          int,            # detector wall-clock runtime
    "computed_at": str             # ISO-8601 UTC
  }

Cache
-----
  data/algorithm-outputs/span/<slug>/<algo>.json

The whole server is gated by the `experimental-models` docker compose profile.
If that profile is not running, the web client gets a 503 from the vite proxy
and the SPAN family family flag (`experimentalSpanFamily` in user settings)
keeps the UI surface hidden anyway.
"""

from __future__ import annotations

import json
import sys
import warnings
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

warnings.filterwarnings("ignore")

PORT = 8009

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import find_audio, REPO_ROOT, SPAN_OUTPUTS_DIR as CACHE_DIR  # noqa: E402

CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ─── Optional imports (each detector is independent) ────────────────────────

try:
    import numpy as np
    _NUMPY_OK = True
except ImportError:
    _NUMPY_OK = False

try:
    import torch  # noqa: F401
    _TORCH_OK = True
except ImportError:
    _TORCH_OK = False

try:
    # Silero-VAD ships its weights via torch.hub. The first call downloads
    # the model into HF_HOME / TORCH_HOME (configured by the docker image).
    # We don't pre-import the model — only do that the first time a detect
    # request lands, so the server can start without network access.
    import torchaudio  # noqa: F401  # silero needs torchaudio for load_audio
    _TORCHAUDIO_OK = True
except ImportError:
    _TORCHAUDIO_OK = False

try:
    import librosa  # noqa: F401  # we use it for resampling when feeding JDCNet
    _LIBROSA_OK = True
except ImportError:
    _LIBROSA_OK = False


# Lazy model holders. Each detector loads its model on first use and caches
# it for subsequent calls in the same process. Restarting the server clears
# them — Docker layer caching keeps the weights on disk so the reload is fast.
_silero_model = None
_silero_utils = None

# JDCNet weights file. Loaded once on first detect; `_JDCNET_OK` is True only
# when the .hdf5 + the two normalization .npy files are reachable on disk.
# Docker bakes them into /app/weights/jdcnet/ at image build time; for bare-
# metal runs we fall back to <repo>/.cache/jdcnet/ (populated by run.sh on
# first start via curl, same URLs as the Dockerfile). Pure-PyTorch port lives
# in `jdcnet_torch.py`; we never import tensorflow/keras here.
_JDCNET_DOCKER_DIR = Path("/app/weights/jdcnet")
_JDCNET_LOCAL_DIR  = REPO_ROOT / ".cache" / "jdcnet"
_JDCNET_WEIGHTS_DIR = _JDCNET_DOCKER_DIR if _JDCNET_DOCKER_DIR.exists() else _JDCNET_LOCAL_DIR
_JDCNET_HDF5  = _JDCNET_WEIGHTS_DIR / "ResNet_joint_add_L(CE_G).hdf5"
_JDCNET_MEAN  = _JDCNET_WEIGHTS_DIR / "x_data_mean_total_31.npy"
_JDCNET_STD   = _JDCNET_WEIGHTS_DIR / "x_data_std_total_31.npy"
_JDCNET_OK = _JDCNET_HDF5.exists() and _JDCNET_MEAN.exists() and _JDCNET_STD.exists()
_jdcnet_model = None
_jdcnet_mean: "object" = None  # numpy.ndarray when loaded
_jdcnet_std:  "object" = None


# ─── Helpers ────────────────────────────────────────────────────────────────

def _time_ms(t0_ms: float) -> int:
    return int((datetime.now().timestamp() * 1000) - t0_ms)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _err(algo: str, msg: str) -> dict:
    return {"algorithm": algo, "ok": False, "error": msg, "spans": []}


# ─── Detector: Silero-VAD ───────────────────────────────────────────────────

def _ensure_silero():
    """Load Silero-VAD on first use. Subsequent calls are free."""
    global _silero_model, _silero_utils
    if _silero_model is not None:
        return
    import torch
    # `trust_repo` silences the interactive y/n prompt torch.hub asks the first
    # time it pulls a new repo — we ARE trusting this repo, the prompt would
    # just hang in a headless server.
    _silero_model, _silero_utils = torch.hub.load(
        "snakers4/silero-vad",
        "silero_vad",
        force_reload=False,
        trust_repo=True,
    )


def detect_silero_vad(audio_path: Path) -> dict:
    algo = "silero-vad"
    if not (_TORCH_OK and _TORCHAUDIO_OK):
        return _err(algo, "torch / torchaudio not installed")
    t0 = datetime.now().timestamp() * 1000
    try:
        _ensure_silero()
        get_speech_timestamps, _save, read_audio, _, _ = _silero_utils  # type: ignore[misc]
        sr = 16000
        wav = read_audio(str(audio_path), sampling_rate=sr)
        raw = get_speech_timestamps(wav, _silero_model, sampling_rate=sr)
        spans = [
            {
                "start":      float(seg["start"]) / sr,
                "end":        float(seg["end"]) / sr,
                "label":      "voice",
                "confidence": None,
            }
            for seg in raw
        ]
        duration = float(wav.shape[-1]) / sr
        return {
            "algorithm": algo,
            "ok":        True,
            "spans":     spans,
            "duration":  duration,
            "ms":        _time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


# ─── Detector: JDCNet voicing ───────────────────────────────────────────────

def _ensure_jdcnet():
    """Lazy-load the pure-PyTorch JDCNet port from `jdcnet_torch.py`. Weights
    are converted from the original keums Keras .hdf5 on first call via h5py
    (no TensorFlow needed); the resulting `state_dict` lives in process
    memory for the lifetime of the container.
    """
    global _jdcnet_model, _jdcnet_mean, _jdcnet_std
    if _jdcnet_model is not None:
        return
    import numpy as np
    from jdcnet_torch import load_model
    _jdcnet_model = load_model(_JDCNET_HDF5, device="cpu")
    _jdcnet_mean  = np.load(str(_JDCNET_MEAN))
    _jdcnet_std   = np.load(str(_JDCNET_STD))


def detect_jdcnet_voicing(audio_path: Path) -> dict:
    algo = "jdcnet-voicing"
    if not _JDCNET_OK:
        return _err(
            algo,
            "JDCNet weights missing — rebuild the span sidecar so the keums "
            ".hdf5 + .npy stats get baked into /app/weights/jdcnet/",
        )
    if not (_TORCH_OK and _LIBROSA_OK):
        return _err(algo, "torch / librosa not installed")
    t0 = datetime.now().timestamp() * 1000
    try:
        import torch
        from jdcnet_torch import infer, voicing_spans, pitch_class_to_hz, FRAME_SEC
        _ensure_jdcnet()
        mean_t = torch.from_numpy(_jdcnet_mean).float()
        std_t  = torch.from_numpy(_jdcnet_std).float()
        # batch_size=32 is conservative for CPU; the model is small (4 M params)
        # but the BiLSTM is sequential and dominates wall time anyway.
        pitch, voicing = infer(
            _jdcnet_model, audio_path,
            norm_mean=mean_t, norm_std=std_t,
            batch_size=32, device="cpu",
        )
        spans = voicing_spans(voicing, threshold=0.5, min_duration=0.05)
        # Pitch contour: argmax over the 722-class softmax per frame, mapped
        # to Hz via `pitch_class_to_hz` (class 0 → 0 Hz = non-voice). Stored
        # as parallel arrays rather than a list-of-dicts so the JSON stays
        # compact for ~17 k frames at 10 ms each. Phase 3 will surface this
        # via mir_server's feature API; for now we just persist it.
        argmax = pitch.argmax(dim=-1)
        pitch_hz = [pitch_class_to_hz(int(c)) for c in argmax.tolist()]
        pitch_contour = {
            "frame_sec": FRAME_SEC,
            "hz":        pitch_hz,
        }
        # Use librosa to fetch duration so the payload matches Silero-VAD's
        # shape; cheap because the audio has already been decoded once.
        import librosa
        duration = float(librosa.get_duration(path=str(audio_path)))
        return {
            "algorithm":     algo,
            "ok":            True,
            "spans":         spans,
            "duration":      duration,
            "ms":            _time_ms(t0),
            "pitch_contour": pitch_contour,
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


# ─── Algorithm registry ─────────────────────────────────────────────────────

ALGORITHMS = {
    "silero-vad": {
        "name":        "Silero-VAD",
        "description": "Voice activity detection — voicing spans. Lightweight (~2 MB) torch.hub model.",
        "detect":      detect_silero_vad,
        "available":   lambda: _TORCH_OK and _TORCHAUDIO_OK,
    },
    "jdcnet-voicing": {
        "name":        "JDCNet (voicing)",
        "description": "Joint pitch + voicing detector. Returns voiced spans plus a pitch contour (when wired).",
        "detect":      detect_jdcnet_voicing,
        "available":   lambda: _JDCNET_OK,
    },
}


def _audio_path(slug: str) -> Path:
    p = find_audio(slug)
    if p is None:
        raise FileNotFoundError(f"audio not found for slug: {slug}")
    return p


def detect_one(slug: str, algo: str, force: bool = False) -> dict:
    if algo not in ALGORITHMS:
        raise ValueError(f"unknown algorithm: {algo}")
    cache_dir = CACHE_DIR / slug
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{algo}.json"
    if cache_path.exists() and not force:
        return json.loads(cache_path.read_text())

    audio_path = _audio_path(slug)
    result = ALGORITHMS[algo]["detect"](audio_path)

    payload: dict = {
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
    # Pitch contours are large (>100 KB on a 3 min track) — write them to
    # a side-car file so the main JSON payload stays small for the
    # /algorithms-list path, but keep a pointer the client can follow.
    pitch = result.get("pitch_contour")
    if pitch:
        pitch_path = cache_dir / f"{algo}.pitch.json"
        try:
            pitch_path.write_text(json.dumps(pitch))
            payload["pitch_contour_file"] = pitch_path.name
        except Exception:
            pass
    try:
        cache_path.write_text(json.dumps(payload, indent=2))
    except Exception:
        pass
    return payload


# ─── HTTP handler ───────────────────────────────────────────────────────────

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

        if path == "/api/span/health":
            self._send(200, {
                "ok":          _TORCH_OK and _TORCHAUDIO_OK,
                "torchOk":     _TORCH_OK,
                "torchaudioOk": _TORCHAUDIO_OK,
                "librosaOk":   _LIBROSA_OK,
                "numpyOk":     _NUMPY_OK,
            })
            return

        if path == "/api/span/algorithms":
            self._send(200, [
                {
                    "id":          algo_id,
                    "name":        meta["name"],
                    "description": meta["description"],
                    "available":   bool(meta["available"]()),
                }
                for algo_id, meta in ALGORITHMS.items()
            ])
            return

        if path.startswith("/api/span/detect/"):
            tail = path[len("/api/span/detect/"):].split("/")
            if len(tail) != 2:
                self._send(400, {"error": "expected /api/span/detect/<slug>/<algo>"})
                return
            slug, algo = tail
            cache_path = CACHE_DIR / slug / f"{algo}.json"
            if cache_path.exists():
                self._send(200, json.loads(cache_path.read_text()))
            else:
                self._send(200, None)
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

        if path == "/api/span/detect":
            slug  = str(body.get("slug", "")).strip()
            algo  = str(body.get("algo", "")).strip()
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

        # Warm a model's weights without running detection. Drives the
        # "Initialize models" panel in the experimental settings — the UI
        # surfaces a per-algo Ready badge that flips once this endpoint
        # returns ok=true.
        if path == "/api/span/initialize":
            algo = str(body.get("algo", "")).strip()
            if algo not in ALGORITHMS:
                self._send(400, {"error": f"unknown algorithm: {algo}"})
                return
            try:
                if algo == "silero-vad":
                    if not (_TORCH_OK and _TORCHAUDIO_OK):
                        self._send(503, {"ok": False, "error": "torch / torchaudio not installed"})
                        return
                    _ensure_silero()
                    self._send(200, {"ok": True, "algorithm": algo})
                    return
                if algo == "jdcnet-voicing":
                    if not _JDCNET_OK:
                        self._send(503, {"ok": False, "error": "JDCNet weights not bundled — rebuild span image"})
                        return
                    if not (_TORCH_OK and _LIBROSA_OK):
                        self._send(503, {"ok": False, "error": "torch / librosa not installed"})
                        return
                    _ensure_jdcnet()
                    self._send(200, {"ok": True, "algorithm": algo})
                    return
                self._send(400, {"error": f"no initializer for {algo}"})
            except Exception as e:
                self._send(500, {"ok": False, "error": f"init failed: {type(e).__name__}: {e}"})
            return

        self._send(404, {"error": "not found"})


def main():
    import os
    host = os.environ.get("HOST", "localhost")
    print(f"Starting SPAN server on http://{host}:{PORT}", file=sys.stderr)
    print(
        f"  torch={_TORCH_OK}  torchaudio={_TORCHAUDIO_OK}  librosa={_LIBROSA_OK}  jdcnet={_JDCNET_OK}",
        file=sys.stderr,
    )
    server = HTTPServer((host, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)


if __name__ == "__main__":
    main()
