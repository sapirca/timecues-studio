"""
JDCNet — pure-PyTorch port of Kum & Nam (2019) "Joint Detection and
Classification of Singing Voice Melody Using Convolutional Recurrent Neural
Networks". Architecture mirrors the original Keras implementation at
https://github.com/keums/melodyExtraction_JDC (MIT licensed). Weights are
loaded directly from the official .hdf5 checkpoint via h5py — no
TensorFlow / Keras runtime dependency inside the sidecar.

Two outputs per 31-frame window of log-spectrogram input:
  - pitch:    (B, 31, 722)  — softmax over D3..B5 quantized to 1/16 semitone
                              (721 classes) plus one "non-voice" class.
  - voicing:  (B, 31, 2)    — softmax over {non-voice, voice}.

Used by `tools/python/span_server.py`'s `jdcnet-voicing` algorithm. The
voicing output drives SPAN-family intervals; the pitch output is also
exposed to mir_server.py once that integration lands (Phase 3 of the plan).
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F


# ─── Architecture ───────────────────────────────────────────────────────────


def _conv(in_ch: int, out_ch: int, ksize: int) -> nn.Conv2d:
    # All convs in the original Keras model use he_normal init, no bias,
    # and "same" padding (=== padding=1 for 3x3, =0 for 1x1).
    pad = ksize // 2
    return nn.Conv2d(in_ch, out_ch, ksize, padding=pad, bias=False)


class _ResNetBlock(nn.Module):
    """Mirror of the Keras `ResNet_Block`: BN → LReLU → MaxPool(1,4) →
    {1×1 skip} + {3×3 → BN → LReLU → 3×3} → add."""

    def __init__(self, in_ch: int, out_ch: int):
        super().__init__()
        self.bn_in   = nn.BatchNorm2d(in_ch)
        self.pool    = nn.MaxPool2d((1, 4))
        self.skip    = _conv(in_ch, out_ch, 1)
        self.conv_a  = _conv(in_ch, out_ch, 3)
        self.bn_mid  = nn.BatchNorm2d(out_ch)
        self.conv_b  = _conv(out_ch, out_ch, 3)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.bn_in(x)
        x = F.leaky_relu(x, 0.01)
        x = self.pool(x)
        skip = self.skip(x)
        h = self.conv_a(x)
        h = self.bn_mid(h)
        h = F.leaky_relu(h, 0.01)
        h = self.conv_b(h)
        return skip + h


class JDCNet(nn.Module):
    """Reimplementation of `melody_ResNet_joint_add` from the keums repo.

    The Keras model emits (B, 31, freq, ch) with channels-last; PyTorch
    works channels-first, so the input is (B, 1, 31, 513) and intermediate
    tensors are (B, ch, 31, freq). All MaxPools / Conv strides match the
    Keras model exactly so the post-`Reshape` time-major sequences have
    identical shape (B, 31, ch*freq) that the LSTMs consume.
    """

    NUM_PITCH_CLASSES = 722  # 721 quantized pitches (D3..B5 @ 1/16 semitone) + non-voice
    INPUT_FRAMES      = 31

    def __init__(self):
        super().__init__()
        # block_1 — two 3×3 convs, no resnet wrap
        self.conv1_1 = _conv(1, 64, 3)
        self.bn1     = nn.BatchNorm2d(64)        # batch_normalization_1
        self.conv1_2 = _conv(64, 64, 3)

        # block_2 / block_3 / block_4 — ResNet wraps the surrounding BN/LReLU
        # pattern, so the original Keras `batch_normalization_2..7` map to
        # the (bn_in, bn_mid) of these three blocks in declaration order.
        self.block2 = _ResNetBlock(64,  128)   # uses bn2 (pre), bn3 (mid)
        self.block3 = _ResNetBlock(128, 192)   # bn4, bn5
        self.block4 = _ResNetBlock(192, 256)   # bn6, bn7

        # Post-block_4 processing for the pitch branch
        self.bn8       = nn.BatchNorm2d(256)   # batch_normalization_8
        self.pool_pitch = nn.MaxPool2d((1, 4))

        # Multi-scale pools that produce comparable freq dims (2) across blocks
        self.pool_b1 = nn.MaxPool2d((1, 4 ** 4))   # 64-ch  branch
        self.pool_b2 = nn.MaxPool2d((1, 4 ** 3))   # 128-ch branch
        self.pool_b3 = nn.MaxPool2d((1, 4 ** 2))   # 192-ch branch

        # Joint 1×1 conv: 64+128+192+256 = 640 → 256
        self.conv_joint = _conv(640, 256, 1)    # conv2d_1
        self.bn9        = nn.BatchNorm2d(256)   # batch_normalization_9

        # Bidirectional LSTMs.
        # bilstm1 consumes (B, 31, 2*256=512) and outputs (B, 31, 512).
        # bilstm2 consumes (B, 31, 2*256=512) and outputs (B, 31, 64).
        self.bilstm1 = nn.LSTM(512, 256, batch_first=True, bidirectional=True)
        self.bilstm2 = nn.LSTM(512, 32,  batch_first=True, bidirectional=True)

        # Time-distributed dense heads
        self.fc_pitch   = nn.Linear(512, self.NUM_PITCH_CLASSES)
        self.fc_voicing = nn.Linear(64,  2)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """Run a batch of (B, 1, 31, 513) windows.

        Returns:
            pitch:   (B, 31, 722) softmax probabilities. Index 0 = non-voice.
            voicing: (B, 31, 2)  softmax probabilities over {non-voice, voice}.
        """
        # block_1: conv1_1 → bn1 → LReLU → conv1_2  (no MaxPool inside)
        x = self.conv1_1(x)
        b1 = self.bn1(x)
        b1 = F.leaky_relu(b1, 0.01)
        b1 = self.conv1_2(b1)
        # `block_1` used in concat is the conv1_2 output BEFORE any further
        # pool — matches the Keras `block_1` reference used for the joint
        # concat (the post-pool intermediates are NOT what gets concatenated).

        b2 = self.block2(b1)
        b3 = self.block3(b2)
        b4 = self.block4(b3)

        # Pitch-branch tail (post block_4)
        p = self.bn8(b4)
        p = F.leaky_relu(p, 0.01)
        p_pooled = self.pool_pitch(p)         # (B, 256, 31, 2)
        # In Keras the Dropout is here; eval mode → no-op so we omit it.

        # Reshape to (B, 31, 2*256)
        b_size = p_pooled.shape[0]
        p_seq = p_pooled.permute(0, 2, 3, 1).contiguous().view(b_size, self.INPUT_FRAMES, -1)
        p_seq, _ = self.bilstm1(p_seq)
        pitch_logits = self.fc_pitch(p_seq)   # (B, 31, 722)
        pitch = F.softmax(pitch_logits, dim=-1)

        # Joint multi-scale concat for voicing
        j1 = self.pool_b1(b1)                  # (B, 64,  31, 2)
        j2 = self.pool_b2(b2)                  # (B, 128, 31, 2)
        j3 = self.pool_b3(b3)                  # (B, 192, 31, 2)
        j  = torch.cat([j1, j2, j3, p_pooled], dim=1)  # (B, 640, 31, 2)
        j  = self.conv_joint(j)
        j  = self.bn9(j)
        j  = F.leaky_relu(j, 0.01)
        # Reshape to (B, 31, 2*256) — same convention as pitch branch
        j_seq = j.permute(0, 2, 3, 1).contiguous().view(b_size, self.INPUT_FRAMES, -1)
        j_seq, _ = self.bilstm2(j_seq)
        v_logits = self.fc_voicing(j_seq)     # (B, 31, 2)

        # output_VV: take the pitch model's own [non-voice, voice] estimate
        # and add it as a residual before the final softmax. Matches the
        # original keras Lambda chain.
        non_speech = pitch[..., 0:1]
        speech     = 1.0 - pitch[..., 0:1]
        v_vv = torch.cat([non_speech, speech], dim=-1)
        voicing = F.softmax(v_logits + v_vv, dim=-1)

        return pitch, voicing


# ─── Keras-HDF5 → PyTorch state_dict converter ──────────────────────────────


def _conv_kernel_to_pt(kernel) -> torch.Tensor:
    """Keras Conv2D kernels are (H, W, in_ch, out_ch). PyTorch wants
    (out_ch, in_ch, H, W)."""
    import numpy as np
    arr = np.asarray(kernel)
    return torch.from_numpy(arr.transpose(3, 2, 0, 1).copy()).float()


def _dense_to_pt(kernel, bias):
    import numpy as np
    return (
        torch.from_numpy(np.asarray(kernel).T.copy()).float(),
        torch.from_numpy(np.asarray(bias).copy()).float(),
    )


def _bn_to_pt(group):
    """Keras stores BN as {beta, gamma, moving_mean, moving_variance};
    PyTorch wants {weight=gamma, bias=beta, running_mean, running_var}."""
    import numpy as np
    return {
        "weight":       torch.from_numpy(np.asarray(group["gamma:0"]).copy()).float(),
        "bias":         torch.from_numpy(np.asarray(group["beta:0"]).copy()).float(),
        "running_mean": torch.from_numpy(np.asarray(group["moving_mean:0"]).copy()).float(),
        "running_var":  torch.from_numpy(np.asarray(group["moving_variance:0"]).copy()).float(),
    }


def _lstm_to_pt(bilstm_group, suffix: int, hidden: int) -> dict[str, torch.Tensor]:
    """Map a Keras Bidirectional(LSTM(hidden)) layer to PyTorch nn.LSTM
    (bidirectional=True) weight names.

    Keras packs weights for all four gates ([i, f, c, o]) in one tensor.
    PyTorch uses order [i, f, g, o] where g === c. The keras kernel shape
    is (input_dim, 4*hidden); PyTorch's `weight_ih_l0` is (4*hidden, input_dim)
    — same gate order, just transposed.

    PyTorch keeps two bias tensors (`bias_ih_l0`, `bias_hh_l0`) and adds them.
    Keras has one. We put the full bias on `bias_ih_l0` and zero the other.
    """
    import numpy as np
    out: dict[str, torch.Tensor] = {}
    for side, ptl_suffix in (("forward_lstm", ""), ("backward_lstm", "_reverse")):
        side_name = f"{side}_{suffix}"
        g = bilstm_group[side_name]
        kernel    = np.asarray(g["kernel:0"]).T.copy()           # (4*hidden, input_dim)
        rec_kern  = np.asarray(g["recurrent_kernel:0"]).T.copy() # (4*hidden, hidden)
        bias      = np.asarray(g["bias:0"]).copy()               # (4*hidden,)
        out[f"weight_ih_l0{ptl_suffix}"]  = torch.from_numpy(kernel).float()
        out[f"weight_hh_l0{ptl_suffix}"]  = torch.from_numpy(rec_kern).float()
        out[f"bias_ih_l0{ptl_suffix}"]    = torch.from_numpy(bias).float()
        out[f"bias_hh_l0{ptl_suffix}"]    = torch.zeros(4 * hidden)
    return out


def load_keras_weights(hdf5_path: Path) -> dict[str, torch.Tensor]:
    """Walk the original keums .hdf5 and produce a PyTorch state_dict for
    `JDCNet`. Caller does `model.load_state_dict(state)`.
    """
    import h5py
    state: dict[str, torch.Tensor] = {}

    with h5py.File(str(hdf5_path), "r") as f:
        mw = f["model_weights"]

        # Conv layers (no bias)
        conv_map = {
            "conv1_1":   "conv1_1",
            "conv1_2":   "conv1_2",
            "conv2_1":   "block2.conv_a",
            "conv2_1x1": "block2.skip",
            "conv2_2":   "block2.conv_b",
            "conv3_1":   "block3.conv_a",
            "conv3_1x1": "block3.skip",
            "conv3_2":   "block3.conv_b",
            "conv4_1":   "block4.conv_a",
            "conv4_1x1": "block4.skip",
            "conv4_2":   "block4.conv_b",
            "conv2d_1":  "conv_joint",
        }
        for keras_name, pt_attr in conv_map.items():
            kernel = mw[keras_name][keras_name]["kernel:0"]
            state[f"{pt_attr}.weight"] = _conv_kernel_to_pt(kernel)

        # BN layers — keras numbers them in declaration order
        bn_map = {
            "batch_normalization_1": "bn1",
            "batch_normalization_2": "block2.bn_in",
            "batch_normalization_3": "block2.bn_mid",
            "batch_normalization_4": "block3.bn_in",
            "batch_normalization_5": "block3.bn_mid",
            "batch_normalization_6": "block4.bn_in",
            "batch_normalization_7": "block4.bn_mid",
            "batch_normalization_8": "bn8",
            "batch_normalization_9": "bn9",
        }
        for keras_name, pt_attr in bn_map.items():
            g = mw[keras_name][keras_name]
            for k, v in _bn_to_pt(g).items():
                state[f"{pt_attr}.{k}"] = v

        # Bidirectional LSTMs
        bilstm1_pt = _lstm_to_pt(mw["bidirectional_1"]["bidirectional_1"], 1, hidden=256)
        for k, v in bilstm1_pt.items():
            state[f"bilstm1.{k}"] = v
        bilstm2_pt = _lstm_to_pt(mw["bidirectional_2"]["bidirectional_2"], 2, hidden=32)
        for k, v in bilstm2_pt.items():
            state[f"bilstm2.{k}"] = v

        # Time-distributed Dense heads
        k1 = mw["time_distributed_1"]["time_distributed_1"]
        w_pitch, b_pitch = _dense_to_pt(k1["kernel:0"], k1["bias:0"])
        state["fc_pitch.weight"] = w_pitch
        state["fc_pitch.bias"]   = b_pitch

        k2 = mw["time_distributed_2"]["time_distributed_2"]
        w_v, b_v = _dense_to_pt(k2["kernel:0"], k2["bias:0"])
        state["fc_voicing.weight"] = w_v
        state["fc_voicing.bias"]   = b_v

    return state


# ─── Inference helpers ──────────────────────────────────────────────────────


# Pitch range: D3 (MIDI 38) .. B5 (MIDI 83) at 1/16 semitone resolution =
# 45 semitones * 16 + 1 endpoint = 721. Class 0 is "non-voice".
PITCH_RESOLUTION = 16
PITCH_MIDI_LOW   = 38   # D3
PITCH_MIDI_HIGH  = 83   # B5

# STFT params from the original featureExtraction.py: 8 kHz mono, 1024-bin
# FFT, hop 80 (10 ms). Window normalization uses the bundled mean/std arrays.
SAMPLE_RATE  = 8000
N_FFT        = 1024
HOP_LENGTH   = 80
WIN_LENGTH   = 1024
FRAME_SEC    = HOP_LENGTH / SAMPLE_RATE  # 0.01


def midi_to_hz(midi: float) -> float:
    return float(2.0 ** ((midi - 69.0) / 12.0) * 440.0)


def pitch_class_to_hz(idx: int) -> float:
    """Map a class index (0..721) back to a Hz value. Class 0 = non-voice → 0 Hz."""
    if idx == 0:
        return 0.0
    midi = PITCH_MIDI_LOW + (idx - 1) / PITCH_RESOLUTION
    if midi > PITCH_MIDI_HIGH or midi < PITCH_MIDI_LOW:
        return 0.0
    return midi_to_hz(midi)


def load_model(weights_hdf5: Path, device: str = "cpu") -> JDCNet:
    """Build the PyTorch JDCNet, load the converted weights, set eval mode."""
    model = JDCNet()
    state = load_keras_weights(weights_hdf5)
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing:
        raise RuntimeError(f"JDCNet missing keys: {missing}")
    if unexpected:
        raise RuntimeError(f"JDCNet unexpected keys: {unexpected}")
    model.eval()
    model.to(device)
    return model


@torch.no_grad()
def infer(
    model: JDCNet,
    audio_path: Path,
    norm_mean: "Optional[torch.Tensor]" = None,
    norm_std: "Optional[torch.Tensor]" = None,
    *,
    batch_size: int = 64,
    device: str = "cpu",
) -> tuple[torch.Tensor, torch.Tensor]:
    """Run JDCNet over a whole audio file. Returns (pitch_probs, voicing_probs)
    flattened over time:
        pitch_probs:   (T, 722)
        voicing_probs: (T, 2)
    where T is the total number of 10 ms frames (zero-padded to a multiple of
    31, then trimmed back to ceil-without-padding).
    """
    import librosa
    import numpy as np

    y, _ = librosa.load(str(audio_path), sr=SAMPLE_RATE, mono=True)
    spec = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP_LENGTH, win_length=WIN_LENGTH))
    spec = librosa.power_to_db(spec, ref=np.max).astype(np.float32)
    spec = spec.T  # → (T, 513)

    # Pad to a multiple of 31 frames so we can chunk cleanly
    t = spec.shape[0]
    pad = (-t) % JDCNet.INPUT_FRAMES
    if pad:
        spec = np.concatenate([spec, np.zeros((pad, spec.shape[1]), dtype=np.float32)], axis=0)
    # Z-score normalize (mean/std are per-bin tensors of shape (31, 513))
    if norm_mean is not None and norm_std is not None:
        mean_np = norm_mean.numpy() if isinstance(norm_mean, torch.Tensor) else np.asarray(norm_mean)
        std_np  = norm_std.numpy()  if isinstance(norm_std,  torch.Tensor) else np.asarray(norm_std)
        # mean_np / std_np have shape (31, 513); we apply them per window
    else:
        mean_np = None
        std_np  = None

    # Reshape into (N, 31, 513)
    n = spec.shape[0] // JDCNet.INPUT_FRAMES
    windows = spec.reshape(n, JDCNet.INPUT_FRAMES, spec.shape[1])
    if mean_np is not None:
        windows = (windows - mean_np) / (std_np + 1e-4)
    # PyTorch wants (N, 1, 31, 513)
    x = torch.from_numpy(windows).float().unsqueeze(1).to(device)

    all_pitch, all_voice = [], []
    for i in range(0, n, batch_size):
        batch = x[i : i + batch_size]
        pitch, voicing = model(batch)
        all_pitch.append(pitch.cpu())
        all_voice.append(voicing.cpu())
    pitch_all = torch.cat(all_pitch, dim=0).view(-1, JDCNet.NUM_PITCH_CLASSES)
    voice_all = torch.cat(all_voice, dim=0).view(-1, 2)

    # Trim the padding rows off the end
    return pitch_all[:t], voice_all[:t]


def voicing_spans(
    voicing_probs: torch.Tensor,
    *,
    threshold: float = 0.5,
    min_duration: float = 0.05,
) -> list[dict]:
    """Collapse per-frame voicing probabilities into contiguous voiced spans.

    Args:
        voicing_probs: (T, 2) tensor — column 1 = P(voice).
        threshold:     decision boundary on P(voice).
        min_duration:  minimum span length in seconds; shorter detections
                       are dropped as noise.

    Returns:
        List of {"start": float, "end": float, "label": "voice",
                 "confidence": float} dicts in seconds.
    """
    voiced = (voicing_probs[:, 1] > threshold).numpy()
    spans: list[dict] = []
    in_span = False
    start_i = 0
    for i, v in enumerate(voiced):
        if v and not in_span:
            in_span = True
            start_i = i
        elif not v and in_span:
            in_span = False
            start_t = start_i * FRAME_SEC
            end_t   = i * FRAME_SEC
            if end_t - start_t >= min_duration:
                conf = float(voicing_probs[start_i:i, 1].mean())
                spans.append({"start": start_t, "end": end_t, "label": "voice", "confidence": conf})
    if in_span:
        start_t = start_i * FRAME_SEC
        end_t   = len(voiced) * FRAME_SEC
        if end_t - start_t >= min_duration:
            conf = float(voicing_probs[start_i:, 1].mean())
            spans.append({"start": start_t, "end": end_t, "label": "voice", "confidence": conf})
    return spans
