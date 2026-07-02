/**
 * Badge text for a read-only annotation card: the generator/algorithm the
 * layer's items came from. Detector-sourced layers carry
 * `source: 'detector:<name>'`; we surface `<name>` so the card states its
 * origin (e.g. "whisper-base", "librosa-onsets"). Falls back to a generic
 * "detector" label when the source isn't in the expected shape.
 */
export function detectorBadgeLabel(source: string | undefined): string {
  if (source && source.startsWith('detector:')) {
    const name = source.slice('detector:'.length).trim();
    if (name) return name;
  }
  return 'detector';
}
