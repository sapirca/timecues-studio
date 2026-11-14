"""Shared boilerplate for the tools/python/*_server.py HTTP servers.

These servers each hand-roll a tiny handful of identical (or near-identical)
helpers: CORS headers, elapsed-time / ISO-timestamp formatting, and a
standard error-response shape. This module centralizes the parts that are
genuinely duplicated, while keeping the small per-server differences (e.g.
stems_server's extra DELETE method, custom_server's extra X-Annotator-Id
header, each server's domain-specific error payload keys) as explicit
call-site parameters rather than baking one server's variant in as the
default for everyone.

This is intentionally *not* a shared server framework — just the confirmed
duplicated bits, extracted so they have one definition instead of fifteen.
"""

from __future__ import annotations

import gc
import json
import math
import os
import socket
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import HTTPServer
from pathlib import Path

# The methods/headers used by the large majority of servers (everything
# except custom_server.py, which also allows DELETE and an extra
# X-Annotator-Id header, and stems_server.py, which also allows DELETE).
DEFAULT_METHODS = "POST, GET, OPTIONS"
DEFAULT_ALLOW_HEADERS = "Content-Type"


def cors_headers(
    *,
    methods: str = DEFAULT_METHODS,
    allow_headers: str = DEFAULT_ALLOW_HEADERS,
    with_content_type: bool = False,
) -> dict:
    """Build the CORS response-header dict.

    `methods` / `allow_headers` let a caller preserve its own actual
    Allow-Methods / Allow-Headers list (e.g. stems_server.py and
    custom_server.py both allow DELETE; custom_server.py also allows the
    X-Annotator-Id header) instead of silently adopting the majority
    default. `with_content_type=True` reproduces the servers that fold
    "Content-Type": "application/json" into this same dict (dsp_server,
    mir_eval_server, msaf_server, ruptures_server, stems_server) rather than
    setting it as a separate send_header(...) call.
    """
    headers: dict = {}
    if with_content_type:
        headers["Content-Type"] = "application/json"
    headers["Access-Control-Allow-Origin"] = "*"
    headers["Access-Control-Allow-Headers"] = allow_headers
    headers["Access-Control-Allow-Methods"] = methods
    return headers


def time_ms(t0_ms: float) -> int:
    """Milliseconds elapsed since `t0_ms` (a `datetime.now().timestamp() *
    1000` reading taken at the start of a request)."""
    return int((datetime.now().timestamp() * 1000) - t0_ms)


