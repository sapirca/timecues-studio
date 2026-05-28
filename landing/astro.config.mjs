// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { visit } from 'unist-util-visit';
import { REPO_URL, LIVE_DEMO_URL } from './src/consts.mjs';

// TimeCues Studio — landing + documentation site.
// Companion to the React annotation app (the "live demo"). The demo URL is
// single-sourced in src/consts.mjs (override via the LIVE_DEMO_URL env var).
// Built from the same repo so docs in /docs/ stay in sync with the app.

// `site` powers absolute URLs in sitemap.xml and OpenGraph meta tags;
// `base` is the URL path prefix (matters when GitHub Pages serves the
// site under /<repo-name>/ instead of /). Both are set by the GH Actions
// Pages workflow from the GitHub context so the same config file works in
// whichever repo it's deployed from. Defaults below are for local dev.
const SITE_URL = process.env.SITE_URL || 'https://timecues-studio.example.com';
const BASE_PATH = process.env.BASE_PATH || '/';

// Astro auto-prefixes sidebar / hero-action links (configured in this file)
// with BASE_PATH, but does NOT rewrite absolute-style `/path/` hrefs that
// appear in markdown body or inline HTML inside MDX. That left every
// hand-written `<a href="/timecues/">` and `[link](/timecues/user-guide/)`
// pointing at the wrong URL on the Pages deploy (404). This rehype plugin
// walks every <a>/<img>/<link>/<script> element in the rendered HTML and
// prefixes any "/foo" attribute with BASE_PATH (idempotent — skips URLs
// that already start with BASE_PATH).
function rehypePrefixBase() {
  const base = BASE_PATH.replace(/\/$/, '');
  if (!base) return () => {};  // base is "/" → nothing to do
  const ATTR_BY_TAG = { a: 'href', area: 'href', link: 'href', img: 'src', source: 'src', script: 'src' };
  return (tree) => {
    visit(tree, 'element', (node) => {
      const attr = ATTR_BY_TAG[node.tagName];
      if (!attr || !node.properties) return;
      const url = node.properties[attr];
      if (typeof url !== 'string' || !url.startsWith('/')) return;
      // Skip protocol-relative ("//cdn.example.com/...") and already-prefixed URLs.
      if (url.startsWith('//') || url.startsWith(base + '/') || url === base) return;
      node.properties[attr] = base + url;
    });
  };
}

// The live-demo URL is single-sourced in src/consts.mjs. Markdown *body* links
// can't import a JS constant, so they author the sentinel "__LIVE_DEMO_URL__"
// and this plugin rewrites those link targets to LIVE_DEMO_URL at build time.
// NOTE: frontmatter (the Starlight splash hero actions) is parsed before remark
// runs, so the sentinel is resolved there by the "Resolve live-demo URL" sed
// step in .github/workflows/deploy-landing.yml instead.
function remarkLiveDemoUrl() {
  return (tree) => {
    visit(tree, 'link', (node) => {
      if (node.url === '__LIVE_DEMO_URL__') node.url = LIVE_DEMO_URL;
    });
  };
}

export default defineConfig({
  site: SITE_URL,
  base: BASE_PATH,
  markdown: { remarkPlugins: [remarkLiveDemoUrl], rehypePlugins: [rehypePrefixBase] },
  integrations: [
    starlight({
      title: 'TimeCues Studio',
      tagline: 'Music structure annotation, multi-annotator, with built-in algorithm comparison.',
      description:
        'TimeCues Studio — an open-source web app for annotating musical structure and comparing it against algorithmic estimates. Multi-annotator, evaluation built-in.',
      logo: { src: './src/assets/logo.svg', replacesTitle: false },
      social: {
        github: REPO_URL,
      },
      customCss: ['./src/styles/custom.css'],
      lastUpdated: true,
      pagination: true,
      sidebar: [
        {
          label: 'Get started',
          items: [
            { label: 'Welcome', link: '/' },
            { label: 'How to run', link: '/run/' },
            { label: 'Video tutorials', link: '/tutorials/', badge: { text: 'stubs', variant: 'caution' } },
          ],
        },
        {
          label: 'Documentation',
          items: [
            { label: 'Overview', link: '/timecues/' },
            { label: 'User guide', link: '/timecues/user-guide/' },
            { label: 'Data model', link: '/timecues/data-model/' },
            { label: 'Experimental models', link: '/timecues/experimental/' },
            { label: 'Deployment', link: '/timecues/deployment/' },
          ],
        },
        {
          label: 'Community',
          items: [
            { label: 'Send feedback', link: '/feedback/' },
            { label: 'Contact', link: '/contact/' },
          ],
        },
        {
          label: 'Links',
          items: [
            { label: 'Live demo', link: LIVE_DEMO_URL, attrs: { target: '_blank', rel: 'noopener' }, badge: { text: 'live', variant: 'success' } },
            { label: 'Source on GitHub', link: REPO_URL, attrs: { target: '_blank', rel: 'noopener' } },
          ],
        },
      ],
    }),
  ],
});
