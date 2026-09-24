"""Shared natten compatibility shim.

allin1 1.1.x imports natten1dav / natten1dqkrpb / natten2dav / natten2dqkrpb
from natten.functional. natten 0.17+ renamed/removed that API, and natten
itself ships only CUDA wheels — so CPU-only hosts (most laptops, the
docker `cpu-tools` profile, Codespaces, the GCP VM unless GPU-attached)
can't pip-install it at all.

This module re-implements the four legacy functions in pure PyTorch and
installs them under a synthetic `natten.functional` module. After
`apply_natten_shim()` returns, `import allin1` succeeds even when natten
is absent, and the actual inference still works (slower than CUDA natten,
but bit-for-bit equivalent on CPU).

Two consumers:
  * tools/run_allin1.py  — applies the shim before importing allin1 at
    runtime, so detection actually runs.
  * web-app/vite.config.ts (capabilities probe) — applies the shim
    before `import allin1`, so the probe reports allin1=true when the
    package is installed, not "allin1=false" because natten can't be
    found. Previously the probe lied: allin1 was importable in the run
    path (via the inline shim there) but the probe used a naive
    `__import__('allin1')` and the UI grayed out the All-In-One section.

Idempotent: re-applying after the first call short-circuits via
`from natten.functional import natten1dav` succeeding.
"""

from __future__ import annotations


def apply_natten_shim() -> bool:
    """Install the legacy natten.functional names if they're absent.

    Returns True if the shim was installed (natten was missing / had the
    new API only), False if natten already exposed the legacy names so
    no patching was needed.
    """
    try:
        from natten.functional import natten1dav  # noqa: F401 — already present
        return False  # legacy API already there
    except ImportError:
        pass

    import sys
    import types
    import torch

    try:
        import natten.functional as _nf
    except ImportError:
        # natten itself is missing — fabricate a synthetic package so
        # `from natten.functional import natten1dav` resolves to our
        # pure-PyTorch implementations rather than ImportError.
        natten_pkg = types.ModuleType("natten")
        natten_func = types.ModuleType("natten.functional")
        natten_pkg.functional = natten_func
        sys.modules["natten"] = natten_pkg
        sys.modules["natten.functional"] = natten_func
        _nf = natten_func

    def natten1dqkrpb(query, key, rpb, kernel_size, dilation=1):
        """1-D neighborhood-attention QK + relative-position-bias."""
        B, H, L, D = query.shape
        r = kernel_size // 2
        offsets = torch.arange(-r, r + 1, device=query.device) * dilation
        positions = torch.arange(L, device=query.device)
        src_idx = (positions.unsqueeze(1) + offsets.unsqueeze(0)).clamp(0, L - 1)
        key_nbrs = key[:, :, src_idx, :]                     # (B, H, L, K, D)
        scores = (query.unsqueeze(3) * key_nbrs).sum(-1)     # (B, H, L, K)
        rpb_sel = rpb[:, torch.arange(kernel_size, device=query.device)]  # (H, K)
        return scores + rpb_sel.unsqueeze(0).unsqueeze(2)

    def natten1dav(attn, value, kernel_size, dilation=1):
        """1-D neighborhood-attention AV product."""
        _, _, L, _ = attn.shape
        r = kernel_size // 2
        offsets = torch.arange(-r, r + 1, device=attn.device) * dilation
        positions = torch.arange(L, device=attn.device)
        src_idx = (positions.unsqueeze(1) + offsets.unsqueeze(0)).clamp(0, L - 1)
        v_nbrs = value[:, :, src_idx, :]                     # (B, H, L, K, D)
        return (attn.unsqueeze(-1) * v_nbrs).sum(-2)         # (B, H, L, D)

    def natten2dqkrpb(query, key, rpb, kernel_size, dilation=1):
        """2-D neighborhood-attention QK + relative-position-bias."""
        B, H, h, w, D = query.shape
        r = kernel_size // 2
        K = kernel_size
        oy = torch.arange(-r, r + 1, device=query.device) * dilation
        ox = torch.arange(-r, r + 1, device=query.device) * dilation
        sy = (torch.arange(h, device=query.device).unsqueeze(1) + oy.unsqueeze(0)).clamp(0, h - 1)
        sx = (torch.arange(w, device=query.device).unsqueeze(1) + ox.unsqueeze(0)).clamp(0, w - 1)
        lin = sy[:, None, :, None] * w + sx[None, :, None, :]   # (h, w, K, K)
        kf = key.reshape(B, H, h * w, D)
        kn = kf[:, :, lin.reshape(-1), :].reshape(B, H, h, w, K, K, D)
        qe = query.unsqueeze(4).unsqueeze(5)
        scores = (qe * kn).sum(-1)                              # (B, H, h, w, K, K)
        ri = torch.arange(K, device=query.device)
        rp = rpb[:, ri[:, None], ri[None, :]]                   # (H, K, K)
        scores = scores + rp.unsqueeze(0).unsqueeze(2).unsqueeze(3)
        return scores.reshape(B, H, h, w, K * K)

    def natten2dav(attn, value, kernel_size, dilation=1):
        """2-D neighborhood-attention AV product."""
        B, H, h, w, _ = attn.shape
        K = kernel_size
        D = value.shape[-1]
        r = K // 2
        oy = torch.arange(-r, r + 1, device=attn.device) * dilation
        ox = torch.arange(-r, r + 1, device=attn.device) * dilation
        sy = (torch.arange(h, device=attn.device).unsqueeze(1) + oy.unsqueeze(0)).clamp(0, h - 1)
        sx = (torch.arange(w, device=attn.device).unsqueeze(1) + ox.unsqueeze(0)).clamp(0, w - 1)
        lin = sy[:, None, :, None] * w + sx[None, :, None, :]
        vf = value.reshape(B, H, h * w, D)
        vn = vf[:, :, lin.reshape(-1), :].reshape(B, H, h, w, K, K, D)
        at = attn.reshape(B, H, h, w, K, K).unsqueeze(-1)
        return (at * vn).sum(-2).sum(-2)                        # (B, H, h, w, D)

    _nf.natten1dqkrpb = natten1dqkrpb
    _nf.natten1dav = natten1dav
    _nf.natten2dqkrpb = natten2dqkrpb
    _nf.natten2dav = natten2dav
    return True
