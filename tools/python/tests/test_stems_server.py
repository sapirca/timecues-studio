"""Stems server job-state and payload-shape tests.

These cover the torch-free parts of the stems server: `Job` initialization,
the missing-audio early-error path, and the /api/stems/status payload shape.

The worker tests that drove a (mocked) separation to done/error/cancelled were
removed: the server now runs Demucs in a subprocess that the in-process mock no
longer intercepts, so they required a real torch install and gave false
coverage. Demucs itself is not exercised here.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_TOOLS_PY = Path(__file__).resolve().parents[1]
if str(_TOOLS_PY) not in sys.path:
    sys.path.insert(0, str(_TOOLS_PY))

import stems_server  # noqa: E402
from stems_server import Job, _run_separation  # noqa: E402


# ─── Helpers ─────────────────────────────────────────────────────────────────


class _FakeSeparator:
    """Stub matching the surface area `_run_separation` uses:
    `separator.separate(audio_path, out_dir, force=...)`.

    Set `raise_exc` to make `separate` raise, `cancel_on_call` to flip the
    job's cancel event mid-call (simulating a user cancel arriving during
    a long Demucs run)."""

    def __init__(self, *, raise_exc: BaseException | None = None,
                 cancel_on_call_for: Job | None = None) -> None:
        self.calls: list[tuple[Path, Path, bool]] = []
        self.raise_exc = raise_exc
        self.cancel_on_call_for = cancel_on_call_for

    def separate(self, audio_path: Path, out_dir: Path, *, force: bool = False) -> None:
        self.calls.append((audio_path, out_dir, force))
        # Pretend the heavy run logs something.
        print(f"separating {audio_path.name} → {out_dir}")
        if self.cancel_on_call_for is not None:
            self.cancel_on_call_for.cancel.set()
        if self.raise_exc is not None:
            raise self.raise_exc


@pytest.fixture(autouse=True)
def _isolate_module_state(monkeypatch, tmp_path):
    """Reset the lazily-cached separator + jobs dict around every test so they
    can't leak state into each other. STEMS_OUTPUT_DIR is redirected to
    tmp_path so we never touch the real web-app/public/stems tree."""
    monkeypatch.setattr(stems_server, "_demucs_separator", None, raising=False)
    monkeypatch.setattr(stems_server, "_demucs_import_error", None, raising=False)
    monkeypatch.setattr(stems_server, "STEMS_OUTPUT_DIR", tmp_path / "stems")
    monkeypatch.setattr(stems_server, "_jobs", {}, raising=False)
    yield


def _force_separator(monkeypatch, fake: _FakeSeparator | None) -> None:
    """Bypass the lazy importer so `_run_separation` sees our stub."""
    monkeypatch.setattr(stems_server, "_load_separator", lambda: fake)


def _force_audio(monkeypatch, audio_path: Path | None) -> None:
    """Bypass `find_audio` so we don't need a real song on disk."""
    monkeypatch.setattr(stems_server, "find_audio", lambda slug: audio_path)


# ─── Job init contract ───────────────────────────────────────────────────────


def test_job_initial_state():
    j = Job("a-slug")
    assert j.status == "running"
    assert j.logs == ""
    assert j.finished_at is None
    assert j.cancel.is_set() is False
    assert isinstance(j.started_at, int) and j.started_at > 0
    assert isinstance(j.id, str) and len(j.id) > 0
    # 6 stems unless the caller asks otherwise — the UI's default too.
    assert j.model == stems_server.DEFAULT_MODEL == "6s"


def test_job_records_requested_model():
    assert Job("a-slug", model="4s").model == "4s"


# ─── Model selection reaches the CLI ─────────────────────────────────────────


def _capture_demucs_cmd(monkeypatch, job: Job) -> list[str]:
    """Run `_run_separation` with a stubbed Popen and return the argv it built."""
    captured: list[list[str]] = []

    class _FakeProc:
        def __init__(self, cmd):
            captured.append(cmd)
            self.stdout = iter(["done\n"])

        def wait(self):
            return 0

    monkeypatch.setattr(
        stems_server.subprocess, "Popen",
        lambda cmd, **kwargs: _FakeProc(cmd),
    )
    _force_audio(monkeypatch, Path("/songs/song.mp3"))
    _run_separation(job, force=False)
    assert captured, "Popen was never called"
    return captured[0]


@pytest.mark.parametrize("model", ["6s", "4s"])
def test_run_separation_passes_model_to_cli(monkeypatch, model):
    """The job's model must reach demucs_separator.py as --model, otherwise a
    4-stem request silently runs the 6-stem model (and takes ~1.5x as long)."""
    cmd = _capture_demucs_cmd(monkeypatch, Job("song", model=model))
    assert "--model" in cmd
    assert cmd[cmd.index("--model") + 1] == model


# ─── Edge: no audio → status=error before separator is invoked ───────────────


def test_run_separation_missing_audio(monkeypatch):
    fake = _FakeSeparator()
    _force_separator(monkeypatch, fake)
    _force_audio(monkeypatch, None)

    job = Job("does-not-exist")
    _run_separation(job, force=False)

    assert job.status == "error"
    assert "no audio found" in job.logs
    assert "does-not-exist" in job.logs
    assert fake.calls == [], "separator should NOT be called when audio is missing"


# ─── Status-payload shape (the UI contract) ──────────────────────────────────


def test_status_payload_shape_matches_handler_path():
    """The do_GET /api/stems/status handler builds the payload from these
    fields. If a field is renamed on Job, the UI breaks silently because the
    handler reads attributes directly. Pin the field names here."""
    job = Job("song")
    job.status = "done"
    job.logs = "log line\n"
    job.finished_at = job.started_at + 5
    # Same construction as stems_server.Handler.do_GET (lines 252-258).
    payload = {
        "status": job.status,
        "logs": job.logs,
        "startedAt": job.started_at,
        "model": job.model,
    }
    if job.finished_at is not None:
        payload["finishedAt"] = job.finished_at
    assert set(payload.keys()) == {"status", "logs", "startedAt", "finishedAt", "model"}
    assert payload["status"] == "done"
    assert payload["finishedAt"] >= payload["startedAt"]
