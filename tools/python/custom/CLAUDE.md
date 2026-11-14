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
    output_kind = "boundary"      # "boundary" | "cue" | "span" | "loop" | "riff"
                                  # | "lanes" (several lanes at once — see
                                  # "Several lanes from one detector")
                                  # (loop/riff hidden when the
                                  # experimentalLoopsAndPatterns flag is off)
    is_annotation = False         # optional: a run also copies the output into a
                                  # new layer of the annotator who ran it (once).
                                  # Every detector shows in Algorithm Inspect
                                  # either way. Must be a real bool.
    review = False                # optional: ✓/✗ on every item. Off by default —
                                  # the lane shows its items plainly and ⬇ copy
                                  # is the approval. Must be a real bool.
    description = "..."           # optional, one sentence — ⓘ popover blurb
    stem = "mix"                  # optional: "vocals"|"drums"|"bass"|"other"|
                                  # "guitar"|"piano"|"mix" — or a list of them,
                                  # e.g. ["vocals", "other"], to run the detector
                                  # once per stem (see "One detector, several
                                  # stems" below)
    group = "Band"                # optional: family label shown as sub-heading in
                                  # the Detectors sidebar (e.g. "Band", "EDM",
                                  # "Instruments"). Detectors sharing a group are
                                  # clustered within their stem section.
    windowable = False            # optional: True lets it run on a highlighted
                                  # section alone — ONLY if detect() reads nothing
                                  # but ctx (and stem files via ctx.stem_file()).
                                  # See "Section runs" below. Must be a real bool.
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
  `"riff"`, `"lyrics"` or `"lanes"` — pick exactly one. `loop` and `riff` detectors are
  filtered out of the registry response when the
  `experimentalLoopsAndPatterns` Settings flag is off, matching the UI
  gating for those annotation tabs.
- **`is_annotation`** and **`review`**, when set, must be real bools. There is
  no `is_algorithm` any more — every detector shows in Algorithm Inspect; a
  file that still sets it loads and the line is ignored.
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
ctx.bpm            # float — the annotator's BPM from SongInfo, never a guess
ctx.beat_times_ms  # list[int], the ANNOTATOR'S beats in ms, exactly as the app
                   #   draws the grid: tempo splits, the pickup before bar 1 and
                   #   hand-placed beats included. Cut bars/sections at these.
ctx.downbeat_times_ms  # list[int], the annotator's bar lines, same grid
ctx.tracked_beat_times_ms  # list[int], the beats librosa TRACKED in the audio —
                   #   only for measuring the audio against the grid, never for
                   #   cutting.
# There is no fallback grid. The runner refuses to run ANY detector on a song
# with no BPM ("set the grid in Dataset Prep → Song Setup"), so detect() never
# sees a tracked, All-In-One or estimated grid — don't build one yourself.

# Grid params from SongInfo (curator-set, persisted to
# data/song-info/<slug>.json). Use these when emitting grid-aligned output.
ctx.grid_offset_ms   # int — time of bar 1 / beat 1 in ms
ctx.time_signature   # str  — e.g. "4/4"
ctx.beats_per_bar    # int  — parsed numerator (4 for "4/4")
ctx.grid_mode        # "static" | "mapped" | "manual"

ctx.window_start_ms  # None on a whole-song run; on a section run, where the
                     # section starts in the song (see "Section runs")
ctx.stem             # the stem THIS run is for ("vocals", "other", …), or
                     # None for the mix. See "One detector, several stems".
ctx.stem_file(stem)  # context manager → Path | None: the stem's file for
                     # THIS run (a temp file of only the section on a
                     # section run). Use it instead of paths.stem_audio().
