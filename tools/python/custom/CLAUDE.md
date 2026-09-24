# Writing a custom detector for timecues-agent

> **Audience:** anyone (human or LLM) writing a single detector.
> For the architecture overview — how this folder fits into the rest of
> the system, where files live on disk, how to verify the runtime — see
> the companion [README.md](./README.md). This file is the *contract*:
> what your code must look like and what the validator will accept.

Drop your `.py` file in this directory (`tools/python/custom/`). The server
auto-discovers it. The shipped `template.py` and `example_*.py` detectors live
in `tools/python/custom-default/` and are discovered the same way. Hit `POST /api/custom-scripts/reload` (or restart the dev
server) to refresh the registry.

If you are an LLM (Claude Code) helping a user write one, **read this whole
file before generating code** — every rule below is enforced by an
unforgiving validator that will reject your output.

---

## The contract (do not deviate)

```python
from custom_api import Boundary, Cue, CustomDetector, DetectionContext

class MyDetector(CustomDetector):
    name = "my_detector"          # required, see naming rules below
    label = "Human-readable name" # required, 1–80 chars
    output_kind = "boundary"      # "boundary" | "cue" | "span" | "loop" | "pattern"
                                  # (loop/pattern hidden when the
                                  # experimentalLoopsAndPatterns flag is off)
    is_algorithm = True           # show as algorithm overlay
    is_annotation = False         # also/instead surface as editable annotation tab
    description = "..."           # optional, one sentence — ⓘ popover blurb
    stem = "mix"                  # optional: "vocals"|"drums"|"bass"|"other"|"mix"
    group = "Band"                # optional: family label shown as sub-heading in
                                  # the Detectors sidebar (e.g. "Band", "EDM",
                                  # "Instruments"). Detectors sharing a group are
                                  # clustered within their stem section.
    version = "0.1"               # optional, semver-ish

    def detect(self, ctx: DetectionContext) -> list[Boundary] | list[Cue]:
        return []
```

### Hard rules

- **One detector per file.** A file with zero or two-or-more `CustomDetector`
  subclasses is rejected.
- **`name`** must match `^[a-z][a-z0-9_-]{0,30}$` (lowercase letter first;
  letters/digits/`_`/`-` only; max 31 chars) and be unique across the
  registry. Duplicates are rejected on every conflicting file.
- **`label`** must be a non-empty string ≤ 80 chars.
- **`output_kind`** must be one of `"boundary"`, `"cue"`, `"span"`, `"loop"`,
  or `"pattern"` — pick exactly one. `loop` and `pattern` detectors are
  filtered out of the registry response when the
  `experimentalLoopsAndPatterns` Settings flag is off, matching the UI
  gating for those annotation tabs.
- **At least one of** `is_algorithm` / `is_annotation` must be `True`.
- **`detect`** must be overridden. The default raises `NotImplementedError`
  and is rejected.

If any rule fails, the file shows up in the registry with
`status="validation_error"` and your error appears in the UI. The detector
is *not* runnable until you fix it.

---

## Available inputs (the `DetectionContext`)

```python
ctx.audio          # np.ndarray, mono, float32, sample rate = ctx.sr (22050)
ctx.sr             # int, always 22050
ctx.duration_ms    # int, rounded track length in ms
ctx.stems          # dict[str, np.ndarray] — keys are some subset of
                   #   {"vocals", "drums", "bass", "other"}.
                   # Empty dict if the song has not been demuxed. ALWAYS
                   # handle the empty case.
ctx.features       # AudioFeatures (see below)
ctx.energy_curve   # np.ndarray in [0, 1], 100 ms per sample
ctx.tension_curve  # np.ndarray in [0, 1], 100 ms per sample
ctx.bpm            # float — curator-confirmed (falls back to features.tempo)
ctx.beat_times_ms  # list[int], beat instants in ms (sorted ascending)

# Grid params from SongInfo (curator-set, persisted to
# data/song-info/<slug>.json). Use these when emitting grid-aligned output.
ctx.grid_offset_ms   # int — time of bar 1 / beat 1 in ms
ctx.time_signature   # str  — e.g. "4/4"
ctx.beats_per_bar    # int  — parsed numerator (4 for "4/4")
ctx.grid_mode        # "static" | "mapped" | "manual"
```