def now_iso() -> str:
    """Current UTC time as an ISO-8601 string, seconds precision."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def err(algorithm: str, message: str, **extra) -> dict:
    """Build the common `{algorithm, ok: False, error}` error shape.

    Each server merges in its own domain-specific empty-collection keys
    (e.g. cue_extras_server passes cues=[], lyrics_server passes words=[],
    lines=[], span_server passes spans=[], ...) via `extra` so the returned
    JSON shape is unchanged from each server's prior local `_err`.
    """
    return {"algorithm": algorithm, "ok": False, "error": message, **extra}


def cached_result(cache_path: Path, force: bool = False, *, failed=None):
    """Return the cached payload at `cache_path`, or None to (re)compute.

    Every server here writes its result to disk even when the detector
    reported a failure, and that record is worth keeping — it is the only
    answer to "why is this detector dark". What it is not is a *result*. A
    failure in this system is almost never a fact about the song; it is a fact
    about the machine at one moment: a dependency not installed, ffmpeg not on
    PATH, a reference transcript not yet pasted. Those get fixed, and nothing
    tells the cache. So a plain `cache_path.exists()` turns a three-month-old
    missing dependency into today's error message, delivered in 0.0s, with no
    hint that the run never happened — and the annotator's only way out is to
    know to tick Force, which is knowledge they cannot have.

    Hence: a payload whose `ok` is False is a miss, and so is one that will not
    parse. Callers whose envelope marks trouble some other way pass `failed`
    (custom detectors report it as `fatal`). Payloads with no `ok` key at all —
    msaf's section list, mir's feature blob — are hits, unchanged.
    """
    if force or not cache_path.exists():
        return None
    try:
        payload = json.loads(cache_path.read_text())
    except Exception:
        return None  # corrupt / half-written cache → recompute over it
    if not isinstance(payload, dict):
        return payload
    if failed(payload) if failed is not None else payload.get("ok") is False:
        return None
    return payload


def write_result(cache_path: Path, payload: dict, deps_ok: bool) -> None:
    """Write a detector's payload to its cache file — unless the detector could
    not run at all because this machine is missing a dependency.

    A failure is worth keeping when it says something about the song. "torch
    not installed" says something about the machine, and the cache outlives
    the fix: the record kept being read back, from disk, months after the
    package went in, and the lane stayed empty with an error nobody could act
    on. Not writing it costs nothing — the request that hit the missing
    dependency still gets the error in its response, and /health reports it.
    """
    if not deps_ok:
        return
    try:
        cache_path.write_text(json.dumps(payload, indent=2))
    except Exception:
        pass


# ─── Analysing one span of a song instead of the whole thing ─────────────────
#
# DataPrep's Mapped grid mode splits a song into grid segments, each with its
# own tempo and meter. Detecting those from the whole file is useless — a
# song that changes tempo halfway gets one blended answer that is wrong for
# both halves. So the detect endpoints take an optional {start, end} and the
# detectors see only that span. The three helpers below are what every server
# needs to do that honestly: validate the span, hand the file-based detectors
# a file that holds only it, and put the answers back into song time.

# Below roughly two seconds a tempo estimate is noise: librosa's onset
# autocorrelation and madmom's RNN both need several beats to lock on.
MIN_RANGE_SECONDS = 2.0


def parse_range(
    body: dict,
    *,
    min_seconds: float = MIN_RANGE_SECONDS,
    reads: str = "a tempo",
) -> "tuple[float, float] | None":
    """Read the optional `{start, end}` span, in seconds, off a request body.

    Returns None when the caller asked about the whole song. Raises
    ValueError when a range is present but unusable — a caller that meant to
    analyse one grid segment must get a 400, never a whole-song answer
    silently attributed to the segment.

    `min_seconds` is the tempo detectors' floor by default, and `reads` names
    what the floor protects. A family whose answer doesn't need several beats
    to be meaningful lowers it: one mis-heard sung word is a legitimate window
    for the lyrics family, and refusing it would send the annotator back to
    re-running the whole song.
    """
    if body.get("start") is None and body.get("end") is None:
        return None
    try:
        start = float(body.get("start"))
        end = float(body.get("end"))
    except (TypeError, ValueError):
        raise ValueError("start and end must both be numbers of seconds")
    if not (math.isfinite(start) and math.isfinite(end)):
        raise ValueError("start and end must both be finite")
    if start < 0:
        raise ValueError("start must be at least 0")
    if end - start < min_seconds:
        raise ValueError(
            f"a range needs at least {min_seconds:g}s of audio to read "
            f"{reads} from; this one is {end - start:.3f}s"
        )
    return start, end


def decode_mono_16k(audio_path: Path):
    """Decode `audio_path` to a float32 mono waveform at 16 kHz, in-process.

    Both speech models here ship a loader that shells out to the `ffmpeg`
    binary — `whisper.load_audio` and `ctc_forced_aligner.load_audio` build the
    same `ffmpeg -f s16le -ac 1 -ar 16000 -` pipe. That binary is an undeclared
    dependency: the Docker images happen to install it, so the sidecar works in
    prod and the failure only shows up on a bare-metal run, as a bare
    `FileNotFoundError: 'ffmpeg'` from inside a library the caller never asked
    to run a subprocess.

    librosa is already a hard dependency of every one of these servers and
    decodes the same formats, so we hand the models samples instead of a path
    and the subprocess never happens. 16 kHz mono in [-1, 1] is exactly what
    both loaders produce.

    The work is librosa.load's own — soundfile to read, a channel mean, soxr
    HQ to resample — called directly, because importing librosa costs ~250 MB
    a server holds for life. librosa stays the fallback for what soundfile
    cannot read.
    """
    import numpy as np

    try:
        import soundfile as sf
        import soxr

        x, sr = sf.read(str(audio_path), dtype="float32", always_2d=True)
        y = x.mean(axis=1)
        if sr != 16000:
            y = soxr.resample(y, sr, 16000, quality="HQ")
        return np.asarray(y, dtype=np.float32)
    except Exception:
        import librosa

        y, _ = librosa.load(str(audio_path), sr=16000, mono=True)
        return np.asarray(y, dtype=np.float32)


@contextmanager
def trimmed_audio(audio_path: Path, start: float, end: float):
    """Yield the path to a temp WAV holding only `[start, end)` of `audio_path`.

    madmom and BeatNet take a *path*, not a sample array, so the only way to
    scope them to one grid segment is to hand them a file containing nothing
    else. Decoded at the source rate rather than a detector's working rate:
    resampling twice would cost the onset detectors high-frequency transients
    for no reason. The temp file goes away on exit, including on failure.
    """
    import librosa  # local: only servers that actually trim need these
    import soundfile as sf

    y, sr = librosa.load(
        str(audio_path), sr=None, mono=True,
        offset=max(0.0, float(start)),
        duration=max(0.0, float(end) - float(start)),
    )
    if len(y) == 0:
        raise ValueError(f"no audio between {start:.3f}s and {end:.3f}s")

    fd, name = tempfile.mkstemp(prefix="tc-range-", suffix=".wav")
    os.close(fd)
    tmp = Path(name)
    try:
        sf.write(str(tmp), y, int(sr))
        yield tmp
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def shift_times(result: dict, offset: float, keys=("beat_times", "downbeats")) -> dict:
    """Move a detector's timestamps out of range-local time back into song time.

    A detector handed a trimmed file answers about that file, counting from
    zero. Everything downstream — the beat grid, the segment table, the lane —
    speaks song time, so an unshifted result would drop every beat at the top
    of the song. Mutates and returns `result`.
    """
    if not offset:
        return result
    for key in keys:
        value = result.get(key)
        if isinstance(value, list):
            result[key] = [float(t) + offset for t in value]
    return result


# How long a model server keeps its models after the last request. A model
# reload costs seconds; a model left loaded costs gigabytes for as long as the
# server lives (one ivrit run leaves ~7 GB behind), so it goes after a few
# idle minutes.
MODEL_IDLE_SECONDS = float(os.environ.get("TC_MODEL_IDLE_SECONDS", "300"))

# Carries the listening socket across ModelServer's restart.
_SOCKET_FD_ENV = "TC_SERVER_SOCKET_FD"


def release_memory() -> None:
    """Collect what the last request left behind and empty torch's caches."""
    gc.collect()
    torch = sys.modules.get("torch")
    if torch is None:
        return
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        if getattr(torch, "mps", None) is not None and torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:
        pass


