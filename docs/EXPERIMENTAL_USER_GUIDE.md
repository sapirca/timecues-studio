# Experimental User Guide

Companion to [`USER_GUIDE.md`](USER_GUIDE.md). Everything documented here is
**opt-in, behind a per-family feature flag, and may break without notice.**
Once a feature graduates from beta the content migrates into the main user
guide in the same change set.

> ⚠️ Experimental features may produce wrong results, refuse to load, change
> their JSON shape, or be removed entirely between releases. Do not build
> downstream tooling on these endpoints until they graduate.

> **Per-song Eval is tabbed by annotation kind.** Open any song's Eval
> stage and the tabs across the top expose **Boundaries · Cues · Spans ·
> Loops · Patterns · Lyrics**. Boundaries is the legacy mir_eval table;
> each other tab fetches the relevant reference layer + the cached
> detection of every algorithm in that family and renders kind-specific
> metrics (IoU + frame F1 for spans, cycle-alignment F1 + accent Jaccard
> for patterns, bar-snap + phase-pop-free for loops, WER + word-onset F1
> for lyrics). Tabs only appear when the matching family flag is on.
> The all-songs Eval view shows the same tables stacked.

## Where the flags live

`Settings → Annotation → Experimental annotation types`. Each toggle is
independent:

- **Enable Loops and Patterns** — schema-only today; UI in progress.
- **Enable SPAN-family detectors** — voicing / instrument-activity intervals
  via Silero-VAD, JDCNet, and PANNs (AudioSet-527 tagging).
- **Enable CUE-family extras** — BeatNet beats / downbeats / meter,
  basic-pitch polyphonic note transcription.
- **Enable LOOP-family detectors** — chroma-autocorrelation loop finder
  (pure DSP, no model weights).
- **Enable LYRICS-family detectors** — Whisper-base multilingual vocal
  transcription. Opens the LYRICS family (per-word + per-line entries).
- **Enable PATTERN-family detectors** — LoCoMotif DTW-warped motif discovery
  on beat-synchronous chroma. Opens the PATTERN family (variable-length
  repeating motifs, grouped by motif id).

Flipping a flag on does not by itself bring up the backend services. See
*Running the experimental servers* below.

## Running the experimental servers

The SPAN-family and BeatNet detectors live in their own docker sidecars so a
broken install in one doesn't take the others down with it.

**Local dev — lean (`./run.sh`):** the 9 experimental Python servers start
automatically on ports 8009–8017 alongside the core stack, but their heavy
deps (torch, BeatNet, basic-pitch, panns_inference, openai-whisper,
autochord) are **NOT** installed in the lean default. Each server's imports
are guarded by try/except, so the process starts but `available=false` flows
through to the Initialize-models panel as `Deps missing`.

**Local dev — full (`./run_all.sh`):** the same launcher with every model
family installed (≡ `./run.sh --all`) — it pip-installs torch + the
experimental deps (and builds a Python 3.11 venv for basic-pitch/autochord
on Python ≥3.12), so all 9 detectors report `Ready`. ~3 GB of wheels on
first run. To install just one family by hand instead, run the matching
`pip install` line as listed in `run.sh`.

**Full stack (all sidecars):** activate `--profile experimental-models`
alongside `--profile demucs-cpu` so all 9 servers run out of the box. The
per-family user-settings flag still controls visibility — flipping a flag
off hides the family's UI without stopping the server.

**Local docker (manual opt-in):** if you want a clean prod-shape stack
locally, run

```sh
docker compose --profile experimental-models up --build
```

This brings up nine extra services alongside the core stack:

| Service | Port | What it runs |
|---|---|---|
| `span`    | 8009 | `tools/python/span_server.py` — Silero-VAD + JDCNet |
| `beatnet` | 8010 | `tools/python/beatnet_server.py` — BeatNet (CRNN + DBN) |
| `pitch`   | 8011 | `tools/python/pitch_server.py` — basic-pitch (Spotify, polyphonic notes) |
| `loop`    | 8012 | `tools/python/loop_server.py` — chroma autocorrelation loop finder |
| `panns`   | 8013 | `tools/python/panns_server.py` — PANNs CNN14 AudioSet-527 tagging |
| `cue-extras` | 8014 | `tools/python/cue_extras_server.py` — librosa key, autochord, librosa onsets |
| `percussive` | 8015 | `tools/python/percussive_server.py` — HPSS percussive spans |
| `lyrics`  | 8016 | `tools/python/lyrics_server.py` — Whisper-base vocal transcription |
| `pattern` | 8017 | `tools/python/pattern_server.py` — LoCoMotif motif discovery |

