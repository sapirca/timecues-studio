# Credits & Acknowledgements

TimeCues Studio stands on the shoulders of the open-source MIR (music
information retrieval), audio-DSP, ML, and web ecosystems. This file
acknowledges the upstream projects we depend on and credits the researchers
and engineers whose work powers ours.

If you build on TimeCues Studio in academic work, please **also cite the
upstream tools you actually exercise**. The most common ones — `allin1`,
`MSAF`, `librosa`, `mir_eval` — have their own canonical citations listed
below.

For license details (vs. credit) see [NOTICE.md](NOTICE.md). For the
project's own citation see [README.md](README.md#citation).

---

## Music structure & boundary detection

- **All-In-One Music Structure Analyser** — Taejun Kim and Juhan Nam.
  *All-in-one Metrical and Functional Structure Analysis with Neighborhood
  Attentions on Demixed Audio.* WASPAA 2023.
  → https://github.com/mir-aidj/all-in-one — MIT
  Used by the BOUNDARY family (ensemble + 8 folds, BPM, downbeats).

- **MSAF (Music Structure Analysis Framework)** — Oriol Nieto and Juan
  Pablo Bello. *Systematic Exploration of Computational Music Structure
  Research.* ISMIR 2016.
  → https://github.com/urinieto/msaf — MIT
  Drives `msaf-sf`, `msaf-foote`, `msaf-cnmf`, `msaf-olda`.

- **ruptures** — Charles Truong, Laurent Oudre, and Nicolas Vayatis.
  *Selective review of offline change point detection methods.* Signal
  Processing 167 (2020): 107299.
  → https://github.com/deepcharles/ruptures — BSD-2-Clause
  Drives the `ruptures-*` change-point boundary algorithms.

- **band-gradient** — original implementation, inspired by spectral-flux
  boundary detection from MSAF and `librosa`.

## Beat, tempo, and downbeat detection

- **madmom** (CPJKU fork) — Sebastian Böck, Florian Krebs, Filip
  Korzeniowski, Gerhard Widmer (Johannes Kepler University Linz). *madmom:
  a new Python audio and music signal processing library.* ACM Multimedia 2016.
  → https://github.com/CPJKU/madmom — BSD-3-Clause
  Powers most of the BPM detectors in the `bpm` daemon (port 8004) +
  beat/downbeat extraction.

- **BeatNet** — Mojtaba Heydari, Frank Cwitkowitz, Zhiyao Duan. *BeatNet:
  CRNN and Particle Filtering for Online Joint Beat, Downbeat and Meter
  Tracking.* ISMIR 2021.
  → https://github.com/mjhydri/BeatNet — MIT
  Powers the `beatnet` sidecar (port 8010) — beats + downbeats + meter.

- **librosa beat tracker** — Brian McFee et al. (see librosa entry below).

## Source separation, stems

- **Demucs** (Hybrid Transformer v4) — Alexandre Défossez (Meta AI Research).
  *Hybrid Transformers for Music Source Separation.* ICASSP 2023.
  → https://github.com/facebookresearch/demucs — MIT
  Powers the `stems` daemon (port 8006).

## Voicing, vocal melody, transcription

- **Silero VAD** — Silero Team. *Silero Voice Activity Detector.*
  → https://github.com/snakers4/silero-vad — MIT
  Powers the `silero-vad` algorithm in the SPAN family (`span` sidecar,
  port 8009).

- **JDCNet (melody / voicing extractor)** — Sangeun Kum and Juhan Nam.
  *Joint Detection and Classification of Singing Voice Melody Using
  Convolutional Recurrent Neural Networks.* Applied Sciences 2019.
  → https://github.com/keums/melodyExtraction_JDC — MIT
  We re-implement the network in pure PyTorch (`tools/python/jdcnet_torch.py`)
  and load the upstream Keras `.hdf5` checkpoint via h5py — no TF runtime in
  the sidecar.

- **PANNs (Pretrained Audio Neural Networks) — CNN14** — Qiuqiang Kong,
  Yin Cao, Turab Iqbal, Yuxuan Wang, Wenwu Wang, Mark D. Plumbley. *PANNs:
  Large-Scale Pretrained Audio Neural Networks for Audio Pattern
  Recognition.* TASLP 2020.
  → https://github.com/qiuqiangkong/audioset_tagging_cnn — MIT
  Powers the `panns-cnn14` algorithm in the SPAN family (`panns` sidecar,
  port 8013).