_model_used = False


def model_used() -> None:
    """Mark that the request in flight ran a model. Each `_ensure_*` loader
    calls it, so only real work — not /health polls — counts as use."""
    global _model_used
    _model_used = True


class ModelServer(HTTPServer):
    """An HTTPServer that gives its models' memory back once it sits idle.

    Dropping the model objects is not enough: torch and the C allocator keep
    the freed pages, and a server that ran ivrit once stays at 4+ GB after
    every reference is gone. Only a fresh process starts small. So after
    MODEL_IDLE_SECONDS without a model request, the server re-execs itself —
    same PID, same port, same log — handing the listening socket to the new
    image, so a request that arrives meanwhile waits in the backlog instead
    of being refused. The check runs in `service_actions`, on the serving
    thread between requests, so it never interrupts a request in flight.
    """

    def __init__(self, address, handler, idle_seconds: float = MODEL_IDLE_SECONDS):
        fd = os.environ.pop(_SOCKET_FD_ENV, None)
        if fd is None:
            super().__init__(address, handler)
        else:
            super().__init__(address, handler, bind_and_activate=False)
            self.socket.close()
            self.socket = socket.socket(fileno=int(fd))
            self.socket.set_inheritable(False)
            self.server_address = self.socket.getsockname()
            self.server_name = socket.getfqdn(self.server_address[0])
            self.server_port = self.server_address[1]
        self._idle_seconds = idle_seconds
        self._last_use: float | None = None

    def process_request(self, request, client_address):
        global _model_used
        try:
            super().process_request(request, client_address)
        finally:
            if _model_used:
                _model_used = False
                self._last_use = time.monotonic()
                release_memory()

    def service_actions(self):
        if self._last_use is None:
            return
        if time.monotonic() - self._last_use < self._idle_seconds:
            return
        print(f"Idle {self._idle_seconds:.0f}s with models loaded — restarting "
              f"to give their memory back.", file=sys.stderr, flush=True)
        sys.stdout.flush()
        fd = self.socket.fileno()
        os.set_inheritable(fd, True)
        os.environ[_SOCKET_FD_ENV] = str(fd)
        os.execv(sys.executable, sys.orig_argv)