```

### Section runs (`windowable = True`)

Algorithm Inspect can run a detector on just the highlighted region. The
runner then builds the context from that region alone: `audio`, `stems`,
`features` and the curves are cut to it, `duration_ms` is its length,
`beat_times_ms` are the grid's beats inside it, and `grid_offset_ms` is re-anchored to
its first downbeat. The detector answers in those **local** times and the
runner shifts the items back into song time. It also hears 1 s of lead-in
before the region, and drops anything found there, so the cut is not heard as
an attack. The annotator then Merges the result into the lane or Replaces the
region with it.

Set `windowable = True` only when `detect()` reads nothing but `ctx`. Reading a
stem file? Go through `with ctx.stem_file("bass") as path:`. Reading anything
else by `ctx.slug` (allin1, another detector's cache, a generator that loads
the song itself) means you would answer about the whole song while claiming
the section, so leave it `False`, and the UI lists the detector as *Whole song
only*.

### One detector, several stems

`stem` may be a list: `stem = ["vocals", "other"]`. The loader then registers
the detector **once per stem**, as `<name>__vocals` and `<name>__other` (a
`"mix"` entry keeps the bare `<name>`) — the same `<algo>__<stem>` id the
built-in algorithms use for a per-stem run. Each is its own detector to the
rest of the app: its own lane under that stem in the Detectors sidebar, its
own cached result, its own annotation copies. Each run is told its stem:

```python
    stem = ["vocals", "other"]

    def detect(self, ctx):
        y = ctx.stems.get(ctx.stem)      # the stem this run is for
        if y is None:
            return []
        ...
