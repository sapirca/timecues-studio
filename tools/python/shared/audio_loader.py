"""
LOL v04 Audio Loader.

Unified audio loading using librosa with consistent sample rate.
"""

import librosa
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
