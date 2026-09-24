#!/usr/bin/env python3
"""
Whisper-base vocal-transcription sidecar — opens the LYRICS family.

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
import sys
import warnings
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

warnings.filterwarnings("ignore")

PORT = 8016

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import (  # noqa: E402
    find_audio, stem_audio, cache_name, LYRICS_OUTPUTS_DIR as CACHE_DIR,
    DATA_DIR, DEFAULT_DATA_DIR,
)
from server_common import (  # noqa: E402
    cached_result, cors_headers, decode_mono_16k, err as _common_err, now_iso,
    parse_range, time_ms, trimmed_audio,
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

try:
    import torch  # noqa: F401
    _TORCH_OK = True
except ImportError:
    _TORCH_OK = False

try:
    import whisper  # noqa: F401
    _WHISPER_OK = True
except Exception:
    _WHISPER_OK = False

# ctc-forced-aligner — MIT, MahmoudAshraf97/ctc-forced-aligner.
# We pin it to facebook/wav2vec2-base-960h (Apache-2.0) at call time so the
# default CC-BY-NC MMS_FA model is never downloaded by this server.
try:
    import ctc_forced_aligner  # noqa: F401
    _CTC_FA_OK = True
except Exception:
    _CTC_FA_OK = False

CTC_FA_MODEL_PATH = "facebook/wav2vec2-base-960h"

# Process-wide model cache. Whisper-base load takes ~3 s on first call.
_whisper_model = None
_ctc_fa_model = None
_ctc_fa_tokenizer = None


def _err(algo: str, msg: str) -> dict:
    return _common_err(algo, msg, words=[], lines=[])


def _ensure_whisper():
    """Lazy-load Whisper-base. Triggers a ~140 MB checkpoint download into
    ~/.cache/whisper/ on first call. Model lives in process memory for
    the lifetime of the container after that."""
    global _whisper_model
    if _whisper_model is not None:
        return
    import whisper
    _whisper_model = whisper.load_model("base")


def _ensure_ctc_fa():
    """Lazy-load the CTC forced aligner pinned to wav2vec2-base-960h
    (Apache-2.0). Triggers a ~360 MB HuggingFace download into
    ~/.cache/huggingface/ on first call."""
    global _ctc_fa_model, _ctc_fa_tokenizer
    if _ctc_fa_model is not None:
        return
    import torch
    from ctc_forced_aligner import load_alignment_model
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    _ctc_fa_model, _ctc_fa_tokenizer = load_alignment_model(
        device, model_path=CTC_FA_MODEL_PATH, dtype=dtype,
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
        kwargs = {"word_timestamps": True}
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
            if seg_text:
                lines.append({
                    "time": seg_start, "end": seg_end,
                    "text": seg_text, "kind": "line",
                })
            for w in seg.get("words", []) or []:
                wt = float(w.get("start", seg_start))
                we = float(w.get("end", wt))
                wtxt = str(w.get("word", "")).strip()
                if not wtxt:
                    continue
                words.append({
                    "time": wt, "end": we,
                    "text": wtxt, "kind": "word",
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


def detect_ctc_forced_aligner(
    audio_path: Path,
    language: str | None = None,  # unused — model is English-only
    reference_text: str | None = None,
) -> dict:
    """Forced-align `reference_text` against the audio using a CTC log-prob
    Viterbi alignment over wav2vec2-base-960h. Returns word-level start/end
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
            preprocess_text,
            get_alignments,
            get_spans,
            postprocess_results,
        )
        _ensure_ctc_fa()
        device = "cuda" if torch.cuda.is_available() else "cpu"
        # wav2vec2-base-960h expects 16 kHz mono — which is what
        # decode_mono_16k returns, so the model's own loader (another `ffmpeg`
        # subprocess, see detect_whisper_base) is only the fallback.
        samples = _audio_for_model(audio_path)
        audio_waveform = (
            torch.from_numpy(samples).to(_ctc_fa_model.dtype).to(device)
            if samples is not None
            else load_audio(str(audio_path), _ctc_fa_model.dtype, device)
        )
        # Tokenize the transcript at the model's CTC vocab.
        tokens_starred, text_starred = preprocess_text(
            reference_text, romanize=False, language="eng",
        )
        emissions, stride = generate_emissions(_ctc_fa_model, audio_waveform, batch_size=1)
        segments, scores, blank_token = get_alignments(emissions, tokens_starred, _ctc_fa_tokenizer)
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
            "language":  "en",
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
    "ctc-forced-aligner": {
        "name":        "CTC forced aligner",
        "description": "Force-align reference lyrics against the audio with wav2vec2-base-960h (Apache-2.0, English). Requires a reference transcript saved via the Lyrics text panel.",
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
    try:
        cache_path.write_text(json.dumps(payload, indent=2))
    except Exception:
        pass
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
    print(f"  whisper={_WHISPER_OK}  ctc_fa={_CTC_FA_OK}  torch={_TORCH_OK}  numpy={_NUMPY_OK}", file=sys.stderr)
    HTTPServer((host, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