If the profile is not running, the web app's `/api/span/*` and
`/api/beatnet/*` calls return 503 and the corresponding family UI surfaces
stay hidden — there is no broken-button state to clean up later.

## Initialize models

After enabling at least one experimental family, the settings page shows an
**Initialize models** panel that lists every detector for the enabled
families along with:

- Approximate weight size before download
- Per-detector status badge: `Not loaded` · `Loading…` · `Ready` · `Deps missing` · `Server off`
- A per-row `Initialize` button and a global `Initialize all`

Initializing warms the model into the sidecar's memory (and on-disk weight
cache) so the first per-song detect call doesn't pay the cold-load latency.
The download targets a docker named volume (`timecues-model-cache`) shared
across the experimental sidecars, so restarts don't re-download.

## SPAN family

Output kind: **intervals** of voicing / instrument activity (start, end,
label). Distinct from boundaries (single time points) and cues (single
time points with a label).

### Detectors

- **Silero-VAD** — voicing intervals. MIT, ~2 MB, torch.hub. Lightweight
  enough to ship in the prod image once the family graduates.
- **JDCNet voicing** — pure-PyTorch port (in `tools/python/jdcnet_torch.py`)
  of Kum & Nam (2019) "Joint Detection and Classification of Singing Voice
  Melody". Weights come from the original keums Keras checkpoint (MIT,
  ~17 MB) loaded via h5py — no TensorFlow runtime inside the sidecar.
  Returns voicing spans plus a 722-class pitch contour (D3..B5 at 1/16
  semitone resolution + non-voice). The pitch contour is now surfaced
  via `mir_server` under `features.tonal.jdcnet_pitch` — re-run the MIR
  feature extraction (force=true) after running JDCNet to refresh the
  cached `mir-features/<slug>.json`. Custom detectors can then read it
  via `ctx.features["tonal"]["jdcnet_pitch"]` (shape: `{frame_sec, hz,
  summary: {frames, voiced_ratio, voiced_hz: {min, max, median}}}`).
  CPU inference is ~3 frames/ms — a 3 min track takes 30-60 s.
- **PANNs CNN14** — multi-label AudioSet-527 tagging (Kong et al. 2020).
  Apache-2.0, ~80 MB checkpoint lazy-downloaded from HuggingFace on first
  detect into the shared `timecues-model-cache` named volume. 1 s window
  with 0.5 s hop; classes above probability threshold 0.2 collapse into
  contiguous spans, capped at the 12 globally-dominant labels per song.
  Output looks like `{label: "Drum kit", start, end, confidence}` etc.
- **HPSS percussive** — pure-DSP percussive-only span detector. Runs
  `librosa.effects.hpss` to isolate the drum / transient component, then
  thresholds its RMS to emit "drums are active here" spans. Complements
  Silero-VAD's voicing view; useful for finding drum-only breakdowns and
  fills. No model weights.

## LOOP family

Output kind: **loops** — labeled intervals representing seamless N-bar
phrases that audibly repeat. Distinct from spans (no repetition contract)
and from patterns (no per-beat highlight grid).

### Detectors

- **Chroma autocorrelation** — pure-DSP loop finder. Beat-synchronous
  chroma vectors + cosine-similarity scoring between adjacent N-bar
  candidates. No model weights, no GPU, no special install — works on
  every platform that runs the existing TimeCues stack. Outputs the
  top-K non-overlapping candidates with their bar count and intra-cycle
  similarity score. Fast (~5–10 s for a 3 min track on CPU).

### Loop-specific eval columns

Beyond the inherited span-style metrics (IoU + frame F1 + edge F1), the
LOOP eval table adds two loop-quality columns:

- **Bar snap** — fraction of predicted loops whose `start` AND `end`
  fall within ±50 ms of a bar boundary. Requires a cached BPM
  detection — without one the cell shows `—`.
- **Phase-pop free** — fraction of predicted loops whose duration is
  an integer multiple of the bar length (within ±50 ms). Loops that
  are non-integer-bar audibly pop when the playback engine wraps; this
  metric flags them up front.

The bar grid is derived from the cached `/api/bpm/detect/<slug>` result
(first detector with `beat_times` sets the grid origin; the first
detector with a numeric `bpm` is the fallback).

### Evaluation

Per-kind span metrics now ship as part of Phase 2 of the integration plan:

- **IoU** — Jaccard overlap of matched `[start, end]` pairs (greedy match).
- **Frame F1** — voicing-mask agreement at 100 ms resolution. Voiced frames
  in a reference span unioned with its candidate alternates count as gold.
