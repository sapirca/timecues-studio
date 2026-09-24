/** Does any cached result exist for a family? (GET /api/<family>/cached is the
 *  in-process index served from disk regardless of sidecar state.) */
export async function familyHasCached(family: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/${family}/cached`);
    if (!res.ok) return false;
    const data = await res.json();
    return typeof data?.count === 'number' && data.count > 0;
  } catch {
    return false;
  }
}
