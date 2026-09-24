"""Absolute + relative audio-energy gate for per-stem detectors.

Why this exists
---------------
Note/onset detectors (basic-pitch, librosa-onsets) score events *relative to
each stem's own dynamics*. basic-pitch's per-note `amplitude` is model
note-salience, not loudness; librosa's onset strength is normalized by the
stem's own peak. So when these run on a Demucs stem that is *nearly silent*
(e.g. a piano stem that is mostly separation bleed and artifacts), they still
emit lots of events — the model/peak-picker is confident about content that is
inaudible in the actual audio.

The gate asks the question those detectors don't: *is the audio actually
audible at this moment?* It drops events that fall in regions whose local RMS
is below both:

  * an ABSOLUTE floor (`abs_floor_db`, dBFS) — the stem is essentially silent
    here in absolute terms (catches a stem that is uniformly low-level bleed),
  * a RELATIVE floor (`rel_floor_db` below the stem's own peak RMS) — this
    moment is far quieter than the stem's loudest content (catches gaps and
    bleed between the real notes of an otherwise-active stem).

An event survives only if its local peak RMS clears
`max(abs_floor_db, stem_peak_db - rel_floor_db)`.

Pure librosa + numpy. Returns booleans, never mutates the caller's events.
"""

from __future__ import annotations

from typing import Optional, Sequence

import librosa
import numpy as np

# Defaults tuned for Demucs stems normalized to a 1.0 peak scale. -55 dBFS is
# below anything a listener would call "present"; 38 dB of intra-stem dynamic
# range keeps quiet-but-real passages while cutting between-note bleed.
ABS_FLOOR_DB = -55.0
REL_FLOOR_DB = 38.0

_FRAME_LENGTH = 2048
_HOP_LENGTH = 512
_EPS = 1e-10


class EnergyGate:
    """Per-stem RMS envelope plus the keep/drop decision for time windows."""

    def __init__(
        self,
        y: np.ndarray,
        sr: int,
        *,
        abs_floor_db: float = ABS_FLOOR_DB,
        rel_floor_db: float = REL_FLOOR_DB,
    ) -> None:
        self.sr = sr
        self.abs_floor_db = abs_floor_db
        self.rel_floor_db = rel_floor_db
        if y is None or len(y) == 0:
            self._db = np.array([], dtype=float)
            self._peak_db = -np.inf
            self._threshold_db = abs_floor_db
            return
        rms = librosa.feature.rms(
            y=y, frame_length=_FRAME_LENGTH, hop_length=_HOP_LENGTH,
        )[0]
        self._db = 20.0 * np.log10(np.maximum(rms, _EPS))
        self._peak_db = float(self._db.max()) if self._db.size else -np.inf
        self._threshold_db = max(abs_floor_db, self._peak_db - rel_floor_db)

    @property
    def threshold_db(self) -> float:
        return self._threshold_db

    @property
    def peak_db(self) -> float:
        return self._peak_db

    def _frame(self, t: float) -> int:
        return int(round(t * self.sr / _HOP_LENGTH))

    def window_peak_db(self, start_s: float, end_s: float) -> float:
        """Loudest RMS frame (dBFS) overlapping [start_s, end_s]."""
        if self._db.size == 0:
            return -np.inf
        lo = max(0, self._frame(start_s))
        hi = min(self._db.size, max(lo + 1, self._frame(end_s) + 1))
        return float(self._db[lo:hi].max())

    def passes(self, start_s: float, end_s: float) -> bool:
        """True if the audio is audible anywhere in [start_s, end_s]."""
        if self._db.size == 0:
            return True  # no envelope (silent/empty load) → don't gate
        return self.window_peak_db(start_s, end_s) >= self._threshold_db


def gate_note_events(
    events: Sequence[dict],
    y: np.ndarray,
    sr: int,
    *,
    start_key: str = "time",
    end_key: str = "end",
    abs_floor_db: float = ABS_FLOOR_DB,
    rel_floor_db: float = REL_FLOOR_DB,
) -> tuple[list[dict], int]:
    """Filter note dicts (start/end seconds) to those in audible regions.

    Returns (kept_events, dropped_count).
    """
    gate = EnergyGate(
        y, sr, abs_floor_db=abs_floor_db, rel_floor_db=rel_floor_db,
    )
    kept = [
        ev for ev in events
        if gate.passes(
            float(ev.get(start_key, 0.0)),
            float(ev.get(end_key, ev.get(start_key, 0.0))),
        )
    ]
    return kept, len(events) - len(kept)


def gate_point_events(
    events: Sequence[dict],
    y: np.ndarray,
    sr: int,
    *,
    time_key: str = "time",
    pre_s: float = 0.03,
    post_s: float = 0.07,
    abs_floor_db: float = ABS_FLOOR_DB,
    rel_floor_db: float = REL_FLOOR_DB,
) -> tuple[list[dict], int]:
    """Filter instantaneous events (onsets) by audibility around their attack.

    Returns (kept_events, dropped_count).
    """
    gate = EnergyGate(
        y, sr, abs_floor_db=abs_floor_db, rel_floor_db=rel_floor_db,
    )
    kept = [
        ev for ev in events
        if gate.passes(
            float(ev.get(time_key, 0.0)) - pre_s,
            float(ev.get(time_key, 0.0)) + post_s,
        )
    ]
    return kept, len(events) - len(kept)


def load_mono(audio_path, sr: int = 22050) -> tuple[Optional[np.ndarray], int]:
    """Load audio mono at `sr` for gating. Returns (y, sr); (None, sr) on fail."""
    try:
        y, sr = librosa.load(str(audio_path), sr=sr, mono=True)
        return y, sr
    except Exception:
        return None, sr
