# CUE-family extras sidecar — bundles three pure-DSP detectors that share
# the same lightweight librosa-only image: librosa-key (Krumhansl-Schmuckler),
# autochord-chords (chroma-template chord recognition), and librosa-onsets.
# Listens on :8014, called by the web container as http://cue-extras:8014/api/cue-extras/*.
#
# Inherits Python 3.11 + librosa + numpy<2 from experimental-dsp-base;
# build that first via
# `docker compose --profile experimental-base build experimental-dsp-base`.
ARG BASE_REPO=timecues
FROM ${BASE_REPO}/experimental-dsp-base:latest

# autochord pip package — chroma templates + Viterbi smoothing + a small
# TF-SavedModel BiLSTM-CRF baked into ~/.autochord/. autochord 1.x ships
# the model in the LEGACY TF SavedModel format that Keras 3 (shipped
# alongside TensorFlow ≥ 2.16) refuses to load (`File format not
# supported`). Pinning tensorflow<2.16 (which pins keras<3 transitively)
# keeps the legacy h5/SavedModel path working. Pin setuptools<81 for
# the same `pkg_resources` reason run.sh handles on bare-metal: autochord
# imports pkg_resources at module load and setuptools 81 dropped it.
RUN pip install --no-cache-dir \
    "setuptools<81" \
    "tensorflow<2.16" \
    autochord

COPY tools/python/paths.py             /app/tools/python/paths.py
COPY tools/python/cue_extras_server.py /app/tools/python/cue_extras_server.py
COPY data-default/                     /app/data-default/

EXPOSE 8014
CMD ["python", "tools/python/cue_extras_server.py"]
