"""Vendored Beat Transformer model code (MIT, © 2022 Zhao Jingwei).

Source: github.com/zhaojw1998/Beat-Transformer — `code/DilatedTransformer.py`
and `code/DilatedTransformerLayer.py`, from the ISMIR 2022 paper "Beat
Transformer: Demixed Beat and Downbeat Tracking with Dilated Self-Attention".

Vendored rather than pip-installed because upstream ships no package: the
model is two files plus checkpoints in a research repo. Both files are
byte-for-byte upstream except one line — `DilatedTransformer.py`'s flat
`from DilatedTransformerLayer import ...` is made relative so it imports as a
package instead of requiring its own directory on sys.path. The change is
marked inline.

The checkpoints are NOT vendored (37 MB each, eight folds). They are fetched
on first use into .cache/beat-transformer/, the same pattern run.sh uses for
the JDCNet weights.

See tools/python/beat_transformer_server.py for how it is driven, and
NOTICE.md / CREDITS.md for the license record.
"""

from .DilatedTransformer import Demixed_DilatedTransformerModel  # noqa: F401
