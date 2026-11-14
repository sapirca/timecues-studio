// UI scale: the whole page bigger (or smaller), like the browser's own zoom.
// The studio is dense 10-13px text with small hit targets. This zooms the page
// (CSS `zoom` on <html>) by a per-viewer factor, set with the − / + control
// in the header (UiScaleControl) and remembered in localStorage.
//
// CSS zoom alone breaks every drag and scrub: under it, getBoundingClientRect,
// clientX and innerWidth come back in screen px (zoomed) while clientWidth,
// offsetWidth, scrollLeft and style.left stay in layout px (unzoomed), and the
// lanes mix the two (x = e.clientX - rect.left; t = (x + scrollLeft) / pxPerSec).
// So this module also wraps the screen-px APIs to return layout px, which puts
// every API back into one coordinate system -- the one the code was written
// for, exactly as under browser zoom. devicePixelRatio is multiplied by the
// zoom so canvases sized clientWidth*dpr stay sharp.
//
// vh/vw are zoomed too, so `h-screen` would run off the bottom. postcss.config.js
// rewrites every vh/vw/dvh in the built CSS to var(--vh-u) etc., which divide
// by --uiz; inline styles use the same variables.
//
// Keys: Cmd/Ctrl + = / - / 0 step it up, down, and back to the default. They
// are the browser's own zoom keys, taken over because this replaces browser
// zoom (the two stacked would double up); bare + / - / 0 stay timeline zoom.
//
// Imported first in main.tsx, before any other module reads a coordinate.

const KEY = 'tc.uiscale';
export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.8;
const STEP = 0.1;

// Until the viewer picks a size, the default FITS THE WINDOW: the largest step
// (up to 120%) that still leaves FIT_LAYOUT_PX of layout, so every workspace
// tab, both side panels and the header controls are on screen — a 1920 px
// window gets 120%, a 1440 px laptop 90%, 1280 px 80%. It follows the window
// as it resizes. A fixed 120% left a 1280 px screen ~1070 px of layout: the
// header wrapped and the corpus name shrank to one letter.
// A phone (coarse pointer) already has its own layout and stays at 100%.
// (jsdom has no matchMedia, and this runs at import, so a test that renders
// the header would fail to load at all without the guard.)
const FIT_LAYOUT_PX = 1600;
const FIT_MAX = 1.2;
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches;
// The window's real width in screen px. innerWidth is divided by the zoom once
// patchCoords runs, so it keeps the unpatched getter.
let screenWidth = () => (typeof window === 'undefined' ? FIT_LAYOUT_PX * FIT_MAX : window.innerWidth);
function fitScale() {
  if (COARSE) return 1;
  const fit = Math.floor((screenWidth() / FIT_LAYOUT_PX) * 10 + 1e-9) / 10;
  return Math.min(FIT_MAX, Math.max(UI_SCALE_MIN, fit));
}

function readChosen(): number | null {
  try {
    const v = parseFloat(localStorage.getItem(KEY) ?? '');
    if (v >= UI_SCALE_MIN && v <= UI_SCALE_MAX) return v;
  } catch { /* storage blocked: fit the window */ }
  return null;
}
let chosen = readChosen() !== null;
let z = readChosen() ?? fitScale();

const listeners = new Set<() => void>();

function apply() {
  const root = document.documentElement;
  root.style.setProperty('zoom', String(z));
  root.style.setProperty('--uiz', String(z));
}

