/** What a cue is, from its label: the part before " · " — "drop" of
 *  "drop · bar 33", "hit" of "hit · drums · bar 25 beat 2". */
export function cueSubject(label: string | undefined): string {
  return (label ?? '').split(' · ')[0].trim();
}
