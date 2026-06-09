---
title: TimeCues
description: A web tool for annotating musical structure and comparing it against algorithmic estimates.
---

**TimeCues Studio** is a web app for annotating musical structure and
evaluating boundary-detection algorithms. Annotators mark section
boundaries on a waveform; the app overlays algorithmic estimates from
allin1, MSAF, ruptures, and change-point detectors; `mir_eval` runs the
metrics in-browser.

Open source, multi-arch (amd64 / arm64), with a CI pipeline and a public live demo.

## What it does

- **Annotate.** Lay down section boundaries on a per-song waveform with
  keyboard-driven flow. Multiple layers per song — *manual* (reviewed,
  source of truth), *eye* (quick by-eye pass over a spectrogram),
  *auto-guess* (algorithm-clustered draft you tick through point-by-point).
- **Compare.** Toggle algorithm overlays. Each algorithm's boundary set
  gets its own color and a per-song F-measure / HitRate against the
  current manual layer.
- **Evaluate.** Run `mir_eval` metrics across a whole dataset in one
  click. Aggregate scores per algorithm and per annotator.
- **Multi-annotator.** Each annotator's work lives under their own subdir.
  Sign in with Google; compare annotations side-by-side; resolve
  disagreements.
- **Custom detectors.** Drop a Python file in `tools/python/custom/`,
  reload, and your algorithm shows up as another overlay with full
  evaluation. No build step.

## Where to go next

- **[User guide](/timecues/user-guide/)** — every panel, button, shortcut,
  and file format. Start here if you want to use the app.
- **[Data model](/timecues/data-model/)** — how songs and annotations are
  laid out on disk. Read if you're integrating with the data directly.
- **[Experimental models](/timecues/experimental/)** — opt-in detectors
  behind feature flags. May break.
- **[Deployment](/timecues/deployment/)** — put it on a public URL: a cloud
  VM running Docker Compose, with HTTPS and Google sign-in. Read if you want
  your own shared instance.

## Try it

If you'd rather poke at the running instance than read docs, the public
deployment lives at the address in the project README. Sign in with
Google; you'll start in your own namespace.

## The paper

There's an accompanying paper describing the annotation tool, the
evaluation methodology, and findings on inter-annotator agreement. The
PDF is linked from the project's GitHub README.