- **basic-pitch** — Rachel M. Bittner, Juan José Bosch, David Rubinstein,
  Gabriel Meseguer-Brocal, and Sebastian Ewert (Spotify Audio Intelligence
  Lab). *A Lightweight Instrument-Agnostic Model for Polyphonic Note
  Transcription and Multipitch Estimation.* ICASSP 2022.
  → https://github.com/spotify/basic-pitch — Apache-2.0
  Powers the `basic-pitch` algorithm in the CUE family (`pitch` sidecar,
  port 8011).

- **Whisper** — Alec Radford, Jong Wook Kim, Tao Xu, Greg Brockman,
  Christine McLeavey, Ilya Sutskever (OpenAI). *Robust Speech Recognition
  via Large-Scale Weak Supervision.* arXiv:2212.04356, 2022.
  → https://github.com/openai/whisper — MIT
  Powers the `whisper-base` algorithm in the LYRICS family (`lyrics`
  sidecar, port 8016).

- **ctc-forced-aligner** — Mahmoud Ashraf et al.
  → https://github.com/MahmoudAshraf97/ctc-forced-aligner — MIT
  We use the package pinned to `facebook/wav2vec2-base-960h` (Apache-2.0,
  English-only) so the integration stays fully permissively-licensed.
  Powers the `ctc-forced-aligner` algorithm in the LYRICS family.

- **wav2vec 2.0** — Alexei Baevski, Henry Zhou, Abdelrahman Mohamed,
  Michael Auli (Meta AI). *wav2vec 2.0: A Framework for Self-Supervised
  Learning of Speech Representations.* NeurIPS 2020.
  → https://github.com/facebookresearch/fairseq — checkpoint
  `facebook/wav2vec2-base-960h` is Apache-2.0.
  Underlies the `ctc-forced-aligner` forced-alignment path.

## Loop & pattern discovery

- **LoCoMotif** — Daan Van Wesenbeeck, Aras Yurtman, Wannes Meert, Hendrik
  Blockeel (KU Leuven, DTAI). *LoCoMotif: Time Warping for Time-Series
  Motif Discovery.* Data Mining and Knowledge Discovery 2024.
  → https://github.com/ML-KULeuven/locomotif — MIT
  Powers the `locomotif` algorithm in the PATTERN family (`pattern`
  sidecar, port 8017).

- **Chroma autocorrelation loop finder** — original DSP implementation
  built on `librosa` chroma features, no external model. Powers the
  `chroma-autocorr` algorithm in the LOOP family (`loop` sidecar, port 8012).

## Key / chord cues

- **Krumhansl–Schmuckler key profile** — Carol L. Krumhansl. *Cognitive
  Foundations of Musical Pitch.* Oxford University Press, 1990.
  Implementation drives the `librosa-key` algorithm in the CUE family
  (`cue-extras` sidecar, port 8014).

- **autochord** — Vincent Roca et al.
  → https://github.com/cjbayron/autochord — MIT
  Powers the `autochord-chords` algorithm in the CUE family.

- **librosa onsets** — see librosa entry. Powers `librosa-onsets` (CUE family).

## Percussive / harmonic separation

- **HPSS (Harmonic-Percussive Source Separation)** — Jonathan Driedger,
  Meinard Müller, Sascha Disch. *Extending Harmonic-Percussive Separation
  of Audio Signals.* ISMIR 2014.
  Implementation via librosa drives the `hpss-percussive` algorithm in the
  SPAN family (`percussive` sidecar, port 8015).

## Foundational audio + MIR libraries

- **librosa** — Brian McFee, Matt McVicar, Daniel P.W. Ellis, Eric
  Battenberg, Ryuichi Yamamoto, Rachel Bittner, et al. *librosa: Audio and
  music signal analysis in Python.* SciPy 2015.
  → https://github.com/librosa/librosa — ISC
  Drives chroma, onsets, key detection, audio I/O across virtually every
  Python sidecar.

- **mir_eval** — Colin Raffel, Brian McFee, Eric J. Humphrey, Justin
  Salamon, Oriol Nieto, Dawen Liang, Daniel P.W. Ellis. *mir_eval: A
  Transparent Implementation of Common MIR Metrics.* ISMIR 2014.
  → https://github.com/craffel/mir_eval — MIT
  The authoritative boundary / cue / onset metrics in
  `tools/python/mir_eval_server.py`.

