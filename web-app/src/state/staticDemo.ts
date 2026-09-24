// Build-time flag for the static, backend-less Cloudflare Pages mirror.
//
// When the app is built with VITE_STATIC_DEMO=1 (see
// web-app/scripts/assemble-cf-demo.mjs + the deploy-cf-demo workflow) there is
// NO server: only the read-only public/demo tier works. In that build every
// visitor is forced into Demo Mode at startup (reads come from bundled static
// files, writes go to localStorage), and the sign-in / full-corpus entry
// points — which need the backend — are hidden so they can't dead-end.
//
// In every normal build this is false and the app behaves exactly as before.
export const IS_STATIC_DEMO = import.meta.env.VITE_STATIC_DEMO === '1';

// Optional: the URL of the full (GCP) app, surfaced on the static mirror's
// landing chooser so visitors can jump to sign-in / their real corpus. Empty
// when not configured at build time.
export const MAIN_APP_URL = (import.meta.env.VITE_MAIN_APP_URL as string | undefined) || '';
