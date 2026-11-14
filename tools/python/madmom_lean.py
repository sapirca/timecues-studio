"""madmom, run in less memory, with the same results.

Two of madmom's steps hold far more than they need on a whole song, which
sank the core-mir container (2 GB, shared by three servers):

- `activations()` — the RNN beat/downbeat processors build three full-song
  spectrograms (the 4096-sample one alone is ~0.5 GB) to make 34 MB of
  features. Every feature row depends on its own frame and a few before it
  (the spectral difference), so they are built in chunks with context, by
  the processors' own objects, and come out identical: 1.6 GB → ~0.3 GB.
- `viterbi()` — see below.

madmom's Cython Viterbi stores a uint32 state id per (frame, state). For the
downbeat DBN on a 5-minute song at 100 fps that is 31.8k frames × 14.9k
states × 4 bytes = 1.9 GB — more than a 2 GB container can spare. Every
state has at most a few dozen predecessors, so the index into its
predecessor list fits a byte, and the same table costs a quarter.

The recursion is madmom's, step for step — same additions in the same
order, and a strict `>` so the first best predecessor wins a tie — so the
path and its log probability come out identical (checked against madmom's
own decoder). `patch_downbeats()` routes madmom's DBNDownBeatTrackingProcessor
through it.
"""
from __future__ import annotations

import numpy as np
from numba import njit

# Feature frames per chunk, and the frames of context before each — more
# than any branch's spectral-difference lag (a few frames at 100 fps).
FEATURE_CHUNK = 2048
FEATURE_CONTEXT = 64


def _branch_features(branch, signal) -> np.ndarray:
    """One frame-size branch (frames → STFT → filterbank → log → difference)
    of a madmom RNN pre-processor, applied chunk by chunk."""
    frames_proc, *rest = branch.processors
    frames = frames_proc(signal)
    n = len(frames)
    out = None
    for a in range(0, n, FEATURE_CHUNK):
        b = min(n, a + FEATURE_CHUNK)
        lo = max(0, a - FEATURE_CONTEXT)
        x = frames[lo:b]
        for proc in rest:
            x = proc(x)
        x = np.asarray(x)[a - lo:]
        if out is None:
            out = np.empty((n, x.shape[1]), dtype=x.dtype)
        out[a:b] = x
    return out


def activations(processor, path) -> np.ndarray:
    """`processor(path)` for madmom's RNNBeatProcessor / RNNDownBeatProcessor,
    with the features built in chunks. Same numbers, a fraction of the memory."""
    pre, *after = processor.processors       # after: the network (+ any post step)
    sig_proc, multi, _stack = pre.processors
    signal = sig_proc(str(path))
    x = np.hstack([_branch_features(b, signal) for b in multi.processors])
    del signal
    for proc in after:
        x = proc(x)
    return x


@njit(cache=True)
def _forward(prev, tm_states, tm_pointers, tm_logp, om_dens, om_ptr):
    num_frames = om_dens.shape[0]
    num_states = prev.shape[0]
    bt = np.empty((num_frames, num_states), np.uint8)
    cur = np.empty(num_states)
    for f in range(num_frames):
        for s in range(num_states):
            best = -np.inf
            arg = 0
            density = om_dens[f, om_ptr[s]]
            start = tm_pointers[s]
            for k in range(start, tm_pointers[s + 1]):
                p = prev[tm_states[k]] + tm_logp[k] + density
                if p > best:
                    best = p
                    arg = k - start
            cur[s] = best
            bt[f, s] = arg
        prev, cur = cur, prev
    return prev, bt


def viterbi(hmm, observations):
    """`hmm.viterbi(observations)` → (path, log_prob), with byte back-pointers.
    Falls back to madmom's own decoder for a model whose states have more
    predecessors than a byte can index."""
    tm, om = hmm.transition_model, hmm.observation_model
    pointers = np.asarray(tm.pointers)
    if int(np.diff(pointers).max()) > 255:
        return hmm.viterbi(observations)
    states = np.asarray(tm.states)
    with np.errstate(divide="ignore"):
        init = np.log(np.asarray(hmm.initial_distribution, dtype=np.float64))
    last, bt = _forward(
        init, states, pointers, np.asarray(tm.log_probabilities, dtype=np.float64),
        np.asarray(om.log_densities(observations), dtype=np.float64), np.asarray(om.pointers),
    )
    state = int(np.argmax(last))
    log_prob = float(last[state])
    if np.isinf(log_prob):
        return np.empty(0, dtype=np.uint32), log_prob
    path = np.empty(bt.shape[0], dtype=np.uint32)
    for f in range(bt.shape[0] - 1, -1, -1):
        path[f] = state
        state = int(states[pointers[state] + bt[f, state]])
    return path, log_prob


def patch_downbeats() -> None:
    """Point madmom's downbeat DBN at `viterbi`. Its process() looks the
    module-level `_process_dbn` up on every call, so this is enough."""
    import madmom.features.downbeats as downbeats
    downbeats._process_dbn = lambda args: viterbi(*args)
