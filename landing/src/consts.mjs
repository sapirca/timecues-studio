// Single source of truth for cross-page URLs in the landing site.
//
// There are TWO live-demo deployments, each deployment-specific and set via
// an environment variable (e.g. as GitHub repo variables in the Pages
// workflow). Defaults are placeholders so the public repo never hard-codes a
// specific deployment's address.
//
//   LIVE_DEMO_URL    — the GCP-hosted instance (the full live server: sign-in,
//                      detectors, saving). This is the DEFAULT/PRIMARY link.
//   LIVE_DEMO_URL_CF — the Cloudflare-hosted static demo (the always-on public
//                      mirror, independent of GCP). The SECONDARY link.
//
// Markdown content (which can't import these constants) uses the sentinels
// "__LIVE_DEMO_URL__" / "__LIVE_DEMO_URL_CF__"; the remark plugin in
// astro.config.mjs rewrites them to these values at build time.
export const LIVE_DEMO_URL = process.env.LIVE_DEMO_URL || 'https://timecues-studio.example.com/';
export const LIVE_DEMO_URL_CF = process.env.LIVE_DEMO_URL_CF || 'https://timecues-studio-cf.example.com/';
export const REPO_URL = 'https://github.com/sapirca/timecues-studio';
