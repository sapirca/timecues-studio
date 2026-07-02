#!/usr/bin/env python3
"""
MSAF Analysis Server — boundary detection via the Music Structure Analysis
Framework (Nieto & Bello, 2016). Port 8002.

Wraps `msaf.process` for the four boundary algorithms used by the web app:
  sf     — Structural Features
  foote  — Foote Self-Similarity
  cnmf   — Convex Non-negative Matrix Factorization
  olda   — Optimal Linear Discriminant Analysis

Endpoints
---------
  GET  /api/msaf/health
  GET  /api/msaf/algorithms        → list of supported algorithm descriptors
  POST /api/msaf/analyze           → { slug, algorithm } — run one algo on one song

Cache
-----
    data/algorithm-outputs/analysis/<slug>/<algorithm>.json
  (served as static files by Vite once written)

Usage
-----
  pip install msaf librosa numpy
  python tools/python/msaf_server.py
"""

import json
import os
import sys
import time
import warnings
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np

warnings.filterwarnings("ignore")

try:
    import librosa
    _LIBROSA_OK = True
except ImportError:
    _LIBROSA_OK = False

try:
    import msaf
    # msaf.process() writes a features cache to msaf.config.features_tmp_file,
    # which defaults to ".features_msaf_tmp.json" in cwd — route it to the
    # system tmp dir so it doesn't pollute the repo root.
    import tempfile
    msaf.config.features_tmp_file = os.path.join(tempfile.gettempdir(), ".features_msaf_tmp.json")
    _MSAF_OK = True
except ImportError:
    _MSAF_OK = False

PORT = 8002

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import ANALYSIS_DIR, REPO_ROOT, MSAF_DIR, find_audio, safe_segment  # noqa: E402

MANIFEST     = ANALYSIS_DIR / "manifest.json"

ALGORITHMS: dict[str, str] = {
    "sf":    "Structural Features (SF)",
    "foote": "Foote Self-Similarity",
    "cnmf":  "CNMF (Non-negative Matrix Factorization)",
    "olda":  "OLDA (Optimal Linear Discriminant)",
}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _cors_headers() -> dict:
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    }


def _update_manifest_has_analysis(slug: str) -> None:
    try:
        manifest = json.loads(MANIFEST.read_text())
    except Exception:
        return
    changed = False
    for entry in manifest:
        if entry.get("id") == slug and not entry.get("hasAnalysis"):
            entry["hasAnalysis"] = True
            changed = True
            break
    if changed:
        try:
            MANIFEST.write_text(json.dumps(manifest, indent=2))
        except Exception as e:
            print(f"[msaf] manifest update failed: {e}", file=sys.stderr)


def classify_sections(y: np.ndarray, sr: int, boundaries: np.ndarray) -> list[dict]:
    """Same heuristic as ruptures_server: energy + spectral-centroid → labels.
    Kept inline so the two services stay independently deployable.
    """
    duration = float(librosa.get_duration(y=y, sr=sr))
    boundaries = np.clip(np.sort(np.unique(boundaries)), 0, duration)

    energies: list[float] = []
    centroids: list[float] = []
    for i in range(len(boundaries) - 1):
        s0 = int(boundaries[i] * sr)
        s1 = int(boundaries[i + 1] * sr)
        seg = y[s0:s1]
        if len(seg) < 512:
            energies.append(0.0); centroids.append(0.0); continue
        energies.append(float(np.sqrt(np.mean(seg ** 2))))
        centroids.append(float(np.mean(librosa.feature.spectral_centroid(y=seg, sr=sr))))

    n = len(energies)
    if n == 0:
        return []

    e = np.array(energies); e_n = e / (e.max() or 1.0)
    c = np.array(centroids); c_n = c / (c.max() or 1.0)

    labels = ["verse"] * n
    is_drop = e_n > 0.65
    for i in range(n):
        if is_drop[i]: labels[i] = "drop"
    for i in range(1, n):
        if labels[i] == "drop" and labels[i-1] != "drop" and (boundaries[i] - boundaries[i-1]) >= 4:
            labels[i-1] = "buildup"
    for i in range(n):
        if labels[i] == "verse" and e_n[i] < 0.35 and (i+1 >= n or labels[i+1] != "drop"):
            labels[i] = "breakdown"
    for i in range(min(3, n)):
        if labels[i] == "verse" and e_n[i] < 0.55: labels[i] = "intro"
        else: break
    for i in range(n-1, max(n-4, -1), -1):
        if labels[i] == "verse" and e_n[i] < 0.55: labels[i] = "outro"
        else: break

    DISPLAY = {"intro": "Intro", "verse": "Verse", "buildup": "Buildup",
               "drop": "Drop", "breakdown": "Breakdown", "outro": "Outro"}
    return [
        {
            "time":     float(round(boundaries[i], 3)),
            "endTime":  float(round(boundaries[i + 1], 3)),
            "type":     labels[i],
            "label":    DISPLAY.get(labels[i], labels[i].capitalize()),
            "energy":   float(round(e_n[i], 4)),
            "centroid": float(round(c_n[i], 4)),
        }
        for i in range(n)
    ]


