import tailwindcss from '@tailwindcss/postcss'

// Under the page zoom (src/uiScale.ts) a vh/vw is zoomed too, so `h-screen` at
// 120% runs 20% off the bottom. Rewrite every viewport length in the built CSS
// (Tailwind's utilities and index.css alike) to a variable that divides the
// zoom back out: 100vh -> calc(100 * var(--vh-u, 1vh)). The variables live on
// :root in index.css; the fallback keeps the plain unit if they are missing.
const VIEWPORT_LEN = /(^|[^\w.-])(-?\d*\.?\d+)(d|s|l)?v(h|w)\b/g
const unzoomViewport = {
  postcssPlugin: 'unzoom-viewport',
  Declaration(decl) {
    if (/^--[dsl]?v[hw]-u$/.test(decl.prop)) return   // the variables themselves
    if (!/\dv[hw]|\d[dsl]v[hw]/.test(decl.value)) return
    if (decl.value.includes('-u, 1')) return   // already rewritten (PostCSS revisits changed nodes)
    decl.value = decl.value.replace(VIEWPORT_LEN, (_m, pre, n, kind = '', axis) =>
      `${pre}calc(${n} * var(--${kind}v${axis}-u, 1${kind}v${axis}))`)
  },
}

export default {
  plugins: [tailwindcss(), unzoomViewport],
}
