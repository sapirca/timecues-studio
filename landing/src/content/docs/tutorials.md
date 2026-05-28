---
title: Video tutorials
description: Screencast walkthroughs of every TimeCues workflow — annotation, comparison, auto-guess, custom detectors. Most are still stubs; videos rolling in over time.
---

Short screencasts that walk through every TimeCues workflow. The list
below is the planned curriculum — most are still stubs (red LED) and will
flip to green as recordings land. **Every stub has a step-by-step textual
guide further down this page** — you can follow it today, the screencast
is just the friendly version of the same flow.

If there's one you'd like me to record first, [say so on the contact page](/contact/).

<div class="tutorial-grid">

  <div class="tutorial-stub">
    <h3><span class="stub-led"></span> Getting started in 3 minutes</h3>
    <p>Open a song, scrub the waveform, drop your first boundary, save. The shortest possible loop through the app.</p>
    <div class="stub-status">Stub · Up next</div>
  </div>

  <div class="tutorial-stub">
    <h3><span class="stub-led"></span> Creating a new dataset</h3>
    <p>From a fresh deploy to your first reviewed corpus — claiming the workspace, uploading audio, picking an access tier, inviting your team, and switching between datasets.</p>
    <div class="stub-status">Stub</div>
  </div>

  <div class="tutorial-stub">
    <h3><span class="stub-led"></span> Aligning the beat grid</h3>
    <p>Bar-start anchor, Grid Offset, Static BPM vs Dynamic vs Manual modes, what to do with songs that drift, and how to read the red / amber / emerald grid-readiness glyph.</p>
    <div class="stub-status">Stub</div>
  </div>

  <div class="tutorial-stub">
    <h3><span class="stub-led"></span> Annotating boundaries with the keyboard</h3>
    <p>The full keyboard-driven flow — M to add, snap-to-grid, the violet-halo tick when you snap, undo/redo, and how to think about the layer cards in the sidebar.</p>
    <div class="stub-status">Stub</div>
  </div>

  <div class="tutorial-stub">
    <h3><span class="stub-led"></span> Comparing algorithms</h3>
    <p>Toggle algorithm overlays, read the per-song F-measure and HitRate, and switch reference layers to see how scores shift.</p>
    <div class="stub-status">Stub</div>
  </div>

  <div class="tutorial-stub">
    <h3><span class="stub-led"></span> The Auto-guess workflow</h3>
    <p>Generate an AutoGuess from the four clustered algorithms, then tick through point-by-point with ✓ / ✗ / @ to harvest a clean manual layer in a fraction of the time.</p>
    <div class="stub-status">Stub</div>
  </div>

  <div class="tutorial-stub">
    <h3><span class="stub-led"></span> Eye annotations from the spectrogram</h3>
    <p>Doing a quick by-eye pass on the spectrogram alone, when audio playback isn't an option, and how Eye annotations compare to Manual.</p>
    <div class="stub-status">Stub</div>
  </div>

  <div class="tutorial-stub">
    <h3><span class="stub-led"></span> Writing a custom detector</h3>
    <p>Drop a Python file in <code>tools/python/custom/</code>, reload, and have your algorithm show up as an overlay with full evaluation. No build step.</p>
    <div class="stub-status">Stub</div>
  </div>

  <div class="tutorial-stub">
    <h3><span class="stub-led"></span> Multi-annotator: comparing two people's work</h3>
    <p>Signing in, the per-annotator namespace, side-by-side comparison view, and resolving disagreements between annotators.</p>
    <div class="stub-status">Stub</div>
  </div>

  <div class="tutorial-stub">
    <h3><span class="stub-led"></span> BPM auto-detection chips</h3>
    <p>The five detectors (librosa + CPJKU-madmom), what the clickable chips do, and how to pick the right candidate when they disagree.</p>
    <div class="stub-status">Stub</div>
  </div>

  <div class="tutorial-stub">
    <h3><span class="stub-led"></span> Stem separation with Demucs</h3>
    <p>Triggering the stems daemon, what the wait time looks like, and using the resulting vocal / drum / bass / other tracks in inspection.</p>
    <div class="stub-status">Stub</div>
  </div>

  <div class="tutorial-stub">
    <h3><span class="stub-led"></span> Self-hosting on your own server</h3>
    <p>Bring up the Docker stack on any VM or homelab, put a TLS reverse proxy in front, and claim the first admin.</p>
    <div class="stub-status">Stub</div>
  </div>

  <div class="tutorial-stub">
    <h3><span class="stub-led"></span> Settings — the complete tour</h3>
    <p>Every panel, every toggle, every dropdown — the role banner, the five categories (User info / Annotation / Research / Corpus management / Danger Zone), what's admin-only, and where to flip each one.</p>
    <div class="stub-status">Stub</div>
  </div>

</div>

## Want one sooner?

The order above is roughly priority-first. If there's a specific
workflow you'd find most useful — or a wrinkle in the app that confused
you and would benefit from being shown rather than written — drop a note
on the [contact page](/contact/) and I'll bump it up.

---

# Textual walkthroughs

The detailed step-by-step guide for every stub above. Skim the one that
matches what you want to do — each section is self-contained and
references the deep-dive part of the [user guide](/timecues/user-guide/)
when the topic deserves more than a screencast can give.

