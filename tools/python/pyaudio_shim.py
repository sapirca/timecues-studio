"""Let BeatNet import without portaudio, for the offline path.

BeatNet does `import pyaudio` at module load (BeatNet/BeatNet.py:14) even
though the only use of it is opening a live input stream in realtime mode
(line 84). We run BeatNet exclusively offline — the sidecar hands it a file —
so that import is the single thing standing between a working detector and a
host without portaudio.

That host is not hypothetical. pyaudio links against libportaudio2, which
means a system package (`portaudio19-dev`, which docker/beatnet.Dockerfile
installs) or Homebrew. The maintainer's Mac has neither, so `pip install
pyaudio` fails to build there and BeatNet is simply unavailable — which in
turn means it cannot be scored by tools/python/beat_eval.py against the
corpus, and "we could not measure it" is a much worse answer than "it scored
poorly".

So: install a stub module exposing the two names BeatNet touches, but ONLY
when the real package is absent. A host that has real pyaudio keeps it, and
realtime mode there still works. On a host without it, realtime mode raises a
clear error the moment it is actually attempted, rather than at import.

Mirrors the approach in natten_shim.py, for the same reason: a dependency
that is unavailable on CPU-only / library-less hosts should not take a
working code path down with it.
"""

from __future__ import annotations

import sys


class _RealtimeUnavailable(RuntimeError):
    """Raised if something reaches for live audio through the stub."""


def _unavailable(*_args, **_kwargs):
    raise _RealtimeUnavailable(
        "pyaudio is not installed, so BeatNet's realtime mode is unavailable "
        "on this host. Offline detection (the only mode this project uses) "
        "does not need it. Install the portaudio system library and "
        "`pip install pyaudio` if you need live input."
    )


def apply_pyaudio_shim() -> bool:
    """Install a stub `pyaudio` when the real one is missing.

    Returns True if the stub was installed, False if real pyaudio was already
    importable and nothing was patched.
    """
    try:
        import pyaudio  # noqa: F401
        return False
    except ImportError:
        pass

    import types

    stub = types.ModuleType("pyaudio")
    # The two names BeatNet references. paFloat32's real value is 1; it is
    # only ever passed back into PyAudio().open(), which raises here anyway.
    stub.paFloat32 = 1
    stub.PyAudio = _unavailable
    stub.__doc__ = (
        "Stub installed by tools/python/pyaudio_shim.py — offline use only."
    )
    sys.modules["pyaudio"] = stub
    return True