```

Rules the validator enforces: every entry must be an allowed stem, none
twice, and the list non-empty; `<name>__<stem>` must still fit the 31-character
name rule for every listed stem (so a name used this way is at most ~23
characters); and a list can't be combined with `stem_parts`, which already
reads several stems into ONE lane. The file itself — source, save, rename,
delete — is still addressed by the `name` written in it. A detector with a
single `stem = "vocals"` sees `ctx.stem == "vocals"` too, so code written
against `ctx.stem` works either way.

### Grid helpers (do not reimplement these)

`ctx` exposes three methods that give you the grid math, so detectors emit
grid-aligned output without copying the beat formula:

```python
ctx.bpm_at(t_ms)            # tempo at t_ms
ctx.beat_index_at(t_ms)     # cumulative integer beat index from origin
ctx.snap_to_beat_ms(t_ms)   # snap to the nearest beat
```

All three read the annotator's grid (`ctx.beat_times_ms`), so a tempo split or
a hand-placed beat is followed — never re-derive beats from `ctx.bpm` and
`ctx.grid_offset_ms`, which describe only the opening tempo. **Every detector
cuts on the annotator's grid**: anything it marks by bar or beat must land on
the lines the app draws. A detector's own beat tracking (librosa, All-In-One)
is never a substitute when the song has a grid.

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
| `color` | str \| None | no | `"#rrggbb"` — this section in its own colour instead of its type's |

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
| `color` | str \| None | no | `"#rrggbb"` — this span in its own colour instead of the lane's |
| `description` | str \| None | no | longer free-form note, shown only in the editor. An ⚡ Energy export (JSON with `"type": "energy_span"`, the shape `web-app/src/utils/energySpan.ts` writes) makes the span draw its measured A/D/S/R envelope and brightness curve. |
| `pulse` | str \| None | no | the rate this stretch hits at, relative to the beat: `"32nd"`, `"16th-triplet"`, `"16th"`, `"8th-triplet"`, `"8th"`, `"beat"`, `"bar"`, or `"silent"` for a stretch where nothing hits. Sets the span's Pulse field — the lane draws the ticks off the song's grid. Leave it unset where you can't tell; unset and `"silent"` are different claims. |

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
| `color` | str \| None | no | `"#rrggbb"` — this loop in its own colour instead of the lane's |

### `Riff` — for `output_kind="riff"`  *(experimental)*

A repeating figure, in the ONE shape a repeated figure takes everywhere — a
Riff Patterns layer in the app and in the export: a library of **nodes** (each
figure written once, its notes on its own pulse) and the **items** that place
them. A play that differed from its node (a dropped hit, a fill) is an
**occurrence** on its item — never a node of its own (there is no `A²`).
`detect()` returns ONE `Riff` (not a list). Filtered out of the registry when
`experimentalLoopsAndPatterns` is off. A groove of several drums is one riff
per drum: return a `"lanes"` detector with a riff lane each, `drum` set.

| field | type | required | bounds |
|---|---|---|---|
| `nodes` | list[`RiffNode`] | yes | ids unique in the riff |
| `items` | list[`RiffItem`] | yes | each plays nodes / combos of this riff |
| `combos` | list[`RiffCombo`] | no | a named run of nodes (A A B) placed like a node |
| `drum` | str \| None | no | the drum the lane plays (`"kick"`, `"snare"`, `"hat"` …) |
| `summary` | str \| None | no | the lane's big picture in one line |

#### `RiffNode`

| field | type | required | bounds |
|---|---|---|---|
| `id` | str | yes | unique in the riff; what sequences point at |
| `name` | str | yes | a letter for a groove (`"A"`), any short name otherwise |
| `steps_per_cycle` | int | yes | `>= 1` — the node's length in steps of its pulse (1-bar 4/4 on 16ths = 16) |
| `subbeats_per_beat` | int | no | the pulse, one of `4, 2, 1, 6, 3` (default 4 = sixteenths) |
| `notes` | list[`RiffNote`] | yes | the notes; rests are filled in |
| `color` | str \| None | no | `"#rrggbb"`; None lets the app pick |
| `names` | list[str] \| None | no | what a musician would call it (`"dembow"`) |

#### `RiffNote`

| field | type | required | bounds |
|---|---|---|---|
| `start` / `end` | float | yes | beats from the node's start, `0 <= start < end <= node length`, on the pulse |
| `note` | int \| None | no | MIDI pitch `[0, 127]` for a pitched note |
| `label` | str \| None | no | what to call it (`"C1"`, `"ghost"`) |
| `accent` | int \| None | no | how hard it is struck, `[1, 127]`; None = full strength |

#### `RiffItem`, `RiffEntry`, `RiffOccurrence`

| field | type | required | bounds |
|---|---|---|---|
| `RiffItem.start` / `end` | float | yes | **seconds**; `end` is where the FIRST cycle ends |
| `RiffItem.sequence` | list[`RiffEntry`] | yes | non-empty; played end to end, `repeat_count` times |
| `RiffItem.repeat_count` | int | no | `>= 1` (default 1) |
| `RiffItem.occurrences` | list[`RiffOccurrence`] \| None | no | the plays that differed from their node |
| `RiffEntry.type` / `length_steps` | str / int | yes | a node or combo id (or `RIFF_SILENCE`), and how long it plays in **sixteenths** whatever the node's pulse |
| `RiffOccurrence.index` | int | yes | which play: repeat `r` of an `n`-entry sequence plays entry `e` as `r * n + e` |
| `RiffOccurrence.event` | str | yes | `"fill"` (only added), `"drop"` (nothing struck), `"variation"`, `"exact"` |
| `RiffOccurrence.added` | list[`RiffNote`] \| None | no | notes the play struck that the node does not have |
| `RiffOccurrence.missing` | list[float] \| None | no | starts (beats) of the node's notes it left out |

A generator that finds runs the drum-groove way (canonical cycle + every
repeat as played) turns them into riffs with `generators.riff_out.riffs()`.

`detect()` must return a `list` (a `Riff` for `"riff"`). Anything else is rejected wholesale. If you
return a generator or a NumPy array, validation will fail.

### `Lane` — for `output_kind="lanes"`: several lanes from one detector

A detector that reads one thing several ways — each instrument's notes AND its
loop, say — can return several lanes, of different kinds, from one run. It is
still ONE detector: one row in the Detectors sidebar, one Run, one show / hide.

```python
from custom_api import Cue, CustomDetector, Lane, Riff, RiffEntry, RiffItem, RiffNode, RiffNote

