# TimeCues Studio

TimeCues Studio is a music structure annotation and evaluation tool. The web
app lets annotators mark section boundaries on a waveform, compare them
against algorithmic estimates (`allin1`, MSAF, ruptures, change-point
detection), and run `mir_eval` metrics in-browser.

License: [MIT](LICENSE) · Third-party notices: [NOTICE.md](NOTICE.md)

## Quick start

```bash
git clone https://github.com/sapirca/timecues-studio.git
cd timecues-studio
cp .env.example .env
docker compose up --build      # first run; subsequent: docker compose up
# open http://localhost:5173
```

That's the full stack on localhost. For every other install path — local
development without Docker, GPU/CPU profiles, self-hosting beyond localhost,
experimental detector sidecars, troubleshooting — see [INSTALL.md](INSTALL.md).

## Where to read next

| If you want to… | Read |
|---|---|
| Install or self-host the app | [INSTALL.md](INSTALL.md) |
| Learn the app's features and UI | [docs/USER_GUIDE.md](docs/USER_GUIDE.md) |
| Use experimental detectors | [docs/EXPERIMENTAL_USER_GUIDE.md](docs/EXPERIMENTAL_USER_GUIDE.md) |
| Understand the on-disk data layout | [DATA.md](DATA.md) |
| Verify third-party licenses | [NOTICE.md](NOTICE.md) |

## Repository layout

```
data/                 Runtime user data — annotations, algorithm caches, and
│                      uploaded audio. Empty on a fresh clone; reads fall back
│                      to data-default/ when a slug is absent.
├── annotations/      Per-annotator labels — see DATA.md for the layered scheme.
│   ├── manual/       Reviewed boundary annotations (the source of truth).
│   ├── eye/          By-eye annotations from spectrogram inspection.
│   ├── auto-guess/   AutoGuess clusters (per-point ✓/✗/@ review).
│   └── timing/       Per-song annotation-time tracking.
├── algorithm-outputs/ Cached algorithm runs.
│   ├── algo-clusters/    MSAF cluster analysis (centroid linkage of 4 algos).
│   ├── bpm-detections/   BPM estimator outputs (gitignored cache).
│   ├── msaf/             Raw MSAF outputs per song (regenerable cache).
│   └── msaf-batch-jams/  Archive: flat JAMS dump from a batch MSAF run.
├── song-info/        Per-song metadata (BPM, genre, etc.) — per annotator.
└── songs/            Uploaded audio — one folder per slug, contains the .mp3.

data-default/         Read-only CC0 seed dataset (songs, pre-rendered stems,
                      song-info, annotations) shipped so a fresh install boots
                      with content.
web-app/              React + TypeScript + Vite frontend (the annotation UI).
├── dataPaths.ts          Centralized on-disk paths (consumed by vite.config.ts).
├── vite.config.ts        Dev-server REST endpoints under /api/*.
└── src/                  React components, services, and inspector pages.
tools/                Python servers + CLI runners.
├── python/paths.py       Centralized on-disk paths for Python tools.
├── python/{mir_eval,bpm,ruptures,mir}_server.py  Long-running analysis servers.
├── run_allin1*.py        allin1 / MSAF / Demucs CLI runners.
└── cache-algo-clusters.mjs  Batch MSAF cluster precomputer.
docker/               Per-service Dockerfiles.
docs/                 User & operator documentation.
```

**Path constants live in two files** — if you rename or move a data folder,
update only these:
- [web-app/dataPaths.ts](web-app/dataPaths.ts) (TypeScript, consumed by
  `vite.config.ts`)
- [tools/python/paths.py](tools/python/paths.py) (Python, consumed by all
  Python tools)

## Citation

If you use TimeCues Studio in academic work, please cite:

```bibtex
@misc{timecues-studio,
  title        = {TimeCues Studio: An Interactive Tool for Annotation, Algorithm
                  Development, Evaluation, and Comparison in Time-Aligned Music
                  Analysis},
  author       = {Caduri, Sapir and Goldberg, Yoav},
  year         = {2026},
  howpublished = {\url{https://github.com/sapirca/timecues-studio}}
}
```

> Update the BibTeX entry with the final author list, and add venue/DOI if the
> paper is published.

## Contributing

Issues and pull requests welcome. By contributing, you agree that your
contributions will be licensed under the project's [MIT License](LICENSE).
