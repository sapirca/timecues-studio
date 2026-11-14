#!/usr/bin/env python3
"""
Whisper-base vocal-transcription sidecar — opens the LYRICS family.
Also serves `ivrit` (ivrit.ai's Hebrew speech model, for Hebrew songs)
and `ctc-forced-aligner` (aligns a pasted transcript).

OpenAI Whisper "base" model: ~140 MB checkpoint lazy-downloaded into the
shared `timecues-model-cache` named volume on first detect, then reused.
CPU-only torch wheels keep the image multi-platform.

Output is a `LyricsItem`-compatible list of word-level entries with
start/end times, suitable for the LyricsLayer schema. Word-level
timestamps from base Whisper are coarse (~200 ms granularity); WhisperX
or a forced-aligner refinement is the planned Phase 5 follow-up.

Endpoints
---------
  GET  /api/lyrics/health             → server up + dep availability
  GET  /api/lyrics/algorithms         → [{ id, name, available, description }]
  GET  /api/lyrics/detect/:slug/:algo → cached result, or null
  POST /api/lyrics/detect             { slug, algo, stem?, force?, language?,
                                        text?, start?, end?, pad? }
  POST /api/lyrics/merge              { slug, algo, stem?, start, end, words[] }
  POST /api/lyrics/initialize         { algo }

Re-transcribing one section
---------------------------
A whole-song transcription is a single take: where it mis-hears a line, or
skips one entirely, there is nothing to do about that line short of running
the whole song again and hoping. So `/detect` also takes a `{start, end}`
window — it transcribes only that slice of the chosen stem, shifts the word
times back into song time, and returns them *without* touching the cache.
`/merge` is the second half: it writes a set of words into the cached result
for one window, replacing whatever the full run heard there. Together they
let an annotator repair one line — or fill a gap the full run left silent —
against a cleaner stem, without discarding the rest of the take.

Output schema
-------------
  {
    "slug":        str,
    "audio_file":  str,
    "algorithm":   str,
    "duration":    float,
    "language":    str | null,
    "words": [
      {
        "time":   float,    # word onset (seconds)
        "end":    float,    # word offset
        "text":   str,
        "kind":   "word"
      }
    ],
    "lines": [
      {
        "time":   float,    # segment start
        "end":    float,    # segment end
        "text":   str,
        "kind":   "line"
      }
    ],
    "ms":          int,
    "computed_at": str
  }

Cache
-----
  data/algorithm-outputs/lyrics/<slug>/<algo>.json
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import warnings
from datetime import datetime
from http.server import BaseHTTPRequestHandler
from importlib.util import find_spec
from pathlib import Path

warnings.filterwarnings("ignore")

PORT = 8016

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import (  # noqa: E402
    find_audio, stem_audio, cache_name, LYRICS_OUTPUTS_DIR as CACHE_DIR,
    DATA_DIR, DEFAULT_DATA_DIR,
)
from server_common import (  # noqa: E402
    cached_result, write_result, cors_headers, decode_mono_16k, err as _common_err, now_iso,
    parse_range, time_ms, trimmed_audio, ModelServer, model_used, release_memory,
)

CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _load_reference_text(slug: str) -> str | None:
    """The per-song reference lyrics saved by the Lyrics text panel
    (data/lyrics-text/<slug>.txt, with a data-default seed fallback). Lets any
    caller — including the CLI curated pipeline — run ctc-forced-aligner without
    threading the transcript through, mirroring what the web run path posts."""
    for base in (DATA_DIR, DEFAULT_DATA_DIR):
        p = base / "lyrics-text" / f"{slug}.txt"
        try:
            if p.is_file():
                txt = p.read_text(encoding="utf-8").strip()
                if txt:
                    return txt
        except Exception:
            pass
    return None

try:
    import numpy as np  # noqa: F401
    _NUMPY_OK = True
except ImportError:
    _NUMPY_OK = False

def _installed(name: str) -> bool:
    """Whether `name` can be imported — without importing it. torch and
    transformers cost ~350 MB the moment they load, so the server only pays
    that when a detector that needs them actually runs."""
    try:
        return find_spec(name) is not None
    except Exception:
        return False


_TORCH_OK = _installed("torch")
_WHISPER_OK = _installed("whisper")

# ctc-forced-aligner — MIT, MahmoudAshraf97/ctc-forced-aligner.
# We pin it to facebook/wav2vec2-base-960h (Apache-2.0) at call time so the
# default CC-BY-NC MMS_FA model is never downloaded by this server.
_CTC_FA_OK = _installed("ctc_forced_aligner")

CTC_FA_MODEL_PATH = "facebook/wav2vec2-base-960h"
# The English model's alphabet is A–Z and an apostrophe, so Hebrew lyrics align
# against a Hebrew one: imvladikon's XLSR-53 fine-tune (Apache-2.0), whose
# vocabulary is exactly the 27 Hebrew letters. The xls-r-300m sibling scores
# better but publishes no licence, so it is not an option.
CTC_FA_HEBREW_MODEL_PATH = "imvladikon/wav2vec2-large-xlsr-53-hebrew"

# Ivrit — ivrit.ai's Hebrew speech-recognition model, Apache-2.0 weights
# (the crowd-transcribe / Knesset training sets are CC-BY-4.0 with a "training
# only, no deep-fakes" rider, which binds whoever trains on them, not us).
IVRIT_MODEL_PATH = "ivrit-ai/whisper-large-v3-turbo"
# It runs through CTranslate2 (faster-whisper) on int8 weights, not
# transformers at fp32: one song peaked at 10.5 GB the old way and ~1.7 GB this
# way, which fits the lyrics container's 2 GB. The int8 copy is converted from
# the checkpoint once (`--prepare-ivrit`) — at image build in Docker, on first
# use on bare metal — because converting holds the fp32 weights (~3.5 GB).
IVRIT_CT2_DIR = Path(
    os.environ.get("TC_IVRIT_CT2_DIR")
    or Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "timecues" / "ivrit-ct2-int8"
)
_FASTER_WHISPER_OK = _installed("faster_whisper")

# Process-wide model cache. Whisper-base load takes ~3 s on first call.
_whisper_model = None
# CTC aligners by script ("en" / "he"), each (model, tokenizer).
_ctc_fa: dict[str, tuple] = {}
_ivrit_model = None


def _drop_models_except(keep: str) -> None:
    """Hold one model at a time. The lyrics container's cap fits the biggest
    of them, not all of them at once, so loading one lets the others go."""
    global _whisper_model, _ivrit_model
    if keep != "whisper":
        _whisper_model = None
    if keep != "ivrit":
        _ivrit_model = None
    if keep != "ctc":
        _ctc_fa.clear()
    release_memory()


def _err(algo: str, msg: str) -> dict:
    return _common_err(algo, msg, words=[], lines=[])


def _ensure_whisper():
    """Lazy-load Whisper-base. Triggers a ~140 MB checkpoint download into
    ~/.cache/whisper/ on first call. Model stays in process memory until the
    server sits idle (see server_common.ModelServer)."""
    global _whisper_model
    model_used()
    if _whisper_model is not None:
        return
    _drop_models_except("whisper")
    import whisper
    _whisper_model = whisper.load_model("base")


def _ensure_ctc_fa(script: str = "en") -> tuple:
    """Lazy-load the CTC forced aligner for `script`: wav2vec2-base-960h for
    English (~360 MB), the Hebrew XLSR-53 fine-tune for Hebrew (~1.3 GB), both
    Apache-2.0, downloaded into ~/.cache/huggingface/ on first call."""
    model_used()
    if script not in _ctc_fa:
        # The other script's aligner goes too: one model at a time.
        _drop_models_except("ctc")
        _ctc_fa.clear()
        import torch
        from ctc_forced_aligner import load_alignment_model
        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if device == "cuda" else torch.float32
        path = CTC_FA_HEBREW_MODEL_PATH if script == "he" else CTC_FA_MODEL_PATH
        model, tokenizer = load_alignment_model(device, model_path=path, dtype=dtype)
        _ctc_fa[script] = (model, _CtcVocab(tokenizer, model.config))
    return _ctc_fa[script]


class _CtcVocab:
    """A tokenizer cut down to the tokens the model actually emits.

    The Hebrew checkpoint's tokenizer carries four added tokens (`<s>`, `</s>`,
    `<pad>`, `<unk>`) past the 31 the CTC head outputs, and names the added
    `<pad>` as its pad token — which the aligner would take for the blank,
    an id the model can never emit. So the vocabulary stops at the head's
    width and the blank is the model config's pad id (`[PAD]`).
    """

    def __init__(self, tokenizer, config):
        width = int(config.vocab_size)
        self._vocab = {k: i for k, i in tokenizer.get_vocab().items() if i < width}
        self.vocab_size = len(self._vocab)
        self.pad_token_id = int(config.pad_token_id)

    def get_vocab(self) -> dict[str, int]:
        return dict(self._vocab)


def _lyrics_script(text: str) -> str:
    """"he" when the lyrics are mostly Hebrew letters, else "en"."""
    hebrew = sum(1 for c in text if "א" <= c <= "ת")
    latin = sum(1 for c in text if c.isascii() and c.isalpha())
    return "he" if hebrew > latin else "en"


def _ctc_words(text: str, vocab: set[str]) -> list[tuple[str, str]]:
    """Split the lyrics into (word as written, its letters the model knows).

    The aligner silently drops every character outside the model's vocabulary
    when it builds the target, then walks the undropped text and asserts the
    two agree — so one stray letter (a Hebrew `י` for the English model, a
    digit, niqqud) failed the whole song. Each word is cut down to the
    alphabet first; a word with nothing left (a number, a dash) is not
    aligned at all rather than guessed at.
    """
    out = []
    for word in text.split():
        letters = "".join(c for c in word.lower() if c in vocab)
        if letters:
            out.append((word, letters))
    return out


def prepare_ivrit() -> Path:
    """Convert the Ivrit checkpoint to int8 CTranslate2 in IVRIT_CT2_DIR, once.
    Downloads the ~3.2 GB checkpoint into ~/.cache/huggingface/ and needs
    transformers + torch; the result is ~790 MB."""
    if (IVRIT_CT2_DIR / "model.bin").is_file():
        return IVRIT_CT2_DIR
    import shutil
    from ctranslate2.converters import TransformersConverter
    IVRIT_CT2_DIR.parent.mkdir(parents=True, exist_ok=True)
    partial = IVRIT_CT2_DIR.with_name(IVRIT_CT2_DIR.name + ".partial")
    TransformersConverter(
        IVRIT_MODEL_PATH,
        copy_files=["tokenizer.json", "preprocessor_config.json"],
        low_cpu_mem_usage=True,
    ).convert(str(partial), quantization="int8", force=True)
    shutil.rmtree(IVRIT_CT2_DIR, ignore_errors=True)
    partial.rename(IVRIT_CT2_DIR)
    return IVRIT_CT2_DIR


def _ensure_ivrit():
    """Lazy-load Ivrit's int8 CTranslate2 model (~0.9 GB resident). Converts
    it first if missing — in a child process, so the fp32 weights the
    conversion holds never land in the server."""
    global _ivrit_model
    model_used()
    if _ivrit_model is not None:
        return
    _drop_models_except("ivrit")
    if not (IVRIT_CT2_DIR / "model.bin").is_file():
        subprocess.run([sys.executable, str(Path(__file__).resolve()), "--prepare-ivrit"], check=True)
    from faster_whisper import WhisperModel
    # TC_IVRIT_CPU_THREADS caps the cores a run takes (0 = CTranslate2's
    # default, 4) — on a 2-vCPU VM, or to keep a laptop's fan down.
    _ivrit_model = WhisperModel(
        str(IVRIT_CT2_DIR), device="auto", compute_type="int8",
        cpu_threads=int(os.environ.get("TC_IVRIT_CPU_THREADS", "0")),
    )


# A silence longer than this between two words ends the line. Coarse, but it
# is the same reading Whisper's own segmentation makes, so per-word results
# from either detector split into lines the same way.
LINE_GAP_SECONDS = 0.6

# Context handed to the model on each side of a re-run window. A word clipped
# mid-syllable is a word the model mis-hears, so it hears the neighbours too —
# and then we throw the neighbours away (`_within`).
RANGE_PAD_SECONDS = 1.0


def _lines_from_words(words: list[dict]) -> list[dict]:
    """Group per-word entries into `kind: "line"` entries on silence."""
    lines: list[dict] = []
    current: list[dict] = []

    def flush() -> None:
        if current:
            lines.append({
                "time":  current[0]["time"],
                "end":   current[-1]["end"],
                "text":  " ".join(w["text"] for w in current),
                "kind":  "line",
            })
            current.clear()

    for w in words:
        if current and (float(w["time"]) - float(current[-1]["end"])) > LINE_GAP_SECONDS:
            flush()
        current.append(w)
    flush()
    return lines


def _shift(rows: list[dict], offset: float) -> list[dict]:
    """Put a trimmed file's answers back into song time."""
    out = []
    for r in rows:
        t = float(r.get("time", 0.0))
        out.append({**r, "time": t + offset, "end": float(r.get("end", t)) + offset})
    return out