# ─── Full pipeline ─────────────────────────────────────────────────────────────

def analyze(slug: str, algorithm: str, force: bool = False) -> dict:
    if not _LIBROSA_OK:
        raise RuntimeError("librosa not installed")
    if not _MSAF_OK:
        raise RuntimeError("msaf not installed")
    if algorithm not in ALGORITHMS:
        raise ValueError(f"Unknown algorithm: {algorithm!r} (valid: {list(ALGORITHMS)})")

    cache_dir  = ANALYSIS_DIR / slug
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{algorithm}.json"

    if cache_path.exists() and not force:
        return json.loads(cache_path.read_text())

    audio_path = find_audio(slug)
    if audio_path is None:
        raise FileNotFoundError(f"No audio file found for slug: {slug!r}")

    t0 = time.time()
    y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))

    boundaries, _labels = msaf.process(str(audio_path), boundaries_id=algorithm, feature="mfcc")
    boundaries = np.asarray(boundaries, dtype=float)
    if len(boundaries) == 0 or boundaries[0] != 0:
        boundaries = np.concatenate([[0.0], boundaries])

    sections = classify_sections(y, sr, boundaries)
    elapsed  = time.time() - t0

    result = {
        "algorithm":     algorithm,
        "algoName":      ALGORITHMS[algorithm],
        "audioFile":     audio_path.name,
        "duration":      sections[-1]["endTime"] if sections else duration,
        "sections":      sections,
        "rawBoundaries": [float(round(b, 3)) for b in boundaries],
        "computedAt":    int(time.time()),
        "elapsedSec":    float(round(elapsed, 2)),
    }

    cache_path.write_text(json.dumps(result, indent=2))

    # Mirror to the legacy raw-output location so existing storage-stats and
    # per-slug cleanup paths (web-app/vite.config.ts) keep finding these files.
    try:
        raw_dir = MSAF_DIR / slug
        raw_dir.mkdir(parents=True, exist_ok=True)
        (raw_dir / f"msaf-{algorithm}.json").write_text(json.dumps(result, indent=2))
    except Exception as e:
        print(f"[msaf] raw-mirror write failed: {e}", file=sys.stderr)

    _update_manifest_has_analysis(slug)

    print(f"[msaf] {slug}/{algorithm}: {len(sections)} sections in {elapsed:.1f}s", file=sys.stderr)
    return result


# ─── Route handlers ────────────────────────────────────────────────────────────
# Shared by the standalone server below and the consolidated dsp_server.py.
# Each returns (status_code, body) or None when the path isn't a msaf route.

def handle_get(full_path: str):
    path = full_path.split("?")[0]
    if path == "/api/msaf/health":
        return 200, {
            "ok":        _LIBROSA_OK and _MSAF_OK,
            "librosaOk": _LIBROSA_OK,
            "msafOk":    _MSAF_OK,
            "version":   "1.0.0",
            "algorithms": list(ALGORITHMS),
        }
    if path == "/api/msaf/algorithms":
        return 200, [{"id": k, "name": v} for k, v in ALGORITHMS.items()]
    return None


def handle_post(full_path: str, body: dict):
    path = full_path.split("?")[0]
    if path == "/api/msaf/analyze":
        slug      = safe_segment(str(body.get("slug", "")).strip())
        algorithm = str(body.get("algorithm", "")).strip()
        force     = bool(body.get("force", False))
        if not slug:
            return 400, {"error": "invalid or missing slug"}
        if algorithm not in ALGORITHMS:
            return 400, {"error": f"unknown algorithm, valid: {list(ALGORITHMS)}"}
        try:
            return 200, analyze(slug, algorithm, force=force)
        except FileNotFoundError as e:
            return 404, {"error": str(e)}
        except RuntimeError as e:
            return 503, {"error": str(e)}
        except Exception as e:
            return 500, {"error": f"Analysis failed: {e}"}
    return None


# ─── HTTP handler ──────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        code = str(args[1]) if len(args) > 1 else "???"
        try:
            if int(code) >= 400:
                super().log_message(fmt, *args)
        except ValueError:
            super().log_message(fmt, *args)

    def _send_json(self, code: int, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        for k, v in _cors_headers().items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in _cors_headers().items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        self._send_json(*(handle_get(self.path) or (404, {"error": "not found"})))

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError as e:
            self._send_json(400, {"error": f"invalid JSON: {e}"}); return
        self._send_json(*(handle_post(self.path, body) or (404, {"error": "not found"})))


def main():
    if not _LIBROSA_OK:
        print("WARNING: librosa not installed — pip install librosa", file=sys.stderr)
    if not _MSAF_OK:
        print("WARNING: msaf not installed — pip install msaf", file=sys.stderr)

    host = os.environ.get("HOST", "localhost")
    print(f"Starting MSAF server on http://{host}:{PORT}", file=sys.stderr)
    print(f"Algorithms: {list(ALGORITHMS)}", file=sys.stderr)

    server = HTTPServer((host, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)


if __name__ == "__main__":
    main()
