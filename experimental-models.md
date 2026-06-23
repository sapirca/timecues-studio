# Algo Inspect — non-boundary models

Every model below answers a *different* musical question than the section/boundary
detectors (RUPTURES/CPD, MSAF). Each runs as its own Python sidecar, gated by the
`experimental-models` docker compose profile + a per-family user setting.

Families: **[span]** = active-over-a-range, **[cue]** = point-in-time event,
**[loop]** = seamless repeats, **[pattern]** = warped motifs, **[lyrics]** =
transcription, **[custom]** = user scripts.

---

## SPAN family — `span_server.py` (:8009)

### Silero-VAD  [span]
- **what is it:** Lightweight (~2 MB) `torch.hub` voice-activity-detection model (snakers4/silero-vad, MIT). Lazy-loaded on first detect.
- **input:** audio file → mono, resampled to 16 kHz.
- **output:** `spans[]` = voicing intervals `{ start, end, label:"voice", confidence:null }` + `duration`.

### JDCNet  [span]
- **what is it:** Joint pitch + voicing detector (keums/melodyExtraction_JDC weights, ~30 MB, MIT). Pure-PyTorch port in `jdcnet_torch.py` — no TensorFlow.
- **input:** audio file → resampled, normalized with bundled mean/std `.npy` stats.
- **output:** `spans[]` = voiced intervals (threshold 0.5, min 0.05 s) **plus** a `pitch_contour` (per-frame Hz, 10 ms frames; class 0 = non-voice), written to a side-car `.pitch.json`.

### PANNs CNN14  [span] — `panns_server.py` (:8013)
- **what is it:** Pretrained Audio Neural Network CNN14 on AudioSet-2M (Kong et al. 2020, Apache-2.0, ~80 MB). Own sidecar so the big download is opt-in.
- **input:** audio file → fed to the CNN14 tagger.
- **output:** `spans[]` = one span per (top AudioSet class, time range), `label` = class name (e.g. "Drum kit", "Guitar"), `confidence` = max P(class) inside the span.

### HPSS percussive  [span] — `percussive_server.py` (:8015)
- **what is it:** Pure-DSP percussive-activity detector — `librosa.effects.hpss` + energy threshold. No weights.
- **input:** audio file → harmonic/percussive source separation.
- **output:** `spans[]` = intervals where percussive RMS is above threshold (min-duration filtered) — a "drums are playing here" view.

---

## CUE family — point-in-time events

### librosa-key  [cue] — `cue_extras_server.py` (:8014)
- **what is it:** Krumhansl-Schmuckler key correlation against the 24 major/minor templates. Pure librosa.
- **input:** audio file → chroma.
- **output:** `cues[]` (global-key cue at t=0 + a cue per key change) and a top-level `key` string.

### autochord-chords  [cue] — `cue_extras_server.py` (:8014)
- **what is it:** Chroma-template chord recognition via the `autochord` pip package.
- **input:** audio file → chroma.
- **output:** `cues[]` = one cue per chord transition, `label` = chord symbol (e.g. "Am", "G/B", "C:maj7").

### librosa-onsets  [cue] — `cue_extras_server.py` (:8014)
- **what is it:** `librosa.onset.onset_detect` transient detector. Pure DSP.
- **input:** audio file → onset envelope.
- **output:** `cues[]` = one cue per transient onset (kick hits, FX triggers, anything sharp).

### BeatNet  [cue] — `beatnet_server.py` (:8010)
- **what is it:** CRNN + Monte-Carlo particle filter (Heydari & Duan 2021, MIT, ~20 MB). Sibling to the BPM server. *(behind `experimentalCueExtras`)*
- **input:** audio file.
- **output:** `result` = `{ bpm, beat_times[], downbeats[], meter }` — beats, the downbeat subset, and inferred meter ("4/4", "3/4", …).

### basic-pitch  [cue] — `pitch_server.py` (:8011)
- **what is it:** Spotify basic-pitch polyphonic note transcription (2022, Apache-2.0, ONNX bundle ~5 MB, pure CPU). *(behind `experimentalCueExtras`)*
- **input:** audio file → ONNX model.
- **output:** `notes[]` = `{ time, end, midi, pitch:"C4", amplitude }` — one event per transcribed note.

---

## LOOP family — `loop_server.py` (:8012)

### Chroma autocorrelation  [loop]
- **what is it:** Pure-DSP seamless-loop finder — beat-synchronous CQT chroma + cosine-similarity scoring of adjacent cycles. No weights (~5–10 s for a 3-min track).
- **input:** audio file → mono 22.05 kHz; beat-tracked, beat-synced chroma.
- **output:** `loops[]` = `{ start, end, label:"8 bars · score 0.91", bars, confidence }`, top-K non-overlapping candidates above a similarity threshold.

---

## PATTERN family — `pattern_server.py` (:8017)

### LoCoMotif  [pattern]
- **what is it:** Variable-length motif discovery via time-warped DTW (ML-KULeuven/dtai-locomotif, MIT). Unlike LOOP, occurrences are warped matches, not regularly spaced.
- **input:** audio file → z-normalized beat-synchronous CQT chroma.
- **output:** `patterns[]` = one item per occurrence: `{ start, end, label:"Motif 2 · 3/5", motif_id, occurrence_index, occurrence_count, confidence }`.

---

## LYRICS family — `lyrics_server.py` (:8016)

### Whisper-base  [lyrics]
- **what is it:** OpenAI Whisper "base" vocal transcription (~140 MB checkpoint, lazy-downloaded, CPU-only). Word timestamps are coarse (~200 ms).
- **input:** audio file (optional `language` hint).
- **output:** `words[]` = `{ time, end, text, kind:"word" }`, `lines[]` = line-level segments, plus detected `language`.

---

## CUSTOM family — `custom_server.py` (:8005)

### Custom detector  [custom]
- **what is it:** Runs user-authored Python detector scripts (sandboxed). The extension point, not a fixed model.
- **input:** audio file + the uploaded script.
- **output:** whatever schema the script declares (algorithm-mode or annotation-mode).
