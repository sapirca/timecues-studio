#!/usr/bin/env python3
"""Consolidated DSP server — hosts the pure-DSP (CPU, no neural model) analysis
families behind a single port, replacing their individual sidecars.

Each family keeps its logic in its own module and exposes
``handle_get(full_path) -> (code, body) | None`` and
``handle_post(full_path, body) -> (code, body) | None``. This multiplexer
dispatches by URL path prefix; the per-family route tables and detection code
are untouched, so behavior is identical to the standalone servers.

Absorbed families (one port instead of several):
  /api/ruptures/*   ← ruptures_server   (was :8003)
  /api/mir/*        ← mir_server        (was :8007)

Only families that share the Python 3.11 / numpy>=1.24 / librosa>=0.10 floor
are folded in. msaf is NOT here — it pins Python 3.10 / numpy<1.24 /
librosa<0.10 (incompatible in one process), so it stays its own sidecar. The
Custom server (8005) and the neural-model sidecars are likewise left separate.

Run:  python tools/python/dsp_server.py        (defaults to port 8003)
"""

import json
import os
import sys
import warnings
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

warnings.filterwarnings("ignore")

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ruptures_server  # noqa: E402
import mir_server  # noqa: E402

PORT = int(os.environ.get("DSP_PORT", "8003"))

# (url-prefix, module). Each module exposes handle_get / handle_post.
FAMILIES = [
    ("/api/ruptures/", ruptures_server),
    ("/api/mir/", mir_server),
]


def _cors_headers() -> dict:
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    }


def _aggregate_health() -> dict:
    families: dict[str, bool] = {}
    ok = True
    for prefix, mod in FAMILIES:
        name = prefix.strip("/").split("/")[-1]
        h = mod.handle_get(f"/api/{name}/health")
        fam_ok = bool(h and h[0] == 200 and h[1].get("ok"))
        families[name] = fam_ok
        ok = ok and fam_ok
    return {"ok": ok, "families": families}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        code = str(args[1]) if len(args) > 1 else "???"
        if not code.isdigit() or int(code) >= 400:
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
        path = self.path.split("?")[0]
        if path == "/api/dsp/health":
            self._send_json(200, _aggregate_health())
            return
        for prefix, mod in FAMILIES:
            if path.startswith(prefix):
                self._send_json(*(mod.handle_get(self.path) or (404, {"error": "not found"})))
                return
        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError as e:
            self._send_json(400, {"error": f"invalid JSON: {e}"}); return
        for prefix, mod in FAMILIES:
            if path.startswith(prefix):
                self._send_json(*(mod.handle_post(self.path, body) or (404, {"error": "not found"})))
                return
        self._send_json(404, {"error": "not found"})


def main():
    host = os.environ.get("HOST", "localhost")
    names = ", ".join(p.strip("/").split("/")[-1] for p, _ in FAMILIES)
    print(f"Starting DSP server on http://{host}:{PORT} (families: {names})", file=sys.stderr)
    server = HTTPServer((host, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)


if __name__ == "__main__":
    main()