- **Onset F1 / Offset F1** — each span edge treated as a cue at 100 ms
  tolerance. Tracks whether the model's edges line up, separately from
  whether the core span overlaps.
- **Coverage** — total covered ground-truth duration divided by total
  reference duration. A sanity check for under-prediction.

The SPAN-family eval table renders under the boundary algorithms table in
the all-songs Global Eval view (gated by `experimentalSpanFamily`). It
compares each detector against the user's first span layer in
`/api/annotation-layers/<slug>`. Songs without a span layer show `—` in
the eval columns; the per-song detector outputs still cache and the
detector rows still show their "Songs" count.

Per-layer mode toggle (`'full-annotation'` ↔ `'multiple-candidates'`) is
implemented in [`evaluation.ts`](../web-app/src/utils/evaluation.ts) and
surfaced as a compact **Full / Cands** pill in each layer's editor
toolbar (Cues, Spans, Loops, Patterns — see
[`LayerModePicker.tsx`](../web-app/src/components/inspector-v2/LayerModePicker.tsx)).
The SPAN-family eval table reads the pill's value off the active span
reference layer before scoring. Item-level `candidates: [[start, end], ...]`
arrays work today too: any candidate within tolerance counts as a hit.

- **Full** (default) — every gold item must be matched; unmatched items
  count as misses.
- **Cands** — the whole layer is treated as a set of alternates for the
  same underlying truth; matching ANY ONE item satisfies the layer.

A global override lives in **Settings → Research → Evaluation → "Score
region layers as multiple candidates (spans / loops / patterns)"**. When on,
every span, loop, and pattern layer is scored in **Cands** mode regardless of
its per-layer **Full / Cands** pill — a single switch for when you want all of
a layer's items treated as interchangeable alternatives of the same event.
When off, each layer's own pill is honoured. Cues and boundaries are
unaffected (they carry their own per-item `candidates`). The setting is stored
per-browser in `evalRegionLayersAsCandidates`; toggling it re-scores the
SPAN- and LOOP-family eval tables live.

## CUE family extras

### BeatNet

`BeatNet(model=1, mode='offline', inference_model='DBN')`. Outputs:

- `beat_times` — every beat (seconds)
- `downbeats` — subset where the per-beat label is `1`
- `meter` — `"4/4"` / `"3/4"` / … inferred from the per-bar beat count, or
  `null` when too few bars are observed to be confident
- `bpm` — `60 / median(diff(beat_times))`, matching `madmom-rnn-beats`'s
  convention

BeatNet runs in its own sidecar and writes to
`data/algorithm-outputs/beatnet/<slug>.json`. It does **not** populate the
existing bpm-detections cache used by the 5 librosa / madmom detectors —
those stay on `:8004` untouched.

### basic-pitch (Spotify polyphonic transcription)

`pip install basic-pitch[onnx]`. Spotify ships the model as ONNX bundled
inside the pip package — no separate weight download, no GPU, identical
output on every architecture. Inference outputs per-note `(start, end,
midi, pitch_name, amplitude)` tuples. Each note becomes a CUE-family item
at its onset, labelled with the pitch name (e.g. `"C4"`). The note's end
time is kept on the payload so downstream consumers (eval, MIDI export)
can use it without re-running. Cache lives at
`data/algorithm-outputs/pitch/<slug>/basic-pitch.json`.

### librosa key + autochord + librosa onsets

Three pure-DSP detectors sharing one slim sidecar (`cue-extras` :8014):

- **librosa key** — Krumhansl-Schmuckler chord-tone-profile correlation
  against the 24 major/minor keys. Emits the global key as a cue at t=0
  plus per-segment cues at every detected key change (10 s sliding window,
  5 s hop). Output label format: `"A minor"`, `"F# major"`.
- **autochord chords** — chord recognition via the `autochord` pip
  package (chroma templates + Viterbi smoothing). Emits one cue per
  chord transition, label like `"Am"` or `"G/B"`. No neural net.
- **librosa onsets** — `librosa.onset.onset_detect` spectral-flux
  transient detection. One cue per onset event, with a confidence
  proportional to onset-envelope peak strength.

Cache at `data/algorithm-outputs/cue-extras/<slug>/<algo>.json`.

### Cues eval columns

The Cues tab compares every cue-emitting detector against the song's
first `cues` annotation layer at a per-kind tolerance:

| Algorithm | Tolerance | Why |
|---|---|---|
| BeatNet downbeats          | 100 ms | beat-onset alignment |
| basic-pitch onsets         |  50 ms | sharp note attacks |
| librosa-key changes        | 250 ms | mode transitions are perceptually wide |
| autochord chord changes    | 250 ms | same |
| librosa-onsets             |  50 ms | DSP onsets are tight by construction |

Columns: precision · recall · F1 · MNBD (mean nearest-cue distance, s).
Each algorithm's prediction set is projected to `{time, label}[]`
before scoring via `evaluateCueLayer` so all five share the same
boundary-style point-F1 metric.

## LYRICS family

Output kind: **lyrics** — per-word and per-line entries with start/end
timestamps. The full payload feeds `LyricsLayer` items downstream.

### Reference lyrics text

When the LYRICS family flag is on, a **Reference lyrics** textarea appears
in the LYRICS sidebar section of the inspector for the currently selected
song. Pasting the song's lyrics there saves them under
`data/lyrics-text/<slug>.txt` — shared across annotators since lyric text
is generally objective. Whisper-base transcribes independently and ignores
this field; the upcoming SOFA / ctc-forced-aligner detectors will use it
as their alignment target. The panel auto-saves on a 600 ms debounce; word
/ line / char counts render below the box.

### Detectors

- **Whisper base** — OpenAI Whisper "base" multilingual transcription.
  ~140 MB checkpoint lazy-downloaded into the shared `timecues-model-cache`
  named volume on first detect. CPU-only torch wheels keep the sidecar
  multi-platform. Word-level timestamps are coarse (~200 ms) — refine
  with the CTC forced aligner below if you have the reference text.

- **CTC forced aligner** — `MahmoudAshraf97/ctc-forced-aligner` (MIT)
  pinned to `facebook/wav2vec2-base-960h` (Apache-2.0, English-only).
  ~360 MB checkpoint lazy-downloaded into the shared HuggingFace cache
  on first detect. Requires the **Reference lyrics** panel to be filled
  in for the song — without a transcript the detector returns ok=false
  with a clear error message. Tight word-level onset/offset (~30 ms)
  vs. Whisper's coarse ~200 ms.
  > **Note** — the package's default `MMS_FA` model (CC-BY-NC) is **not**
  > used; the integration stays fully permissively-licensed.

### Lyrics eval columns

The LYRICS eval table inherits the line-level IoU + edge-F1 columns
from the span family (every `kind: 'line'` ref/est item gets scored
as a span) and adds two word-level metrics on top:

- **WER** — classic Levenshtein word distance between the reference's
  normalised word sequence and the detector's, divided by the
  reference word count. Whisper-base sees this move; ctc-forced-aligner
  forces it to 0 by construction (the model aligns the reference text
  itself, so the word sequence is fixed).
- **Word onset F1** — among text-aligned word pairs (output of the
  Wagner-Fischer DP), a true-positive requires the predicted onset
  to land within ±50 ms of the reference onset. Whisper-base's ~200 ms
  granularity caps this in the 0.3–0.6 range on most tracks; ctc-forced-aligner
  routinely sits above 0.85 when the reference text is accurate.

When BeatNet returns a meter and the value differs from the currently
selected Time Signature, a violet `BeatNet: 4/4` chip appears next to
the Time Signature select in the Song Info panel. Click it to apply
BeatNet's detected meter. The chip hides itself when the current value
already matches (or when no meter could be inferred from too few bars).

## PATTERN family

Output kind: **variable-length repeating motifs** discovered via DTW-warped
matching on beat-synchronous chroma. Each detected motif is a *set* of
similar (but not identical, and not necessarily evenly spaced) intervals.
Each occurrence surfaces as one inspector tile labelled `Motif N · k/m`
so the user can see "this is occurrence k of m for motif N" at a glance.
Tiles of the same motif share a color.

### Detector