def _within(rows: list[dict], start: float, end: float) -> list[dict]:
    """The rows that overlap [start, end). A word straddling an edge belongs to
    the window — half a word is not a word."""
    return [
        r for r in rows
        if float(r.get("end", r.get("time", 0.0))) > start and float(r.get("time", 0.0)) < end
    ]


def _outside(rows: list[dict], start: float, end: float) -> list[dict]:
    """The rows a window replacement keeps — everything it does not overlap."""
    keep = {id(r) for r in _within(rows, start, end)}
    return [r for r in rows if id(r) not in keep]


def _audio_for_model(audio_path: Path):
    """Decoded samples for a speech model, or None to let it load the file.

    None means "librosa could not read this one" — a format its backends don't
    cover, a truncated file. Falling back to the model's own ffmpeg loader
    keeps whatever worked before working; where ffmpeg is missing too, the
    error the caller sees is the real one about the file, not about a binary.
    """
    try:
        return decode_mono_16k(audio_path)
    except Exception:
        return None


def detect_whisper_base(audio_path: Path, language: str | None = None) -> dict:
    algo = "whisper-base"
    if not (_WHISPER_OK and _TORCH_OK and _NUMPY_OK):
        return _err(algo, "whisper / torch / numpy not installed")
    t0 = datetime.now().timestamp() * 1000
    try:
        _ensure_whisper()
        # word_timestamps=True triggers Whisper's cross-attention DTW pass
        # to estimate per-word timing — coarse but real.
        # condition_on_previous_text=False: conditioned, the decoder re-reads
        # the last line it heard at the end of each 30 s window and writes it
        # again, every word squeezed onto the cut — a narrated intro came back
        # five times at 30 s spacing, each copy zero seconds long.
        kwargs = {"word_timestamps": True, "condition_on_previous_text": False}
        if language:
            kwargs["language"] = language
        # Samples, not a path: handed a path, Whisper decodes it by piping the
        # file through the `ffmpeg` binary, which the Docker image installs and
        # a bare-metal host generally does not. See decode_mono_16k().
        samples = _audio_for_model(audio_path)
        result = _whisper_model.transcribe(  # type: ignore[union-attr]
            str(audio_path) if samples is None else samples, **kwargs,
        )

        words: list[dict] = []
        lines: list[dict] = []
        for seg in result.get("segments", []):
            seg_start = float(seg.get("start", 0.0))
            seg_end   = float(seg.get("end", seg_start))
            seg_text  = str(seg.get("text", "")).strip()
            seg_words: list[dict] = []
            for w in seg.get("words", []) or []:
                wt = float(w.get("start", seg_start))
                we = float(w.get("end", wt))
                wtxt = str(w.get("word", "")).strip()
                # A sung word takes time. One with none has no place on the
                # timeline: the DTW pass ran out of audio and stacked it on the
                # window's last frame (see _drop_decoder_loops, MIN_WORD_S).
                if not wtxt or we - wt < MIN_WORD_S:
                    continue
                seg_words.append({
                    "time": wt, "end": we,
                    "text": wtxt, "kind": "word",
                    "prob": round(float(w.get("probability", 0.0)), 3),
                })
            # A line whose every word collapsed is the same failure, whole.
            if seg.get("words") and not seg_words:
                continue
            words.extend(seg_words)
            if seg_text:
                # How sure Whisper was of the line, in its own terms — what its
                # decoder checks to call a line a hallucination (log-prob under
                # -1, compression ratio over 2.4, no-speech over 0.6). Kept so a
                # reader can tell sung words from words Whisper made up over
                # music or gibberish (see wordless_vocals.whisper_real_words).
                lines.append({
                    "time": seg_start, "end": seg_end,
                    "text": seg_text, "kind": "line",
                    "avg_logprob": round(float(seg.get("avg_logprob", 0.0)), 3),
                    "no_speech_prob": round(float(seg.get("no_speech_prob", 0.0)), 3),
                    "compression_ratio": round(float(seg.get("compression_ratio", 0.0)), 3),
                })

        return {
            "algorithm": algo,
            "ok":        True,
            "words":     words,
            "lines":     lines,
            "language":  result.get("language"),
            "duration":  float(lines[-1]["end"]) if lines else 0.0,
            "ms":        time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


# Characters a Hebrew transcript carries that are not text: the bidi controls
# Whisper emits around right-to-left runs, and U+FFFD where a chunk boundary
# split a multi-byte letter's tokens.
_NOT_TEXT = re.compile("[‎‏‪-‮⁦-⁩�]")
# No word holds one letter five times running — that is a held note ("אהההה")
# the decoder kept spelling out.
_HELD_NOTE = re.compile(r"(\w)\1{4,}")
# "כן, כן, כן, כן" is a lyric; the same word forty times is the decoder stuck
# in a loop over a melisma. A repeat — of one word or of a short phrase like
# "אוהו נה" — that runs past this many words is dropped whole.
MAX_REPEATED_WORD = 8
LOOP_MAX_PHRASE = 3
# Shorter than any sung syllable.
MIN_WORD_S = 0.02


def _drop_decoder_loops(words: list[dict]) -> list[dict]:
    """Remove what Whisper writes when it loses the thread on sustained
    singing: held-note spellings and runs of one word repeated past any lyric.
    Precision over recall — a dropped run costs a few real repeats at most,
    a kept one paints a minute of the lane with nonsense."""
    clean: list[dict] = []
    for w in words:
        text = _NOT_TEXT.sub("", w["text"]).strip()
        if not text or _HELD_NOTE.search(text):
            continue
        # A sung word takes time. One with none is the decoder emitting a
        # last token at the very end of its audio, after the singing.
        if float(w["end"]) - float(w["time"]) < MIN_WORD_S:
            continue
        clean.append({**w, "text": text})

    keys = [re.sub(r"\W", "", w["text"]) for w in clean]
    drop = [False] * len(clean)
    for size in range(1, LOOP_MAX_PHRASE + 1):
        i = 0
        while i + size <= len(keys):
            j = i + size
            # Extend while the next `size` words repeat the phrase at i.
            while j + size <= len(keys) and keys[j:j + size] == keys[i:i + size]:
                j += size
            if j - i > MAX_REPEATED_WORD:
                drop[i:j] = [True] * (j - i)
                i = j
            else:
                i += 1
    return [w for w, d in zip(clean, drop) if not d]


IVRIT_SR = 16000
# A piece is at most this long — the model hears 30 s at a time, and a little
# headroom keeps a word that runs past the cut inside the piece.
PHRASE_MAX_S = 28.0
# Below this, a piece is cut short only by a real pause, never by length.
PHRASE_MIN_S = 8.0
# A pause this long ends a piece wherever it falls: a breath between lines.
PAUSE_S = 1.0
# Shorter than this, a piece joins its neighbour.
PHRASE_SHORT_S = 2.0
# Sound this far under the stem's loud passages counts as silence — never
# sent to the model.
SILENCE_DB = 40.0
# Sound this far under counts as a breath: a piece may end there, and no word
# starts in one. Softer than silence, because a singer's breath between lines
# is rarely 40 dB down.
BREATH_DB = 30.0


def _levels(samples, sr: int = IVRIT_SR):
    """Loudness per 10 ms frame (200 ms smoothing), in dB under the stem's loud
    passages (its 99th percentile) — so 0 is loud and -40 is silence."""
    import numpy as np
    hop = sr // 100
    n = len(samples) // hop
    if n == 0:
        return np.zeros(0)
    power = (samples[:n * hop].astype(np.float64) ** 2).reshape(n, hop).mean(axis=1)
    power = np.convolve(power, np.ones(20) / 20, mode="same")
    db = 10 * np.log10(power + 1e-12)
    return db - np.percentile(db, 99)


def _onsets_on_voice(words: list[dict], samples, sr: int = IVRIT_SR) -> list[dict]:
    """Move a word that starts in a breath to where the voice comes in.

    The model pins the first word of a piece to the start of its audio, which
    is the lead-in before anyone sings. A word cannot begin in a breath, so
    when one does and the voice starts inside the word, its onset moves there.
    On a full mix there is always sound, and nothing moves.
    """
    import numpy as np
    db = _levels(samples, sr)
    sung = db > -BREATH_DB
    out = []
    for w in words:
        i, j = int(w["time"] * 100), int(w["end"] * 100)
        if 0 <= i < len(sung) and not sung[i]:
            on = np.flatnonzero(sung[i:max(j, i + 1)])
            if on.size:
                w = {**w, "time": (i + int(on[0])) / 100}
        out.append(w)
    return out


def _phrases(samples, sr: int = IVRIT_SR) -> list[tuple[float, float]]:
    """Cut a stem into pieces the model can hear whole, at the singer's pauses.

    Fixed 30 s windows put a cut wherever the clock says, and a word that
    straddles one comes back pinned to the window edge — the song's timings
    clustered on multiples of 20 s. So a piece ends at the first pause of at
    least PAUSE_S, or, when the singing runs on for PHRASE_MAX_S without one,
    at the quietest moment between PHRASE_MIN_S and PHRASE_MAX_S. A pause is
    measured at BREATH_DB, softer than silence: a breath between lines. Stretches
    with nothing above the silence floor are never sent at all: silence and
    held notes are where Whisper-family models invent text.
    """
    import numpy as np
    db = _levels(samples, sr)
    n = len(db)
    if n == 0:
        return []
    voiced = db > -SILENCE_DB
    breath = db <= -BREATH_DB
    pause, lo_min, lo_max = int(PAUSE_S * 100), int(PHRASE_MIN_S * 100), int(PHRASE_MAX_S * 100)

    out: list[tuple[float, float]] = []
    i = 0
    while True:
        on = np.flatnonzero(voiced[i:])
        if on.size == 0:
            break
        start = max(i, i + int(on[0]) - 20)  # 200 ms of lead-in
        limit = min(n, start + lo_max)
        end = limit
        # The first long-enough pause inside the allowed length ends the piece.
        quiet = 0
        for k in range(start + 20, limit):
            quiet = quiet + 1 if breath[k] else 0
            if quiet >= pause:
                end = k - pause + 20  # keep 200 ms of the tail
                break
        else:
            if limit < n:
                lo = start + lo_min
                end = lo + int(np.argmin(db[lo:limit]))
        out.append((start / 100, end / 100))
        i = max(end, start + 1)

    # A breath or a single shout makes a piece too short to read — the model
    # guesses at half a second of audio. Fold it into its neighbour, gap and
    # all, while the two still fit in one window.
    merged: list[tuple[float, float]] = []
    for a, b in out:
        if merged and (b - a < PHRASE_SHORT_S or merged[-1][1] - merged[-1][0] < PHRASE_SHORT_S) \
                and b - merged[-1][0] <= PHRASE_MAX_S:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    return merged


def detect_ivrit(audio_path: Path, language: str | None = None) -> dict:
    """Hebrew transcription with Ivrit, ivrit.ai's Hebrew speech model.

    `language` is ignored: the model no longer detects language reliably,
    and its model card says to pin the language token to Hebrew — so this
    detector is always Hebrew, which is the only reason to pick it over
    whisper-base.
    """
    algo = "ivrit"
    if not (_FASTER_WHISPER_OK and _NUMPY_OK):
        return _err(algo, "faster-whisper / numpy not installed")
    t0 = datetime.now().timestamp() * 1000
    try:
        _ensure_ivrit()
        samples = _audio_for_model(audio_path)
        if samples is None:
            raise RuntimeError(f"could not decode {audio_path.name}")
        words: list[dict] = []
        # One phrase at a time, never the whole song: memory stays at one
        # 30 s window, and no word is cut by a window edge (see _phrases).
        for lo, hi in _phrases(samples):
            piece = samples[int(lo * IVRIT_SR):int(hi * IVRIT_SR)]
            # word_timestamps runs the same cross-attention DTW as
            # whisper-base's, over the checkpoint's own alignment heads.
            # Greedy, one temperature, no skipping "no speech" — what the
            # transformers pipeline did, so a piece reads the same way.
            segments, _ = _ivrit_model.transcribe(  # type: ignore[union-attr]
                piece, language="he", task="transcribe", word_timestamps=True,
                beam_size=1, temperature=0.0, condition_on_previous_text=False,
                no_speech_threshold=None,
            )
            for seg in segments:
                for w in seg.words or []:
                    wtxt = w.word.strip()
                    if not wtxt:
                        continue
                    wt = min(float(w.start), hi - lo)
                    we = min(float(w.end), hi - lo)
                    words.append({"time": lo + wt, "end": lo + max(we, wt), "text": wtxt, "kind": "word"})
        words.sort(key=lambda w: (w["time"], w["end"]))
        words = _drop_decoder_loops(_onsets_on_voice(words, samples))
        # The pipeline returns words without Whisper's segments, so silence
        # draws the lines — the same reading as ctc-forced-aligner.
        lines = _lines_from_words(words)

        return {
            "algorithm": algo,
            "ok":        True,
            "words":     words,
            "lines":     lines,
            "language":  "he",
            "duration":  float(words[-1]["end"]) if words else 0.0,
            "ms":        time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


def detect_ctc_forced_aligner(
    audio_path: Path,
    language: str | None = None,  # unused — the lyrics' own script decides
    reference_text: str | None = None,
) -> dict:
    """Forced-align `reference_text` against the audio using a CTC log-prob
    Viterbi alignment over wav2vec2 — the English model, or the Hebrew one
    when the lyrics are written in Hebrew. Returns word-level start/end
    timestamps locked to the reference's word sequence — much tighter than
    Whisper's cross-attention DTW estimate.

    Requires `reference_text`: without a transcript there is nothing to
    align against. Whisper-base is the right algorithm when no transcript
    exists.
    """
    algo = "ctc-forced-aligner"
    if not (_CTC_FA_OK and _TORCH_OK and _NUMPY_OK):
        return _err(algo, "ctc-forced-aligner / torch / numpy not installed")
    if not reference_text or not reference_text.strip():
        return _err(algo, "no reference lyrics text — open the Lyrics text panel and paste the song's lyrics first")
    t0 = datetime.now().timestamp() * 1000
    try:
        import torch
        from ctc_forced_aligner import (
            load_audio,
            generate_emissions,
            get_alignments,
            get_spans,
            postprocess_results,
        )
        script = _lyrics_script(reference_text)
        model, tokenizer = _ensure_ctc_fa(script)
        vocab = {k.lower() for k in tokenizer.get_vocab() if len(k) == 1 and k != "|"}
        pairs = _ctc_words(reference_text, vocab)
        if not pairs:
            return _err(algo, "the lyrics have no letters the aligner can read")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        # Both models expect 16 kHz mono — which is what decode_mono_16k
        # returns, so the model's own loader (another `ffmpeg` subprocess, see
        # detect_whisper_base) is only the fallback.
        samples = _audio_for_model(audio_path)
        audio_waveform = (
            torch.from_numpy(samples).to(model.dtype).to(device)
            if samples is not None
            else load_audio(str(audio_path), model.dtype, device)
        )
        # One target per word, spelled in the model's letters and separated by
        # <star> — the library's preprocess_text layout — while the text
        # carried through to the result is the word as the lyrics wrote it.
        tokens_starred: list[str] = []
        text_starred: list[str] = []
        for word, letters in pairs:
            tokens_starred += ["<star>", " ".join(letters)]
            text_starred += ["<star>", word]
        emissions, stride = generate_emissions(model, audio_waveform, batch_size=1)
        segments, scores, blank_token = get_alignments(emissions, tokens_starred, tokenizer)
        spans = get_spans(tokens_starred, segments, blank_token)
        word_timestamps = postprocess_results(text_starred, spans, stride, scores)

        words: list[dict] = []
        for w in word_timestamps:
            wt = float(w.get("start", 0.0))
            we = float(w.get("end", wt))
            wtxt = str(w.get("text", "")).strip()
            if not wtxt:
                continue
            words.append({"time": wt, "end": we, "text": wtxt, "kind": "word"})
        # The aligner has no notion of a line, so silence draws them — the
        # same reading `_lines_from_words` makes of any per-word result.
        lines = _lines_from_words(words)

        return {
            "algorithm": algo,
            "ok":        True,
            "words":     words,
            "lines":     lines,
            "language":  script,
            "duration":  float(words[-1]["end"]) if words else 0.0,
            "ms":        time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


ALGORITHMS = {
    "whisper-base": {
        "name":        "Whisper base",
        "description": "OpenAI Whisper base model — multilingual vocal transcription with coarse word-level timestamps.",
        "detect":      detect_whisper_base,
        "available":   lambda: _WHISPER_OK and _TORCH_OK and _NUMPY_OK,
        "needs_text":  False,
    },
    "ivrit": {
        "name":        "Ivrit",
        "description": "ivrit.ai's Hebrew speech-recognition model (Apache-2.0) — far better Hebrew than Whisper base, Hebrew only. Runs int8 (~2 GB peak); first use on bare metal downloads ~3.2 GB and converts it once.",
        "detect":      detect_ivrit,
        "available":   lambda: _FASTER_WHISPER_OK and _NUMPY_OK,
        "needs_text":  False,
    },
    "ctc-forced-aligner": {
        "name":        "CTC forced aligner",
        "description": "Force-align reference lyrics against the audio with wav2vec2 (Apache-2.0) — the English model, or a Hebrew one when the lyrics are in Hebrew (~1.3 GB download on first use). Requires a reference transcript saved via the Lyrics text panel.",
        "detect":      detect_ctc_forced_aligner,
        "available":   lambda: _CTC_FA_OK and _TORCH_OK and _NUMPY_OK,
        "needs_text":  True,
    },
}


def _resolve_audio(slug: str, stem: str) -> Path:
    if stem and stem != "mix":
        audio_path = stem_audio(slug, stem)
        if audio_path is None:
            raise FileNotFoundError(f"no cached '{stem}' stem for slug: {slug}")
        return audio_path
    audio_path = find_audio(slug)
    if audio_path is None:
        raise FileNotFoundError(f"audio not found for slug: {slug}")
    return audio_path


def detect_one(
    slug: str,
    algo: str,
    stem: str = "mix",
    force: bool = False,
    language: str | None = None,
    reference_text: str | None = None,
    span: "tuple[float, float] | None" = None,
    pad: float = RANGE_PAD_SECONDS,
) -> dict:
    """Transcribe `slug` — the whole song, or just `span` of it.

    The whole-song form is cached under `<algo>[__<stem>].json` and read back
    from there unless `force`. The ranged form is never cached: it is a second
    opinion about one window, and the annotator decides whether it is better
    than what the full run heard there (`merge_window` is how they say yes).
    """
    if algo not in ALGORITHMS:
        raise ValueError(f"unknown algorithm: {algo}")
    cache_dir = CACHE_DIR / slug
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{cache_name(algo, stem)}.json"
    if span is None:
        hit = cached_result(cache_path, force)
        if hit is not None:
            return hit
    audio_path = _resolve_audio(slug, stem)
    needs_text = bool(ALGORITHMS[algo].get("needs_text", False))
    if needs_text and not reference_text and span is None:
        # Fall back to the saved per-song reference when the caller didn't pass
        # one — so the CLI pipeline can run ctc just like the web app does.
        # Deliberately NOT done for a window: force-aligning a whole song's
        # transcript against eight seconds of audio would cram every line into
        # the window and call it an alignment. A window needs its own words.
        reference_text = _load_reference_text(slug)

    def _run(path: Path) -> dict:
        if needs_text:
            return ALGORITHMS[algo]["detect"](path, language, reference_text)  # type: ignore[misc]
        return ALGORITHMS[algo]["detect"](path, language)  # type: ignore[misc]

    if span is not None:
        start, end = span
        lo = max(0.0, start - max(0.0, pad))
        hi = end + max(0.0, pad)
        with trimmed_audio(audio_path, lo, hi) as ranged_path:
            result = _run(ranged_path)
        words = _within(_shift(result.get("words", []), lo), start, end)
        return {
            "slug":        slug,
            "audio_file":  audio_path.name,
            "algorithm":   algo,
            "stem":        stem or "mix",
            "duration":    float(end - start),
            "range":       {"start": start, "end": end, "pad": pad},
            "language":    result.get("language"),
            "words":       words,
            "lines":       _lines_from_words(words),
            "ok":          result.get("ok", False),
            "error":       result.get("error"),
            "ms":          result.get("ms", 0),
            "computed_at": now_iso(),
        }

    result = _run(audio_path)
    payload = {
        "slug":        slug,
        "audio_file":  audio_path.name,
        "algorithm":   algo,
        "stem":        stem or "mix",
        "duration":    result.get("duration", 0.0),
        "language":    result.get("language"),
        "words":       result.get("words", []),
        "lines":       result.get("lines", []),
        "ok":          result.get("ok", False),
        "error":       result.get("error"),
        "ms":          result.get("ms", 0),
        "computed_at": now_iso(),
    }
    write_result(cache_path, payload, deps_ok=ALGORITHMS[algo]["available"]())
    return payload


def merge_window(
    slug: str,
    algo: str,
    stem: str = "mix",
    *,
    start: float,
    end: float,
    words: list[dict],
    source: str | None = None,
) -> dict:
    """Replace everything the cached result says about [start, end) with `words`.

    This is destructive on purpose, and only inside the window: the annotator
    looked at that stretch, decided the full run was wrong about it, and said
    so. An empty `words` clears the window — the honest answer when the full
    run hallucinated a line over silence.

    Lines are re-derived for the surviving words rather than patched, so a line
    that straddled an edge comes back split at the window. Each call appends to
    `patches`, so the file still says how it came to disagree with the take it
    claims to be.
    """
    if algo not in ALGORITHMS:
        raise ValueError(f"unknown algorithm: {algo}")
    if not (end > start):
        raise ValueError("end must be greater than start")
    cache_dir = CACHE_DIR / slug
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{cache_name(algo, stem)}.json"

    if cache_path.exists():
        payload = json.loads(cache_path.read_text())
    else:
        # No full run to merge into — the window becomes the whole result. The
        # `patches` entry below is what keeps that legible.
        payload = {
            "slug": slug, "audio_file": "", "algorithm": algo,
            "stem": stem or "mix", "duration": 0.0, "language": None,
            "words": [], "lines": [], "ok": True, "error": None, "ms": 0,
        }

    clean: list[dict] = []
    for w in words:
        text = str(w.get("text", "")).strip()
        if not text:
            continue
        t = float(w.get("time", 0.0))
        clean.append({
            "time": t, "end": float(w.get("end", t)), "text": text, "kind": "word",
        })
    clean.sort(key=lambda w: (w["time"], w["end"]))

    kept = _outside(list(payload.get("words") or []), start, end)
    removed = len(payload.get("words") or []) - len(kept)
    merged = sorted(kept + clean, key=lambda w: (float(w["time"]), float(w.get("end", 0.0))))

    payload["words"] = merged
    payload["lines"] = _lines_from_words([
        {"time": float(w["time"]), "end": float(w.get("end", w["time"])), "text": str(w["text"])}
        for w in merged
    ])
    payload["duration"] = max(
        float(payload.get("duration") or 0.0),
        float(merged[-1]["end"]) if merged else 0.0,
    )
    # A window that produced real words makes the file usable even if the full
    # run had failed outright — the generators skip any payload without `ok`.
    if clean:
        payload["ok"] = True
        payload["error"] = None
    payload.setdefault("patches", []).append({
        "start": float(start), "end": float(end),
        "added": len(clean), "removed": removed,
        "source": source or f"{algo}:{stem or 'mix'}",
        "at": now_iso(),
    })
    payload["computed_at"] = now_iso()
    cache_path.write_text(json.dumps(payload, indent=2))
    return {**payload, "added": len(clean), "removed": removed}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        code = str(args[1]) if len(args) > 1 else "???"
        if not code.isdigit() or int(code) >= 400:
            super().log_message(fmt, *args)

    def _send(self, code: int, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        for k, v in cors_headers().items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in cors_headers().items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/lyrics/health":
            self._send(200, {
                "ok":         _WHISPER_OK and _TORCH_OK and _NUMPY_OK,
                "whisperOk":  _WHISPER_OK,
                "ctcFaOk":    _CTC_FA_OK,
                "ivritOk":    _FASTER_WHISPER_OK,
                "torchOk":    _TORCH_OK,
                "numpyOk":    _NUMPY_OK,
            })
            return
        if path == "/api/lyrics/algorithms":
            self._send(200, [
                {"id": k, "name": v["name"], "description": v["description"], "available": bool(v["available"]())}
                for k, v in ALGORITHMS.items()
            ])
            return
        if path.startswith("/api/lyrics/detect/"):
            tail = path[len("/api/lyrics/detect/"):].split("/")
            if len(tail) != 2:
                self._send(400, {"error": "expected /api/lyrics/detect/<slug>/<algo>"})
                return
            slug, algo = tail
            cache_path = CACHE_DIR / slug / f"{algo}.json"
            self._send(200, json.loads(cache_path.read_text()) if cache_path.exists() else None)
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
        if path == "/api/lyrics/detect":
            slug = str(body.get("slug", "")).strip()
            algo = str(body.get("algo", "")).strip()
            stem = str(body.get("stem", "mix")).strip() or "mix"
            force = bool(body.get("force", False))
            language = body.get("language") or None
            reference_text = body.get("text") or None
            if not slug or not algo:
                self._send(400, {"error": "slug and algo are required"})
                return
            try:
                # A quarter-second is enough audio to hold a sung word, which
                # is the smallest thing anyone re-runs this for.
                span = parse_range(body, min_seconds=0.25, reads="a word")
            except ValueError as e:
                self._send(400, {"error": str(e)})
                return
            try:
                pad = float(body.get("pad", RANGE_PAD_SECONDS))
            except (TypeError, ValueError):
                self._send(400, {"error": "pad must be a number of seconds"})
                return
            try:
                self._send(200, detect_one(
                    slug, algo, stem=stem, force=force, language=language,
                    reference_text=reference_text, span=span, pad=pad,
                ))
            except FileNotFoundError as e:
                self._send(404, {"error": str(e)})
            except ValueError as e:
                self._send(400, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": f"detection failed: {type(e).__name__}: {e}"})
            return

        # Write one window's words into the cached result — the annotator
        # accepting a re-run (or clearing a hallucinated line) for that stretch.
        if path == "/api/lyrics/merge":
            slug = str(body.get("slug", "")).strip()
            algo = str(body.get("algo", "")).strip()
            stem = str(body.get("stem", "mix")).strip() or "mix"
            if not slug or not algo:
                self._send(400, {"error": "slug and algo are required"})
                return
            words = body.get("words")
            if not isinstance(words, list):
                self._send(400, {"error": "words must be a list (empty clears the window)"})
                return
            try:
                span = parse_range(body, min_seconds=0.25, reads="a word")
            except ValueError as e:
                self._send(400, {"error": str(e)})
                return
            if span is None:
                self._send(400, {"error": "start and end are required"})
                return
            try:
                self._send(200, merge_window(
                    slug, algo, stem=stem, start=span[0], end=span[1],
                    words=words, source=body.get("source") or None,
                ))
            except ValueError as e:
                self._send(400, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": f"merge failed: {type(e).__name__}: {e}"})
            return
        if path == "/api/lyrics/initialize":
            algo = str(body.get("algo", "")).strip()
            if algo not in ALGORITHMS:
                self._send(400, {"error": f"unknown algorithm: {algo}"})
                return
            try:
                if not ALGORITHMS[algo]["available"]():
                    self._send(503, {"ok": False, "error": f"{algo}: deps missing"})
                    return
                if algo == "whisper-base":
                    _ensure_whisper()
                elif algo == "ctc-forced-aligner":
                    _ensure_ctc_fa()
                self._send(200, {"ok": True, "algorithm": algo})
            except Exception as e:
                self._send(500, {"ok": False, "error": f"init failed: {type(e).__name__}: {e}"})
            return
        self._send(404, {"error": "not found"})


def main():
    import os
    host = os.environ.get("HOST", "localhost")
    print(f"Starting lyrics server on http://{host}:{PORT}", file=sys.stderr)
    print(f"  whisper={_WHISPER_OK}  ctc_fa={_CTC_FA_OK}  ivrit={_FASTER_WHISPER_OK}  torch={_TORCH_OK}  numpy={_NUMPY_OK}", file=sys.stderr)
    ModelServer((host, PORT), Handler).serve_forever()


if __name__ == "__main__":
    if "--prepare-ivrit" in sys.argv:
        print(f"Ivrit int8 model ready in {prepare_ivrit()}", file=sys.stderr)
    else:
        main()
