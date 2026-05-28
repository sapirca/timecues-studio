"""
LOL v04 Audio Loader.

Unified audio loading using librosa with consistent sample rate.
"""

import librosa
import numpy as np
from pathlib import Path

from .models import AudioData


def load_audio(file_path: str, sr: int = 22050) -> AudioData:
    """Load audio file and return AudioData.

    Args:
        file_path: Path to audio file (mp3, wav, etc.)
        sr: Target sample rate (default 22050 Hz)

    Returns:
        AudioData with mono audio, sample rate, and duration info.
    """
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Audio file not found: {file_path}")

    y, loaded_sr = librosa.load(file_path, sr=sr, mono=True)

    duration_seconds = len(y) / sr
    duration_ms = int(duration_seconds * 1000)

    return AudioData(
        y=y,
        sr=sr,
        duration_seconds=duration_seconds,
        duration_ms=duration_ms,
        file_path=str(path.absolute()),
    )


def frames_to_ms(frames: np.ndarray, sr: int, hop_length: int) -> np.ndarray:
    """Convert frame indices to milliseconds."""
    times_sec = librosa.frames_to_time(frames, sr=sr, hop_length=hop_length)
    return (times_sec * 1000).astype(int)


def ms_to_frames(ms: int, sr: int, hop_length: int) -> int:
    """Convert milliseconds to frame index."""
    seconds = ms / 1000.0
    return librosa.time_to_frames(seconds, sr=sr, hop_length=hop_length)


def ms_to_samples(ms: int, sr: int) -> int:
    """Convert milliseconds to sample index."""
    return int(ms * sr / 1000)