| ID | What it does | Weights | Sidecar |
|---|---|---|---|
| `locomotif` | [LoCoMotif](https://github.com/ML-KULeuven/locomotif) (MIT, KU Leuven) — applies dynamic time warping over beat-synchronous chroma to find repeating motif sets. Variable length, time-warped. | None (pure DSP + numba JIT) | `pattern` (port 8017) |

### How it differs from LOOP

The LOOP family (`chroma-autocorr`) finds *exact-length, evenly-spaced*
N-bar repeats — useful for "is this loopable as an 8-bar phrase?". The
PATTERN family is broader: it discovers any musical motif that repeats,
even if the occurrences are different lengths and arrive at irregular
times. A chorus-with-variations or a riff that gets stretched/compressed
under a vocal line is exactly the kind of thing LoCoMotif catches that
chroma-autocorr misses.

### What lands on disk

`data/algorithm-outputs/pattern/<slug>/locomotif.json` contains:

```json
{
  "patterns": [
    {
      "start": 32.39, "end": 39.17,
      "label": "Motif 1 · 7/9",
      "motif_id": 1,
      "occurrence_index": 6,
      "occurrence_count": 9,
      "confidence": 0.87
    },
    ...
  ]
}
```

### One-time numba JIT warm-up

The first `/api/pattern/detect` call after the sidecar boots pays a one-time
~15 s numba JIT compile cost; subsequent calls are seconds. The Initialize
Models panel triggers this explicitly so the user can pay the warm-up cost
before clicking Run on a song.

### Pattern-specific eval columns

The PATTERN eval table adds two columns alongside the inherited
span-style metrics:

- **Cycle F1** — point-F1 over the expanded tile-start set
  (`start + k·cycleLen` for `k ∈ [0, repeatCount)`) at ±100 ms.
  Catches "right cycle length, wrong repeat count" cases the inherited
  interval IoU silently passes.
- **Accent Jaccard** — Jaccard of `highlightedBeats` sets averaged
  over ref/est pattern pairs that overlap (greedy by interval IoU).
  Empty-vs-empty (neither pattern accents any sub-beat) scores 1 so
  unaccented patterns don't drag the metric down.

## Warm models before first use (dev only)

The Initialize panel is the recommended way to warm models during normal
use. For batch dev work (multiple containers / fresh machines) the
project ships `tools/warm-experimental-models.sh` — a one-shot curl
loop over every `/api/<family>/algorithms` + `/api/<family>/initialize`
endpoint:

```sh
# Warm everything against the default dev base (http://localhost:5174):
./tools/warm-experimental-models.sh

# Custom host (VM, remote dev, CI):
./tools/warm-experimental-models.sh -h http://timecues-vm:5173

# Subset of families:
./tools/warm-experimental-models.sh --only lyrics,span
```

The script skips algorithms the sidecar reports as `available=false`
(deps missing) and prints a Ready / Failed / Skipped table at the end.
Exit code 1 if any /initialize returned non-2xx so it slots cleanly
into CI.

For ad-hoc per-algorithm warming the underlying endpoints still work:

```sh
curl -XPOST http://localhost:5173/api/span/initialize \
     -H 'content-type: application/json' \
     -d '{"algo": "silero-vad"}'
```

## Setlist workspace

A separate top-level workspace at `/setlist` that orders the corpus into a
DJ-style play sequence. Off by default — flip on **Enable Setlist workspace
(algorithmic DJ-style ordering)** under Settings → Experimental to expose
the tab.

### What it does

Pulls the cached BPM (median across the 5 detectors) for every song in your
corpus and runs a greedy nearest-neighbour pass over the included subset:
seed with the lowest-BPM song, then repeatedly pick whichever remaining song
has the smallest BPM gap to the tail of the sequence. Pairs whose BPMs
differ by ≥ 8 score 0 and are effectively pushed to the end. Songs with no
cached BPM trail at the very end in their original order.

### Controls

- **Strategy** — only `BPM ladder` ships in v0. The dropdown is the extension
  point for `harmonic-mix` (once Phase 3 key/chord detectors land) and
  future strategies.
- **Weights** — sliders for BPM, Meter, and Energy. v0 honours BPM and
  Meter; the Energy slider is disabled until that scorer ships.
- **Corpus picker** — every song is included by default. Uncheck songs you
  want to skip without removing them from the corpus.
- **Generated order panel** — shows the ordered list with each pair's Δ BPM,
  meter match (✓ / ✗), and combined score.

### Saving & exporting

Setlists persist per-annotator under
`data/setlists/<your-id>/<name>.json`. The **Save** button writes the
current order plus the strategy + weights used; the dropdown picker lists
your saved setlists. **Export JSON** downloads the same payload locally.

Server-side writes require team membership — public / demo visitors cannot
save and will see *Save failed — are you signed in as a team member?*. The
demo route is blocked entirely, since demo identities have no persistent
storage.

### What's next

Meter scoring is wired in but currently weighted 0 by default; flip the
slider up to bias same-meter neighbours. Energy and harmonic-mix scorers
arrive once the underlying cached signals (energy curves are already in
`mir_server.py`; key / chord wait on Phase 3) are plumbed through the
strategy registry. See `future_work/README.md` for the broader DJ-set
research track.

## When a feature graduates

Move its docs from this file into `USER_GUIDE.md` in the same change set
that flips its flag on by default. Remove the corresponding section here.
