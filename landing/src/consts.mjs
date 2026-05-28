// Single source of truth for cross-page URLs in the landing site.
//
// LIVE_DEMO_URL is deployment-specific: set the LIVE_DEMO_URL environment
// variable (e.g. in the GitHub Pages workflow) to point at your running
// instance. The default is a placeholder so the public repo never hard-codes
// one specific deployment's address. Markdown content (which can't import this
// constant) uses the sentinel "__LIVE_DEMO_URL__"; the remark plugin in
// astro.config.mjs rewrites it to this value at build time.
export const LIVE_DEMO_URL = process.env.LIVE_DEMO_URL || 'https://timecues-studio.example.com/';
export const REPO_URL = 'https://github.com/sapirca/timecues-studio';