class Layers(CustomDetector):
    name = "layers"
    label = "Layers"
    output_kind = "lanes"

    def detect(self, ctx):
        return [
            Lane(id="kick_notes", label="Kick notes", output_kind="cue",
                 group="Kick", items=[Cue(time_ms=0), Cue(time_ms=500)]),
            Lane(id="kick_pattern", label="Kick pattern", output_kind="riff",
                 group="Kick", items=Riff(
                     nodes=[RiffNode(id="a", name="A", steps_per_cycle=16,
                                     notes=[RiffNote(b, b + 0.25) for b in range(4)])],
                     items=[RiffItem(start=0.0, end=2.0, repeat_count=4,
                                     sequence=[RiffEntry("a", 16)])],
                     drum="kick")),
        ]
```

| field | type | required | bounds |
|---|---|---|---|
| `id` | str | yes | the lane's name within the detector, same rule as a detector `name`; unique per run |
| `label` | str | yes | 1–80 chars, what the lane is called |
| `output_kind` | str | yes | any kind but `"lanes"` |
| `items` | list | yes | that kind's dataclasses, validated exactly as a single-kind detector's are |
| `group` | str \| None | no | lanes sharing a group are drawn in one band ("Kick": the kick's notes and its loop) |

A malformed lane (bad id, a repeated id, no label, an unknown kind) is dropped
whole with one error; a bad item in a good lane is dropped alone, its error
naming the lane (`kick_notes.items[3]`). Riff and loop lanes are hidden with
the experimental flag off, like a riff or loop detector.

A `"lanes"` detector may set `strictness` (one setting for all its lanes),
`windowable` (a section run is merged into each lane on its own, into the
cached lane with the same id; a lane the cache does not have yet is added) and
a list of stems (one run, and one set of lanes, per stem — give each stem's
lanes their own `group`, or they share a band) and `is_annotation` (each lane
with a layer to copy into — not a riff lane — is copied as
"<label> · <lane label>"). A section run may return only the lanes it can read
from the section; the cached lanes it leaves out stay as they were. It cannot
set `review` or `stem_parts` — each acts on ONE list of items.

Other code that reads one lane of a lanes detector's saved output goes through
`custom_runner.get_cached_lane(name, slug, lane_id)`, which also reads a result
saved before that detector had lanes, as it is.

### Where the drums come from: `drum_source`

Every detector that reads labelled drum hits reads them through
`generators.drum_hits.drum_hits()` — the separated kit (Drum kit, separated /
`drum_kit_split`, DrumSep) where the song has been split, the drums stem's three
bands (Drum hits) otherwise. A detector that sets `drum_source = True` lets the
annotator pin that: its sidebar row gets a pill — **Auto** (showing what it
read, "Auto · kit"), **Kit** or **Bands** — that opens a three-way picker under
the row; choosing runs nothing, ▶ Run applies it. The run reads the pick as
`ctx.drum_source`, but a detector never needs to: the runner wraps detect() in
`drum_hits.reading(...)`, so every read in the run follows it. Kit with no kit
run reads nothing and says so (`kit-not-run`) rather than quietly reading the
bands. The pill only shows where `drum_kit_split` is installed.

Every run that reads drums — offering the pick or not — records `drum_read` on
its envelope: `source` ("kit" | "bands") and `kit_ran_at`, the kit run it read
(None for none). The sidebar compares that with the kit run on screen and marks
the row **out of date** when the kit was split after the lane was read, split
again, or deleted. Band reads carry a `band-source` note as kit reads carry
`kit-source`, so the ⓘ says which it was. Set on Percussion layers
(`instrument_layers`) and Drum hits & grooves (its Grooves lane; the Hits lane
is the bands by definition).

There is still one saved result per detector per song: running from Bands
replaces the Kit lane. To compare the two, copy one to a layer with ⬇ first.

### Where the sections come from: `section_source`

A detector that scores the song section by section and sets
`section_source = True` lets the annotator pick the sections: **Auto** (their
first boundaries layer with marks, All-In-One otherwise), **Annotated** or
**All-In-One**. The pick arrives as `ctx.section_source`, and `ctx.annotator`
is whose layer *Annotated* means (None from a batch run). The detector reads
the sections itself — it reads files by slug, so it is not `windowable` — and
says which it read with `ctx.section_read.update({"source": "annotated" |
"allin1" | "none", "layer": ...})`. The runner saves both on the envelope
(`section_source`, `section_read`), and the sidebar pill says "Auto ·
Annotated". Set on Energy levels (`energy_levels`).

### Reading the annotator's layers: `reads_layers`

A detector that works on what the annotator drew — their lyrics, say — sets
`reads_layers = True`, and the run hands it `ctx.annotator` (None from a batch
run: say so and read nothing). It reads
`paths.ANNOTATION_LAYERS_DIR / ctx.annotator / f"{ctx.slug}.json"` itself, so
it is not `windowable`. The song keeps one result per detector, so a run reads
the layers as they were when ▶ Run was pressed. Set on Held lyrics
(`visualizer/lyric_envelopes.py`).

### Where the input comes from: `sources`

A detector that can read its input from more than one place declares them,
name → (label, hint), in the order the picker shows them; the first is the
default:

```python
    sources = {
        "auto": ("Auto", "Your lyrics lanes, else the first model that has run."),
        "yours": ("Yours", "Your own lyrics lanes on this song."),
        "ivrit": ("ivrit", "ivrit.ai's Whisper, trained on Hebrew."),
    }

    def detect(self, ctx):
        want = ctx.source              # one of the names above
        ...
        ctx.source_read.update({"source": "ivrit"})   # what Auto came to
