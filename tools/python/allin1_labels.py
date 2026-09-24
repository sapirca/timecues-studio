"""Shared allin1 segment-label mapping.

Used by both run_allin1.py and run_allin1_lean.py so the two runners can't
drift out of sync on what JSON `type` value a given allin1 label produces.
"""


def label_to_type(label: str) -> str:
    """Map allin1 segment labels to the EDM section-type vocabulary."""
    label = label.lower().strip()
    mapping = {
        'intro':        'intro',
        'verse':        'verse',
        'pre-chorus':   'buildup',
        'chorus':       'drop',
        'bridge':       'breakdown',
        'break':        'breakdown',
        'instrumental': 'verse',
        'outro':        'outro',
        'solo':         'verse',
        'interlude':    'breakdown',
    }
    return mapping.get(label, label)