function patchCoords() {
  const divide = (proto: object, names: string[]) => {
    for (const n of names) {
      const d = Object.getOwnPropertyDescriptor(proto, n);
      if (!d?.get) continue;
      const get = d.get;
      Object.defineProperty(proto, n, { ...d, get() { return get.call(this) / z; } });
    }
  };
  // Pointer positions (PointerEvent and WheelEvent inherit from MouseEvent).
  divide(MouseEvent.prototype, ['clientX', 'clientY', 'pageX', 'pageY', 'x', 'y', 'offsetX', 'offsetY', 'movementX', 'movementY']);
  if (typeof Touch !== 'undefined') divide(Touch.prototype, ['clientX', 'clientY', 'pageX', 'pageY']);

  // Element and text-range boxes.
  const scaleRect = (r: DOMRect) => new DOMRect(r.x / z, r.y / z, r.width / z, r.height / z);
  for (const P of [Element.prototype, Range.prototype] as Array<{
    getBoundingClientRect(): DOMRect; getClientRects(): DOMRectList;
  }>) {
    const gbr = P.getBoundingClientRect;
    const gcr = P.getClientRects;
    P.getBoundingClientRect = function () { return scaleRect(gbr.call(this)); };
    P.getClientRects = function () {
      const out = Array.from(gcr.call(this), scaleRect) as DOMRect[] & { item?: (i: number) => DOMRect | null };
      out.item = (i) => out[i] ?? null;
      return out as unknown as DOMRectList;
    };
  }

  // Viewport size and pixel density.
  for (const n of ['innerWidth', 'innerHeight']) {
    const d = Object.getOwnPropertyDescriptor(window, n);
    if (d?.get) {
      const get = d.get;
      if (n === 'innerWidth') screenWidth = () => get.call(window);
      Object.defineProperty(window, n, { ...d, get() { return get.call(window) / z; } });
    }
  }
  const dpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  if (dpr?.get) { const get = dpr.get; Object.defineProperty(window, 'devicePixelRatio', { ...dpr, get() { return get.call(window) * z; } }); }

  // Hit-testing takes screen px: scale the layout px the code passes back up.
  const doc = Document.prototype as unknown as Record<string, unknown>;
  for (const n of ['elementFromPoint', 'elementsFromPoint', 'caretRangeFromPoint', 'caretPositionFromPoint']) {
    const f = doc[n] as ((x: number, y: number, ...rest: unknown[]) => unknown) | undefined;
    if (f) doc[n] = function (this: Document, x: number, y: number, ...rest: unknown[]) { return f.call(this, x * z, y * z, ...rest); };
  }
}

// jsdom (vitest) has no layout to zoom; leave its APIs alone.
const IS_TEST = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
if (!IS_TEST) { patchCoords(); apply(); }

export function getUiScale() { return z; }

function applyScale(next: number) {
  z = Math.round(Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, next)) * 10) / 10;
  if (!IS_TEST) apply();
  listeners.forEach((l) => l());
  // Everything that sizes a canvas or clamps a popup re-measures on resize.
  window.dispatchEvent(new Event('resize'));
}

export function setUiScale(next: number) {
  chosen = true;
  applyScale(next);
  try { localStorage.setItem(KEY, String(z)); } catch { /* not remembered, still applied */ }
}

export function bumpUiScale(dir: 1 | -1) { setUiScale(z + dir * STEP); }

/** Forget the chosen size and fit the window again (Cmd/Ctrl+0). */
export function resetUiScale() {
  chosen = false;
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
  applyScale(fitScale());
}

/** True while the size follows the window (nothing picked with − / +). */
export function isUiScaleFitted() { return !chosen; }

// The window resized: refit, unless the viewer picked a size. applyScale fires
// a resize of its own, which lands here with nothing left to change.
if (!IS_TEST) {
  window.addEventListener('resize', () => {
    if (chosen) return;
    const next = fitScale();
    if (next !== z) applyScale(next);
  });
}

function onKey(e: KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  // e.code too, so non-US layouts that put = and - elsewhere still work.
  const k = e.key, c = e.code;
  if (k === '=' || k === '+' || c === 'Equal' || c === 'NumpadAdd') bumpUiScale(1);
  else if (k === '-' || k === '_' || c === 'Minus' || c === 'NumpadSubtract') bumpUiScale(-1);
  else if (k === '0' || c === 'Digit0' || c === 'Numpad0') resetUiScale();
  else return;
  e.preventDefault();
  e.stopPropagation();
}
if (!IS_TEST) window.addEventListener('keydown', onKey, { capture: true });

export function subscribeUiScale(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
