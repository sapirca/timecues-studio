// The static Cloudflare mirror has no server. Its layers must load and save
// through localStorage — a 404 from /api/annotation-layers used to read as a
// failed load, so every song showed "layers didn't load" and refused to save.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../state/staticDemo', () => ({ IS_STATIC_DEMO: true, MAIN_APP_URL: '' }));

import { deleteLayers, loadLayersForEdit, saveLayers } from './annotationLayers';

describe('annotation layers on the static demo', () => {
  const fetchSpy = vi.fn(() => Promise.reject(new Error('no server on the static mirror')));

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockClear();
  });

  it('loads an empty document when nothing was saved, without the network', async () => {
    const doc = await loadLayersForEdit('pantheon');
    expect(doc.layers).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('saves to this browser and loads it back', async () => {
    const doc = await loadLayersForEdit('pantheon');
    const layer = { id: 'l1', name: 'Cues 1', type: 'cues', visible: true, color: '#fff', items: [{ id: 'c1', time: 12.5, label: 'drop' }] };
    const res = await saveLayers('pantheon', { ...doc, layers: [layer] } as never, { baseRev: 0 });
    expect(res).toEqual({ ok: true, rev: 1 });

    const back = await loadLayersForEdit('pantheon');
    expect(back.rev).toBe(1);
    expect(back.layers).toHaveLength(1);
    expect(back.layers[0].name).toBe('Cues 1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('deletes from this browser too', async () => {
    const doc = await loadLayersForEdit('pantheon');
    await saveLayers('pantheon', { ...doc, layers: [{ id: 'l1', name: 'Cues 1', type: 'cues', visible: true, color: '#fff', items: [] }] } as never, { baseRev: 0 });
    expect(await deleteLayers('pantheon')).toBe(true);
    expect((await loadLayersForEdit('pantheon')).layers).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