> ⚠ **Set BPM and lock the grid in Dataprep before anything else.** Every
> annotation snaps to the song's beat grid, and the Annotator Tool
> refuses to open without a BPM. The grid-readiness glyph on the song
> row in the sidebar turns **emerald ♩** once you're ready; amber ♩
> means the grid is not locked yet, red ♩ means BPM is still missing.

## Getting started in 3 minutes

The shortest possible loop through the app — open a song, lock the
grid, drop your first boundary, save.

1. **Open the app** — [the live demo](__LIVE_DEMO_URL__)
   if you just want to look, or your own deploy from `docker compose up`.
   The main page shows two entry cards: *Enter Demo* and either *Start
   a new dataset* (fresh deploy) or *Enter `<corpus>`* (already claimed).
2. **Sign in or click Enter Demo.** Demo Mode needs no account and
   keeps every edit in `localStorage`; signing in writes annotations
   server-side under your annotator id.
3. **You land in Dataprep.** Pick a song in the left sidebar. If the
   manifest is empty, drop an MP3 into the upload zone.
4. **Open the *BPM and Grid ▸* disclosure** below the waveform. Click
   an `Auto-detected` chip (or type a value) to set BPM. Click *Set bar
   start (G)* at the first audible kick to align bar 1.
5. **Switch to the *Annotator Tool* tab.** The song's sidebar glyph
   should now read emerald ♩.
6. **Press space to play, press M when the song hits a section
   transition.** The boundary lands on the nearest beat; tab to give it
   a label.
7. **Auto-saves on every edit.** No save button. Refresh — the boundary
   is still there.

## Creating a new dataset

From a fresh deploy to your first reviewed corpus. This is the
"day-zero" path — the first thing you do on a TimeCues install where
nobody's claimed the workspace yet.

### Demo vs. claimed corpus

The landing page after sign-in shows two cards, so know which one you
want:

- **Enter Demo** — uses the three CC0 songs shipped in
  `data-default/songs/` (`edm-at-midnight`, `pantheon`, `phonk-remix`)
  with pre-computed BPM, grids, stems, and one Manual layer per song.
  Every edit lives only in your browser's `localStorage` — nothing
  hits disk. Use this to evaluate the tool with zero commitment;
  reset by clearing site data.
- **Start a new dataset** *(fresh deploy)* — claims the corpus on disk
  for your annotator id, with you as the first admin. Audio uploads,
  annotations, and BPM caches all persist to `data/songs/`,
  `data/annotations/`, and `data/algorithm-outputs/`.
- **Enter `<corpus name>`** *(already-claimed deploy)* — the corpus
  exists; you're joining as whatever tier the admin set for your
  email. If your email isn't on the allowlist you'll see a
  Public-tier read-only view of the demo songs only.

### Step by step — creating from scratch

1. **Open the app** at your deploy URL or
   [the live demo](__LIVE_DEMO_URL__). If this is a
   fresh deploy the landing page will show *Start a new dataset*. If
   someone's already claimed it you'll see *Enter `<corpus>`* and need
   that admin to add you to the team.
2. **Click *Start a new dataset*.** You'll be prompted to sign in via
   Google. Your email becomes the first admin's id; in
   `dataset-config.json` it lands under `peopleByEmail[<you>].tier =
   "admin"`.
3. **Name the corpus.** This is the human-readable string that shows
   in the sidebar title and the *Enter `<corpus>`* card. Stored at
   `data/dataset-config.json:datasetName`. Edit later from
   **Settings → Corpus management → Admin & access**.
4. **You land in Dataprep** with an empty song list. The viz canvas
   shows a placeholder.
5. **Drop audio into the upload zone** at the bottom of the song
   sidebar. MP3, WAV, FLAC, and M4A are supported; the file's slug is
   derived from the filename (lowercased, non-alphanumeric → `-`),
   and the file lands at `data/songs/<slug>/<filename>.<ext>`.
   *Drag-drop multiple files at once* to bulk-add — each one becomes
   its own song row.
6. **Click a song** in the sidebar to open it. The waveform draws,
   the audio decodes. If you uploaded files with embedded ID3 metadata
   the *Song Info Bar* pre-fills title and artist.