### Grid helpers (do not reimplement these)

`ctx` exposes three methods that give you the grid math, so detectors emit
grid-aligned output without copying the beat formula:

```python
ctx.bpm_at(t_ms)            # tempo at t_ms
ctx.beat_index_at(t_ms)     # cumulative integer beat index from origin
ctx.snap_to_beat_ms(t_ms)   # snap to the nearest beat
```

All three read `ctx.bpm` and `ctx.grid_offset_ms` — identical to a manual
computation, and the one place to change if the grid math ever moves.

`AudioFeatures` (from `shared.models`) — pre-extracted, all NumPy arrays
unless noted:

```
rms                  spectral_centroid     spectral_bandwidth
spectral_flux        spectral_flatness     spectral_rolloff
chromagram (12×n)    mfcc (13×n)
onset_env            onset_frames          tempo (float)
beat_frames
sr (int)             hop_length (512)      n_frames (int)
frame_times_ms (np.ndarray)
```

Hop length is 512 at sr=22050 → ~23 ms per frame. Multiply
`frame_index * hop_length / sr` to get seconds.

---

## Output schema

### `Boundary` — for `output_kind="boundary"`

| field | type | required | bounds |
|---|---|---|---|
| `time_ms` | int | yes | `[0, ctx.duration_ms]` |
| `label` | str \| None | no | — |
| `importance` | `"critical"` \| `"optional"` \| None | no | — |
| `candidates` | list[int] \| None | no | every entry in `[0, ctx.duration_ms]` |

### `Cue` — for `output_kind="cue"`

A `Cue` is a labeled point in time — a discrete event such as a kick hit, FX
trigger, or clap. It does NOT partition the timeline the way a `Boundary`
does. Like `Boundary`, it can carry alternative `candidates` so a detector
that names two equally plausible times for the same event doesn't have to
pick one.

| field | type | required | bounds |
|---|---|---|---|
| `time_ms` | int | yes | `[0, ctx.duration_ms]` |
| `label` | str \| None | no | short text, shown next to the tick on the canvas |
| `description` | str \| None | no | longer free-form note, shown only in the editor |
| `intensity` | float \| None | no | `[0.0, 1.0]` |
| `candidates` | list[int] \| None | no | every entry in `[0, ctx.duration_ms]` |
| `velocity` | int \| None | no | `[1, 127]` — how hard this hit was struck, against the same instrument's hardest hit; the tick draws this tall |
| `level_db` | float \| None | no | finite, `<= 0` — level against the loudest hit in the track (comparable across instruments) |
| `color` | str \| None | no | `"#rrggbb"` — paints this one tick instead of the lane colour (e.g. one hue per drum) |
| `note` | int \| None | no | `[0, 127]` — MIDI note number of the hit's pitch (60 = middle C); shown by name on hover |
| `decay_ms` | int \| None | no | `> 0` — how long the hit rings; drawn as a faint tail after the tick |
| `importance` | str \| None | no | `"critical"` / `"optional"` — the same ★ a hand-placed cue carries |

`time_ms` must be **`int`** (Python int or NumPy integer). Floats and
`np.float64` are rejected — cast with `int(round(x))` when in doubt.

Every field except `time_ms` is optional — set only what your detector
knows. `velocity`, `level_db`, `color`, `note` and `decay_ms` are for
**struck** cues (drum hits, plucks). `velocity`, `note` and `decay_ms` must be
`int`s too, not floats. None of the three is a
confidence — use `intensity` for that. The runner only writes them into the
output when you set them.

### `Span` — for `output_kind="span"`

A labeled interval that may overlap with other spans on the same layer
(vocal-active regions, instrument presence, FX sweeps, hierarchical phrases).

| field | type | required | bounds |
|---|---|---|---|
| `start_ms` | int | yes | `[0, ctx.duration_ms]` |
| `duration_ms` | int | yes | `> 0`; `start_ms + duration_ms ≤ ctx.duration_ms` |
| `label` | str \| None | no | — |
| `intensity` | float \| None | no | `[0.0, 1.0]` |

### `Loop` — for `output_kind="loop"`  *(experimental)*

A grid-aware seamless-playback interval — signals "this region works
musically when played back-to-back on repeat" (N-bar phrases, drum loops, DJ
pickups). Filtered out of the registry when `experimentalLoopsAndPatterns`
is off.