```

The row gets a pill ("Auto · ivrit" once run) that opens the choices as
buttons, each with its hint; choosing runs nothing, ▶ Run applies it. The run
reads `?source=` (a name the detector does not offer is refused, and the
song's saved result is left alone), the envelope records `source` and
`source_read`, and a cached result read from another source is a miss. Names
follow the detector `name` rule, labels are 1–24 chars. A third entry,
`(label, hint, group)`, shows the choice under that heading with the rest of
its group ("Models — as they came out"); ungrouped choices sit on top. Set on Held lyrics
(`visualizer/lyric_envelopes.py`).

Add `lane_sources = "lyrics"` (any layer type) and the picker also lists each
of the annotator's lanes of that type on the song, by name, as the source
`lane:<layer id>`. The detector finds that layer itself — in the team document
on a shared song, else the annotator's own — and says so if it is gone.

### Facts about the song: `switches`

A reading that depends on a yes/no fact about the song — one the audio can't
settle — declares it as a switch, name → label:

```python
    switches = {"bass_leads": "The bass leads this song"}

    def detect(self, ctx):
        bass_leads = ctx.switches.get("bass_leads") is True
```

Each switch is a tick on its own line under the detector's sidebar row,
always in sight. Ticking runs nothing; while a tick differs from what the lane
on screen was read with, an amber ▶ Run sits beside it, and an unrun tick is
dropped when the annotator changes song. The run reads `ctx.switches`
(`{name: bool}`, every declared name present), and the envelope records it as
`switches`. A switch is a fact about the song, not a reading choice, so a run
that does not name the switches (`?switches=` absent — a batch run, a section
run) keeps the ones the song's last result had; `?switches=` empty unticks
them all. Names follow the detector `name` rule, labels are 1–80 chars.
In front (`visualizer/prominence.py`) declares `bass_leads`.

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
6. Inspect results in Algorithm Inspect, where the detector has a lane in the
   Detectors sidebar. If `is_annotation=True`, the run also copied the output
   into a new layer of yours, which the Annotator Tool shows.

If anything is wrong, the registry entry will carry `status="validation_error"`
or `status="load_error"` with concrete error messages — read them before
asking why your detector isn't showing up.