7. **Lock the grid for this song.** Open the *BPM and Grid ▸*
   disclosure (see [Aligning the beat grid](#aligning-the-beat-grid)
   below). The sidebar's per-song workflow glyph flips from red ♩
   to amber ♩ once BPM is set, and to emerald ♩ once you've
   confirmed the grid by anchoring the bar start.
8. **(Optional) Invite the team.** Go to **Settings → Corpus
   management → Admin & access → People** and add emails one row at
   a time. Each row chooses one of four tiers — admin, researcher,
   team, public. The added person sees the dataset the next time they
   sign in. See [Roles](/timecues/user-guide/#roles-admin-team-leader-vs-annotator)
   in the user guide for the full per-tier capability matrix.
9. **(Optional) Pre-compute the algorithm cache.** From the sidebar
   footer in Dataprep click **Run all algorithms** — every built-in
   detector runs on every song and the per-song cache fills. Useful
   before Auto-guess (it needs the per-detector outputs as input) and
   before any batch Inspect All run (instant load when the cache is
   warm).

### Switching between datasets

There's only one corpus per deploy — `data/dataset-config.json` is
the single source of truth for who's in and who's an admin. If you
want a *separate* corpus, run a second deploy with a different
`DATA_DIR` set in `.env` (e.g. `DATA_DIR=/Volumes/research-corpus`).
The same code, the same login, a different on-disk root.

### Where files land on disk

A claimed dataset writes to four subtrees under `DATA_DIR` (default
`./data/`):

| Path | Contents |
|---|---|
| `data/songs/<slug>/<filename>` | The original audio file, untouched. |
| `data/annotations/<layer>/<annotator>/<slug>.json` | One file per song per annotator per layer (Manual / Eye / Auto-guess). |
| `data/algorithm-outputs/<algorithm>/<slug>.json` | One file per algorithm per song — the detector run cache. |
| `data/dataset-config.json` | The single corpus-config — name, people-by-email, default vocabularies, BPM defaults. |
| `data/stems/<slug>/{vocals,drums,bass,other}.wav` | Demucs stems once extracted (admin runs *Run Demucs* in the source picker). |

Snapshot or export this directory and you have the entire dataset
state — the rest of the app is stateless code. See
[Data model](/timecues/data-model/) for the deep-dive.

### Export and migration

From the **Storage stats** panel in Settings → Corpus management, an
admin can export the entire corpus in any of five formats — JSON,
Audacity labels, Sonic Visualiser layers, JAMS, MIDI, REAPER project.
The exports are read-only at export time (no streaming sync). Useful
for handing the corpus to collaborators or moving to a fresh deploy.

Deep dive: [Main Page](/timecues/user-guide/#the-main-page) covers
the Dataprep workspace end-to-end, and
[Roles](/timecues/user-guide/#roles-admin-team-leader-vs-annotator)
covers the four-tier access model.

## Annotating boundaries with the keyboard

The full keyboard-driven flow. Faster than the mouse once you commit to it.

1. **Lock BPM and grid in Dataprep first** — section transitions snap
   to the grid you set up there.
2. **Switch to the Annotator Tool.** Pick *Boundaries → Manual* in the
   tab strip just under the waveform.
3. **Press space to play.** Listen for the first transition.
4. **Press `M` to drop a boundary** at the playhead. The boundary
   snaps to the nearest grid line — you'll see a brief violet halo at
   the snap target so you know which beat caught it.
5. **Use `Tab` to focus the label field** on the just-dropped boundary
   and type its label (`intro`, `verse`, `chorus`, …). Press `Enter` or
   `Escape` to return focus to the waveform.
6. **Navigate with `[` and `]`** to step backwards / forwards between
   boundaries. The playhead jumps to each one in turn.
7. **Mark importance** — `★` toggles a boundary between *critical*
   (the must-hit-it transitions) and *optional* (nice-to-have). Critical
   recall is scored separately in evaluation.
8. **Repair mistakes** — `Delete` removes the focused boundary, `S`
   splits an existing boundary into two candidates (multiple defensible
   start times for the same transition; matching uses whichever is
   closer).
9. **Undo / redo** with `Cmd/Ctrl-Z` and `Cmd/Ctrl-Shift-Z`.
10. **Flip the layer to *reviewed*** in the right rail when you're done.
    The sidebar's per-song workflow indicator goes emerald once every
    layer you've started is marked reviewed.

Deep dive: [Annotation Workspace](/timecues/user-guide/#annotation-workspace)
and [Keyboard Shortcuts](/timecues/user-guide/#keyboard-shortcuts).

## Comparing algorithms

The whole point of TimeCues — line every detector up against your
ground truth and see who wins, per song and across the corpus.

1. **Have a reference layer.** You need at least one of *Manual*,
   *Eye*, or *Auto-guess (reviewed)* on the song to evaluate against.
   Without that, every metric is meaningless — F1 against an empty
   reference is undefined.
2. **Switch to the *Algorithm Inspect* tab** and pick a song from the
   sidebar.
3. **Tick algorithms in the right sidebar.** Each one you tick fires a
   detector run (cached by file hash, so a repeat run is instant). Their
   predictions stack as colored timelines underneath the waveform.
4. **Pick a reference** in the *Reference* dropdown — Manual, Eye, or
   Auto-guess. The metrics panel below the canvas updates immediately.
5. **Pick the evaluation engine:**
   - **`mir_eval`** — the research-standard hit-rate / F1 / precision /
     recall computed by the [mir_eval](https://github.com/craffel/mir_eval)
     library. Use this when you want results that other papers can
     compare against.
   - **`Custom`** — adds Mean Nearest-Boundary Distance (MNBD,
     in seconds), Critical-Section Recall (CSR, restricted to
     ★-marked boundaries), candidate-aware matching (a boundary with
     multiple `S`-split candidates scores against whichever lands
     closest), and an optional-weight slider that lets you down-weight
     optional boundaries when computing F1.
6. **Drag the tolerance slider (τ)** to widen or narrow the matching
   window in seconds. Most published numbers use τ = 0.5 s or τ = 3 s.
7. **Switch to the *All songs* sub-tab** to batch-run the same
   selection across the whole corpus. The leaderboard sorts by F1 /
   precision / recall / MNBD / CSR — click a column header to re-sort.
   Each row expands to per-song scores so you can spot which songs an
   algorithm chokes on.
8. **Pre-compute the cache** in Dataprep first if you have many songs:
   the *Run all algorithms* button warms the cache for every detector ×
   every song, so the batch view loads instantly later.

Deep dive: [Inspect Workspace](/timecues/user-guide/#inspect-workspace)
and [Inspect All](/timecues/user-guide/#inspect-all).

## The Auto-guess workflow — consensus & clustering

Auto-guess is the fastest path from "I just dropped a song in" to
"I have clean ground truth boundaries." It runs 30+ detectors in
parallel, **clusters** their boundary predictions in time, and lets
you tick through the clusters one at a time with three keys: ✓ /
✗ / @. The output is a single, reviewed boundary layer.

### The mental model

Think of it as **wisdom of crowds for boundary detection**. No single
detector is reliable — librosa beat-based segmentation might miss a
break, MSAF SF might fire on every snare fill, allin1 has its own
priors. But if six different detectors all fire within 200 ms of each
other, **something** is happening there. Auto-guess turns that
agreement into a single candidate and asks you to confirm it.

### Step by step

1. **Lock BPM and grid in Dataprep first.** Auto-guess clusters in
   seconds, but candidates are still snapped to the grid you set up.
2. **Pre-compute the detector cache.** From Dataprep, click *Run all
   algorithms* to warm the cache for every built-in detector on this
   song. (You can also do it from Algorithm Inspect — the cache is
   shared.) Auto-guess won't run until the source detectors have
   results to consume.
3. **Switch to the Annotator Tool → Boundaries → Auto-guess** tab.
4. **Click *Generate AutoGuess*.** The server pulls every cached
   detector's output, clusters all the boundary times into groups
   within a **cluster tolerance τ** (default 1.5 s, slider exposes
   0.1 s – 5 s), and returns one candidate per cluster. Each candidate
   carries:
   - a **timestamp** (the cluster centroid, weighted by detector
     confidence when available);
   - an **agreement score** — how many of the 30+ detectors fired
     inside this cluster;
   - the **list of contributing detectors** so you can see who
     agrees.
5. **Tick through the candidates** with `J` / `K` (next / previous).
   At each candidate, press:
   - **`✓` (or `A` for accept)** — the candidate becomes a confirmed
     boundary in your Auto-guess layer.
   - **`✗` (or `R` for reject)** — the candidate is dropped. Use this
     for false positives: a swell that no human would call a section
     boundary, a snare fill that fooled three detectors, an outro
     fade-out that everyone agreed on but doesn't actually mark a
     transition.
   - **`@` (or `E` for edit)** — accept the candidate but **nudge it
     in time** before committing. Use this when the consensus is in
     the right neighborhood but the cluster centroid landed half a
     bar early.
6. **Adjust the cluster tolerance** if you're seeing too many
   candidates (lower τ) or too few (raise τ). Regenerating with a
   different τ is cheap — the per-detector cache is already warm, only
   the clustering re-runs.
7. **Flip the layer to *reviewed*** when you've ticked through every
   candidate. The Auto-guess layer is now eligible as a reference in
   Algorithm Inspect — meaning you can train new detectors against
   the boundaries the consensus revealed.

### Why this is faster than annotating from scratch

A typical 3-minute song has ~8–12 section boundaries. From scratch you
play the song through, drop M boundaries, then go back and refine each
one — usually 10–15 minutes per song. With Auto-guess, the consensus
typically surfaces ~80–90% of the true boundaries on the first pass,
plus a handful of false positives. Ticking through 12 candidates
(✓ ✓ ✗ ✓ @ ✓ …) takes 60–90 seconds. The remaining 1–2 missed
boundaries you add by hand using normal Manual workflow.

### Tuning the consensus

The **AutoGuess grid search** in *Inspect All* lets you sweep the
clustering parameters across your whole corpus to find the F1-optimal
tolerance and agreement-threshold settings. Use it once on a small
labeled subset, then apply the winning parameters to the rest of the
corpus.

Deep dive: [Auto-Guess Internals](/timecues/user-guide/#auto-guess-internals)
covers the full clustering algorithm, the per-detector confidence
weighting, and the exact grid-search procedure.

## Eye annotations from the spectrogram

What does the *eye* — not the ear — recover from a waveform and
spectrogram alone? Useful for studying visual cues vs. audio cues, and
for noisy-environment annotation when you can't play audio.

1. **Lock BPM and grid in Dataprep first.**
2. **Switch to the Annotator Tool → Boundaries → Eye** tab.
3. **The audio is automatically muted** in Eye mode. The waveform and
   spectrogram are your only signal.
4. **Toggle the spectrogram on** from the *SIGNALS* menu in the top
   viz bar if it isn't already (Eye mode pre-enables it by default).
   Try also enabling the SSM (self-similarity matrix) row — large
   off-diagonal jumps are often boundaries the eye catches before the
   ear.
5. **Drop boundaries with `M`** at every transition you can *see* —
   a sudden change in spectral content, a brightening or darkening of
   the high frequencies, a visual restart in the SSM.
6. **Cross-reference against Manual afterwards.** Each layer is
   reviewed independently; the Compare sub-tab shows them side by
   side. Eye usually nails the macro transitions and misses the
   smooth-but-audible ones.

Deep dive: [Annotation Workspace → Eye mode](/timecues/user-guide/#annotation-workspace).

## Writing a custom detector

Drop a Python file in `tools/python/custom/`, reload, and your
algorithm shows up as an overlay alongside every built-in detector.

1. **Switch to the *Playground* tab.** Hidden in Demo Mode.
2. **Write a `.py` file** that exposes a function matching the
   detector contract — the [Custom Detectors](/timecues/user-guide/#custom-detectors)
   section of the user guide has the exact signature. Roughly:
   ```python
   def detect(audio, sr, **kwargs):
       """Return a list of Boundary objects (time + label)."""
       boundaries = my_segmentation(audio, sr)
       return [Boundary(time=t, label=lbl) for t, lbl in boundaries]
   ```
3. **Upload it** via the Playground UI's file picker (or drop it into
   `tools/python/custom/` on disk and click *Reload*). The registry
   hot-reloads and the new detector appears alongside built-ins in
   Algorithm Inspect, Auto-guess's source pool, and the Dataprep
   batch-run picker.
4. **Run it** on a song in Algorithm Inspect and check the overlay.
5. **Iterate** — edit the script, re-upload (or just re-save and
   *Reload*), re-run. Cached results are keyed by the script's file
   hash, so a tweaked script always produces a fresh run; reverting
   to a previous version transparently re-hits the cache.

Deep dive: [Custom Detectors](/timecues/user-guide/#custom-detectors)
documents the full Python contract, the parameter schema for the UI,
and how cached results are stored.

## Multi-annotator: comparing two people's work

The per-annotator namespace is what keeps two people's manual
annotations from clobbering each other; the Compare sub-tab is where
you put them side by side and resolve disagreements.

1. **Sign in with two different accounts** (two browsers, or one
   browser with a private window). Each becomes a distinct annotator
   id; annotations land at
   `data/annotations/<layer>/<annotator-id>/<slug>.json`.
2. **Each annotator does a Manual pass** on the same song.
3. **Open the Annotator Tool's *Compare* sub-tab** while signed in as
   an admin or researcher (regular team annotators only see their own
   work).
4. **Pick the two annotators in the Compare picker.** Their layers
   render as two stacked timelines on the waveform, in distinct
   colors.
5. **Per-boundary diff readout** appears in the panel below — every
   boundary that's within τ of a peer is paired, everything else is
   flagged as a disagreement.
6. **Adjudicate** by switching to either annotator's layer (top-right
   *View as* dropdown) and editing — or use the Team page's "Merge
   into Auto-guess" action to fold both annotators' boundaries into
   a shared Auto-guess layer that you can then review together.

Deep dive: [Sign-In & Identity](/timecues/user-guide/#sign-in--identity)
and [Team Dashboard](/timecues/user-guide/#team-dashboard).

## BPM auto-detection chips

Five detectors race in parallel; you click the chip whose number
matches what you hear, and the song's BPM is set.

1. **In Dataprep, open the *BPM and Grid ▸* disclosure** below the
   waveform.
2. **A row of `Auto-detected` chips** appears just below the BPM
   input. As detectors finish, their chips light up:
   - **`client-wabd`** — runs in your browser via
     [web-audio-beat-detector](https://github.com/chrisguttandin/web-audio-beat-detector)
     the moment the audio decodes. Fastest, typically the first chip
     to appear.
   - **`librosa-beat-track`** — onset → beat tracking from
     [librosa](https://librosa.org/).
   - **`librosa-tempo-static`** — librosa's global tempo estimate.
   - **`librosa-tempo-dynamic`** — librosa's frame-wise tempo
     (dominant mode reported).
   - **`madmom-rnn-beats`** — RNN beat tracker from the
     [CPJKU madmom fork](https://github.com/CPJKU/madmom).
   - **`madmom-tempo`** — madmom tempo histogram.
3. **Click a chip to adopt its BPM** into the input. Click another
   chip to switch.
4. **Disagree on the octave?** Halve or double the value in the input
   manually — many detectors confuse half-time and double-time. The
   metronome panel below is the fastest way to verify: play the song
   with the metronome on and listen for the click to land on the
   kick.
5. **Click *↻ Re-run*** at the right of the chip row to force a fresh
   detection (ignores the cache). Useful after replacing the audio
   file.
6. **Filter which detectors appear** under
   [Settings → BPM Detection](/timecues/user-guide/#settings) — turn off
   detectors that are slow or that you don't trust on your corpus.

Deep dive: [Song Info Bar → BPM](/timecues/user-guide/#song-info-bar).

## Aligning the beat grid

BPM tells the app the tempo, but not *where* bar 1 starts. Without an
anchor every snap lands on the closest grid line — which may be one
or two beats off the song's actual downbeat. Aligning the grid takes
ten seconds per song and prevents an entire category of annotation
drift.

### Why this matters

Every Manual / Eye boundary snaps to the song's beat grid when *Snap*
is on (which is the default — see [Snap toggle](/timecues/user-guide/#3-big-icon-controls-zoom--grid--snap--misc)).
If your grid is misaligned by 240 ms, every boundary you drop with `M`
lands 240 ms early. Then when you compare against algorithm output
they look "always slightly off" — and that's the grid's fault, not
the algorithm's. Catching this in Dataprep saves debugging in
Algorithm Inspect later.

### The grid-readiness glyph

Each song row in the sidebar carries a `♩` glyph that summarizes how
ready that song is for annotation:

- **🔴 red ♩** — no BPM set. Annotator Tool won't open.
- **🟡 amber ♩** — BPM is set but the bar start has not been
  confirmed. Annotation will work, but every boundary's snap may be
  one beat off the actual downbeat.
- **🟢 emerald ♩** — BPM set *and* bar start anchored. Safe to
  annotate.

The goal of the alignment workflow below is to get every song to
emerald before you start annotating.

### Step by step

1. **In Dataprep, pick the song** in the sidebar. The viz canvas
   loads, the audio decodes, the waveform draws.
2. **Open the *BPM and Grid ▸* disclosure** below the waveform if
   it's collapsed.
3. **Set BPM first** — click an `Auto-detected` chip or type a value.
   See [BPM auto-detection chips](#bpm-auto-detection-chips) above
   for the chip-by-chip details. The grid overlay on the waveform
   appears as soon as BPM is non-zero.
4. **Listen for the first kick** of the song's actual content
   (usually right after the intro / pickup). Press space to play,
   pause when you hear it.
5. **Press `G` at the playhead** to set the bar start. The grid
   overlay snaps so that beat is now beat 1 of bar 1. The sidebar
   glyph flips from amber ♩ to emerald ♩.
6. **Verify with the metronome.** Click **Metronome ▶** in the
   *BPM and Grid ▸* disclosure and press space. You should hear the
   click land *on* the kick, not slightly before or after. If the
   click drifts: nudge **Grid Offset** in 1 ms steps until it locks.

### Grid Offset — the fine-tuning slider

Below the BPM input is a **Grid Offset** field, in seconds, range
`≥ 0`, step `0.001`. This is where the grid's bar-1 boundary sits
relative to `t = 0` in the audio. Setting bar start with `G`
auto-fills it; you can also type a value directly if you're matching
to an existing JAMS/REAPER reference.

**When to nudge Grid Offset by hand:**

- **Audio file has a long silence at the start** — the first kick
  is 3 seconds in, but the producer intended bar 1 to be at exactly
  3.000 s. Type that.
- **Imported from another tool** — the JAMS file says `bar_offset =
  1.2375`. Type that.
- **The `G` placement is off by a few milliseconds** — you anchored
  near the kick but not exactly on it. Nudge ± 10 ms at a time and
  re-verify with the metronome.

### The three Grid Modes

The **Grid Mode** dropdown (below Grid Offset in the *BPM and Grid ▸*
disclosure) tells the app whether the song's tempo is constant or
drifts:

| Mode | When to pick | What it does |
|---|---|---|
| **Static BPM** *(default)* | DAW-produced music, EDM, hip-hop — anything with a click track at the source. | One BPM number, one bar-start anchor, one rigid grid for the whole song. The fastest and most precise. |
| **Dynamic** | Live recordings, expressive playing, songs that speed up or slow down across sections. | A *tempo curve* per song with a *sensitivity slider* to control how aggressively the curve follows local tempo. Annotations still snap, but to a curve, not a constant. |
| **Manual adjustment** | Studio takes stitched from multiple performances, songs with no consistent tempo at all (free jazz, ambient, noise). | A two-layer system — an underlying coarse grid plus per-section adjustments. Place anchors at every section start and the app fills in tempo between them. |

**Static BPM** handles ~95% of recorded music. Reach for the other
two only when the metronome consistently drifts off the kick across
the song.

### Common pitfalls

- **Anchoring on the pickup, not the downbeat.** Many songs begin with
  a pickup beat (a single drum hit or guitar strum before bar 1
  proper). Anchoring on that puts bar 1 a beat early. Listen for the
  *full kick + snare pattern* to know you're on the real downbeat.
- **Songs that drift but you stay in Static BPM mode.** The metronome
  starts on the kick at second 0 but is off by half a beat at second
  120. That's drift — switch to Dynamic mode and let the curve track
  the tempo.
- **BPM is half what it should be.** Many detectors report half-time
  for songs with strong off-beat snare patterns. Double the BPM
  manually and re-anchor; the metronome will tell you instantly if
  you guessed wrong.
- **Audio file has been re-encoded** and the start timestamp moved.
  Re-anchor; old `Grid Offset` values are stale.

Deep dive:
[Song Info Bar → BPM](/timecues/user-guide/#bpm-20300-step-001),
[Grid Offset](/timecues/user-guide/#grid-offset-seconds--0-step-0001),
[Grid Mode (Static / Dynamic / Manual)](/timecues/user-guide/#grid-mode-static-bpm--dynamic--manual-adjustment),
[Manual mode is a two-layer system](/timecues/user-guide/#manual-mode-is-a-two-layer-system),
and [Metronome Panel](/timecues/user-guide/#metronome-panel-dataset-prep).

## Stem separation with Demucs

Four stem tracks (vocals / drums / bass / other) extracted by
[Demucs](https://github.com/facebookresearch/demucs), available
everywhere a source picker is shown.

1. **Open the Source picker** in the top viz bar — the dropdown next
   to the waveform mode chooser.
2. **Pick a stem** — *Vocals*, *Drums*, *Bass*, or *Other*. If stems
   aren't cached yet for this song, Algorithm Inspect / Annotator
   Tool will show a "Stems not extracted" hint and (for admins) a
   *Run Demucs* button.
3. **Admin: click *Run Demucs*** to trigger the stems daemon (`:8006`
   in the default docker-compose profile). Extraction takes roughly
   1–3 minutes per song on CPU; if you have the GPU profile enabled
   it's seconds. Progress is streamed to the browser console; a
   failure raises a visible alert rather than silently swallowing
   (fixed 2026-05-20).
4. **Once stems exist**, switching between them in the Source picker
   is instant — the waveform redraws, the spectrogram re-renders, and
   every algorithm overlay re-evaluates against the chosen stem.
5. **Useful in practice:** running beat detection on the *Drums*
   stem alone often beats running it on the full mix; running
   boundary detection on *Vocals* surfaces verse / chorus transitions
   that the full-mix detector smears over.

Demo Mode ships with pre-extracted stems for the three sample songs
(`edm-at-midnight`, `pantheon`, `phonk-remix`) — switching stems in
demo is instant and does not run Demucs.

Deep dive: [Stems server](/timecues/user-guide/#dataset-prep)
and [Storage clear scopes](/timecues/user-guide/#tri-mode-clear-dialog-clearscopedialogtsx).

## Self-hosting on your own server

The Docker Compose stack runs anywhere Docker runs — a cloud VM, a
homelab, or bare metal.

1. **Clone the repo** on the host and copy `.env.example` to `.env`.
   Fill in `VITE_GOOGLE_CLIENT_ID` if you want Google sign-in.
2. **Bring up the stack** — `docker compose up --build` starts the web
   app, BPM server (`:8004`), MIR server (`:8005`), and stems server
   (`:8006`).
3. **Put an HTTPS reverse proxy in front** (Caddy, Traefik, or nginx +
   certbot) pointing at `web:5173`, so sign-in and the app work over
   TLS on your public hostname.
4. **First sign-in claims admin.** Open the deployed URL, click
   *Start a new dataset*, sign in with Google. You're now the first
   admin; invite the rest of your team from the Team page.
5. **Optional heavy profiles:** the GPU profile
   (`COMPOSE_PROFILES=gpu-tools`) gives CUDA-accelerated Demucs /
   allin1; the CPU profile (`cpu-tools`) is the slow-but-works-everywhere
   fallback.

Deep dive: the full install matrix lives in
[INSTALL.md](https://github.com/sapirca/timecues-studio/blob/main/INSTALL.md)
— Docker on localhost, local dev without Docker, Apple Silicon, optional
GPU / CPU / experimental-models profiles, and sign-in setup.

## Settings — the complete tour

Every personal preference and corpus-wide knob is on the Settings
page. The page is **self-saving** — there's no Save button; a
transient *Saved* pill flashes after every write. Personal preferences
land in your browser's `localStorage` under `timecues.settings.v1`;
corpus-wide settings (vocabularies, BPM defaults, access list) write
through to `data/dataset-config.json` on the server.

### The role banner

A colored banner at the top of the page tells you your current access
tier and bullets out what you can do at that tier. Out-of-tier
sections elsewhere on the page stay visible (so you know what's
there) but are interaction-suppressed with an **Admin only** pill.

| Tier | Banner accent | Headline capabilities |
|---|---|---|
| **Admin** | amber | Manage members, configure corpus-wide vocabularies, upload/export, clear caches, factory-reset the corpus. |
| **Researcher** | violet | Full corpus access, run any algorithm, view every annotator's output, upload/export. *Cannot* manage members or change dataset defaults. |
| **Team** | cyan | Full corpus access for your own annotations. *Cannot* see other annotators' work or run admin actions. |
| **Public** | slate | Annotate the shipped default songs only. Other corpus features unlock once an admin adds you to the team. |

### The five categories

Below the banner the page is grouped into five color-coded
collapsible categories. Only **Annotator profile** is expanded by
default — click any other section's chevron-and-title to open it.

#### 👤 User info  *(cyan)*

| Panel | Tier | What's inside |
|---|---|---|
| **Annotator profile** | all | Display name, email (auto-filled from Google sign-in), free-text role and affiliation, read-only id + auth method. Requires clicking *Save profile* (the only setting on the page that's not auto-saving). |
| **Theme** | all | Color scheme radio — `dark` / `light` / `system`. Default `dark`. `system` follows your OS `prefers-color-scheme`. |

#### ✎ Annotation  *(indigo)*

Everything that customizes how *you personally* see the workspace
and the annotation editors. Strictly browser-local — nothing here
syncs to the corpus.

| Panel | What's inside |
|---|---|
| **Display & playback** | Sidebar collapsed by default, show beat grid by default, default playback rate slider (0.5× – 2.0×, step 0.05, default 1.00×). |
| **Default signals** | Master "Signal overlays on" toggle plus 12 sub-toggles for which signal rows are pre-checked in the SIGNALS dropdown (3-Band waveform, Spectrogram, Cepstrogram/MFCC, Chromagram, Tempogram, SSM, Energy/RMS, Brightness, Novelty, Onsets, Spectral Flux, EQ). Plus a 3-Band palette picker (`Classic` / `Cool` / `Sunset` / `Forest` / `Mono`). |
| **Annotations — display** | Per-layer visibility defaults (Manual / Eye / Auto-guess) plus a time-unit picker for annotation editors (`Milliseconds` or `Beats & bars`). |
| **Vocabularies & taxonomies** | All label vocabularies in one place. Section vocabulary (genre cards plus a custom textarea), cue vocabulary, span vocabulary. Each row has a *Save as dataset default* / *Clear dataset default* button **visible only to admins**, plus a *Local override* pill that appears next to your row when your local value diverges from the admin default. |
| **Loops** | Default loop names, default cue labels for loops, opt-in for the loops/patterns marker family (experimental). |
| **BPM & grid protection (personal)** | When on, prevents accidental BPM or Grid Offset edits — the field becomes read-only until you toggle it back off. Useful once a song is fully annotated. |
| **Experimental annotation types** | Per-family feature flags — Loops, Patterns, Cue Extras, Span layers, etc. Off by default. Switching one on reveals its UI surface across the app. |

#### 🔬 Research  *(violet)*

Algorithm and detector defaults. **Visible to all tiers but
read-only for Team / Public** — each row carries an *Admin only*
pill at those tiers.

| Panel | What's inside |
|---|---|
| **Default algorithms** | Which algorithms are pre-ticked in Algorithm Inspect when a song opens. The order matters — the first ticked algorithm becomes the default reference in the diff readout. |
| **BPM detection** | Per-detector enable toggles (`client-wabd`, `librosa-beat-track`, `librosa-tempo-static`, `librosa-tempo-dynamic`, `madmom-rnn-beats`, `madmom-tempo`). Disabled detectors don't appear in the chip row. Useful for turning off detectors you don't trust on your corpus. |
| **Auto-guess defaults** | Default cluster tolerance τ in seconds (default 1.5), default minimum agreement count (default 3), default source-detector subset (which of the 30+ detectors feed into Auto-guess by default). |
| **Optional GPU tooling** | When the GPU profile is enabled at compose time, toggles here let you opt specific algorithms (allin1, demucs) into GPU acceleration. No effect when the profile is off. |

#### 🛡 Corpus management  *(amber)*

**Admin-only.** Every panel here writes through to the server (i.e.
to `data/dataset-config.json`) and affects every annotator.

| Panel | What's inside |
|---|---|
| **Admin & access** | The corpus's display name, plus the **People** list — one row per email, four-tier dropdown (admin / researcher / team / public). Adding an email here is what unlocks an annotator on first sign-in. Removing an email demotes that annotator to Public the next time they sign in. |
| **Storage stats** | A read-out of total disk usage by `data/` subtree (songs, annotations, algorithm-outputs, stems, song-info), plus an **Export everything** button (JSON / Audacity / Sonic Visualiser / JAMS / MIDI / REAPER) and per-category **Clear cache** buttons. |

> Corpus-wide vocabulary defaults *used to* live here in a standalone
> *Dataset defaults — corpus-wide vocabularies* section. That was
> retired in 2026-05-18 — every admin "Save as dataset default" /
> "Clear dataset default" button now lives inline under the field it
> applies to in **Annotation → Vocabularies & taxonomies**.

#### ⚠ Danger Zone  *(rose)*

Destructive actions, split in two:

| Subpanel | Who can use it | What's there |
|---|---|---|
| **Personal — this browser only** | all | *Reset to defaults* — wipes `timecues.settings.v1` and restores every preference to the values in `DEFAULT_SETTINGS`. Annotator profile is unaffected (it's stored elsewhere). |
| **Corpus-wide — affects every annotator** | admin only | *Clear all algorithm caches*, *Clear all annotations for one annotator*, *Factory-reset the corpus* (drops the People list, vocabularies, defaults — leaves audio and annotations intact). |

### Self-save and the "Saved" pill

Every change other than Annotator profile commits immediately. The
*Saved* pill flashes for ~600 ms top-right after a write so you know
the value persisted. There's no "discard changes" — undo is by
re-toggling, or by *Reset to defaults* in the Danger Zone for a wider
revert.

### Where settings actually live

| Scope | Storage |
|---|---|
| Personal preferences | `localStorage` key `timecues.settings.v1` (one JSON blob). |
| Annotator profile | `AnnotatorContext` — separate `localStorage` key, requires *Save profile* click. |
| Dataset defaults + People list | `data/dataset-config.json` on the server. Edits via the inline admin buttons hit `PUT /api/dataset-config`. |
| Authentication | Google OAuth session cookie. Cleared on sign-out. |

### Common tasks — where to click

- **Make spectrogram on by default** → ✎ Annotation → Default
  signals → toggle *Spectrogram* on.
- **Switch the workspace to light mode** → 👤 User info → Theme →
  radio: `light`.
- **Add a researcher to the team** → 🛡 Corpus management → Admin &
  access → *Add row*, type email, tier dropdown → `researcher`.
- **Lock BPM on a finalized song** → ✎ Annotation → BPM & grid
  protection (personal) → toggle on.
- **Make `madmom-rnn-beats` the only BPM detector** → 🔬 Research →
  BPM detection → toggle every other detector off.
- **Add a custom section label like `pre-chorus`** to the corpus →
  ✎ Annotation → Vocabularies & taxonomies → Section vocabulary →
  *Custom* card → edit the textarea → (admin) *Save as dataset
  default*.
- **Export the whole dataset to JAMS** → 🛡 Corpus management →
  Storage stats → *Export everything* → JAMS.
- **Reset my preferences but keep my annotations** → ⚠ Danger Zone
  → Personal — this browser only → *Reset to defaults*.

Deep dive: [Settings — the full reference](/timecues/user-guide/#settings)
in the user guide enumerates every key, default, and the underlying
storage shape.