| field | type | required | bounds |
|---|---|---|---|
| `start_ms` | int | yes | `[0, ctx.duration_ms]` |
| `duration_ms` | int | yes | `> 0`; `start_ms + duration_ms ≤ ctx.duration_ms` |
| `label` | str \| None | no | — |
| `snap_zero_cross` | bool \| None | no | UI hint: snap loop edges to nearest audio zero-crossing |

### `Pattern` — for `output_kind="pattern"`  *(experimental)*

A short repeating motif that tiles across the track. `start_ms` +
`duration_ms` describe ONE cycle; the renderer multiplies it `repeat_count`
times. Filtered out of the registry when `experimentalLoopsAndPatterns` is
off.

| field | type | required | bounds |
|---|---|---|---|
| `start_ms` | int | yes | `[0, ctx.duration_ms]` |
| `duration_ms` | int | yes | `> 0` (one cycle length); `start_ms + repeat_count * duration_ms ≤ ctx.duration_ms` |
| `label` | str \| None | no | — |
| `repeat_count` | int | yes | `>= 1` |
| `highlighted_beats` | list[int] \| None | no | 0-based step indices inside one cycle that are accented (`0 .. steps_per_cycle - 1`) |
| `steps_per_cycle` | int \| None | no | how many sub-steps the cycle is divided into — the index space of `highlighted_beats`. Set it to match YOUR cycle (1-bar 4/4 → 16, a 2-beat cycle → 8). When omitted the UI falls back to `beats_per_bar × 4`. |
| `rows` | list[`PatternRow`] \| None | no | named lines played at once (a drum groove is kick + snare + hat, not one list of hits). Each becomes its own riff node, drawn as a stacked row. |
| `occurrences` | list[`PatternOccurrence`] \| None | no | per-repeat detail: how far each repeat strayed from the canonical cycle, and which steps it added or dropped. |
| `motif` | str \| None | no | names the FIGURE, where `label` describes this one run of it. Two patterns carrying the same motif are the same thing coming back — the verse groove returning in the drop. Keep it short and stable (a letter, a slug); the UI builds node names from it (`"A"` → `Groove A · Kick`) and reuses one node across every run that plays the same bar. |

#### `PatternRow`

| field | type | required | bounds |
|---|---|---|---|
| `row` | str | yes | the line's name, e.g. `"kick"` |
| `highlighted_beats` | list[int] | yes | step indices in the pattern's own `steps_per_cycle` space |
| `accents` | list[int] \| None | no | how hard each of those steps is struck, **positional** against `highlighted_beats` (`accents[k]` belongs to `highlighted_beats[k]`). Values clamp to 1–127; a shorter list leaves the rest at full strength, a longer one is rejected. Drawn as chip brightness. |

#### `PatternOccurrence`

| field | type | required | bounds |
|---|---|---|---|
| `index` | int | yes | which repeat this is |
| `start_ms` | int | yes | when it starts |
| `deviation` | float | yes | `[0.0, 1.0]`; 0 = played exactly |
| `added` / `missing` / `relabelled` | list[dict] \| None | no | the cells that differ, as `{"row": str, "step": int}` |

When you emit `rows`, also set the top-level `highlighted_beats` to their
**union**, so a reader that only knows the single-row shape still draws the
figure rather than nothing.

`detect()` must return a `list`. Anything else is rejected wholesale. If you
return a generator or a NumPy array, validation will fail.

---

## Validation behavior (per item)

The runner validates every item independently:

- **Bad items are dropped, good items are kept.** You don't lose all your
  output because of one offender.
- **Every dropped item produces a structured error**: `{index, field, value, message}`.
- **An exception inside `detect()` is caught and reported** — the envelope
  stores the type, message, and full traceback under `fatal`.

There is no recovery if the *manifest* fails (load-time validation). The
detector simply does not appear as runnable until the file is fixed.

---

## Do / don't

- ✅ Use only what's on `ctx`. Don't try to read files, hit the network, or
  spawn subprocesses — your code will run inside a long-lived server.
- ✅ Cast to `int` before constructing `Boundary` / `Cue`. NumPy integers
  are fine, but `float` is not.
