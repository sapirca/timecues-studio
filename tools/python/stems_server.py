#!/usr/bin/env python3
"""
Stems Server — Demucs stem separation as a long-running HTTP daemon. Port 8006.

Wraps `tools.python.tools.demucs_separator.separate()` so the web container can
trigger separation over HTTP instead of trying to spawn `python` itself (the
web image is node-only). Same one-shot pattern as bpm/msaf/mir servers:
import the heavy module once at startup, then dispatch per-request.

Endpoints
---------
  GET    /api/stems/health
                       → { ok, demucsOk, variant, runningJobs }
  GET    /api/stems/capabilities
                       → contents of /app/gpu-tools-capabilities.json (the
                         marker baked at image-build time). Lets the web
                         container's /api/capabilities answer "fast" or
                         "slow" without spawning anything.
  POST   /api/stems/separate
         body { slug: str, force?: bool }
                       → { jobId }
  GET    /api/stems/status/<jobId>
                       → { status: 'running'|'done'|'error'|'cancelled',
                           logs: str, startedAt: int, finishedAt?: int,
                           cancelMode?: 'soft'|'hard' }
  DELETE /api/stems/cancel/<jobId>
                       → { ok: true, mode: 'soft' }
                       Graceful: SIGINT to the demucs subprocess so it
                       cleans up between chunks (typically within a few
                       seconds).
  DELETE /api/stems/kill/<jobId>
                       → { ok: true, mode: 'hard' }
                       Force: SIGKILL to the whole subprocess group. Stops
                       GPU/CPU work immediately, no cleanup. Use when the
                       graceful cancel doesn't land.

On disk
-------
  Stems land in $STEMS_OUTPUT_DIR (default /app/web-app/public/stems). In
  docker-compose that path is bind-mounted into the web container so vite
  serves the freshly-written WAVs at /stems/<slug>/<stem>.wav.

Usage
-----
  python tools/python/stems_server.py             # binds to 0.0.0.0:8006 in docker
  HOST=127.0.0.1 python tools/python/stems_server.py   # bind locally only
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Optional

# Make `tools.python.tools.demucs_separator` importable. This file lives at
# tools/python/stems_server.py — parents[2] is the repo root.
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "tools" / "python"))

from paths import find_audio  # noqa: E402

PORT = 8006

# Stems output directory. Override with STEMS_OUTPUT_DIR for tests; the docker
# bind mount lines up at /app/web-app/public/stems by default.
STEMS_OUTPUT_DIR = Path(
    os.environ.get("STEMS_OUTPUT_DIR")
    or str(REPO_ROOT / "web-app" / "public" / "stems")
)

# Capability marker baked into the gpu-tools / cpu-tools image at build time.
# Existence here means demucs imported cleanly during `docker build`, so it's
# a stronger signal than a runtime import probe.
CAPABILITIES_PATH = Path(
    os.environ.get("CAPABILITIES_PATH") or "/app/gpu-tools-capabilities.json"
)

# Import demucs lazily so the daemon can boot (and answer /health) even when
# the heavy ML stack is broken. The first /separate request will surface the
# error to the user instead of crashing the process at startup.
_demucs_separator = None
_demucs_import_error: Optional[str] = None


def _load_separator():
    """Import demucs_separator on first use; cache the result (or error)."""
    global _demucs_separator, _demucs_import_error
    if _demucs_separator is not None or _demucs_import_error is not None:
        return _demucs_separator
    try:
        from tools.python.tools import demucs_separator  # noqa: WPS433

        _demucs_separator = demucs_separator
    except Exception as exc:  # noqa: BLE001 — any import failure is fatal here
        _demucs_import_error = f"{type(exc).__name__}: {exc}"
        print(f"[stems] demucs import failed: {_demucs_import_error}", file=sys.stderr)
    return _demucs_separator


# ─── Job tracking ─────────────────────────────────────────────────────────────

class Job:
    """One Demucs separation run. Logs accumulate as strings; the reader thread
    appends subprocess output into `logs` while HTTP handlers read it —
    protected by the GIL since every append is a single bytecode."""

    __slots__ = (
        "id", "slug", "status", "logs", "started_at", "finished_at",
        "cancel", "process", "cancel_mode",
    )

    def __init__(self, slug: str) -> None:
        self.id: str = uuid.uuid4().hex[:12]
        self.slug: str = slug
        self.status: str = "running"  # running | done | error | cancelled
        self.logs: str = ""
        self.started_at: int = int(time.time() * 1000)
        self.finished_at: Optional[int] = None
        self.cancel: threading.Event = threading.Event()
        # The demucs CLI runs in a child process so DELETE /cancel can SIGINT
        # it (graceful) and DELETE /kill can SIGKILL the whole process group
        # (immediate). In-process import-and-call gave us no way to stop the
        # GPU/CPU work once it started.
        self.process: Optional[subprocess.Popen] = None
        # Which kind of cancel the user requested — surfaced in /status so
        # the UI can distinguish "⌛ Cancelling…" from "⌛ Killing…".
        self.cancel_mode: Optional[str] = None  # 'soft' | 'hard' | None


_jobs: dict[str, Job] = {}
_jobs_lock = threading.Lock()


# ─── Worker ───────────────────────────────────────────────────────────────────

# Path to the demucs_separator CLI we shell out to. It already accepts
# --file / --output / --force, so we just spawn it and pipe its stdout into
# the Job log. Running in a subprocess (instead of importing the module) is
# what makes hard-kill possible.
_DEMUCS_CLI = REPO_ROOT / "tools" / "python" / "tools" / "demucs_separator.py"


def _run_separation(job: Job, force: bool) -> None:
    try:
        audio_path = find_audio(job.slug)
        if audio_path is None:
            job.status = "error"
            job.logs += f"\n[error] no audio found for slug {job.slug!r}\n"
            return

        STEMS_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        job.logs += f"\n▶ Demucs ({audio_path.name})\n"

        cmd: list[str] = [
            sys.executable, "-u",
            str(_DEMUCS_CLI),
            "--file", str(audio_path),
            "--output", str(STEMS_OUTPUT_DIR),
        ]
        if force:
            cmd.append("--force")

        # start_new_session=True puts the subprocess in its own process group
        # so we can SIGINT/SIGKILL the whole group at once — covers any
        # worker subprocesses PyTorch / Demucs may spawn.
        job.process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            start_new_session=True,
        )

        # Stream stdout into both job.logs and our stderr (so `docker logs
        # stems` still shows live progress). Read line-by-line so the
        # `--unbuffered` (-u) interpreter flag gives us near-real-time
        # output for the UI poller.
        assert job.process.stdout is not None
        for line in job.process.stdout:
            job.logs += line
            sys.__stderr__.write(line)

        rc = job.process.wait()

        if job.cancel.is_set():
            job.status = "cancelled"
        elif rc == 0:
            job.status = "done"
        else:
            job.status = "error"
            job.logs += f"\n[demucs subprocess exited with code {rc}]\n"
    except Exception as exc:  # noqa: BLE001 — surface every error to the job log
        job.status = "error"
        job.logs += f"\n[error] {type(exc).__name__}: {exc}\n"
        job.logs += traceback.format_exc()
    finally:
        job.finished_at = int(time.time() * 1000)
        job.process = None


def _signal_process_group(job: Job, sig: int, label: str) -> bool:
    """Send a signal to the whole subprocess group; log the outcome.
    Returns True if a live process was signalled."""
    proc = job.process
    if proc is None or proc.poll() is not None:
        job.logs += f"\n[{label} requested — no live subprocess]\n"
        return False
    try:
        os.killpg(os.getpgid(proc.pid), sig)
        job.logs += f"\n[{label} requested — sent to demucs subprocess group]\n"
        return True
    except ProcessLookupError:
        job.logs += f"\n[{label} requested — process already exited]\n"
        return False


# ─── HTTP ─────────────────────────────────────────────────────────────────────

def _cors_headers() -> dict:
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    }


def _capabilities_payload() -> dict:
    if CAPABILITIES_PATH.exists():
        try:
            return json.loads(CAPABILITIES_PATH.read_text())
        except Exception:  # noqa: BLE001
            pass
    # Fallback when the marker isn't baked (e.g. running outside docker): trust
    # whether the heavy import worked. variant=host so the web container's
    # capability merger can label this as "host-python" speed-unknown.
    if _load_separator() is not None:
        return {"allin1": False, "demucs": True, "variant": "host"}
    return {"allin1": False, "demucs": False, "variant": "unknown"}


class Handler(BaseHTTPRequestHandler):
    server_version = "stems/1.0"

    def log_message(self, fmt, *args):  # noqa: N802 — std-lib override
        code = str(args[1]) if len(args) > 1 else "???"
        try:
            if int(code) >= 400:
                super().log_message(fmt, *args)
        except ValueError:
            super().log_message(fmt, *args)

    def _send_json(self, code: int, body) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        for k, v in _cors_headers().items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        for k, v in _cors_headers().items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        if path == "/api/stems/health":
            with _jobs_lock:
                running = sum(1 for j in _jobs.values() if j.status == "running")
            self._send_json(200, {
                "ok": _load_separator() is not None,
                "demucsOk": _load_separator() is not None,
                "importError": _demucs_import_error,
                "runningJobs": running,
                "version": "1.0.0",
            })
        elif path == "/api/stems/capabilities":
            self._send_json(200, _capabilities_payload())
        elif path.startswith("/api/stems/status/"):
            job_id = path[len("/api/stems/status/"):]
            with _jobs_lock:
                job = _jobs.get(job_id)
            if job is None:
                self._send_json(404, {"error": "job not found"})
                return
            payload = {
                "status": job.status,
                "logs": job.logs,
                "startedAt": job.started_at,
            }
            if job.finished_at is not None:
                payload["finishedAt"] = job.finished_at
            if job.cancel_mode is not None:
                payload["cancelMode"] = job.cancel_mode
            self._send_json(200, payload)
        else:
            self._send_json(404, {"error": "not found"})

    def do_DELETE(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]

        # Soft cancel: SIGINT lets the Demucs subprocess clean up between
        # chunks (Python catches it as KeyboardInterrupt, soundfile / torch
        # writers exit gracefully). Typically lands within a few seconds.
        if path.startswith("/api/stems/cancel/"):
            job_id = path[len("/api/stems/cancel/"):]
            with _jobs_lock:
                job = _jobs.get(job_id)
            if job is None:
                self._send_json(404, {"error": "job not found"})
                return
            job.cancel.set()
            job.cancel_mode = "soft"
            _signal_process_group(job, signal.SIGINT, "cancel")
            self._send_json(200, {"ok": True, "mode": "soft"})
            return

        # Hard kill: SIGKILL the whole process group. GPU/CPU work stops
        # immediately, no cleanup; partial WAVs on disk are orphaned (no
        # manifest.json gets written so the picker just sees no stems).
        if path.startswith("/api/stems/kill/"):
            job_id = path[len("/api/stems/kill/"):]
            with _jobs_lock:
                job = _jobs.get(job_id)
            if job is None:
                self._send_json(404, {"error": "job not found"})
                return
            job.cancel.set()
            job.cancel_mode = "hard"
            _signal_process_group(job, signal.SIGKILL, "kill")
            self._send_json(200, {"ok": True, "mode": "hard"})
            return

        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError as exc:
            self._send_json(400, {"error": f"invalid JSON: {exc}"})
            return

        if path == "/api/stems/separate":
            slug = str(body.get("slug", "")).strip()
            force = bool(body.get("force", False))
            if not slug:
                self._send_json(400, {"error": "slug is required"})
                return

            job = Job(slug)
            with _jobs_lock:
                _jobs[job.id] = job
            threading.Thread(
                target=_run_separation,
                args=(job, force),
                name=f"stems-{job.id}",
                daemon=True,
            ).start()
            self._send_json(200, {"jobId": job.id})
            return

        self._send_json(404, {"error": "not found"})


class _ThreadingHTTPServer(HTTPServer):
    """Spawn a thread per request so /status polls don't queue behind a
    running /separate. (BaseHTTPServer is single-threaded by default.)"""

    daemon_threads = True
    allow_reuse_address = True

    def process_request(self, request, client_address):
        threading.Thread(
            target=self._handle_request_thread,
            args=(request, client_address),
            daemon=True,
        ).start()

    def _handle_request_thread(self, request, client_address) -> None:
        try:
            self.finish_request(request, client_address)
        finally:
            self.shutdown_request(request)


def main() -> None:
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"Starting stems server on http://{host}:{PORT}", file=sys.stderr)
    print(f"Stems output dir: {STEMS_OUTPUT_DIR}", file=sys.stderr)
    print(f"Capabilities marker: {CAPABILITIES_PATH} (exists={CAPABILITIES_PATH.exists()})",
          file=sys.stderr)

    # Eager-load demucs so /health is fast and import errors surface in the
    # boot logs (not silently on the first /separate request 10 minutes later).
    print("  Loading demucs…", file=sys.stderr)
    t0 = time.time()
    if _load_separator() is not None:
        print(f"  demucs ready in {time.time() - t0:.1f}s", file=sys.stderr)
    else:
        print(f"  WARNING: demucs unavailable — /separate will return errors: "
              f"{_demucs_import_error}", file=sys.stderr)

    server = _ThreadingHTTPServer((host, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)


if __name__ == "__main__":
    main()