- **scikit-learn**, **NumPy**, **SciPy**, **soundfile**, **audioread**,
  **resampy**, **pretty_midi**, **PyTorch**, **ONNX Runtime**, **h5py** —
  the standard scientific-Python and ML stack we build on.

## Web audio + frontend

- **wavesurfer.js** — Katspaugh and contributors.
  → https://github.com/katspaugh/wavesurfer.js — BSD-3-Clause
  Powers the waveform + spectrogram plugin used throughout the inspector.

- **CodeMirror 6** — Marijn Haverbeke and contributors (`@codemirror/*`)
  + `@uiw/react-codemirror`. → https://github.com/codemirror/dev — MIT
  Powers the custom-detector code editor.

- **Radix UI** (`@radix-ui/react-dialog` et al.) — WorkOS / Modulz.
  → https://github.com/radix-ui/primitives — MIT
  Powers accessible dialog / popover primitives.

- **realtime-bpm-analyzer** — Mickael Burguet.
  → https://github.com/dlepaux/realtime-bpm-analyzer — MIT
  Streaming-BPM estimation from the live `AudioContext`.

- **web-audio-beat-detector** — Christoph Guttandin.
  → https://github.com/chrisguttandin/web-audio-beat-detector — MIT
  Client-side beat detection.

- **PapaParse** — Matt Holt.
  → https://github.com/mholt/PapaParse — MIT
  CSV import.

- **JSZip** — Stuart Knightley.
  → https://github.com/Stuk/jszip — MIT / GPLv3 (we use MIT)
  Annotation-zip export.

- **Tailwind CSS** — Adam Wathan and Tailwind Labs.
  → https://github.com/tailwindlabs/tailwindcss — MIT

- **React**, **Vite**, **TypeScript**, **Vitest**, **PostCSS**,
  **autoprefixer** — standard frontend stack, MIT/Apache-2.0.

## Landing site

- **Astro** + **Starlight** — Astro core team and contributors.
  → https://astro.build — MIT

- **sharp** — Lovell Fuller (image processing).
  → https://github.com/lovell/sharp — Apache-2.0

## Optional / opt-in

- **Essentia** — Universitat Pompeu Fabra (Music Technology Group).
  *Essentia: an Audio Analysis Library for Music Information Retrieval.*
  ISMIR 2013. → https://github.com/MTG/essentia — AGPL-3.0
  Used **only** when the user explicitly installs it; unlocks the
  `danceability`, `dynamic_complexity`, and `inharmonicity` features in
  `mir_server.py`.

## Datasets used for evaluation (not redistributed)

- Commercial electronic dance music tracks referenced in our evaluation
  corpus belong to their respective rights-holders. The audio is not
  redistributed. The annotation schema and per-song boundary labels are
  collected and maintained by the TimeCues Studio annotators.

## Building the experimental sidecars

The experimental MIR-model pipeline (the `experimental-models` Docker
profile + the `ExperimentalModelsPanel` UI) explicitly draws on the
ISMIR / MTG / KU Leuven communities. The integration plan in
`archive/deep_research/integration_plan.md` cites the specific papers we
followed; this section names the people behind the work:

- The MSAF community for clarifying boundary-eval's `mir_eval` contract.
- The all-in-one team for the demixed-audio attention idea and the fold
  ensemble pattern we exposed in the inspector.
- The librosa, mir_eval, and madmom maintainers for keeping the
  Python-MIR stack alive over a decade of churn.
- The KU Leuven DTAI lab for LoCoMotif's clean MIT licensing — it made
  PATTERN family integration tractable.
- Spotify's Audio Intelligence Lab for shipping `basic-pitch` with the
  ONNX runtime bundled — universal CPU support out of the box.
- OpenAI for releasing Whisper under MIT.
- The Silero team for shipping a 2 MB voice-activity detector that
  finally made browser-and-laptop VAD reasonable.
- Meta AI for the Apache-2.0 wav2vec 2.0 release, which is the
  permissively-licensed CTC backbone we use for forced alignment.

---

If your work powers something here and you're not credited above, please
open an issue — the omission is unintentional.
