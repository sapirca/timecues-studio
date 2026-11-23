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

### madmom DBN downbeats  [cue] — `bpm_server.py` (:8004)
- **what is it:** `RNNDownBeatProcessor` + `DBNDownBeatTrackingProcessor`. Sibling to the existing `madmom-rnn-beats`, which finds beats only. Hypothesis set is `beats_per_bar=[3, 4]`, so meters outside that (this corpus has a 5/4 track) are not representable — one of the DBN limitations the Beat This! paper singles out.
- **input:** audio file.
- **output:** joins `algorithms[]` as `madmom-dbn-downbeats` with `beat_times[]` **and** `downbeats[]`.

### Beat Transformer  [cue] — `beat_transformer_server.py` (:8018)
- **what is it:** Dilated self-attention over **demixed stems** (Zhao, Xia & Wang, ISMIR 2022; MIT code **and** weights). It is the only detector here that reads Demucs stems rather than the mix — the premise being that the drum track should drive the downbeat decision, which is the half that actually fails on EDM. Model code is vendored ([tools/python/vendor/beat_transformer/](../tools/python/vendor/beat_transformer/)) since upstream ships no package; the 36 MB checkpoint is fetched on first use into `.cache/beat-transformer/`. *(behind `experimentalCueExtras`)*
- **input:** Demucs stems → per-stem log-power mel spectrogram (44.1 kHz, n_fft 4096, hop 1024, 128 mels, 30–11000 Hz), stacked to `(time, stems, 128)`. **Needs stems**: a song without them returns an explicit error rather than falling back to the mix. Upstream trained on 5 Spleeter stems; Demucs's 4–6 work because the training loop randomly sums stem pairs, so 2–5 channel inputs all appear during training and the model reads its instrument count off the input shape.
- **output:** same shape as `beat-this` — `{ bpm, beat_times[], downbeats[], meter, segments[], summary, stems[] }`. The network emits beat/downbeat *activations*; madmom's DBNs decode them to times, using upstream's published settings (55–215 BPM, `beats_per_bar=[3,4]`).
- **measured here:** ~3 s inference per 4-minute track on CPU. On this corpus it does **not** beat Beat This! on downbeats (0.370 vs 0.406 head-to-head), but it has the best **CMLt** of any tracker (0.426) — the most temporally consistent. Run `tools/python/beat_eval.py` for the current numbers rather than trusting this line.

### Beat This!  [cue] — `beat_this_server.py` (:8008)
- **what is it:** Transformer beat/downbeat tracker (Foscarin, Schlüter & Widmer, ISMIR 2024, MIT code **and** weights). It drops the DBN post-processing madmom relies on, which is what makes it useful here: the DBN pulls its answer toward one globally-consistent tempo, and that smoothing is exactly wrong for a track whose grid restarts. *(behind `experimentalCueExtras`)*
- **input:** audio file. CPU is fine — ~8s for a 4-minute track.
- **output:** `result` = `{ bpm, beat_times[], downbeats[], meter, segments[], summary }`. The last two are unique to this detector: `segments[]` are fitted grid segments `{ start, end, bpm, time_signature, beats, reason }` where `start` is bar 1 beat 1, matching `GridSegment` in the grid model; `summary` counts tempo changes vs. phase shifts.
- **why segments:** every tracker stops at a flat beat list. Turning that into "three segments at 138 BPM whose count restarts at 0:31" happens in [tools/python/beat_segments.py](../tools/python/beat_segments.py), which separates a real tempo change from a phase shift at an unchanged tempo (the usual case in sequenced music) from a breakdown the tracker simply went quiet through (not a boundary at all).

### basic-pitch  [cue] — `pitch_server.py` (:8011)
- **what is it:** Spotify basic-pitch polyphonic note transcription (2022, Apache-2.0, ONNX bundle ~5 MB, pure CPU). *(behind `experimentalCueExtras`)*
- **input:** audio file → ONNX model.
- **output:** `notes[]` = `{ time, end, midi, pitch:"C4", amplitude }` — one event per transcribed note.

---

## Scoring the beat trackers against this corpus

`tools/python/beat_eval.py` ranks every cached tracker against the curated
grids in `data/song-info`, which are already beat annotation — stored as a
rule (`gridOffset` + `bpm` + splits) rather than a list. `grid_truth.expand()`
turns that rule back into beat and downbeat times, so the corpus is a labelled
evaluation set with no extra annotation pass.

```
python tools/python/beat_eval.py                 # every song
python tools/python/beat_eval.py --slug <slug>   # one
python tools/python/beat_eval.py --json out.json
```

**In the UI:** DataPrep → Song setup → step ④ **Check against the models**
does the same scoring for the song on screen, via
`POST /api/mir-eval/grid-score` on the mir_eval server (:8001 — core-mir, so
it works without the experimental profile up). The grid travels in the
request rather than being read from disk, so it scores *unsaved* edits: drag
the downbeat and the numbers move. It reads cached tracker output only and
never starts a model run; with nothing cached it says so instead of scoring.
The CLI is the corpus-wide view, the panel is the per-song one.

Why not just use the published numbers: Beat This! reports 89.1 beat / 78.3
downbeat on GTZAN across 18 datasets, **none of them EDM**. The one EDM
evaluation that exists ([Raveform](https://transactions.ismir.net/articles/10.5334/tismir.288),
TISMIR 2025) put madmom at 0.947 beat / **0.669 downbeat**, versus 0.941 /
0.805 on pop. On four-on-the-floor the beats are nearly free and the
*downbeats* are where trackers fail — which is exactly what a grid segment's
bar 1 depends on.

Two guards keep the report honest:

- **Refusal.** A grid still at the untouched default, a Hand-placed grid with
  per-beat overrides, or a Drifting grid with tempo anchors is skipped with a
  reason rather than expanded into a reference this module cannot model.
- **Consensus.** The trackers are independent — different architectures,
  training sets and decades. When they agree with each other and all disagree
  with the grid, the report says **DISPUTED GRID**, because three independent
  models do not fail identically. Those songs are excluded from the headline
  mean.

---

## LOOP family — retired as a sidecar

There is no `loop` service any more: the standalone `loop_server.py`
(:8012) was removed and its chroma work folded into a batch generator, so
nothing in the compose file listens on 8012. LOOP survives as an
*annotation kind* — the UI still has loop lanes, and `example_random_loops.py`
in `tools/python/custom-default/` is the shipped worked example — but a loop
detector is now something you write, not a sidecar you start. The
algorithm the sidecar used is described below for reference.

### Chroma autocorrelation  [loop] — no longer served
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

### Ivrit  [lyrics]
- **what is it:** ivrit.ai's Hebrew speech-recognition model (Apache-2.0), via `transformers` (~3.2 GB checkpoint, lazy-downloaded). Hebrew only: the language is pinned to `he`.
- **input:** audio file (`language` is ignored); best on the vocals stem. Transcribed one phrase at a time, cut at pauses (≤ 28 s); silent stretches are never sent.
- **output:** same shape as Whisper-base; `lines[]` are drawn from silences between words; `language` is always `"he"`. Held-note spellings, decoder loops and zero-length words are dropped.

---

## CUSTOM family — `custom_server.py` (:8005)

### Custom detector  [custom]
- **what is it:** Runs user-authored Python detector scripts (sandboxed). The extension point, not a fixed model.
- **input:** audio file + the uploaded script.
- **output:** whatever schema the script declares (algorithm-mode or annotation-mode).