- ✅ Bail out cleanly with `return []` if your input is too short or noisy.
- ❌ Don't import from anywhere except `custom_api` and stdlib / NumPy /
  librosa / SciPy. Other deps may not be installed.
- ❌ Don't mutate `ctx` (it's frozen — you'll get a `FrozenInstanceError`).
- ❌ Don't pickle or hash NumPy arrays for caching. The runner already
  caches one envelope per `(name, slug)`.

---

## Examples

### Boundary detector (audio-only)

```python
import numpy as np
from custom_api import Boundary, CustomDetector, DetectionContext

class LoudnessJumps(CustomDetector):
    name = "loudness_jumps"
    label = "Loudness jumps"
    output_kind = "boundary"
    is_algorithm = True

    def detect(self, ctx: DetectionContext) -> list[Boundary]:
        rms = np.asarray(ctx.features.rms, dtype=np.float32)
        if rms.size < 4:
            return []
        diffs = np.abs(np.diff(rms))
        threshold = float(np.mean(diffs) + 3 * np.std(diffs))
        idxs = np.where(diffs > threshold)[0]
        # frame index → ms via hop_length / sr.
        ms_per_frame = ctx.features.hop_length * 1000 / ctx.features.sr
        return [
            Boundary(time_ms=int(round(i * ms_per_frame)))
            for i in idxs
            if 0 <= int(round(i * ms_per_frame)) <= ctx.duration_ms
        ]
```

### Cue detector (point events from onset detection)

```python
import numpy as np
from custom_api import Cue, CustomDetector, DetectionContext

class OnsetCues(CustomDetector):
    name = "onset_cues"
    label = "Onset cues"
    output_kind = "cue"
    is_algorithm = True
    is_annotation = True   # also editable as an annotation tab

    def detect(self, ctx: DetectionContext) -> list[Cue]:
        # ctx.features.onset_frames is already populated by the feature
        # extractor — turn each frame into a single labeled cue point.
        frames = np.asarray(ctx.features.onset_frames or [], dtype=np.int64)
        if frames.size == 0:
            return []
        # Frame index → ms via hop_length / sr.
        ms_per_frame = ctx.features.hop_length * 1000 / ctx.features.sr
        out: list[Cue] = []
        for f in frames:
            t_ms = int(round(f * ms_per_frame))
            if 0 <= t_ms <= ctx.duration_ms:
                out.append(Cue(time_ms=t_ms, label="onset"))
        return out
```

### Grid-aligned detector (uses the grid helpers)

```python
from custom_api import Boundary, CustomDetector, DetectionContext

class EveryEightBars(CustomDetector):
    """Emits a boundary every 8 bars, snapped to the grid. Routes every
    timestamp query through ctx.beat_index_at / ctx.snap_to_beat_ms so the
    grid math lives in one place."""

    name = "every_eight_bars"
    label = "Every 8 bars"
    output_kind = "boundary"

    def detect(self, ctx: DetectionContext) -> list[Boundary]:
        if ctx.bpm <= 0:
            return []
        out: list[Boundary] = []
        # Walk by beat index rather than by wall time.
        t = ctx.grid_offset_ms
        beats_per_phrase = ctx.beats_per_bar * 8
        idx = ctx.beat_index_at(t)
        while t <= ctx.duration_ms:
            if idx % beats_per_phrase == 0:
                snapped = ctx.snap_to_beat_ms(t)
                if 0 <= snapped <= ctx.duration_ms:
                    out.append(Boundary(time_ms=snapped))
            idx += 1
            # Step forward one beat at the song's tempo.
            t += int(round(60000.0 / ctx.bpm_at(t)))
        return out
```

---

## Workflow for the user

1. Copy `../custom-default/template.py` → `<your_name>.py` in this folder.
2. Fill in `detect()`. Reference `../custom-default/example_energy.py` for a
   working pattern.
3. Save the file in `tools/python/custom/`.
4. Reload the registry (server restart, or `POST /api/custom-scripts/reload`).
5. From the `/custom` web page: click **Run** to execute it on a song.
6. Inspect results in the regular inspector view. If `is_annotation=True`,
   also a new editable tab appears alongside Manual / Eye / Auto-guess.

If anything is wrong, the registry entry will carry `status="validation_error"`
or `status="load_error"` with concrete error messages — read them before
asking why your detector isn't showing up.
