import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import http from 'http'
import path from 'path'
import dnsPromises from 'node:dns/promises'
import { spawn } from 'child_process'
import { DATA_DIRS, DATA_FILES, DEFAULT_DATA_DIRS, REPO_ROOT } from './dataPaths'

// Resolve the deployed commit SHA for the landing-page footer. In a deployed
// build the container's env already carries VITE_COMMIT_SHA. For local dev —
// both bare `npm run dev` and `docker compose up` — fall back to reading the
// .git tree directly so the footer shows the working tree's commit. The
// docker-compose dev web service bind-mounts the repo's .git into /app/.git so
// this lookup works there too.
// We parse .git/HEAD manually rather than shell out, since node:20-slim has
// no git binary inside the container.
// Deploy / build timestamp shown alongside the commit SHA in the landing
// footer. Set once at vite startup → in production this matches container
// start (≈ deploy time); in local dev it refreshes on each `npm run dev`.
if (!process.env.VITE_BUILD_TIME) {
  process.env.VITE_BUILD_TIME = new Date().toISOString()
}

if (!process.env.VITE_COMMIT_SHA) {
  try {
    const gitDir = path.join(REPO_ROOT, '.git')
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    let sha = ''
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim()
      const refPath = path.join(gitDir, ref)
      if (fs.existsSync(refPath)) {
        sha = fs.readFileSync(refPath, 'utf8').trim()
      } else {
        // Packed ref: scan .git/packed-refs for "<sha> <ref>".
        const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8')
        for (const line of packed.split('\n')) {
          if (line.startsWith('#') || line.startsWith('^')) continue
          const [s, r] = line.split(' ')
          if (r === ref) { sha = s; break }
        }
      }
    } else if (/^[0-9a-f]{40}$/.test(head)) {
      sha = head  // detached HEAD
    }
    if (sha) process.env.VITE_COMMIT_SHA = sha
  } catch {
    // Not a git checkout (e.g. tarball install) — landing page hides the footer.
  }
}

// Hosts for the Python sidecar services. Default to localhost for plain
// `npm run dev` setups; in docker-compose these are set to service names
// (`bpm`, `mir`, `mir-eval`, `ruptures`, `custom`, `stems`) so the web
// container reaches them via the internal compose network.
const BPM_HOST = process.env.BPM_HOST ?? '127.0.0.1'
const MIR_EVAL_HOST = process.env.MIR_EVAL_HOST ?? 'localhost'
const MIR_HOST = process.env.MIR_HOST ?? '127.0.0.1'
const RUPTURES_HOST = process.env.RUPTURES_HOST ?? '127.0.0.1'
const MSAF_HOST = process.env.MSAF_HOST ?? '127.0.0.1'
const CUSTOM_HOST = process.env.CUSTOM_HOST ?? '127.0.0.1'
const STEMS_HOST = process.env.STEMS_HOST ?? '127.0.0.1'
const STEMS_PORT = 8006
// Experimental-models sidecars (SPAN family / BeatNet). Default to localhost
// so `npm run dev` can talk to a manually-launched python server; in
// docker-compose these get set to the service names by the `experimental-models`
// profile. When the profile isn't running, the proxy returns 503.
const SPAN_HOST = process.env.SPAN_HOST ?? '127.0.0.1'
const BEATNET_HOST = process.env.BEATNET_HOST ?? '127.0.0.1'
const LOOP_HOST = process.env.LOOP_HOST ?? '127.0.0.1'
const PANNS_HOST = process.env.PANNS_HOST ?? '127.0.0.1'
const PITCH_HOST = process.env.PITCH_HOST ?? '127.0.0.1'
const CUE_EXTRAS_HOST = process.env.CUE_EXTRAS_HOST ?? '127.0.0.1'
const PERCUSSIVE_HOST = process.env.PERCUSSIVE_HOST ?? '127.0.0.1'
const LYRICS_HOST     = process.env.LYRICS_HOST     ?? '127.0.0.1'

// ─── URL-derived path-segment validators ─────────────────────────────────────
// Every handler that takes a slug / filename from the URL and joins it into
// a filesystem path must run the decoded value through one of these. The
// regex on the *route* (`[^/]+`) blocks literal `/`, but the request URL can
// carry `%2F` which decodes to `/` and escapes the target directory; the
// validators below catch that, plus `..`, NUL, and oversized inputs.

const SLUG_RE = /^[a-z0-9._\-]+$/

/** Strict slug: lowercase alphanumerics, dot, underscore, hyphen. Matches the
 *  slug generator that uploadSong() uses, plus every existing on-disk slug
 *  audited in data/songs/ and data-default/songs/. Use everywhere the slug
 *  identifies a song (annotations, song-info, algo-clusters, run-* jobs). */
function safeSlug(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const v = String(raw)
  if (v.length === 0 || v.length > 128) return null
  if (v === '.' || v === '..') return null
  if (v.includes('/') || v.includes('\\') || v.includes('\0')) return null
  if (!SLUG_RE.test(v)) return null
  return v
}

/** Looser: the audio handler accepts human-friendly filenames with spaces,
 *  parens, accents (e.g. "Tahüm - Broken Whole (Einki Remix).mp3"). No
 *  character whitelist — relies on the traversal-token block plus the
 *  realpath containment check in findInDir(). */
function safeFilename(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const v = String(raw)
  if (v.length === 0 || v.length > 256) return null
  if (v === '.' || v === '..') return null
  if (v.includes('/') || v.includes('\\') || v.includes('\0')) return null
  // Block `..` anywhere — even inside a longer token. Existing real
  // filenames don't contain `..`; rejecting it kills the traversal vector
  // without affecting legitimate names.
  if (v.includes('..')) return null
  return v
}

/** Internally-generated job ids. Two producers flow through here:
 *   • /api/run-algorithms uses "<counter>-<timestamp>" (digits + dash)
 *   • /api/run-demucs (stems_server.py) uses uuid.uuid4().hex[:12] (hex)
 *  Accept either shape. Strict allowlist still blocks `/`, `\`, `..`, `\0`. */
function safeJobId(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const v = String(raw)
  if (v.length === 0 || v.length > 64) return null
  if (!/^[A-Za-z0-9_-]+$/.test(v)) return null
  return v
}

/** Decode + validate in one step. Returns null on URIError (malformed `%`)
 *  or on validation failure. Replaces the bare `decodeURIComponent(...)`
 *  pattern that historically 500-ed on a stray `%` and traversed on `%2F`. */
function decodeSegment(raw: string, kind: 'slug' | 'filename' | 'jobId' = 'slug'): string | null {
  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { return null }
  if (kind === 'filename') return safeFilename(decoded)
  if (kind === 'jobId') return safeJobId(decoded)
  return safeSlug(decoded)
}

function send400BadSegment(res: http.ServerResponse, what: string): void {
  res.statusCode = 400
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.end(JSON.stringify({ error: `invalid ${what}` }))
}

/** Upfront Content-Length cap. Use at the entry of POST handlers that
 *  buffer the whole body into memory. Trusts the client-declared header,
 *  which is fine for the "stop accidental / malicious huge JSON" use case
 *  — a deliberate attacker can lie, but they still pay the bandwidth cost
 *  and the route's downstream parsers will reject malformed bodies. For
 *  routes that stream to disk (audio upload), do their own per-chunk
 *  accounting instead.
 *
 *  Returns true if the response has been sent (caller should return). */
function rejectIfBodyTooLarge(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBytes: number,
): boolean {
  const declared = parseInt(req.headers['content-length'] ?? '', 10)
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.statusCode = 413
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.end(JSON.stringify({ error: 'request body too large', maxBytes }))
    return true
  }
  return false
}

// Default body caps. Annotations / song-info / layers / algo-clusters are
// small JSON docs — 4 MB is generous (the Python side caps at the same).
// Algorithm-run option bodies are tiny (a list of algorithm ids) — 64 KB
// is plenty.
const MAX_JSON_BODY = 4 * 1024 * 1024
const MAX_OPTIONS_BODY = 64 * 1024

// ─── Multi-annotator storage helpers ────────────────────────────────────────
// Annotations are scoped per annotator: `<baseDir>/<annotator_id>/<slug>.json`.

const ANNOTATOR_ID_RE = /^[a-z0-9._@+\-]+$/

function sanitizeAnnotatorId(raw: string | string[] | undefined | null): string | null {
  if (raw == null) return null
  const v = (Array.isArray(raw) ? raw[0] : raw).trim().toLowerCase()
  if (!v || v === '.' || v === '..') return null
  if (v.includes('/') || v.includes('\\') || v.includes('..')) return null
  if (!ANNOTATOR_ID_RE.test(v)) return null
  return v
}

function readAnnotatorIdFromCookie(req: http.IncomingMessage): string | null {
  const raw = req.headers.cookie
  if (typeof raw !== 'string' || raw.length === 0) return null
  // Manual parse — keeps the server free of a `cookie` npm dep. Cookies are
  // separated by `; `; the value may be URL-encoded (signIn writes it that
  // way so emails with `@` are safe).
  for (const pair of raw.split(';')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    if (pair.slice(0, eq).trim() !== 'annotator_id') continue
    try { return sanitizeAnnotatorId(decodeURIComponent(pair.slice(eq + 1).trim())) }
    catch { return null }
  }
  return null
}

// Identification falls back from header → cookie. Mutating endpoints (upload,
// annotation writes, delete) reach this via fetch() and always set the
// X-Annotator-Id header. Static-asset routes like /audio/<file> are loaded
// by the browser without custom headers, so the cookie is what identifies
// the signed-in user there.
function readAnnotatorIdFromReq(req: http.IncomingMessage): string | null {
  const fromHeader = sanitizeAnnotatorId(req.headers['x-annotator-id'] as string | string[] | undefined)
  if (fromHeader) return fromHeader
  return readAnnotatorIdFromCookie(req)
}

// Resolve an annotation file within a single corpus base dir. The caller picks
// the base dir based on whether the request is team-corpus (data/) or
// demo-corpus (data-default/) — there is no cross-corpus fallback. See
// corpusBaseFor() / the team-vs-demo split in this file.
function resolveAnnotationFile(baseDir: string, annotatorId: string, slug: string): {
  filePath: string;
  exists: boolean;
} {
  // Support shared-corpus mode: annotations live at <baseDir>/<slug>.json
  const cfg = readDatasetConfigSafe()
  const shared = !!cfg?.sharedCorpus
  if (shared) {
    const sharedPath = path.join(baseDir, `${slug}.json`)
    return { filePath: sharedPath, exists: fs.existsSync(sharedPath) }
  }

  const own = path.join(baseDir, annotatorId, `${slug}.json`)
  return { filePath: own, exists: fs.existsSync(own) }
}

function ownAnnotationPath(baseDir: string, annotatorId: string, slug: string): string {
  const cfg = readDatasetConfigSafe()
  if (cfg?.sharedCorpus) return path.join(baseDir, `${slug}.json`)
  return path.join(baseDir, annotatorId, `${slug}.json`)
}

/** List subdirectories under baseDir that look like annotator buckets. */
function listAnnotatorDirs(baseDir: string): string[] {
  if (!fs.existsSync(baseDir)) return []
  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => ANNOTATOR_ID_RE.test(n))
}

/** Read every annotation file owned by `annotatorId` within a single corpus
 * base dir. Returns slug → file path. Caller picks the base dir based on
 * team/demo corpus selection — there is no cross-corpus merge.
 */
function listOwnAnnotationFiles(baseDir: string, annotatorId: string): Record<string, string> {
  const out: Record<string, string> = {}
  const cfg = readDatasetConfigSafe()
  const shared = !!cfg?.sharedCorpus
  const ownDir = shared ? baseDir : path.join(baseDir, annotatorId)
  if (fs.existsSync(ownDir)) {
    for (const f of fs.readdirSync(ownDir)) {
      if (!f.endsWith('.json')) continue
      out[f.slice(0, -5)] = path.join(ownDir, f)
    }
  }
  return out
}

function send401MissingAnnotator(res: http.ServerResponse): void {
  res.statusCode = 401
  res.setHeader('Content-Type', 'application/json')
  res.end('{"error":"missing or invalid X-Annotator-Id header"}')
}

function send403NotAdmin(res: http.ServerResponse): void {
  res.statusCode = 403
  res.setHeader('Content-Type', 'application/json')
  res.end('{"error":"admin required"}')
}

function send403NotOnTeam(res: http.ServerResponse): void {
  res.statusCode = 403
  res.setHeader('Content-Type', 'application/json')
  res.end('{"error":"team membership required for this song"}')
}

// Read dataset-config.json on every check. The file is tiny and edits are
// rare, so re-reading avoids a stale-cache class of bugs when an admin
// promotes/demotes someone mid-session.
type AccessTier = 'admin' | 'researcher' | 'team'
interface PersonEntry { tier: AccessTier; invitedAt?: string; invitedBy?: string }
interface DatasetCfg {
  adminEmails?: string[];
  teamEmails?: string[];
  peopleByEmail?: Record<string, PersonEntry>;
  [k: string]: unknown;
}
function readDatasetConfigSafe(): DatasetCfg | null {
  try {
    if (!fs.existsSync(DATA_FILES.datasetConfig)) return null
    return JSON.parse(fs.readFileSync(DATA_FILES.datasetConfig, 'utf-8')) as DatasetCfg
  } catch { return null }
}

/** Resolve the effective tier for an annotator id. Mirrors
 *  tierForAnnotator() in types/datasetConfig.ts — see there for the full
 *  resolution order. Returns null for public users. */
function tierForId(annotatorId: string | null, cfg: DatasetCfg | null): AccessTier | null {
  if (!annotatorId) return null
  // The synthetic demo id is always public, regardless of bootstrap state —
  // otherwise on a fresh clone (no dataset-config.json) the bootstrap branch
  // below would promote demo-anonymous to admin and route demo visitors at
  // data/ instead of data-default/, hiding the shipped CC0 seed songs.
  // Mirrors DEMO_ANNOTATOR_ID in web-app/src/state/demoFlag.ts.
  if (annotatorId === 'demo-anonymous') return null
  if (cfg?.peopleByEmail) {
    const entry = cfg.peopleByEmail[annotatorId]
    if (entry) return entry.tier
    if (Object.keys(cfg.peopleByEmail).length > 0) return null
  }
  if (cfg?.adminEmails && cfg.adminEmails.length > 0) {
    if (cfg.adminEmails.includes(annotatorId)) return 'admin'
  }
  if (cfg?.teamEmails && cfg.teamEmails.includes(annotatorId)) return 'team'
  const hasAdmin = !!cfg?.adminEmails && cfg.adminEmails.length > 0
  const hasTeam = !!cfg?.teamEmails && cfg.teamEmails.length > 0
  const hasPeople = !!cfg?.peopleByEmail && Object.keys(cfg.peopleByEmail).length > 0
  if (!hasAdmin && !hasTeam && !hasPeople) return 'admin' // bootstrap
  return null
}

/** Does this annotator have *member-management* privileges? Admin only. */
function isAdminForReq(req: http.IncomingMessage): { isAdmin: boolean; annotatorId: string | null } {
  const annotatorId = readAnnotatorIdFromReq(req)
  if (!annotatorId) return { isAdmin: false, annotatorId: null }
  return { isAdmin: tierForId(annotatorId, readDatasetConfigSafe()) === 'admin', annotatorId }
}

/** Does this annotator have researcher-or-higher privileges? Used by gates
 *  that grant cross-annotator read access, full-corpus export, and song
 *  upload/delete — i.e. everything that's *not* member management. */
function isResearcherOrAdminForReq(req: http.IncomingMessage): { ok: boolean; tier: AccessTier | null; annotatorId: string | null } {
  const annotatorId = readAnnotatorIdFromReq(req)
  if (!annotatorId) return { ok: false, tier: null, annotatorId: null }
  const tier = tierForId(annotatorId, readDatasetConfigSafe())
  return { ok: tier === 'admin' || tier === 'researcher', tier, annotatorId }
}

/** Mirror of isAnnotatorOnTeam. Admins / researchers / team members are all
 *  on-team. Only public users are limited to the data-default/ corpus. */
function isOnTeamForReq(req: http.IncomingMessage): {
  isOnTeam: boolean; isAdmin: boolean; annotatorId: string | null
} {
  const annotatorId = readAnnotatorIdFromReq(req)
  if (!annotatorId) return { isOnTeam: false, isAdmin: false, annotatorId: null }
  const tier = tierForId(annotatorId, readDatasetConfigSafe())
  return { isOnTeam: tier !== null, isAdmin: tier === 'admin', annotatorId }
}

/** Pulls legacy adminEmails/teamEmails into a fresh peopleByEmail map.
 *  Idempotent — entries already in peopleByEmail win. Used the first time
 *  an admin mutates the people list so we don't silently demote anyone who
 *  was on the legacy lists. */
function seedPeopleByEmail(cfg: DatasetCfg): Record<string, PersonEntry> {
  const out: Record<string, PersonEntry> = { ...(cfg.peopleByEmail ?? {}) }
  for (const email of cfg.adminEmails ?? []) {
    if (!out[email]) out[email] = { tier: 'admin' }
  }
  for (const email of cfg.teamEmails ?? []) {
    if (!out[email]) out[email] = { tier: 'team' }
  }
  return out
}

/** Write `peopleByEmail` and the derived legacy `adminEmails`/`teamEmails`
 *  arrays in one shot. Researchers are intentionally NOT folded into
 *  adminEmails — any code path still gating on the legacy array should
 *  reject them (member-management surfaces). */
function writePeopleByEmail(cfg: DatasetCfg, people: Record<string, PersonEntry>): DatasetCfg {
  const next: DatasetCfg = { ...cfg, peopleByEmail: people }
  const adminEmails: string[] = []
  const teamEmails: string[] = []
  for (const [email, entry] of Object.entries(people)) {
    if (entry.tier === 'admin') adminEmails.push(email)
    else if (entry.tier === 'team') teamEmails.push(email)
  }
  next.adminEmails = adminEmails.length > 0 ? adminEmails : undefined
  next.teamEmails  = teamEmails.length  > 0 ? teamEmails  : undefined
  return next
}

// ─── Shared on-disk helpers ───────────────────────────────────────────────────
// Used by both the storage-stats plugin (for scoped /api/storage DELETE) and the
// songs-admin plugin (for the EVERYTHING scope of /api/songs DELETE).

const STEMS_DIR    = path.resolve(__dirname, 'public/stems')
const ANALYSIS_DIR = DATA_DIRS.analysis

/** Which corpus (team's real data/ tree or the shipped demo data-default/
 *  tree) does this request belong to? Returns the set of base dirs that any
 *  read should be limited to — there is no cross-corpus fallback. Team /
 *  researcher / admin tiers see the real corpus; everyone else (public,
 *  unauthenticated, and the in-browser demo identity) sees data-default/. */
type CorpusBase = {
  songs: string;
  songInfo: string;
  manualAnnotations: string;
  eyeAnnotations: string;
  autoGuessAnnotations: string;
  stems: string;
}
const TEAM_CORPUS: CorpusBase = {
  songs: DATA_DIRS.songs,
  songInfo: DATA_DIRS.songInfo,
  manualAnnotations: DATA_DIRS.manualAnnotations,
  eyeAnnotations: DATA_DIRS.eyeAnnotations,
  autoGuessAnnotations: DATA_DIRS.autoGuessAnnotations,
  stems: STEMS_DIR,
}
const DEMO_CORPUS: CorpusBase = {
  songs: DEFAULT_DATA_DIRS.songs,
  songInfo: DEFAULT_DATA_DIRS.songInfo,
  manualAnnotations: DEFAULT_DATA_DIRS.manualAnnotations,
  eyeAnnotations: DEFAULT_DATA_DIRS.eyeAnnotations,
  autoGuessAnnotations: DEFAULT_DATA_DIRS.autoGuessAnnotations,
  stems: DEFAULT_DATA_DIRS.stems,
}
function corpusForReq(req: http.IncomingMessage): CorpusBase {
  return isOnTeamForReq(req).isOnTeam ? TEAM_CORPUS : DEMO_CORPUS
}

function rmIfExists(p: string) {
  try {
    if (!fs.existsSync(p)) return
    if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true })
    else fs.rmSync(p, { force: true })
  } catch { /* swallow — best-effort */ }
}

// Demucs stems live under public/stems/<fileStem>/ — outside the algo-output tree.
function clearStemsForSong(file: string) {
  const fileStem = file.replace(/\.[^.]+$/, '')
  rmIfExists(path.join(STEMS_DIR, fileStem))
}

// Wipe regenerable caches for one song. Includes stems. Annotations + audio
// are untouched. Used by the ALGOS scope (and the EVERYTHING scope, which
// additionally clears audio + annotations).
function clearCacheForSong(slug: string, file: string) {
  clearStemsForSong(file)
  rmIfExists(path.join(ANALYSIS_DIR, slug))
  rmIfExists(path.join(DATA_DIRS.msaf, slug))
  rmIfExists(path.join(DATA_DIRS.bpmDetections, `${slug}.json`))
  rmIfExists(path.join(DATA_DIRS.algoClusters, `${slug}.json`))
  rmIfExists(path.join(DATA_DIRS.mirFeatures, `${slug}.json`))
  // Custom-script algorithm-mode results live at
  // data/algorithm-outputs/custom/<script>/<slug>.json — clear the slug file
  // from every script subdir without nuking the script dirs themselves.
  if (fs.existsSync(DATA_DIRS.customResults)) {
    try {
      for (const script of fs.readdirSync(DATA_DIRS.customResults)) {
        const scriptDir = path.join(DATA_DIRS.customResults, script)
        try { if (!fs.statSync(scriptDir).isDirectory()) continue } catch { continue }
        rmIfExists(path.join(scriptDir, `${slug}.json`))
      }
    } catch { /* ignore */ }
  }
}

// Remove every annotator's annotation files for a slug across manual/eye/auto-guess
// and per-script custom annotations, plus the shared song-info file. Only the
// user-writable tree under data/ is touched — data-default/ seeds stay intact.
function clearAnnotationsForSong(slug: string) {
  const annotationBases = [
    DATA_DIRS.manualAnnotations,
    DATA_DIRS.eyeAnnotations,
    DATA_DIRS.autoGuessAnnotations,
  ]
  for (const base of annotationBases) {
    if (!fs.existsSync(base)) continue
    try {
      for (const annotator of fs.readdirSync(base)) {
        rmIfExists(path.join(base, annotator, `${slug}.json`))
      }
    } catch { /* ignore */ }
  }
  // Custom-script annotations: data/annotations/custom/<script>/<annotator>/<slug>.json
  const customRoot = DATA_DIRS.customAnnotations
  if (fs.existsSync(customRoot)) {
    try {
      for (const script of fs.readdirSync(customRoot)) {
        const scriptDir = path.join(customRoot, script)
        if (!fs.statSync(scriptDir).isDirectory()) continue
        for (const annotator of fs.readdirSync(scriptDir)) {
          rmIfExists(path.join(scriptDir, annotator, `${slug}.json`))
        }
      }
    } catch { /* ignore */ }
  }
  // song-info is a single shared file per slug, no annotator subdir.
  rmIfExists(path.join(DATA_DIRS.songInfo, `${slug}.json`))
}

// Serve audio files at /audio/<filename>. Team requests resolve under
// data/songs/*/; demo / public requests resolve under data-default/songs/*/.
// Strict separation — no cross-corpus fallback in either direction.
function serveSongAudio(): Plugin {
  const mimeMap: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
  }

  // Containment check: the resolved candidate must live under baseDir even
  // after path.resolve normalises any `..` tokens the filename might have
  // smuggled in. Belt-and-braces — safeFilename() already rejects `..` and
  // separators, but realpath-based confinement is the standard defense for
  // static file servers.
  function findInDir(baseDir: string, filename: string): string | null {
    if (!fs.existsSync(baseDir)) return null
    let baseReal: string
    try { baseReal = fs.realpathSync(baseDir) } catch { return null }
    for (const slug of fs.readdirSync(baseDir)) {
      const candidate = path.resolve(baseDir, slug, filename)
      if (!candidate.startsWith(baseReal + path.sep)) continue
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    }
    return null
  }

  return {
    name: 'serve-song-audio',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/audio/')) return next()
        // Strip any query string ("/audio/foo.mp3?t=123" → "foo.mp3").
        const rawPath = req.url.slice('/audio/'.length).split('?')[0]
        const filename = decodeSegment(rawPath, 'filename')
        if (!filename) return send400BadSegment(res, 'filename')

        // Strict per-request corpus: team identities resolve under data/songs/,
        // demo / public identities resolve under data-default/songs/. No
        // cross-corpus fallback — hand-crafted /audio/<file> URLs for the
        // other corpus return 404 rather than leaking bytes.
        const corpus = corpusForReq(req)
        const resolvedFile = findInDir(corpus.songs, filename)
        if (!resolvedFile) return next()

        const ext  = path.extname(resolvedFile).toLowerCase()
        const mime = mimeMap[ext] ?? 'application/octet-stream'
        const stat = fs.statSync(resolvedFile)
        const total = stat.size
        const range = req.headers.range

        res.setHeader('Content-Type', mime)
        res.setHeader('Accept-Ranges', 'bytes')

        // Range requests: WaveSurfer / browser audio elements often issue
        // these for seek-without-redownload. Honour them so playback works
        // for users with strict media-session policies.
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range)
          if (match) {
            const start = match[1] ? parseInt(match[1], 10) : 0
            const end   = match[2] ? parseInt(match[2], 10) : total - 1
            if (start <= end && end < total) {
              res.statusCode = 206
              res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
              res.setHeader('Content-Length', String(end - start + 1))
              fs.createReadStream(resolvedFile, { start, end }).pipe(res)
              return
            }
          }
          // Malformed / unsatisfiable range → 416.
          res.statusCode = 416
          res.setHeader('Content-Range', `bytes */${total}`)
          res.end()
          return
        }

        // Plain GET: declare full size so progressive decoders know when the
        // download is complete (avoids chunked-without-length ambiguity).
        res.setHeader('Content-Length', String(total))
        fs.createReadStream(resolvedFile).pipe(res)
      })
    },
  }
}

// Serve Demucs stems at /stems/<slug>/<file>. Strict per-request corpus:
//   - team identities: web-app/public/stems/<slug>/<file>  — locally-generated
//                                                            stems (full-res
//                                                            WAVs written by
//                                                            the Demucs
//                                                            separator).
//   - demo / public:   data-default/stems/<slug>/<file>    — shipped seed
//                                                            stems for the CC0
//                                                            demo tracks
//                                                            (192 kbps MP3,
//                                                            baked into the
//                                                            docker image).
// No cross-corpus fallback — the URL prefix is taken over from Vite's default
// public/ serving so even hand-crafted /stems/ URLs for the other corpus
// return 404.
function serveStems(): Plugin {
  const mimeMap: Record<string, string> = {
    '.mp3':  'audio/mpeg',
    '.wav':  'audio/wav',
    '.flac': 'audio/flac',
    '.ogg':  'audio/ogg',
    '.m4a':  'audio/mp4',
    '.json': 'application/json',
  }

  // Multi-segment paths can't use safeFilename directly (the second
  // segment is the stem file, the first is the song folder). Defense is
  // realpath containment: resolve the requested path and only accept it if
  // it still lives under baseDir after `..` normalisation and symlink
  // following.
  function resolveStem(baseDir: string, subPath: string): string | null {
    let baseReal: string
    try { baseReal = fs.realpathSync(baseDir) } catch { return null }
    const candidate = path.resolve(baseDir, subPath)
    if (!candidate.startsWith(baseReal + path.sep)) return null
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    return null
  }

  return {
    name: 'serve-stems',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/stems/')) return next()
        const rawPath = req.url.slice('/stems/'.length).split('?')[0]
        let subPath: string
        try { subPath = decodeURIComponent(rawPath) } catch { res.statusCode = 400; res.end(); return }
        if (subPath.includes('\0')) { res.statusCode = 400; res.end(); return }
        const corpus = corpusForReq(req)
        const resolved = resolveStem(corpus.stems, subPath)
        if (!resolved) return next()

        const ext  = path.extname(resolved).toLowerCase()
        const mime = mimeMap[ext] ?? 'application/octet-stream'
        const stat = fs.statSync(resolved)
        const total = stat.size

        res.setHeader('Content-Type', mime)
        res.setHeader('Accept-Ranges', 'bytes')

        // Honour range requests so WaveSurfer / browser audio elements can
        // seek without re-downloading the full stem.
        const range = req.headers.range
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range)
          if (match) {
            const start = match[1] ? parseInt(match[1], 10) : 0
            const end   = match[2] ? parseInt(match[2], 10) : total - 1
            if (start <= end && end < total) {
              res.statusCode = 206
              res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
              res.setHeader('Content-Length', String(end - start + 1))
              fs.createReadStream(resolved, { start, end }).pipe(res)
              return
            }
          }
          res.statusCode = 416
          res.setHeader('Content-Range', `bytes */${total}`)
          res.end()
          return
        }

        res.setHeader('Content-Length', String(total))
        fs.createReadStream(resolved).pipe(res)
      })
    },
  }
}

// Serve and persist manual annotations at /api/manual-annotations
// GET    /api/manual-annotations           → list all { slug, reviewed }[]
// GET    /api/manual-annotations/:slug     → read one annotation (200 + null if absent)
// POST   /api/manual-annotations/:slug     → write one annotation to disk
// DELETE /api/manual-annotations/:slug     → delete one annotation file
function serveManualAnnotations(): Plugin {
  // Create the team-corpus manual dir up-front; the demo corpus lives in the
  // baked-in data-default/ tree and must already exist (read-only).
  if (!fs.existsSync(DATA_DIRS.manualAnnotations)) fs.mkdirSync(DATA_DIRS.manualAnnotations, { recursive: true })

  return {
    name: 'manual-annotations',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/manual-annotations')) return next()

        const suffix = req.url.slice('/api/manual-annotations'.length) // '' | '/' | '/:slug'
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        const annotatorId = readAnnotatorIdFromReq(req)
        if (!annotatorId) return send401MissingAnnotator(res)

        const corpus = corpusForReq(req)
        const dir = corpus.manualAnnotations
        const eyeDir = corpus.eyeAnnotations
        const autoGuessDir = corpus.autoGuessAnnotations

        // LIST  GET /api/manual-annotations  or  /api/manual-annotations/
        if (req.method === 'GET' && (suffix === '' || suffix === '/')) {
          const visibleManual = listOwnAnnotationFiles(dir, annotatorId)
          const statuses = Object.entries(visibleManual).map(([slug, filePath]) => {
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
              const eyeFile = resolveAnnotationFile(eyeDir, annotatorId, slug)
              let eyeStatus: string | null = null
              let eyeSectionsCount = 0
              if (eyeFile.exists) {
                try {
                  const eyeData = JSON.parse(fs.readFileSync(eyeFile.filePath, 'utf-8'))
                  eyeStatus = eyeData.eye_status ?? null
                  eyeSectionsCount = Array.isArray(eyeData.sections) ? eyeData.sections.length : 0
                } catch { /* ignore */ }
              }
              const autoGuessFile = resolveAnnotationFile(autoGuessDir, annotatorId, slug)
              let autoGuessStatus: string | null = null
              let autoGuessPointsCount = 0
              if (autoGuessFile.exists) {
                try {
                  const autoGuessData = JSON.parse(fs.readFileSync(autoGuessFile.filePath, 'utf-8'))
                  autoGuessStatus = autoGuessData.auto_guess_status ?? null
                  autoGuessPointsCount = Array.isArray(autoGuessData.points) ? autoGuessData.points.length : 0
                } catch { /* ignore */ }
              }
              return {
                slug,
                reviewed: !!data.reviewed,
                ready_for_review: !!data.ready_for_review,
                genre: data.genre ?? null,
                eye_status: eyeStatus,
                auto_guess_status: autoGuessStatus,
                // Item counts so the sidebar popover applies the same
                // hasItems × status rule as the editor's StatusPill.
                sections_count: Array.isArray(data.sections) ? data.sections.length : 0,
                eye_sections_count: eyeSectionsCount,
                auto_guess_points_count: autoGuessPointsCount,
              }
            } catch {
              return { slug, reviewed: false, ready_for_review: false, eye_status: null, sections_count: 0, eye_sections_count: 0, auto_guess_points_count: 0 }
            }
          })
          res.end(JSON.stringify(statuses))
          return
        }

        // Single annotation  /api/manual-annotations/:slug
        const match = suffix.match(/^\/([^/]+)$/)
        if (!match) return next()
        const slug = decodeSegment(match[1])
        if (!slug) return send400BadSegment(res, 'slug')

        if (req.method === 'GET') {
          const resolved = resolveAnnotationFile(dir, annotatorId, slug)
          if (resolved.exists) {
            res.end(fs.readFileSync(resolved.filePath, 'utf-8'))
          } else {
            // 200 + null body, not 404: "no annotation yet for this song" is a
            // normal lookup result, not an error. Returning 404 turns every
            // first-time-load into red noise in the browser console.
            res.end('null')
          }
          return
        }

        // Writes (POST/DELETE) require team membership. Demo / public
        // identities keep their work in localStorage (see demoStorage.ts) and
        // never POST to the server, so a non-team POST here is invalid.
        if (req.method === 'POST' || req.method === 'DELETE') {
          const { isOnTeam } = isOnTeamForReq(req)
          if (!isOnTeam) return send403NotOnTeam(res)
        }

        if (req.method === 'POST') {
          if (rejectIfBodyTooLarge(req, res, MAX_JSON_BODY)) return
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString() })
          req.on('end', () => {
            try {
              const data = JSON.parse(body)
              const ownPath = ownAnnotationPath(dir, annotatorId, slug)
              const ownDir = path.dirname(ownPath)
              if (!fs.existsSync(ownDir)) fs.mkdirSync(ownDir, { recursive: true })
              if (data.time_spent_seconds === undefined && fs.existsSync(ownPath)) {
                try {
                  const prev = JSON.parse(fs.readFileSync(ownPath, 'utf-8'))
                  if (typeof prev?.time_spent_seconds === 'number') {
                    data.time_spent_seconds = prev.time_spent_seconds
                  }
                } catch { /* ignore */ }
              }
              fs.writeFileSync(ownPath, JSON.stringify(data, null, 2), 'utf-8')
              res.end('{"ok":true}')
            } catch {
              res.statusCode = 400
              res.end('{"error":"invalid json"}')
            }
          })
          return
        }

        if (req.method === 'DELETE') {
          const ownPath = ownAnnotationPath(dir, annotatorId, slug)
          if (fs.existsSync(ownPath)) fs.unlinkSync(ownPath)
          res.end('{"ok":true}')
          return
        }

        next()
      })
    },
  }
}

// Serve and persist auto-guess annotations at /api/auto-guess-annotations
// GET    /api/auto-guess-annotations/:slug     → read one (200 + null if absent)
// POST   /api/auto-guess-annotations/:slug     → write one
// DELETE /api/auto-guess-annotations/:slug     → delete
function serveAutoGuessAnnotations(): Plugin {
  if (!fs.existsSync(DATA_DIRS.autoGuessAnnotations)) fs.mkdirSync(DATA_DIRS.autoGuessAnnotations, { recursive: true })

  return {
    name: 'auto-guess-annotations',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/auto-guess-annotations')) return next()

        const suffix = req.url.slice('/api/auto-guess-annotations'.length)
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        const annotatorId = readAnnotatorIdFromReq(req)
        if (!annotatorId) return send401MissingAnnotator(res)

        const dir = corpusForReq(req).autoGuessAnnotations

        const match = suffix.match(/^\/([^/]+)$/)
        if (!match) return next()
        const slug = decodeSegment(match[1])
        if (!slug) return send400BadSegment(res, 'slug')

        if (req.method === 'GET') {
          const resolved = resolveAnnotationFile(dir, annotatorId, slug)
          if (resolved.exists) {
            res.end(fs.readFileSync(resolved.filePath, 'utf-8'))
          } else {
            // 200 + null body: see /api/manual-annotations comment above.
            res.end('null')
          }
          return
        }

        if (req.method === 'POST' || req.method === 'DELETE') {
          const { isOnTeam } = isOnTeamForReq(req)
          if (!isOnTeam) return send403NotOnTeam(res)
        }

        if (req.method === 'POST') {
          if (rejectIfBodyTooLarge(req, res, MAX_JSON_BODY)) return
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString() })
          req.on('end', () => {
            try {
              const data = JSON.parse(body)
              const ownPath = ownAnnotationPath(dir, annotatorId, slug)
              const ownDir = path.dirname(ownPath)
              if (!fs.existsSync(ownDir)) fs.mkdirSync(ownDir, { recursive: true })
              if (data.time_spent_seconds === undefined && fs.existsSync(ownPath)) {
                try {
                  const prev = JSON.parse(fs.readFileSync(ownPath, 'utf-8'))
                  if (typeof prev?.time_spent_seconds === 'number') {
                    data.time_spent_seconds = prev.time_spent_seconds
                  }
                } catch { /* ignore */ }
              }
              fs.writeFileSync(ownPath, JSON.stringify(data, null, 2), 'utf-8')
              res.end('{"ok":true}')
            } catch {
              res.statusCode = 400
              res.end('{"error":"invalid json"}')
            }
          })
          return
        }

        if (req.method === 'DELETE') {
          const ownPath = ownAnnotationPath(dir, annotatorId, slug)
          if (fs.existsSync(ownPath)) fs.unlinkSync(ownPath)
          res.end('{"ok":true}')
          return
        }

        next()
      })
    },
  }
}

// ─── Manifest (dynamic) ──────────────────────────────────────────────────────
// /analysis/manifest.json is generated on demand by scanning exactly one of
// data/songs/ (team requests) or data-default/songs/ (demo / public requests).
// Strict per-corpus separation — the two trees are never merged.

type ManifestEntry = {
  id: string
  name: string
  file: string
  url: string
  hasAnalysis: boolean
}

function deriveDisplayName(songInfoDir: string, slug: string, filenameStem: string): string {
  // Prefer "Artist — Title" from <corpus>/song-info/<slug>.json when present
  // (so shipped tracks display human names instead of the dash-split filename).
  try {
    const sip = path.join(songInfoDir, `${slug}.json`)
    if (fs.existsSync(sip)) {
      const meta = JSON.parse(fs.readFileSync(sip, 'utf-8')) as { artist?: string; title?: string }
      if (meta.artist && meta.title) return `${meta.artist} — ${meta.title}`
      if (meta.title) return meta.title
    }
  } catch { /* fall through to filename heuristic */ }
  if (filenameStem) return filenameStem.replace(/\s*-\s*/g, ' — ')
  return slug
}

function buildManifest(corpus: CorpusBase): ManifestEntry[] {
  const audioExt = /\.(mp3|wav|flac|ogg|m4a)$/i
  const bySlug: Record<string, ManifestEntry> = {}

  const base = corpus.songs
  if (fs.existsSync(base)) {
    for (const slug of fs.readdirSync(base)) {
      const slugDir = path.join(base, slug)
      try { if (!fs.statSync(slugDir).isDirectory()) continue } catch { continue }
      const audioFile = fs.readdirSync(slugDir).find((f) => audioExt.test(f))
      if (!audioFile) continue
      const stem = audioFile.slice(0, audioFile.length - path.extname(audioFile).length)
      bySlug[slug] = {
        id: slug,
        name: deriveDisplayName(corpus.songInfo, slug, stem),
        file: audioFile,
        url: `/audio/${audioFile}`,
        hasAnalysis: fs.existsSync(path.join(ANALYSIS_DIR, slug)),
      }
    }
  }
  return Object.values(bySlug).sort((a, b) => a.name.localeCompare(b.name))
}

function serveManifest(): Plugin {
  return {
    name: 'manifest',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/analysis/manifest.json')) return next()
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        const entries = buildManifest(corpusForReq(req))
        res.end(JSON.stringify(entries))
      })
    },
  }
}

// Serve per-song analysis JSONs at /analysis/<slug>/<file>.json. The files are
// written by the algorithm runner into data/algorithm-outputs/analysis/<slug>/
// (= ANALYSIS_DIR), which sits outside web-app/public/ so Vite's default static
// serving can't reach them — without this middleware every cached MSAF / allin1
// / Ruptures JSON falls through to the SPA index.html and the inspector's
// algoOptions stays empty after a successful run.
function serveAnalysis(): Plugin {
  return {
    name: 'analysis-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/analysis/')) return next()
        if (req.method !== 'GET') return next()
        // /analysis/manifest.json has its own handler.
        if (req.url.startsWith('/analysis/manifest.json')) return next()
        const rawPath = req.url.slice('/analysis/'.length).split('?')[0]
        let subPath: string
        try { subPath = decodeURIComponent(rawPath) } catch { res.statusCode = 400; res.end(); return }
        if (subPath.includes('\0')) { res.statusCode = 400; res.end(); return }
        // Realpath containment — defends against `..`, weird encodings, and
        // symlinks pointing outside ANALYSIS_DIR.
        let baseReal: string
        try { baseReal = fs.realpathSync(ANALYSIS_DIR) } catch { return next() }
        const resolved = path.resolve(ANALYSIS_DIR, subPath)
        if (!resolved.startsWith(baseReal + path.sep)) { res.statusCode = 400; res.end(); return }
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        fs.createReadStream(resolved).pipe(res)
      })
    },
  }
}

// Upload a song to data/songs/<slug>/. Manifest is derived from disk so the
// next GET /analysis/manifest.json automatically reflects the new entry.
// POST /api/upload-song?name=<filename>  body: raw audio bytes
function serveUploadSong(): Plugin {
  const songsDir = DATA_DIRS.songs

  // URL-safe slug: lowercase a-z0-9, underscore as the only separator.
  // Everything else (spaces, parens, ampersands, em-dashes, apostrophes,
  // accented chars) collapses to an underscore. Existing hyphen-slugged
  // songs on disk are unaffected — this only governs new uploads.
  function slugify(stem: string): string {
    return stem
      .toLowerCase()
      .replace(/'/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  }

  return {
    name: 'upload-song',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'POST' || !req.url?.startsWith('/api/upload-song')) return next()

        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        // Admins and researchers can grow the corpus. Team members get full
        // read access but uploading stays gated so the public-facing dataset
        // remains curated. (Researcher is the "trusted collaborator" tier.)
        const { ok, annotatorId } = isResearcherOrAdminForReq(req)
        if (!annotatorId) return send401MissingAnnotator(res)
        if (!ok) return send403NotAdmin(res)

        const urlObj   = new URL(req.url!, `http://localhost`)
        const filename = decodeSegment(urlObj.searchParams.get('name') ?? '', 'filename')
        if (!filename) {
          res.statusCode = 400; res.end('{"error":"invalid or missing ?name= param"}'); return
        }

        const ext = path.extname(filename).toLowerCase()
        if (!['.mp3', '.wav', '.flac', '.ogg', '.m4a'].includes(ext)) {
          res.statusCode = 400; res.end('{"error":"unsupported audio format"}'); return
        }

        const stem = filename.slice(0, filename.length - ext.length)
        const slug = slugify(stem)
        const songDir = path.join(songsDir, slug)
        fs.mkdirSync(songDir, { recursive: true })

        // Store as <slug><ext> rather than the raw uploaded filename. Raw names
        // can contain spaces, parens, ampersands, and em-dashes (e.g. "Alex
        // Adair \u2014 Make Me Feel Better (Don Diablo & CID Radio Edit).mp3") which
        // turn into malformed /audio/<name> URLs and silently hang WaveSurfer.
        const safeFile = `${slug}${ext}`
        const destPath = path.join(songDir, safeFile)

        // Codespaces' public-port nginx proxy caps request bodies near 100 MB,
        // so larger files arrive as ?chunk=<i>&total=<n> and we append. Chunks
        // must be sent sequentially (the client awaits each response). Single-
        // shot callers (no chunk/total params) take the legacy path: one POST,
        // one write, behaves identically to before.
        const chunkStr = urlObj.searchParams.get('chunk')
        const totalStr = urlObj.searchParams.get('total')
        const chunked  = chunkStr !== null && totalStr !== null
        const chunkIdx = chunked ? parseInt(chunkStr!, 10) : 0
        const total    = chunked ? parseInt(totalStr!, 10) : 1
        if (chunked && (
          !Number.isFinite(chunkIdx) || !Number.isFinite(total) ||
          chunkIdx < 0 || total < 1 || chunkIdx >= total
        )) {
          res.statusCode = 400; res.end('{"error":"invalid chunk/total"}'); return
        }
        const isFirst = chunkIdx === 0
        const isLast  = chunkIdx === total - 1
        const writeStream = fs.createWriteStream(destPath, { flags: isFirst ? 'w' : 'a' })
        req.pipe(writeStream)

        writeStream.on('finish', () => {
          if (!isLast) {
            res.end(JSON.stringify({ ok: true, received: chunkIdx + 1, total }))
            return
          }
          const displayName = stem.replace(/\s*-\s*/g, ' \u2014 ')
          res.end(JSON.stringify({ id: slug, name: displayName, url: `/audio/${safeFile}`, hasAnalysis: false }))
        })

        writeStream.on('error', (err: Error) => {
          res.statusCode = 500
          res.end(JSON.stringify({ error: err.message }))
        })
      })
    },
  }
}

// Upload pre-computed stems for a slug. Mirrors the layout that
// /api/run-demucs/:slug writes — public/stems/<slug>/<stem>.<ext> — so an
// imported dataset's stems are picked up by the existing /stems/* server
// without re-running Demucs.
//
// POST /api/upload-stem/:slug?stem=<name>&ext=<ext>[&chunk=<i>&total=<n>]
//   body: raw audio bytes (chunked or single-shot, same wire shape as upload-song)
// POST /api/upload-stem-manifest/:slug   body: { stems: { name: filename } }
//   finalises the dir by writing manifest.json referencing the uploaded files
function serveUploadStems(): Plugin {
  // Known Demucs stem names. Sticking to this set keeps the manifest schema
  // identical to what the Demucs daemon writes (model: htdemucs).
  const STEM_NAMES = new Set(['drums', 'bass', 'other', 'vocals'])
  const STEM_EXTS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a'])

  return {
    name: 'upload-stems',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'POST') return next()
        const url = req.url ?? ''
        if (!url.startsWith('/api/upload-stem/') && !url.startsWith('/api/upload-stem-manifest/')) return next()

        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        // Same gate as upload-song — researcher or admin can grow the corpus.
        const { ok, annotatorId } = isResearcherOrAdminForReq(req)
        if (!annotatorId) return send401MissingAnnotator(res)
        if (!ok) return send403NotAdmin(res)

        const urlObj = new URL(url, 'http://localhost')

        // Manifest finaliser branch
        if (url.startsWith('/api/upload-stem-manifest/')) {
          const slug = decodeSegment(url.slice('/api/upload-stem-manifest/'.length).split('?')[0])
          if (!slug) {
            res.statusCode = 400; res.end('{"error":"invalid slug"}'); return
          }
          const stemDir = path.join(STEMS_DIR, slug)
          if (!fs.existsSync(stemDir)) {
            res.statusCode = 400; res.end('{"error":"no stems uploaded for slug"}'); return
          }
          if (rejectIfBodyTooLarge(req, res, MAX_JSON_BODY)) return
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString() })
          req.on('end', () => {
            let payload: { stems?: Record<string, string>, audioFile?: string } = {}
            try { payload = body ? JSON.parse(body) : {} } catch { /* tolerate empty/invalid */ }
            // Derive the audio filename — the import flow may not know it
            // because audio uploads happen in parallel; fall back to scanning
            // data/songs/<slug>/ for the canonical <slug>.<ext>.
            let audioFile = payload.audioFile
            if (!audioFile) {
              const songDir = path.join(DATA_DIRS.songs, slug)
              try {
                const found = fs.readdirSync(songDir).find((f) => /\.(mp3|wav|flac|ogg|m4a)$/i.test(f))
                if (found) audioFile = found
              } catch { /* leave undefined */ }
            }
            // If no explicit stem map was supplied, build one from what's on
            // disk now — the import flow can call this after the per-stem
            // uploads without re-listing.
            let stems = payload.stems
            if (!stems || typeof stems !== 'object') {
              stems = {}
              for (const f of fs.readdirSync(stemDir)) {
                const ext = path.extname(f).toLowerCase()
                const name = f.slice(0, f.length - ext.length)
                if (STEM_NAMES.has(name) && STEM_EXTS.has(ext)) {
                  stems[name] = `/stems/${encodeURIComponent(slug)}/${encodeURIComponent(f)}`
                }
              }
            }
            const manifest = {
              model: 'user-uploaded',
              audioFile: audioFile ?? '',
              slug,
              computedAt: Math.floor(Date.now() / 1000),
              elapsedSec: 0,
              stems,
            }
            fs.writeFileSync(path.join(stemDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
            res.end(JSON.stringify({ ok: true, stemCount: Object.keys(stems).length }))
          })
          return
        }

        // Per-stem upload branch
        const slug = decodeSegment(url.slice('/api/upload-stem/'.length).split('?')[0])
        if (!slug) {
          res.statusCode = 400; res.end('{"error":"invalid slug"}'); return
        }
        const stem = (urlObj.searchParams.get('stem') ?? '').toLowerCase()
        if (!STEM_NAMES.has(stem)) {
          res.statusCode = 400; res.end(`{"error":"unknown stem name (expected one of ${[...STEM_NAMES].join(', ')})"}`); return
        }
        const rawExt = (urlObj.searchParams.get('ext') ?? '.wav').toLowerCase()
        const ext = rawExt.startsWith('.') ? rawExt : `.${rawExt}`
        if (!STEM_EXTS.has(ext)) {
          res.statusCode = 400; res.end('{"error":"unsupported stem format"}'); return
        }

        const stemDir = path.join(STEMS_DIR, slug)
        fs.mkdirSync(stemDir, { recursive: true })
        const destPath = path.join(stemDir, `${stem}${ext}`)

        const chunkStr = urlObj.searchParams.get('chunk')
        const totalStr = urlObj.searchParams.get('total')
        const chunked  = chunkStr !== null && totalStr !== null
        const chunkIdx = chunked ? parseInt(chunkStr!, 10) : 0
        const total    = chunked ? parseInt(totalStr!, 10) : 1
        if (chunked && (
          !Number.isFinite(chunkIdx) || !Number.isFinite(total) ||
          chunkIdx < 0 || total < 1 || chunkIdx >= total
        )) {
          res.statusCode = 400; res.end('{"error":"invalid chunk/total"}'); return
        }
        const isFirst = chunkIdx === 0
        const isLast  = chunkIdx === total - 1
        const writeStream = fs.createWriteStream(destPath, { flags: isFirst ? 'w' : 'a' })
        req.pipe(writeStream)
        writeStream.on('finish', () => {
          if (!isLast) {
            res.end(JSON.stringify({ ok: true, received: chunkIdx + 1, total }))
            return
          }
          res.end(JSON.stringify({ ok: true, stem, file: `${stem}${ext}` }))
        })
        writeStream.on('error', (err: Error) => {
          res.statusCode = 500
          res.end(JSON.stringify({ error: err.message }))
        })
      })
    },
  }
}

// DELETE /api/songs/:slug                   → remove data/songs/<slug>/ (audio only)
// DELETE /api/songs/:slug?scope=everything   → also wipe caches + annotations
//                                              from every annotator subdir
// DELETE /api/songs                          → remove every user-owned slug under data/songs/
// DELETE /api/songs?scope=everything         → also wipe caches + every annotator's
//                                              annotations for every slug
// data-default slugs are read-only and unaffected.
// Used by the Dataset Prep workspace and the Settings danger zone. The client
// gates with a typed confirmation (DELETE_SONG / DELETE_ALL / DELETE_ALL_SONGS /
// EVERYTHING) so an accidental fetch can't wipe data.
function serveSongsAdmin(): Plugin {
  const songsDir = DATA_DIRS.songs

  return {
    name: 'songs-admin',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'DELETE' || !req.url?.startsWith('/api/songs')) return next()

        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        // Admins and researchers can prune the corpus. Same tier model as
        // upload — researcher is "trusted collaborator" with full curation.
        const { ok, annotatorId } = isResearcherOrAdminForReq(req)
        if (!annotatorId) return send401MissingAnnotator(res)
        if (!ok) return send403NotAdmin(res)

        const [pathPart, queryStr = ''] = req.url.slice('/api/songs'.length).split('?')
        const query = new URLSearchParams(queryStr)
        const scope = query.get('scope') ?? 'audio'
        if (scope !== 'audio' && scope !== 'everything') {
          res.statusCode = 400
          res.end(JSON.stringify({ error: `invalid scope: ${scope}` }))
          return
        }

        if (pathPart === '' || pathPart === '/') {
          if (!fs.existsSync(songsDir)) { res.end(JSON.stringify({ deleted: 0 })); return }
          const slugs = fs.readdirSync(songsDir).filter((s) => {
            try { return fs.statSync(path.join(songsDir, s)).isDirectory() } catch { return false }
          })
          for (const slug of slugs) {
            const dir = path.join(songsDir, slug)
            // Resolve the audio filename BEFORE removing the dir so the stems
            // helper (keyed by file stem) has something to work with.
            let audioFile: string | null = null
            if (scope === 'everything') {
              try {
                const entries = fs.readdirSync(dir).filter((f) => /\.(mp3|wav|flac|ogg|m4a)$/i.test(f))
                if (entries.length > 0) audioFile = entries[0]
              } catch { /* ignore */ }
            }
            try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ok */ }
            if (scope === 'everything') {
              clearCacheForSong(slug, audioFile ?? `${slug}.mp3`)
              clearAnnotationsForSong(slug)
            }
          }
          res.end(JSON.stringify({ deleted: slugs.length, scope }))
          return
        }

        const slug = decodeSegment(pathPart.replace(/^\//, ''))
        if (!slug) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'invalid slug' }))
          return
        }
        // Resolve the audio filename BEFORE removing the dir — stems are keyed
        // by the file stem (no extension), and we need it to clean them up.
        const dir = path.join(songsDir, slug)
        let audioFile: string | null = null
        try {
          if (fs.existsSync(dir)) {
            const entries = fs.readdirSync(dir).filter((f) => /\.(mp3|wav|flac|ogg|m4a)$/i.test(f))
            if (entries.length > 0) audioFile = entries[0]
          }
        } catch { /* ignore */ }

        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ok */ }

        if (scope === 'everything') {
          if (audioFile) clearStemsForSong(audioFile)
          // clearCacheForSong handles stems + other caches; call without an audio
          // file if we couldn't resolve one (stems pass becomes a no-op).
          clearCacheForSong(slug, audioFile ?? `${slug}.mp3`)
          clearAnnotationsForSong(slug)
        }

        res.end(JSON.stringify({ deleted: 1, slug, scope }))
      })
    },
  }
}

// ── Dataset-wide destructive endpoints ────────────────────────────────────
// Three levels, all admin-only, all wired to typed-confirmation dialogs in
// Settings → Danger Zone → Corpus-wide:
//
//   DELETE /api/songs?scope=everything → "Delete all songs"
//        Wipes every song under data/songs/ plus their caches and every
//        annotator's annotations. Dataset-config and the people/profiles
//        list stay intact. (Handled by serveSongsAdmin above.)
//
//   DELETE /api/dataset                → "Delete workspace"
//        Same as above PLUS dataset-config.json (members, admin list, lock
//        state) and every annotator's saved sign-up profile. The next person
//        to sign in re-bootstraps the dataset and becomes admin.
//
//   DELETE /api/factory-reset          → "Factory reset"
//        Routed through a distinct endpoint so the multi-dataset future can
//        differentiate "wipe this dataset" from "wipe everything". Today
//        (single dataset) the scope matches /api/dataset.
//
// Helper that does the actual wiping for the current dataset. Returns counts
// for the response body. Best-effort throughout — a missing dir is not an
// error, it just means that scope already has nothing to delete.
function wipeCurrentDataset(): {
  songsDeleted: number
  annotationDirsDeleted: number
  annotatorProfilesDeleted: number
  datasetConfigDeleted: boolean
} {
  let songsDeleted = 0
  const songsDir = DATA_DIRS.songs
  if (fs.existsSync(songsDir)) {
    const slugs = fs.readdirSync(songsDir).filter((s) => {
      try { return fs.statSync(path.join(songsDir, s)).isDirectory() } catch { return false }
    })
    for (const slug of slugs) {
      const dir = path.join(songsDir, slug)
      let audioFile: string | null = null
      try {
        const entries = fs.readdirSync(dir).filter((f) => /\.(mp3|wav|flac|ogg|m4a)$/i.test(f))
        if (entries.length > 0) audioFile = entries[0]
      } catch { /* ignore */ }
      rmIfExists(dir)
      clearCacheForSong(slug, audioFile ?? `${slug}.mp3`)
      clearAnnotationsForSong(slug)
      songsDeleted += 1
    }
  }
  // Wipe whole annotation trees in case orphan annotations exist for slugs
  // that were already missing from data/songs/.
  let annotationDirsDeleted = 0
  for (const base of [DATA_DIRS.manualAnnotations, DATA_DIRS.eyeAnnotations, DATA_DIRS.autoGuessAnnotations, DATA_DIRS.customAnnotations]) {
    if (fs.existsSync(base)) { rmIfExists(base); annotationDirsDeleted += 1 }
  }
  // Annotator sign-up profiles — wiped so re-signing rebuilds them.
  let annotatorProfilesDeleted = 0
  if (fs.existsSync(DATA_DIRS.annotatorProfiles)) {
    try {
      annotatorProfilesDeleted = fs.readdirSync(DATA_DIRS.annotatorProfiles).filter((f) => f.endsWith('.json')).length
    } catch { /* ignore */ }
    rmIfExists(DATA_DIRS.annotatorProfiles)
  }
  // Dataset-config last — removing it drops the admin list, so any further
  // admin checks against this request would fail. The current request has
  // already passed its auth check above.
  let datasetConfigDeleted = false
  if (fs.existsSync(DATA_FILES.datasetConfig)) {
    rmIfExists(DATA_FILES.datasetConfig)
    datasetConfigDeleted = true
  }
  // Also flush song-info and any straggling algo-output caches.
  rmIfExists(DATA_DIRS.songInfo)
  rmIfExists(DATA_DIRS.algoClusters)
  rmIfExists(DATA_DIRS.bpmDetections)
  rmIfExists(DATA_DIRS.msaf)
  rmIfExists(DATA_DIRS.mirFeatures)
  rmIfExists(DATA_DIRS.customResults)
  rmIfExists(STEMS_DIR)
  rmIfExists(ANALYSIS_DIR)
  return { songsDeleted, annotationDirsDeleted, annotatorProfilesDeleted, datasetConfigDeleted }
}

function serveDatasetAdmin(): Plugin {
  return {
    name: 'dataset-admin',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'DELETE') return next()
        if (req.url !== '/api/dataset' && req.url !== '/api/factory-reset') return next()

        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        // Admin-only — these endpoints wipe the entire dataset including
        // the membership list. Researcher tier is not enough.
        const { isAdmin, annotatorId } = isAdminForReq(req)
        if (!annotatorId) return send401MissingAnnotator(res)
        if (!isAdmin) return send403NotAdmin(res)

        const summary = wipeCurrentDataset()
        res.end(JSON.stringify({ ok: true, endpoint: req.url, ...summary }))
      })
    },
  }
}

// Serve and persist eye ("by-eye") annotations at /api/eye-annotations
// Same ManualAnnotation shape, annotated visually rather than from algo output.
// GET    /api/eye-annotations/:slug  → read one (200 + null if absent)
// POST   /api/eye-annotations/:slug  → write one
// DELETE /api/eye-annotations/:slug  → delete
function serveEyeAnnotations(): Plugin {
  if (!fs.existsSync(DATA_DIRS.eyeAnnotations)) fs.mkdirSync(DATA_DIRS.eyeAnnotations, { recursive: true })

  return {
    name: 'eye-annotations',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/eye-annotations')) return next()

        const suffix = req.url.slice('/api/eye-annotations'.length)
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        const annotatorId = readAnnotatorIdFromReq(req)
        if (!annotatorId) return send401MissingAnnotator(res)

        const dir = corpusForReq(req).eyeAnnotations

        const match = suffix.match(/^\/([^/]+)$/)
        if (!match) return next()
        const slug = decodeSegment(match[1])
        if (!slug) return send400BadSegment(res, 'slug')

        if (req.method === 'GET') {
          const resolved = resolveAnnotationFile(dir, annotatorId, slug)
          if (resolved.exists) {
            res.end(fs.readFileSync(resolved.filePath, 'utf-8'))
          } else {
            // 200 + null body: see /api/manual-annotations comment above.
            res.end('null')
          }
          return
        }

        if (req.method === 'POST' || req.method === 'DELETE') {
          const { isOnTeam } = isOnTeamForReq(req)
          if (!isOnTeam) return send403NotOnTeam(res)
        }

        if (req.method === 'POST') {
          if (rejectIfBodyTooLarge(req, res, MAX_JSON_BODY)) return
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString() })
          req.on('end', () => {
            try {
              const data = JSON.parse(body)
              const ownPath = ownAnnotationPath(dir, annotatorId, slug)
              const ownDir = path.dirname(ownPath)
              if (!fs.existsSync(ownDir)) fs.mkdirSync(ownDir, { recursive: true })
              if (data.time_spent_seconds === undefined && fs.existsSync(ownPath)) {
                try {
                  const prev = JSON.parse(fs.readFileSync(ownPath, 'utf-8'))
                  if (typeof prev?.time_spent_seconds === 'number') {
                    data.time_spent_seconds = prev.time_spent_seconds
                  }
                } catch { /* ignore */ }
              }
              fs.writeFileSync(ownPath, JSON.stringify(data, null, 2), 'utf-8')
              res.end('{"ok":true}')
            } catch {
              res.statusCode = 400
              res.end('{"error":"invalid json"}')
            }
          })
          return
        }

        if (req.method === 'DELETE') {
          const ownPath = ownAnnotationPath(dir, annotatorId, slug)
          if (fs.existsSync(ownPath)) fs.unlinkSync(ownPath)
          res.end('{"ok":true}')
          return
        }

        next()
      })
    },
  }
}

// Serve and persist per-song info (BPM, time signature, grid offset) at
// /api/song-info. Song-level — not tied to a specific annotation type.
// Sole source of truth for these fields; annotation files no longer carry them
// (one-time migration: tools/migrate-bpm-to-song-info.mjs).
// GET    /api/song-info/:slug → read one (200 + null if absent)
// POST   /api/song-info/:slug → write one
// DELETE /api/song-info/:slug → delete
function serveSongInfo(): Plugin {
  if (!fs.existsSync(DATA_DIRS.songInfo)) fs.mkdirSync(DATA_DIRS.songInfo, { recursive: true })

  return {
    name: 'song-info',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/song-info')) return next()

        const suffix = req.url.slice('/api/song-info'.length)
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        const match = suffix.match(/^\/([^/]+)$/)
        if (!match) return next()
        const slug = decodeSegment(match[1])
        if (!slug) return send400BadSegment(res, 'slug')
        const dir = corpusForReq(req).songInfo
        const filePath = path.join(dir, `${slug}.json`)

        if (req.method === 'GET') {
          if (fs.existsSync(filePath)) {
            res.end(fs.readFileSync(filePath, 'utf-8'))
            return
          }
          // No file on disk → return JSON null, matching the manual/eye/
          // auto-guess endpoints. Callers (songInfo.loadSongInfo) already
          // coalesce null into makeEmptySongInfo(slug). Returning a synthesized
          // default object made the Import-Dataset dialog's "does this exist?"
          // probe think every song already had song-info on the server, so
          // every row's SONG INFO chip rendered as OVERWRITE instead of UPLOAD.
          res.end('null')
          return
        }

        // Song-info is canonical, dataset-wide metadata (BPM, time-sig, grid
        // offset). Only admins may set or clear it — annotators consume it
        // read-only so the team agrees on one truth per song. Writes always
        // target data/ (team corpus); the demo corpus is read-only.
        if (req.method === 'POST' || req.method === 'DELETE') {
          const { isAdmin, annotatorId } = isAdminForReq(req)
          if (!annotatorId) return send401MissingAnnotator(res)
          if (!isAdmin) return send403NotAdmin(res)
        }
        // After the admin check the write path always operates on the team
        // corpus (admins are always on-team by definition); demo files stay
        // baked-in.
        const writePath = path.join(DATA_DIRS.songInfo, `${slug}.json`)

        if (req.method === 'POST') {
          if (rejectIfBodyTooLarge(req, res, MAX_JSON_BODY)) return
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString() })
          req.on('end', () => {
            try {
              const data = JSON.parse(body)
              fs.writeFileSync(writePath, JSON.stringify(data, null, 2), 'utf-8')
              res.end('{"ok":true}')
            } catch {
              res.statusCode = 400
              res.end('{"error":"invalid json"}')
            }
          })
          return
        }

        if (req.method === 'DELETE') {
          if (fs.existsSync(writePath)) fs.unlinkSync(writePath)
          res.end('{"ok":true}')
          return
        }

        next()
      })
    },
  }
}

// Serve and persist per-song reference lyrics text at /api/lyrics-text/:slug.
// One .txt per slug under DATA_DIRS.lyricsText, shared across annotators
// (objective truth, not opinion). Experimental: written by the LyricsTextPanel
// only when `experimentalLyricsFamily` is on. Plain text, not JSON, so
// downstream aligners (SOFA / ctc-forced-aligner) can read it as-is.
//
// GET    /api/lyrics-text/:slug  → text body, or empty string if absent
// POST   /api/lyrics-text/:slug  → write text body (any annotator)
// DELETE /api/lyrics-text/:slug  → wipe text body (admin only)
function serveLyricsText(): Plugin {
  if (!fs.existsSync(DATA_DIRS.lyricsText)) fs.mkdirSync(DATA_DIRS.lyricsText, { recursive: true })

  // 256 KB cap — covers the entire lyrics text for any plausible song with
  // huge margin (a 5-minute rap track tops out near 8 KB of UTF-8).
  const MAX_LYRICS_BODY = 256 * 1024

  return {
    name: 'lyrics-text',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/lyrics-text')) return next()

        const suffix = req.url.slice('/api/lyrics-text'.length)
        res.setHeader('Access-Control-Allow-Origin', '*')

        const match = suffix.match(/^\/([^/]+)$/)
        if (!match) return next()
        const slug = decodeSegment(match[1])
        if (!slug) return send400BadSegment(res, 'slug')
        const filePath = path.join(DATA_DIRS.lyricsText, `${slug}.txt`)

        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          if (fs.existsSync(filePath)) {
            res.end(fs.readFileSync(filePath, 'utf-8'))
            return
          }
          res.end('')
          return
        }

        if (req.method === 'POST') {
          if (rejectIfBodyTooLarge(req, res, MAX_LYRICS_BODY)) return
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString('utf-8') })
          req.on('end', () => {
            fs.writeFileSync(filePath, body, 'utf-8')
            res.setHeader('Content-Type', 'application/json')
            res.end('{"ok":true}')
          })
          return
        }

        if (req.method === 'DELETE') {
          const { isAdmin, annotatorId } = isAdminForReq(req)
          if (!annotatorId) return send401MissingAnnotator(res)
          if (!isAdmin) return send403NotAdmin(res)
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
          res.setHeader('Content-Type', 'application/json')
          res.end('{"ok":true}')
          return
        }

        next()
      })
    },
  }
}

// Serve and persist dataset-wide config at /api/dataset-config (single file).
// Holds access-tier assignments and any corpus-wide defaults.
// GET  /api/dataset-config → read current config (returns defaults if absent)
// POST /api/dataset-config → write config
//
// The GET response is filtered by caller tier: admins and researchers get the
// full file (including peopleByEmail / adminEmails / teamEmails so the Team
// and Settings pages can render member lists). Everyone else gets the public
// subset only — corpusName, sharedCorpus, taxonomy defaults, plus a top-level
// `callerTier` field with the *server-resolved* tier for the calling annotator.
// This prevents the whitelist from leaking via the JS bundle / network panel,
// which would otherwise let any visitor enumerate every admin/researcher/team
// email address.
function serveDatasetConfig(): Plugin {
  const filePath = DATA_FILES.datasetConfig
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  // Keys that should only ever be returned to admin/researcher callers. Any
  // field listed here is stripped from the GET response for everyone else.
  const SENSITIVE_KEYS = new Set(['peopleByEmail', 'adminEmails', 'teamEmails'])

  return {
    name: 'dataset-config',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // /api/check-access?id=<annotator-id> — server-side resolution of an
        // arbitrary candidate id to a tier (or null = denied). Used by the
        // sign-in flow before the annotator cookie is set, so the denial
        // decision lives entirely on the server and the candidate id never
        // has to be checked against a client-visible whitelist. Returns ONLY
        // `{tier}` — never any peer addresses, even when denied.
        if (req.url?.startsWith('/api/check-access') && req.method === 'GET') {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Content-Type', 'application/json')
          const qIdx = req.url.indexOf('?')
          const params = new URLSearchParams(qIdx >= 0 ? req.url.slice(qIdx + 1) : '')
          const id = (params.get('id') ?? '').trim().toLowerCase()
          if (!id) {
            res.statusCode = 400
            res.end('{"error":"missing id"}')
            return
          }
          const tier = tierForId(id, readDatasetConfigSafe())
          res.end(JSON.stringify({ tier }))
          return
        }

        // /api/admin-status — lightweight check for the current signed-in
        // annotator. Always reachable (no admin requirement) so the UI can
        // gate itself before attempting admin-only actions.
        if (req.url === '/api/admin-status' && req.method === 'GET') {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Content-Type', 'application/json')
          const cfg = readDatasetConfigSafe()
          const annotatorId = readAnnotatorIdFromReq(req)
          const tier = tierForId(annotatorId, cfg)
          const isAdmin = tier === 'admin'
          const isResearcher = tier === 'researcher' || tier === 'admin'
          const isOnTeam = tier !== null
          // Counts: prefer peopleByEmail when present, fall back to legacy.
          const peopleCount = cfg?.peopleByEmail ? Object.keys(cfg.peopleByEmail).length : 0
          const adminCount = peopleCount > 0
            ? Object.values(cfg!.peopleByEmail!).filter((p) => p.tier === 'admin').length
            : (cfg?.adminEmails?.length ?? 0)
          const teamCount = peopleCount > 0
            ? Object.values(cfg!.peopleByEmail!).filter((p) => p.tier === 'team').length
            : (cfg?.teamEmails?.length ?? 0)
          const researcherCount = peopleCount > 0
            ? Object.values(cfg!.peopleByEmail!).filter((p) => p.tier === 'researcher').length
            : 0
          // Reveal the people list only to admin or researcher; everyone
          // else just gets the aggregate counts.
          res.end(JSON.stringify({
            annotatorId,
            tier,
            isAdmin,
            isResearcher,
            isOnTeam,
            adminCount,
            teamCount,
            researcherCount,
            mode: peopleCount > 0 ? 'people-by-email'
                : (cfg?.adminEmails && cfg.adminEmails.length > 0) ? 'allowlist'
                : 'bootstrap',
            peopleByEmail: isResearcher ? (cfg?.peopleByEmail ?? null) : undefined,
            adminEmails: isResearcher ? (cfg?.adminEmails ?? []) : undefined,
            teamEmails: isResearcher ? (cfg?.teamEmails ?? []) : undefined,
          }))
          return
        }

        // DELETE /api/people/<email-or-id> — admin-only destructive purge.
        // Removes the person from peopleByEmail AND deletes every annotation
        // file they own (manual/eye/auto-guess + per-script custom) plus their
        // annotator profile from disk. The Team → Members `Remove` button
        // triggers this after a typed DELETE_USER confirmation. The key is
        // usually a real email, but can also be a username-style key like
        // `local-foo` when the row was added via the Username sign-in path.
        const peopleDelMatch = req.url?.match(/^\/api\/people\/([^/?]+)(?:\?.*)?$/)
        if (req.method === 'DELETE' && peopleDelMatch) {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Content-Type', 'application/json')
          const { isAdmin, annotatorId } = isAdminForReq(req)
          if (!annotatorId) return send401MissingAnnotator(res)
          if (!isAdmin) return send403NotAdmin(res)

          const emailKey = decodeURIComponent(peopleDelMatch[1]).trim().toLowerCase()
          if (!emailKey) {
            res.statusCode = 400
            res.end('{"error":"missing email"}')
            return
          }

          // Mirror the UI's last-admin guard server-side so the API can't be
          // misused to lock the dataset.
          const cfg = readDatasetConfigSafe() ?? {}
          const seeded = seedPeopleByEmail(cfg as DatasetCfg)
          const entry = seeded[emailKey]
          if (entry?.tier === 'admin') {
            const adminCount = Object.values(seeded).filter((p) => p.tier === 'admin').length
            if (adminCount <= 1) {
              res.statusCode = 409
              res.end('{"error":"cannot remove the last admin"}')
              return
            }
          }

          // Collect every annotator-id that belongs to this person. The
          // email key itself is one (Google sign-in uses the email as the
          // id; Username uses `local-foo` as both key and id). Email-tab
          // sign-in derives `email-<sanitized-email>` — probe that variant
          // too, because saveProfile is fire-and-forget so the profile-scan
          // fallback below can miss annotations made without a saved profile.
          const idsToPurge = new Set<string>()
          const emailAsId = sanitizeAnnotatorId(emailKey)
          if (emailAsId) {
            idsToPurge.add(emailAsId)
            if (!emailAsId.startsWith('email-') && !emailAsId.startsWith('local-')) {
              const prefixed = sanitizeAnnotatorId(`email-${emailAsId}`)
              if (prefixed) idsToPurge.add(prefixed)
            }
          }
          const profileDir = DATA_DIRS.annotatorProfiles
          if (fs.existsSync(profileDir)) {
            for (const f of fs.readdirSync(profileDir)) {
              if (!f.endsWith('.json')) continue
              try {
                const prof = JSON.parse(fs.readFileSync(path.join(profileDir, f), 'utf-8')) as Record<string, unknown>
                const profEmail = typeof prof.email === 'string' ? prof.email.trim().toLowerCase() : ''
                const profId = typeof prof.id === 'string' ? sanitizeAnnotatorId(prof.id) : null
                if (profEmail && profEmail === emailKey && profId) idsToPurge.add(profId)
              } catch { /* skip unreadable */ }
            }
          }

          const summary = { deletedIds: [] as string[], removedDirs: 0, removedFiles: 0, removedProfiles: 0 }
          const standardDirs = [
            DATA_DIRS.manualAnnotations,
            DATA_DIRS.eyeAnnotations,
            DATA_DIRS.autoGuessAnnotations,
          ]
          for (const id of idsToPurge) {
            let touched = false
            for (const base of standardDirs) {
              const annDir = path.join(base, id)
              if (!fs.existsSync(annDir)) continue
              try {
                summary.removedFiles += fs.readdirSync(annDir).filter((f) => f.endsWith('.json')).length
              } catch { /* ignore */ }
              rmIfExists(annDir)
              summary.removedDirs += 1
              touched = true
            }
            const customRoot = DATA_DIRS.customAnnotations
            if (fs.existsSync(customRoot)) {
              try {
                for (const script of fs.readdirSync(customRoot)) {
                  const scriptDir = path.join(customRoot, script)
                  try { if (!fs.statSync(scriptDir).isDirectory()) continue } catch { continue }
                  const annDir = path.join(scriptDir, id)
                  if (!fs.existsSync(annDir)) continue
                  try {
                    summary.removedFiles += fs.readdirSync(annDir).filter((f) => f.endsWith('.json')).length
                  } catch { /* ignore */ }
                  rmIfExists(annDir)
                  summary.removedDirs += 1
                  touched = true
                }
              } catch { /* ignore */ }
            }
            const profPath = path.join(profileDir, `${id}.json`)
            if (fs.existsSync(profPath)) {
              rmIfExists(profPath)
              summary.removedProfiles += 1
              touched = true
            }
            if (touched) summary.deletedIds.push(id)
          }

          delete seeded[emailKey]
          const next = writePeopleByEmail(cfg as DatasetCfg, seeded)
          // Drop the key entirely when empty so the mode detector falls back
          // to bootstrap/allowlist semantics correctly.
          if (Object.keys(seeded).length === 0) delete next.peopleByEmail
          fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf-8')

          res.end(JSON.stringify({ ok: true, ...summary }))
          return
        }

        if (req.url !== '/api/dataset-config') return next()
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        if (req.method === 'GET') {
          // Resolve caller tier server-side, then filter sensitive whitelist
          // fields out for everyone below researcher. The caller still gets
          // their own resolved tier via `callerTier` so the UI can render
          // tier-dependent labels without ever seeing peer identities.
          const cfg = readDatasetConfigSafe() ?? {}
          const annotatorId = readAnnotatorIdFromReq(req)
          const callerTier = tierForId(annotatorId, cfg as DatasetCfg)
          const isPrivileged = callerTier === 'admin' || callerTier === 'researcher'
          const out: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(cfg)) {
            if (!isPrivileged && SENSITIVE_KEYS.has(k)) continue
            out[k] = v
          }
          out.callerTier = callerTier
          res.end(JSON.stringify(out, null, 2))
          return
        }

        if (req.method === 'POST') {
          // Writes change lock state and the admin allowlist. Both are admin
          // actions. Bootstrap mode (no admin set) lets the first user write,
          // which is how an initial admin gets attached.
          const { isAdmin, annotatorId } = isAdminForReq(req)
          if (!annotatorId) return send401MissingAnnotator(res)
          if (!isAdmin) return send403NotAdmin(res)
          if (rejectIfBodyTooLarge(req, res, MAX_JSON_BODY)) return
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString() })
          req.on('end', () => {
            try {
              const data = JSON.parse(body)
              fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
              res.end('{"ok":true}')
            } catch {
              res.statusCode = 400
              res.end('{"error":"invalid json"}')
            }
          })
          return
        }

        next()
      })
    },
  }
}

// Serve and persist algorithm cluster cache at /api/algo-clusters
// GET  /api/algo-clusters/:slug  → read cached data (or null)
// POST /api/algo-clusters/:slug  → write cached data
function serveAlgoClusters(): Plugin {
  const dir = DATA_DIRS.algoClusters
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  return {
    name: 'algo-clusters',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/algo-clusters')) return next()

        const suffix = req.url.slice('/api/algo-clusters'.length)
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        const match = suffix.match(/^\/([^/]+)$/)
        if (!match) return next()
        const slug = decodeSegment(match[1])
        if (!slug) return send400BadSegment(res, 'slug')
        const filePath = path.join(dir, `${slug}.json`)

        if (req.method === 'GET') {
          res.end(fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : 'null')
        } else if (req.method === 'POST') {
          // Cluster cache is corpus-mutating — gate writes on team membership.
          // Public visitors can still read the cache (GET stays open) so demo
          // tracks render their bundled clusters.
          const { isOnTeam } = isOnTeamForReq(req)
          if (!isOnTeam) return send403NotOnTeam(res)
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', () => {
            fs.writeFileSync(filePath, Buffer.concat(chunks).toString('utf-8'))
            res.end('{"ok":true}')
          })
        } else {
          next()
        }
      })
    },
  }
}

// Proxy /api/mir-eval → Python mir_eval server on localhost:8001
// The Python server must be started separately:
//   python tools/python/mir_eval_server.py
function proxyMirEval(): Plugin {
  return {
    name: 'proxy-mir-eval',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/mir-eval')) return next()

        // Buffer the request body, then forward to the Python server
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          const body = Buffer.concat(chunks)
          const options: http.RequestOptions = {
            hostname: MIR_EVAL_HOST,
            port: 8001,
            path: req.url,
            method: req.method,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': body.length,
            },
          }

          const proxy = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            })
            proxyRes.pipe(res)
          })

          proxy.on('error', () => {
            res.statusCode = 503
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
              error: 'Python MIR eval server is not running.',
              hint: 'python tools/python/mir_eval_server.py',
            }))
          })

          if (body.length) proxy.write(body)
          proxy.end()
        })
      })
    },
  }
}

// Proxy /api/mir → Python MIR feature server on localhost:8007.
// The Python server must be started separately:
//   python tools/python/mir_server.py
function proxyMir(): Plugin {
  return {
    name: 'proxy-mir',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/mir/')) return next()

        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          const body = Buffer.concat(chunks)
          const options: http.RequestOptions = {
            hostname: MIR_HOST,
            port: 8007,
            path: req.url,
            method: req.method,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': body.length,
            },
          }

          const proxy = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            })
            proxyRes.pipe(res)
          })

          proxy.on('error', () => {
            res.statusCode = 503
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
              error: 'Python MIR feature server is not running.',
              hint: 'python tools/python/mir_server.py',
            }))
          })

          if (body.length) proxy.write(body)
          proxy.end()
        })
      })
    },
  }
}

// Proxy /api/ruptures → Python Ruptures server on localhost:8003
function proxyRuptures(): Plugin {
  return {
    name: 'proxy-ruptures',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/ruptures')) return next()

        // /api/ruptures/health is the only GET; everything else is an
        // expensive analysis run that should require team membership.
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
          const { isOnTeam, annotatorId } = isOnTeamForReq(req)
          if (!annotatorId) return send401MissingAnnotator(res)
          if (!isOnTeam) return send403NotOnTeam(res)
        }

        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          const body = Buffer.concat(chunks)
          const options: http.RequestOptions = {
            hostname: RUPTURES_HOST,
            port: 8003,
            path: req.url,
            method: req.method,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': body.length,
            },
          }

          const proxy = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            })
            proxyRes.pipe(res)
          })

          proxy.on('error', () => {
            res.statusCode = 503
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
              error: 'Ruptures server is not running.',
              hint: 'python tools/python/ruptures_server.py',
            }))
          })

          if (body.length) proxy.write(body)
          proxy.end()
        })
      })
    },
  }
}

// Proxy /api/bpm → Python BPM detection server on localhost:8004.
// Runs every available BPM/tempo estimator (librosa, madmom)
// and returns each detector's estimate. The server is auto-started the first
// time Vite boots in dev; it can also be started manually via:
//   python tools/python/bpm_server.py
function proxyBpm(): Plugin {
  const repoRoot = path.resolve(__dirname, '..')
  const serverScript = path.join(repoRoot, 'tools', 'python', 'bpm_server.py')
  let bpmProc: ReturnType<typeof spawn> | null = null

  function spawnServerIfNeeded(): void {
    if (bpmProc && bpmProc.exitCode === null) return  // already alive
    if (!fs.existsSync(serverScript)) {
      console.warn('[bpm] tools/python/bpm_server.py not found — auto-start skipped')
      return
    }
    try {
      const proc = spawn('python3', [serverScript], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
      bpmProc = proc
      let sawAddressInUse = false
      const log = (data: Buffer) => {
        const text = data.toString()
        if (/Address already in use|Errno 98/i.test(text)) sawAddressInUse = true
        if (!sawAddressInUse) process.stderr.write(`[bpm] ${text}`)
      }
      proc.stdout?.on('data', log)
      proc.stderr?.on('data', log)
      proc.on('exit', (code) => {
        if (sawAddressInUse) {
          // Another process already owns :8004 (e.g. run.sh launched it).
          // Re-probe — if it's healthy, reuse it silently instead of warning.
          const probe = http.request({ hostname: BPM_HOST, port: 8004, path: '/api/bpm/health', method: 'GET', timeout: 1500 }, (resp) => {
            resp.resume()
            if (resp.statusCode === 200) {
              process.stderr.write('[bpm] port 8004 already serving — reusing external BPM server.\n')
            } else {
              console.warn(`[bpm] port 8004 held by an unhealthy process (status ${resp.statusCode}); kill it and restart vite.`)
            }
          })
          probe.on('error', () => console.warn('[bpm] port 8004 held but health probe failed; kill the stale process and restart vite.'))
          probe.on('timeout', () => { probe.destroy(); console.warn('[bpm] port 8004 held; health probe timed out.') })
          probe.end()
        } else if (code !== 0 && code !== null) {
          console.warn(`[bpm] server exited with code ${code}`)
        }
        bpmProc = null
      })
      const stop = () => { try { if (bpmProc?.exitCode === null) bpmProc.kill('SIGTERM') } catch { /* ignore */ } }
      process.once('exit', stop)
      process.once('SIGINT', () => { stop(); process.exit(130) })
      process.once('SIGTERM', stop)
    } catch (err) {
      console.warn('[bpm] failed to spawn server:', (err as Error).message)
    }
  }

  // Auto-spawn only makes sense when the server is meant to live on this
  // machine. Inside docker-compose BPM_HOST points at the `bpm` service,
  // which is already running in its own container — never spawn there.
  const autoSpawnEnabled = BPM_HOST === '127.0.0.1' || BPM_HOST === 'localhost'

  return {
    name: 'proxy-bpm',
    configureServer(server) {
      // Probe the port first — if a server is already running (manual launch
      // or a previous Vite session), reuse it instead of double-spawning.
      // Retry a few times because a concurrent launcher (run.sh) may still be
      // booting bpm_server.py when Vite starts.
      if (autoSpawnEnabled) {
        const tryProbe = (attemptsLeft: number) => {
          const probe = http.request({ hostname: BPM_HOST, port: 8004, path: '/api/bpm/health', method: 'GET', timeout: 1500 }, (resp) => {
            resp.resume()
            if (resp.statusCode === 200) return
            if (attemptsLeft > 0) setTimeout(() => tryProbe(attemptsLeft - 1), 500)
            else spawnServerIfNeeded()
          })
          const retry = () => {
            probe.destroy()
            if (attemptsLeft > 0) setTimeout(() => tryProbe(attemptsLeft - 1), 500)
            else spawnServerIfNeeded()
          }
          probe.on('error', retry)
          probe.on('timeout', retry)
          probe.end()
        }
        tryProbe(3)
      }

      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/bpm')) return next()

        // /api/bpm/health is the only GET (used by the dev-server probe);
        // analysis POSTs are expensive — gate on team membership.
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
          const { isOnTeam, annotatorId } = isOnTeamForReq(req)
          if (!annotatorId) return send401MissingAnnotator(res)
          if (!isOnTeam) return send403NotOnTeam(res)
        }

        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          const body = Buffer.concat(chunks)
          const options: http.RequestOptions = {
            hostname: BPM_HOST,
            port: 8004,
            path: req.url,
            method: req.method,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': body.length,
            },
          }

          const proxy = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            })
            proxyRes.pipe(res)
          })

          proxy.on('error', () => {
            // Server may still be booting — re-arm the auto-start in case the
            // earlier attempt failed silently (e.g. the user installed deps
            // while Vite was running).
            if (autoSpawnEnabled) spawnServerIfNeeded()
            res.statusCode = 503
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
              error: 'BPM detection server unavailable (still starting up?).',
              hint: 'Retry in a few seconds, or start manually: python tools/python/bpm_server.py',
            }))
          })

          if (body.length) proxy.write(body)
          proxy.end()
        })
      })
    },
  }
}


// Proxy /api/span → Python SPAN-family server on localhost:8009.
// Experimental: no auto-spawn here. The server needs torch + torchaudio which
// most local dev installs lack; the supported way to run it is inside docker
// via `docker compose --profile experimental-models up`. If it isn't reachable
// we return 503 with a hint, and the UI hides the family because the user
// setting `experimentalSpanFamily` is off by default.
function proxySpan(): Plugin {
  return {
    name: 'proxy-span',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/span')) return next()

        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          const body = Buffer.concat(chunks)
          const options: http.RequestOptions = {
            hostname: SPAN_HOST,
            port: 8009,
            path: req.url,
            method: req.method,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': body.length,
            },
          }

          const proxy = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            })
            proxyRes.pipe(res)
          })

          proxy.on('error', () => {
            res.statusCode = 503
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
              error: 'SPAN family server is not running.',
              hint: 'docker compose --profile experimental-models up --build span',
            }))
          })

          if (body.length) proxy.write(body)
          proxy.end()
        })
      })
    },
  }
}

// Proxy /api/beatnet → Python BeatNet server on localhost:8010.
// Same gating story as proxySpan: experimental, no auto-spawn, surface a 503
// with a docker-compose hint if it can't be reached.
function proxyBeatnet(): Plugin {
  return {
    name: 'proxy-beatnet',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/beatnet')) return next()

        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          const body = Buffer.concat(chunks)
          const options: http.RequestOptions = {
            hostname: BEATNET_HOST,
            port: 8010,
            path: req.url,
            method: req.method,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': body.length,
            },
          }

          const proxy = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            })
            proxyRes.pipe(res)
          })

          proxy.on('error', () => {
            res.statusCode = 503
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
              error: 'BeatNet server is not running.',
              hint: 'docker compose --profile experimental-models up --build beatnet',
            }))
          })

          if (body.length) proxy.write(body)
          proxy.end()
        })
      })
    },
  }
}

// Generic factory for the new family proxies. Each (path-prefix, host, port,
// service-name) tuple gets a plugin that forwards the request and 503s with
// a docker-compose hint when the sidecar can't be reached. Mirrors
// proxySpan / proxyBeatnet bodies — extracted because we're now standing up
// three identical-shape proxies for loop / panns / pitch.
function makeFamilyProxy(
  name: string,
  prefix: string,
  host: string,
  port: number,
  serviceName: string,
): Plugin {
  return {
    name: `proxy-${name}`,
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next()
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          const body = Buffer.concat(chunks)
          const options: http.RequestOptions = {
            hostname: host, port, path: req.url, method: req.method,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': body.length,
            },
          }
          const proxy = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            })
            proxyRes.pipe(res)
          })
          proxy.on('error', () => {
            res.statusCode = 503
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
              error: `${name} server is not running.`,
              hint: `docker compose --profile experimental-models up --build ${serviceName}`,
            }))
          })
          if (body.length) proxy.write(body)
          proxy.end()
        })
      })
    },
  }
}

const proxyLoop       = (): Plugin => makeFamilyProxy('loop',       '/api/loop',       LOOP_HOST,       8012, 'loop')
const proxyPanns      = (): Plugin => makeFamilyProxy('panns',      '/api/panns',      PANNS_HOST,      8013, 'panns')
const proxyPitch      = (): Plugin => makeFamilyProxy('pitch',      '/api/pitch',      PITCH_HOST,      8011, 'pitch')
const proxyCueExtras  = (): Plugin => makeFamilyProxy('cue-extras', '/api/cue-extras', CUE_EXTRAS_HOST, 8014, 'cue-extras')
const proxyPercussive = (): Plugin => makeFamilyProxy('percussive', '/api/percussive', PERCUSSIVE_HOST, 8015, 'percussive')
const proxyLyrics     = (): Plugin => makeFamilyProxy('lyrics',     '/api/lyrics',     LYRICS_HOST,     8016, 'lyrics')

// Proxy /api/custom-scripts and /api/custom-annotations → Python custom-detector
// server on localhost:8005. Auto-starts the server the first time Vite boots.
// Forwards the X-Annotator-Id header (the annotation endpoints require it).
function proxyCustomScripts(): Plugin {
  const repoRoot = path.resolve(__dirname, '..')
  const serverScript = path.join(repoRoot, 'tools', 'python', 'custom_server.py')
  let proc: ReturnType<typeof spawn> | null = null

  function spawnServerIfNeeded(): void {
    if (proc && proc.exitCode === null) return
    if (!fs.existsSync(serverScript)) {
      console.warn('[custom] tools/python/custom_server.py not found — auto-start skipped')
      return
    }
    try {
      const child = spawn('python3', [serverScript], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
      proc = child
      const log = (data: Buffer) => process.stderr.write(`[custom] ${data.toString()}`)
      child.stdout?.on('data', log)
      child.stderr?.on('data', log)
      child.on('exit', (code) => {
        if (code !== 0 && code !== null) console.warn(`[custom] server exited with code ${code}`)
        proc = null
      })
      const stop = () => { try { if (proc?.exitCode === null) proc.kill('SIGTERM') } catch { /* ignore */ } }
      process.once('exit', stop)
      process.once('SIGINT', () => { stop(); process.exit(130) })
      process.once('SIGTERM', stop)
    } catch (err) {
      console.warn('[custom] failed to spawn server:', (err as Error).message)
    }
  }

  // When CUSTOM_HOST points at a sibling container (docker-compose) we
  // shouldn't try to spawn the server in-process — it doesn't live in this
  // container, and `python3` may not even be installed here.
  const isLocalHost = CUSTOM_HOST === '127.0.0.1' || CUSTOM_HOST === 'localhost'

  return {
    name: 'proxy-custom-scripts',
    configureServer(server) {
      if (isLocalHost) {
        // Probe before spawn — 3 s is generous enough that a still-importing
        // Python instance isn't mistaken for "down" and re-spawned. The
        // server is also idempotent on EADDRINUSE, so a duplicate spawn now
        // exits cleanly instead of crash-looping.
        const probe = http.request(
          { hostname: CUSTOM_HOST, port: 8005, path: '/api/custom-scripts', method: 'GET', timeout: 3000 },
          (resp) => { resp.resume(); if (resp.statusCode == null) spawnServerIfNeeded() },
        )
        probe.on('error',   () => spawnServerIfNeeded())
        probe.on('timeout', () => { probe.destroy(); spawnServerIfNeeded() })
        probe.end()
      }

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (
          !url.startsWith('/api/custom-scripts') &&
          !url.startsWith('/api/custom-annotations') &&
          !url.startsWith('/api/detector-outputs')
        ) {
          return next()
        }

        // Demo-mode lockdown for the Playground attack surface. /api/custom-
        // scripts/{upload,run/*,/*/flags,/* DELETE} write or execute Python
        // on the server, so they must be unreachable for the synthetic
        // demo-anonymous identity. The UI route guard hides /custom in demo;
        // this is the matching server-side block so a hand-crafted client
        // that bypasses the UI still hits a 403. GET endpoints (registry
        // list, cached results, source view) stay open — Algorithm Inspect
        // needs them to render the shipped sample corpus. See App.tsx
        // DEMO_FORBIDDEN for the UI side. Mirrored in custom_server.py.
        const annotatorId = readAnnotatorIdFromReq(req)
        if (annotatorId === 'demo-anonymous') {
          const method = (req.method ?? 'GET').toUpperCase()
          const isPlaygroundMutation =
            url.startsWith('/api/custom-scripts/upload') ||
            url.startsWith('/api/custom-scripts/run/') ||
            url.startsWith('/api/custom-scripts/reload') ||
            (method === 'POST' && /^\/api\/custom-scripts\/[^/]+\/flags(\?|$)/.test(url)) ||
            (method === 'DELETE' && /^\/api\/custom-scripts\/[^/]+(\/outputs)?(\?|$)/.test(url))
          if (isPlaygroundMutation) {
            res.statusCode = 403
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(JSON.stringify({
              error: 'playground_disabled_in_demo',
              message: 'Demo Mode cannot upload, modify, delete, or run custom detectors.',
            }))
            return
          }
        }

        // Authorship gate. Uploading, modifying, or deleting detector source
        // executes/replaces Python on the host — restrict to researcher+.
        // Running an *existing* detector stays open to team annotators
        // (running pre-vetted code is no riskier than the researcher who
        // authored it). GET endpoints (registry, cached results, source view)
        // and annotation/layer/output writes remain open per existing tier
        // gates inside the sidecar. Mirrored in custom_server.py.
        const method = (req.method ?? 'GET').toUpperCase()
        const isAuthorshipMutation =
          url.startsWith('/api/custom-scripts/upload') ||
          url.startsWith('/api/custom-scripts/reload') ||
          (method === 'POST' && /^\/api\/custom-scripts\/[^/]+\/flags(\?|$)/.test(url)) ||
          (method === 'DELETE' && /^\/api\/custom-scripts\/[^/]+(\/outputs)?(\?|$)/.test(url))
        if (isAuthorshipMutation) {
          const { ok, annotatorId: authedId } = isResearcherOrAdminForReq(req)
          if (!authedId) {
            res.statusCode = 401
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end('{"error":"missing or invalid X-Annotator-Id header"}')
            return
          }
          if (!ok) {
            res.statusCode = 403
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(JSON.stringify({
              error: 'researcher_or_admin_required',
              message: 'Uploading, modifying, or deleting custom detectors requires researcher access.',
            }))
            return
          }
        }
        // Running an existing detector is a team-level action.
        const isDetectorRun = url.startsWith('/api/custom-scripts/run/')
        if (isDetectorRun) {
          const { isOnTeam, annotatorId: authedId } = isOnTeamForReq(req)
          if (!authedId) {
            res.statusCode = 401
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end('{"error":"missing or invalid X-Annotator-Id header"}')
            return
          }
          if (!isOnTeam) {
            res.statusCode = 403
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(JSON.stringify({
              error: 'team_required',
              message: 'Running custom detectors requires team membership.',
            }))
            return
          }
        }

        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          const body = Buffer.concat(chunks)
          const headers: Record<string, string | number> = {
            'Content-Length': body.length,
          }
          // Pass through Content-Type and the annotator header.
          if (req.headers['content-type']) headers['Content-Type'] = String(req.headers['content-type'])
          if (req.headers['x-annotator-id']) headers['X-Annotator-Id'] = String(req.headers['x-annotator-id'])

          const options: http.RequestOptions = {
            hostname: CUSTOM_HOST,
            port: 8005,
            path: url,
            method: req.method,
            headers,
          }
          const fwd = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, {
              'Content-Type': proxyRes.headers['content-type'] ?? 'application/json',
              'Access-Control-Allow-Origin': '*',
            })
            proxyRes.pipe(res)
          })
          fwd.on('error', () => {
            if (isLocalHost) spawnServerIfNeeded()
            res.statusCode = 503
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({
              error: 'Custom-detector server unavailable (still starting up?).',
              hint: 'Retry in a few seconds, or start manually: python tools/python/custom_server.py',
            }))
          })
          if (body.length) fwd.write(body)
          fwd.end()
        })
      })
    },
  }
}


// ─── Storage stats / cache deletion ───────────────────────────────────────────
//
// GET    /api/storage-stats     → per-song breakdown + aggregate totals
// DELETE /api/storage/:slug     → remove all regenerable caches for one song
// DELETE /api/storage           → remove all regenerable caches across all songs
//
// What counts as "cache" (= deletable): stems, analysis JSONs (allin1/ruptures/
// MSAF), MSAF raw outputs, BPM cache, algo-clusters.
// What is NEVER deleted: audio files in songs/, annotations under data/annotations/,
// per-song metadata in data/song-info/. Those are user data.
// ─── Song cache listing ──────────────────────────────────────────────────────
// GET /api/song-cache-listing/:slug
//
// Returns the list of server-relative URLs for everything a "Full annotation
// export" might want to bundle for one song:
//   {
//     analysis: ["/analysis/<slug>/allin1.json", "/analysis/<slug>/foote.json", …],
//     stems:    ["/stems/<filestem>/drums.wav", "/stems/<filestem>/bass.wav", …],
//   }
//
// The client (ExportManagerModal) then fetches each URL on its own and adds
// the blob to the zip — keeping the bundling logic in the browser so the
// dev server doesn't have to stream large WAVs through itself.
//
// The response contains two arrays of {url} entries — one for analysis files,
// one for stems. The client fetches each URL and adds the blob to the zip.
//
// We cover three on-disk locations under "analysis":
//   1. data/algorithm-outputs/analysis/<slug>/*.json   — allin1, MSAF outputs,
//      ruptures, foote, …
//   2. data/algorithm-outputs/bpm-detections/<slug>.json  → emitted inline as
//      {url:null, inline:<content>, name:"bpm-detections.json"}
//   3. data/algorithm-outputs/algo-clusters/<slug>.json   → same as bpm
//
// (#2 and #3 have no static URL — they live under data/, not public/ — so we
// inline their contents in the listing rather than spinning up a fourth Vite
// endpoint just to serve two small JSON files.)
//
// We intentionally exclude MSAF raw outputs (data/algorithm-outputs/msaf/<slug>/)
// since they are intermediate working files — the consumable JSON lives in
// data/algorithm-outputs/analysis/<slug>/.
interface CacheEntry { url: string | null; inline: string | null; name: string }
function serveSongCacheListing(): Plugin {
  function listAnalysis(slug: string): CacheEntry[] {
    const out: CacheEntry[] = []
    const dir = path.join(ANALYSIS_DIR, slug)
    if (fs.existsSync(dir)) {
      try {
        for (const f of fs.readdirSync(dir)) {
          const stat = fs.statSync(path.join(dir, f))
          if (stat.isFile()) {
            out.push({
              url: `/analysis/${encodeURIComponent(slug)}/${encodeURIComponent(f)}`,
              inline: null,
              name: f,
            })
          }
        }
      } catch { /* ignore */ }
    }
    const bpmPath = path.join(DATA_DIRS.bpmDetections, `${slug}.json`)
    if (fs.existsSync(bpmPath)) {
      try {
        out.push({
          url: null,
          inline: fs.readFileSync(bpmPath, 'utf-8'),
          name: 'bpm-detections.json',
        })
      } catch { /* ignore */ }
    }
    const clustersPath = path.join(DATA_DIRS.algoClusters, `${slug}.json`)
    if (fs.existsSync(clustersPath)) {
      try {
        out.push({
          url: null,
          inline: fs.readFileSync(clustersPath, 'utf-8'),
          name: 'algo-clusters.json',
        })
      } catch { /* ignore */ }
    }
    return out
  }

  function listStems(fileStem: string): CacheEntry[] {
    const out: CacheEntry[] = []
    const dir = path.join(STEMS_DIR, fileStem)
    if (!fs.existsSync(dir)) return out
    try {
      for (const f of fs.readdirSync(dir)) {
        const stat = fs.statSync(path.join(dir, f))
        if (stat.isFile()) {
          out.push({
            url: `/stems/${encodeURIComponent(fileStem)}/${encodeURIComponent(f)}`,
            inline: null,
            name: f,
          })
        }
      }
    } catch { /* ignore */ }
    return out
  }

  return {
    name: 'serve-song-cache-listing',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/song-cache-listing/')) return next()
        if (req.method !== 'GET') return next()

        const slugPart = req.url.slice('/api/song-cache-listing/'.length).split('?')[0]
        const slug = decodeSegment(slugPart)
        if (!slug) return send400BadSegment(res, 'slug')
        const manifest = buildManifest(corpusForReq(req))
        const entry = manifest.find((e) => e.id === slug)
        if (!entry) {
          res.statusCode = 404
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'song not found in manifest' }))
          return
        }
        const fileStem = entry.file.replace(/\.[^.]+$/, '')
        const body = {
          slug,
          fileStem,
          analysis: listAnalysis(slug),
          stems:    listStems(fileStem),
        }
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify(body))
      })
    },
  }
}

function serveStorageStats(): Plugin {
  const stemsDir    = STEMS_DIR
  const analysisDir = ANALYSIS_DIR

  // Recursive directory size, in bytes. Returns 0 for missing paths.
  function dirSize(p: string): number {
    if (!fs.existsSync(p)) return 0
    let total = 0
    try {
      const stat = fs.statSync(p)
      if (stat.isFile()) return stat.size
      if (!stat.isDirectory()) return 0
      for (const name of fs.readdirSync(p)) {
        total += dirSize(path.join(p, name))
      }
    } catch { /* permission errors etc — skip */ }
    return total
  }

  function fileSize(p: string): number {
    try { return fs.existsSync(p) ? fs.statSync(p).size : 0 } catch { return 0 }
  }

  // Sum a per-slug JSON file across every annotator subdir under baseDir.
  function annotationSizeForSlug(baseDir: string, slug: string): number {
    if (!fs.existsSync(baseDir)) return 0
    let total = 0
    try {
      for (const annotator of fs.readdirSync(baseDir)) {
        const p = path.join(baseDir, annotator, `${slug}.json`)
        total += fileSize(p)
      }
    } catch { /* ignore */ }
    return total
  }

  // Compute per-song breakdown. The cache subset is what DELETE will erase.
  // Storage-stats is an admin/researcher surface and operates exclusively on
  // the team corpus (data/) — the demo corpus is read-only and baked into the
  // image, so it never contributes to storage accounting.
  // Sum a per-slug JSON file across every script subdir under a per-script root
  // (used for custom-script algorithm-mode results).
  function customResultsSizeForSlug(slug: string): number {
    const root = DATA_DIRS.customResults
    if (!fs.existsSync(root)) return 0
    let total = 0
    try {
      for (const script of fs.readdirSync(root)) {
        const scriptDir = path.join(root, script)
        try { if (!fs.statSync(scriptDir).isDirectory()) continue } catch { continue }
        total += fileSize(path.join(scriptDir, `${slug}.json`))
      }
    } catch { /* ignore */ }
    return total
  }

  function computeForSong(slug: string, file: string) {
    const fileStem = file.replace(/\.[^.]+$/, '')
    const audioPath = path.join(DATA_DIRS.songs, slug, file)

    const caches = {
      stems:         dirSize(path.join(stemsDir, fileStem)),
      analysis:      dirSize(path.join(analysisDir, slug)),
      msafRaw:       dirSize(path.join(DATA_DIRS.msaf, slug)),
      bpm:           fileSize(path.join(DATA_DIRS.bpmDetections, `${slug}.json`)),
      algoClusters:  fileSize(path.join(DATA_DIRS.algoClusters, `${slug}.json`)),
      mirFeatures:   fileSize(path.join(DATA_DIRS.mirFeatures, `${slug}.json`)),
      customResults: customResultsSizeForSlug(slug),
    }
    const cacheBytes = Object.values(caches).reduce((a, b) => a + b, 0)

    const annotations =
        annotationSizeForSlug(DATA_DIRS.manualAnnotations, slug)
      + annotationSizeForSlug(DATA_DIRS.eyeAnnotations,  slug)
      + annotationSizeForSlug(DATA_DIRS.autoGuessAnnotations, slug)
      + annotationSizeForSlug(DATA_DIRS.songInfo, slug)

    const audio = fileSize(audioPath)
    return { slug, fileStem, caches, cacheBytes, annotations, audio, totalBytes: cacheBytes + annotations + audio }
  }

  return {
    name: 'serve-storage-stats',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/storage')) return next()
        res.setHeader('Access-Control-Allow-Origin', '*')

        // Storage stats reveal corpus shape; deletes wipe regenerable caches
        // across all annotators. Both are admin-only — the Settings page
        // already hides them from everyone else, this is the server-side
        // enforcement so a hand-crafted client can't bypass the UI.
        const { isAdmin, annotatorId } = isAdminForReq(req)
        if (!annotatorId) return send401MissingAnnotator(res)
        if (!isAdmin) return send403NotAdmin(res)

        // GET /api/storage-stats
        if (req.method === 'GET' && (req.url === '/api/storage-stats' || req.url.startsWith('/api/storage-stats?'))) {
          const manifest = buildManifest(TEAM_CORPUS)
          const perSong = manifest.map((e) => computeForSong(e.id, e.file))

          const sum = (key: keyof typeof perSong[number]['caches']) =>
            perSong.reduce((a, s) => a + s.caches[key], 0)

          const totals = {
            stems:         sum('stems'),
            analysis:      sum('analysis'),
            msafRaw:       sum('msafRaw'),
            bpm:           sum('bpm'),
            algoClusters:  sum('algoClusters'),
            mirFeatures:   sum('mirFeatures'),
            customResults: sum('customResults'),
            cacheBytes:    perSong.reduce((a, s) => a + s.cacheBytes, 0),
            annotations:   perSong.reduce((a, s) => a + s.annotations, 0),
            audio:         perSong.reduce((a, s) => a + s.audio, 0),
            totalBytes:    perSong.reduce((a, s) => a + s.totalBytes, 0),
          }

          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ perSong, totals }))
          return
        }

        // DELETE /api/storage/:slug?scope=stems|caches — clear regenerable storage
        // for one song. Default scope is "caches" (preserves the old contract:
        // stems + analysis JSONs + MSAF + BPM + algo-clusters).
        if (req.method === 'DELETE' && req.url.startsWith('/api/storage/')) {
          const rest = req.url.slice('/api/storage/'.length)
          const [slugPart, query = ''] = rest.split('?')
          const slug = decodeSegment(slugPart)
          if (!slug) return send400BadSegment(res, 'slug')
          const scope = new URLSearchParams(query).get('scope') ?? 'caches'
          if (scope !== 'stems' && scope !== 'caches') {
            res.statusCode = 400
            res.end(JSON.stringify({ error: `invalid scope: ${scope}` }))
            return
          }
          const manifest = buildManifest(TEAM_CORPUS)
          const entry = manifest.find((e) => e.id === slug)
          if (!entry) {
            res.statusCode = 404
            res.end(JSON.stringify({ error: 'song not found in manifest' }))
            return
          }
          if (scope === 'stems') clearStemsForSong(entry.file)
          else clearCacheForSong(entry.id, entry.file)
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(computeForSong(entry.id, entry.file)))
          return
        }

        // DELETE /api/storage — clear caches across all songs
        if (req.method === 'DELETE' && (req.url === '/api/storage' || req.url.startsWith('/api/storage?'))) {
          const manifest = buildManifest(TEAM_CORPUS)
          for (const e of manifest) clearCacheForSong(e.id, e.file)
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ cleared: manifest.length }))
          return
        }

        next()
      })
    },
  }
}

// Run Python analysis algorithms for a song in the background and stream logs.
// POST /api/run-algorithms/:slug  → { jobId }
// GET  /api/run-algorithms/status/:jobId → { status, logs, startedAt, finishedAt? }
function serveRunAlgorithms(): Plugin {
  const songsDir = DATA_DIRS.songs
  const repoRoot = path.resolve(__dirname, '..')

  type JobStatus = 'running' | 'done' | 'partial' | 'error' | 'cancelled'
  // Per-section accounting so the UI can show what actually happened
  // (per-algo ✓/✗ in the log isn't enough — the pill bar needs structured
  // counts to decide the section's color, and the summary line needs to
  // honestly report how many ran vs failed vs were already cached).
  // `errors` carries one entry per failed algorithm in this section, keyed
  // by the canonical UI ID (e.g. "msaf-sf", "ruptures-dynp-rbf", "allin1-fold3"),
  // so the sidebar can render a red "failed" pill with the reason as a tooltip
  // next to the matching row. Transient — overwritten by the next job; the
  // user reads the full log pane below the song title for more context.
  interface AlgoError { id: string; message: string }
  interface RunResult { ok: boolean; error?: string }
  interface SectionResult { label: string; total: number; ok: number; failed: number; cached: number; errors?: AlgoError[] }
  interface Job { status: JobStatus; logs: string; sections: SectionResult[]; startedAt: number; finishedAt?: number; killed?: boolean; currentProc?: ReturnType<typeof spawn> }
  const recordFailure = (section: SectionResult, id: string, error: string | undefined) => {
    section.failed++
    if (!section.errors) section.errors = []
    section.errors.push({ id, message: (error ?? 'unknown error').slice(0, 400) })
  }
  const jobs = new Map<string, Job>()
  let jobCounter = 0

  // Algorithm runs always target the team corpus — they write into
  // data/algorithm-outputs/analysis/<slug>/ on disk, and the demo corpus is
  // read-only/baked into the image. Hand-crafted slugs that only exist under
  // data-default/songs/ are rejected.
  function findAudio(slug: string): string | null {
    const dir = path.join(songsDir, slug)
    if (!fs.existsSync(dir)) return null
    for (const f of fs.readdirSync(dir)) {
      if (/\.(mp3|wav|flac|ogg|m4a)$/i.test(f)) return path.join(dir, f)
    }
    return null
  }

  function runStep(job: Job, cmd: string, args: string[], label: string): Promise<RunResult> {
    if (job.killed) return Promise.resolve({ ok: false, error: 'cancelled' })
    job.logs += `\n▶ ${label}\n`
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, { cwd: repoRoot })
      job.currentProc = proc
      // Keep the last non-empty stderr line so we can surface it as the
      // per-algo error reason without bloating the section payload. The full
      // text still streams into job.logs for the run log panel.
      let lastErrLine = ''
      proc.stdout.on('data', (d: Buffer) => { job.logs += d.toString() })
      proc.stderr.on('data', (d: Buffer) => {
        const s = d.toString()
        job.logs += s
        const lines = s.split('\n').map((l) => l.trim()).filter(Boolean)
        if (lines.length) lastErrLine = lines[lines.length - 1].slice(0, 200)
      })
      proc.on('close', (code: number | null) => {
        job.currentProc = undefined
        if (code === 0) { resolve({ ok: true }); return }
        if (!job.killed) job.logs += `[exit ${code}]\n`
        resolve({ ok: false, error: lastErrLine || `exit ${code}` })
      })
      proc.on('error', (err: Error) => {
        job.logs += `error: ${err.message}\n`
        resolve({ ok: false, error: err.message })
      })
    })
  }

  // Run a single ruptures variant by POST-ing to the python server on :8003.
  // Each call writes ruptures-<suffix>.json to the analysis dir.
  function runRupturesOne(job: Job, slug: string, suffix: string): Promise<RunResult> {
    if (job.killed) return Promise.resolve({ ok: false, error: 'cancelled' })
    return new Promise((resolve) => {
      const body = JSON.stringify({ slug, suffix })
      const req = http.request({
        hostname: RUPTURES_HOST, port: 8003, path: '/api/ruptures/analyze', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (resp) => {
        let chunks = ''
        resp.on('data', (d: Buffer) => { chunks += d.toString() })
        resp.on('end', () => {
          if (resp.statusCode === 200) {
            job.logs += `  ✓ ${suffix}\n`
            resolve({ ok: true })
          } else {
            const error = `http ${resp.statusCode}${chunks.trim() ? `: ${chunks.slice(0, 200).trim()}` : ''}`
            job.logs += `  ✗ ${suffix} [${error}]\n`
            resolve({ ok: false, error })
          }
        })
      })
      req.on('error', (err: Error) => {
        const error = `${err.message} (is the ruptures server running on :8003?)`
        job.logs += `  ✗ ${suffix} [${error}]\n`
        resolve({ ok: false, error })
      })
      req.write(body)
      req.end()
    })
  }

  // Run a single SPAN-family detector by POST-ing to the python server on :8009.
  // Each call writes data/algorithm-outputs/span/<slug>/<algo>.json. Same
  // pattern as runRupturesOne / runMsafOne — bubble HTTP failures into the
  // log so the user sees WHY a sidecar didn't fire (most commonly "the
  // experimental-models profile isn't running").
  function runSpanOne(job: Job, slug: string, algo: string): Promise<RunResult> {
    if (job.killed) return Promise.resolve({ ok: false, error: 'cancelled' })
    return new Promise((resolve) => {
      const body = JSON.stringify({ slug, algo })
      const req = http.request({
        hostname: SPAN_HOST, port: 8009, path: '/api/span/detect', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (resp) => {
        let chunks = ''
        resp.on('data', (d: Buffer) => { chunks += d.toString() })
        resp.on('end', () => {
          if (resp.statusCode === 200) {
            // Detector may have returned ok=false inside a 200 (e.g. weights
            // not yet wired for jdcnet-voicing). Surface that as a failure so
            // the pill bar reflects it.
            try {
              const parsed = JSON.parse(chunks)
              if (parsed && parsed.ok === false) {
                const error = parsed.error ?? 'detector reported ok=false'
                job.logs += `  ✗ ${algo} [${error}]\n`
                resolve({ ok: false, error }); return
              }
            } catch { /* fall through to success */ }
            job.logs += `  ✓ ${algo}\n`
            resolve({ ok: true })
          } else {
            const error = `http ${resp.statusCode}${chunks.trim() ? `: ${chunks.slice(0, 200).trim()}` : ''}`
            job.logs += `  ✗ ${algo} [${error}]\n`
            resolve({ ok: false, error })
          }
        })
      })
      req.on('error', (err: Error) => {
        const error = `${err.message} (is the span server running? docker compose --profile experimental-models up span)`
        job.logs += `  ✗ ${algo} [${error}]\n`
        resolve({ ok: false, error })
      })
      req.write(body)
      req.end()
    })
  }

  // Generic single-algo POST against an experimental sidecar at the given
  // (host, port, path) combo. Mirrors runSpanOne but generalized so the LOOP /
  // PANNs / pitch families share the same orchestration code instead of
  // copy-pasting it four times. The body shape `{ slug, algo }` matches every
  // family server's /detect endpoint.
  function runExperimentalOne(
    job: Job, slug: string, algo: string,
    host: string, port: number, apiPath: string, serviceName: string,
    family: string,
  ): Promise<RunResult> {
    if (job.killed) return Promise.resolve({ ok: false, error: 'cancelled' })
    return new Promise((resolve) => {
      const body = JSON.stringify({ slug, algo })
      const req = http.request({
        hostname: host, port, path: apiPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (resp) => {
        let chunks = ''
        resp.on('data', (d: Buffer) => { chunks += d.toString() })
        resp.on('end', () => {
          if (resp.statusCode === 200) {
            try {
              const parsed = JSON.parse(chunks)
              if (parsed && parsed.ok === false) {
                const error = parsed.error ?? 'ok=false'
                job.logs += `  ✗ ${algo} [${error}]\n`
                resolve({ ok: false, error }); return
              }
            } catch { /* fall through to success */ }
            job.logs += `  ✓ ${algo}\n`
            resolve({ ok: true })
          } else {
            const error = `http ${resp.statusCode}${chunks.trim() ? `: ${chunks.slice(0, 200).trim()}` : ''}`
            job.logs += `  ✗ ${algo} [${error}]\n`
            resolve({ ok: false, error })
          }
        })
      })
      req.on('error', (err: Error) => {
        const error = `${err.message} (is the ${family} server running? docker compose --profile experimental-models up ${serviceName})`
        job.logs += `  ✗ ${algo} [${error}]\n`
        resolve({ ok: false, error })
      })
      req.write(body)
      req.end()
    })
  }

  // Run a single MSAF algorithm by POST-ing to the python server on :8002.
  // Each call writes <algorithm>.json to the analysis dir.
  function runMsafOne(job: Job, slug: string, algorithm: string): Promise<RunResult> {
    if (job.killed) return Promise.resolve({ ok: false, error: 'cancelled' })
    return new Promise((resolve) => {
      const body = JSON.stringify({ slug, algorithm })
      const req = http.request({
        hostname: MSAF_HOST, port: 8002, path: '/api/msaf/analyze', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (resp) => {
        let chunks = ''
        resp.on('data', (d: Buffer) => { chunks += d.toString() })
        resp.on('end', () => {
          if (resp.statusCode === 200) {
            job.logs += `  ✓ ${algorithm}\n`
            resolve({ ok: true })
          } else {
            const error = `http ${resp.statusCode}${chunks.trim() ? `: ${chunks.slice(0, 200).trim()}` : ''}`
            job.logs += `  ✗ ${algorithm} [${error}]\n`
            resolve({ ok: false, error })
          }
        })
      })
      req.on('error', (err: Error) => {
        const error = `${err.message} (is the msaf server running on :8002?)`
        job.logs += `  ✗ ${algorithm} [${error}]\n`
        resolve({ ok: false, error })
      })
      req.write(body)
      req.end()
    })
  }

  return {
    name: 'run-algorithms',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        // GET /api/run-algorithms/status/:jobId
        if (req.method === 'GET' && req.url?.startsWith('/api/run-algorithms/status/')) {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Content-Type', 'application/json')
          const jobId = decodeSegment(req.url.slice('/api/run-algorithms/status/'.length), 'jobId')
          if (!jobId) return send400BadSegment(res, 'jobId')
          const job = jobs.get(jobId)
          if (!job) { res.statusCode = 404; res.end('{"error":"job not found"}'); return }
          res.end(JSON.stringify(job))
          return
        }

        // DELETE /api/run-algorithms/cancel/:jobId
        if (req.method === 'DELETE' && req.url?.startsWith('/api/run-algorithms/cancel/')) {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Content-Type', 'application/json')
          const jobId = decodeSegment(req.url.slice('/api/run-algorithms/cancel/'.length), 'jobId')
          if (!jobId) return send400BadSegment(res, 'jobId')
          const job = jobs.get(jobId)
          if (!job) { res.statusCode = 404; res.end('{"error":"job not found"}'); return }
          job.killed = true
          job.status = 'cancelled'
          job.finishedAt = Date.now()
          job.logs += '\n[cancelled by user]\n'
          if (job.currentProc) { try { job.currentProc.kill('SIGTERM') } catch { /* ignore */ } }
          res.end(JSON.stringify({ ok: true }))
          return
        }

        // POST /api/run-algorithms/:slug
        if (req.method !== 'POST' || !req.url?.startsWith('/api/run-algorithms/')) return next()
        const rawSlug = req.url.slice('/api/run-algorithms/'.length)
        if (!rawSlug || rawSlug.startsWith('status/') || rawSlug.startsWith('cancel/')) return next()
        const slug = decodeSegment(rawSlug)
        if (!slug) return send400BadSegment(res, 'slug')

        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        // Algorithm runs write into data/algorithm-outputs/analysis/<slug>/ and
        // can burn minutes of CPU per song — require team membership. Rate
        // limiting + per-user concurrency cap are tracked separately.
        {
          const { isOnTeam, annotatorId } = isOnTeamForReq(req)
          if (!annotatorId) return send401MissingAnnotator(res)
          if (!isOnTeam) return send403NotOnTeam(res)
        }

        const audioPath = findAudio(slug)
        if (!audioPath) { res.statusCode = 404; res.end('{"error":"song not found"}'); return }

        if (rejectIfBodyTooLarge(req, res, MAX_OPTIONS_BODY)) return
        // Parse JSON body for options
        const bodyStr = await new Promise<string>((resolve) => {
          let buf = ''
          req.on('data', (chunk: Buffer) => { buf += chunk.toString() })
          req.on('end', () => resolve(buf))
        })
        let demucsModel = 'htdemucs'
        // algorithms: array of ids like 'msaf-sf', 'msaf-foote', 'allin1', 'allin1-fold0'...'allin1-fold7'
        let algorithms: string[] = [
          'msaf-sf', 'msaf-foote', 'msaf-cnmf', 'msaf-olda', 'allin1',
        ]
        try {
          const parsed = JSON.parse(bodyStr)
          if (parsed.demucsModel) demucsModel = parsed.demucsModel
          if (Array.isArray(parsed.algorithms)) algorithms = parsed.algorithms
        } catch { /* no body / invalid JSON → use defaults */ }

        const analysisDir = path.join(ANALYSIS_DIR, slug)
        const exists = (filename: string) => fs.existsSync(path.join(analysisDir, filename))

        // Determine which MSAF algorithms are requested and not yet done
        const msafRequested = ['sf', 'foote', 'cnmf', 'olda']
          .filter((a) => algorithms.includes(`msaf-${a}`) && !exists(`${a}.json`))

        // Determine which All-In-One models are requested and not yet done
        const allin1Requested = algorithms.filter((a) => {
          if (a !== 'allin1' && !a.startsWith('allin1-fold')) return false
          const filename = a === 'allin1' ? 'allin1.json' : `${a}.json`
          return !exists(filename)
        })

        // Ruptures CPD variants requested (id form: 'ruptures-<suffix>'), filter to missing.
        const rupturesRequested = algorithms
          .filter((a) => a.startsWith('ruptures-'))
          .map((a) => a.slice('ruptures-'.length))
          .filter((suffix) => !exists(`ruptures-${suffix}.json`))

        // Experimental sidecars write their result to disk even when the
        // detector reports `ok: false` (missing weights, missing deps,
        // decode failure) — so a plain file-exists check would lock the
        // row into "cached" state after the first failed attempt and
        // "Run missing" would silently do nothing on retry. Re-run when
        // the file is absent OR contains `ok: false`.
        const isFreshCache = (filepath: string): boolean => {
          if (!fs.existsSync(filepath)) return false
          try {
            const raw = fs.readFileSync(filepath, 'utf-8')
            const parsed = JSON.parse(raw)
            return !(parsed && typeof parsed === 'object' && parsed.ok === false)
          } catch {
            // Unreadable / corrupt cache: treat as missing so the next run
            // overwrites it.
            return false
          }
        }

        // SPAN-family detectors live in their own cache (data/algorithm-outputs/
        // span/<slug>/<algo>.json), not the analysis dir.
        const SPAN_IDS = ['silero-vad', 'jdcnet-voicing']
        const spanDir = path.join(DATA_DIRS.span, slug)
        const spanRequested = algorithms
          .filter((a) => SPAN_IDS.includes(a))
          .filter((a) => !isFreshCache(path.join(spanDir, `${a}.json`)))

        // PANNs (separate sidecar, same SPAN output kind).
        const PANNS_IDS = ['panns-cnn14']
        const pannsRequested = algorithms
          .filter((a) => PANNS_IDS.includes(a))
          .filter((a) => !isFreshCache(path.join(DATA_DIRS.panns, slug, `${a}.json`)))

        // LOOP family (chroma-autocorr).
        const LOOP_IDS = ['chroma-autocorr']
        const loopRequested = algorithms
          .filter((a) => LOOP_IDS.includes(a))
          .filter((a) => !isFreshCache(path.join(DATA_DIRS.loop, slug, `${a}.json`)))

        // CUE-family note-onset detector (basic-pitch).
        const PITCH_IDS = ['basic-pitch']
        const pitchRequested = algorithms
          .filter((a) => PITCH_IDS.includes(a))
          .filter((a) => !isFreshCache(path.join(DATA_DIRS.pitch, slug, `${a}.json`)))

        // CUE-extras trio (librosa key / autochord / librosa onsets).
        const CUE_EXTRAS_IDS = ['librosa-key', 'autochord-chords', 'librosa-onsets']
        const cueExtrasRequested = algorithms
          .filter((a) => CUE_EXTRAS_IDS.includes(a))
          .filter((a) => !isFreshCache(path.join(DATA_DIRS.cueExtras, slug, `${a}.json`)))

        // HPSS percussive (SPAN family, separate sidecar).
        const PERCUSSIVE_IDS = ['hpss-percussive']
        const percussiveRequested = algorithms
          .filter((a) => PERCUSSIVE_IDS.includes(a))
          .filter((a) => !isFreshCache(path.join(DATA_DIRS.percussive, slug, `${a}.json`)))

        // Whisper lyrics.
        const LYRICS_IDS = ['whisper-base']
        const lyricsRequested = algorithms
          .filter((a) => LYRICS_IDS.includes(a))
          .filter((a) => !isFreshCache(path.join(DATA_DIRS.lyrics, slug, `${a}.json`)))

        // Count what the user asked for per family so we can report cached
        // vs newly-run vs failed honestly (e.g. "1 cached, 4 failed" instead
        // of a uniformly green pill bar that hides server outages).
        const msafSelectedCount = ['sf', 'foote', 'cnmf', 'olda']
          .filter((a) => algorithms.includes(`msaf-${a}`)).length
        const allin1SelectedCount = algorithms
          .filter((a) => a === 'allin1' || a.startsWith('allin1-fold')).length
        const rupturesSelectedCount = algorithms
          .filter((a) => a.startsWith('ruptures-')).length
        const spanSelectedCount = algorithms.filter((a) => SPAN_IDS.includes(a)).length

        const jobId = `${++jobCounter}-${Date.now()}`
        const job: Job = { status: 'running', logs: '', sections: [], startedAt: Date.now() }
        jobs.set(jobId, job)
        res.end(JSON.stringify({ jobId }))

        ;(async () => {
          try {
            if (msafSelectedCount > 0) {
              const cached = msafSelectedCount - msafRequested.length
              const section: SectionResult = {
                label: msafRequested.length > 0
                  ? `MSAF (${msafRequested.length} algorithm${msafRequested.length === 1 ? '' : 's'})`
                  : 'MSAF',
                total: msafRequested.length,
                ok: 0, failed: 0, cached,
              }
              job.sections.push(section)
              if (msafRequested.length > 0) {
                job.logs += `\n▶ ${section.label}\n`
                for (const algo of msafRequested) {
                  if (job.killed) break
                  const result = await runMsafOne(job, slug, algo)
                  if (result.ok) section.ok++
                  else recordFailure(section, `msaf-${algo}`, result.error)
                }
              } else {
                job.logs += '\n▶ MSAF\n  (all selected MSAF algorithms already cached)\n'
              }
            }

            if (allin1SelectedCount > 0) {
              const cached = allin1SelectedCount - allin1Requested.length
              const section: SectionResult = {
                label: allin1Requested.length > 0
                  ? `All-In-One (${allin1Requested.length} model${allin1Requested.length === 1 ? '' : 's'})`
                  : 'All-In-One',
                total: allin1Requested.length,
                ok: 0, failed: 0, cached,
              }
              job.sections.push(section)
              if (allin1Requested.length > 0) {
                for (const algoId of allin1Requested) {
                  if (job.killed) break
                  const harmonixModel = algoId === 'allin1' ? 'harmonix-all'
                    : `harmonix-${algoId.replace('allin1-', '')}`
                  const result = await runStep(job, 'python',
                    ['tools/run_allin1.py', audioPath, '--save',
                     '--model', harmonixModel, '--demucs-model', demucsModel],
                    `All-In-One (${harmonixModel})`)
                  if (result.ok) section.ok++
                  else recordFailure(section, algoId, result.error)
                }
              } else {
                job.logs += '\n▶ All-In-One\n  (all selected All-In-One models already cached)\n'
              }
            }

            if (rupturesSelectedCount > 0) {
              const cached = rupturesSelectedCount - rupturesRequested.length
              const section: SectionResult = {
                label: rupturesRequested.length > 0
                  ? `Ruptures CPD (${rupturesRequested.length} variant${rupturesRequested.length === 1 ? '' : 's'})`
                  : 'Ruptures CPD',
                total: rupturesRequested.length,
                ok: 0, failed: 0, cached,
              }
              job.sections.push(section)
              if (rupturesRequested.length > 0) {
                job.logs += `\n▶ ${section.label}\n`
                for (const suffix of rupturesRequested) {
                  if (job.killed) break
                  const result = await runRupturesOne(job, slug, suffix)
                  if (result.ok) section.ok++
                  else recordFailure(section, `ruptures-${suffix}`, result.error)
                }
              } else {
                job.logs += '\n▶ Ruptures CPD\n  (all selected variants already cached)\n'
              }
            }

            if (spanSelectedCount > 0) {
              const cached = spanSelectedCount - spanRequested.length
              const section: SectionResult = {
                label: spanRequested.length > 0
                  ? `SPAN family (${spanRequested.length} detector${spanRequested.length === 1 ? '' : 's'})`
                  : 'SPAN family',
                total: spanRequested.length,
                ok: 0, failed: 0, cached,
              }
              job.sections.push(section)
              if (spanRequested.length > 0) {
                job.logs += `\n▶ ${section.label}\n`
                for (const algo of spanRequested) {
                  if (job.killed) break
                  const result = await runSpanOne(job, slug, algo)
                  if (result.ok) section.ok++
                  else recordFailure(section, algo, result.error)
                }
              } else {
                job.logs += '\n▶ SPAN family\n  (all selected detectors already cached)\n'
              }
            }

            // Generic runner for the three trailing experimental families
            // (PANNs / LOOP / pitch). Each follows the same pattern as the
            // SPAN block above: count, log header, dispatch via the shared
            // `runExperimentalOne` helper, accumulate ok/failed counts.
            const runFamilyBlock = async (
              label: string, ids: string[], host: string, port: number,
              apiPath: string, serviceName: string, requested: string[],
            ) => {
              const selectedCount = algorithms.filter((a) => ids.includes(a)).length
              if (selectedCount === 0) return
              const cached = selectedCount - requested.length
              const section: SectionResult = {
                label: requested.length > 0
                  ? `${label} (${requested.length} detector${requested.length === 1 ? '' : 's'})`
                  : label,
                total: requested.length, ok: 0, failed: 0, cached,
              }
              job.sections.push(section)
              if (requested.length === 0) {
                job.logs += `\n▶ ${label}\n  (all selected detectors already cached)\n`
                return
              }
              job.logs += `\n▶ ${section.label}\n`
              for (const algo of requested) {
                if (job.killed) break
                const result = await runExperimentalOne(
                  job, slug, algo, host, port, apiPath, serviceName, label,
                )
                if (result.ok) section.ok++
                else recordFailure(section, algo, result.error)
              }
            }

            await runFamilyBlock(
              'PANNs (SPAN)', PANNS_IDS, PANNS_HOST, 8013,
              '/api/panns/detect', 'panns', pannsRequested,
            )
            await runFamilyBlock(
              'LOOP family', LOOP_IDS, LOOP_HOST, 8012,
              '/api/loop/detect', 'loop', loopRequested,
            )
            await runFamilyBlock(
              'basic-pitch (CUE)', PITCH_IDS, PITCH_HOST, 8011,
              '/api/pitch/detect', 'pitch', pitchRequested,
            )
            await runFamilyBlock(
              'CUE extras', CUE_EXTRAS_IDS, CUE_EXTRAS_HOST, 8014,
              '/api/cue-extras/detect', 'cue-extras', cueExtrasRequested,
            )
            await runFamilyBlock(
              'HPSS percussive (SPAN)', PERCUSSIVE_IDS, PERCUSSIVE_HOST, 8015,
              '/api/percussive/detect', 'percussive', percussiveRequested,
            )
            await runFamilyBlock(
              'LYRICS family', LYRICS_IDS, LYRICS_HOST, 8016,
              '/api/lyrics/detect', 'lyrics', lyricsRequested,
            )

            if (!job.killed) {
              const totalOk = job.sections.reduce((s, x) => s + x.ok, 0)
              const totalFailed = job.sections.reduce((s, x) => s + x.failed, 0)
              const totalCached = job.sections.reduce((s, x) => s + x.cached, 0)
              if (totalFailed === 0) job.status = 'done'
              else if (totalOk === 0 && totalCached === 0) job.status = 'error'
              else job.status = 'partial'
            }
          } catch (err) {
            if (!job.killed) { job.status = 'error'; job.logs += String(err) }
          }
          if (!job.finishedAt) job.finishedAt = Date.now()
        })()
      })
    },
  }
}

// Proxy /api/run-demucs/* → stems daemon on :8006. The web container is
// node-only and can't spawn python locally, so we forward to the stems
// sidecar which wraps demucs_separator over HTTP.
//
// Endpoints (request/response shape unchanged from the previous spawn-based
// implementation; the frontend doesn't need to know it's now a proxy):
//   POST   /api/run-demucs/:slug         body { force? } → { jobId }
//   GET    /api/run-demucs/status/:jobId                 → { status, logs, startedAt, finishedAt? }
//   DELETE /api/run-demucs/cancel/:jobId                 → { ok }
//
// In dev outside docker, STEMS_HOST defaults to 127.0.0.1 so the developer
// can launch the daemon manually (`python tools/python/stems_server.py`).
// We auto-spawn it on first request — same lazy-start pattern as the BPM
// proxy — so `npm run dev` keeps working without an extra terminal.
function serveRunDemucs(): Plugin {
  const repoRoot = path.resolve(__dirname, '..')
  const serverScript = path.join(repoRoot, 'tools', 'python', 'stems_server.py')
  const autoSpawnEnabled = STEMS_HOST === '127.0.0.1' || STEMS_HOST === 'localhost'
  let stemsProc: ReturnType<typeof spawn> | null = null

  function spawnDaemonIfNeeded(): void {
    if (!autoSpawnEnabled) return
    if (stemsProc && stemsProc.exitCode === null) return
    if (!fs.existsSync(serverScript)) {
      console.warn('[stems] tools/python/stems_server.py not found — auto-start skipped')
      return
    }
    try {
      const proc = spawn('python3', [serverScript], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
      stemsProc = proc
      const log = (data: Buffer) => process.stderr.write(`[stems] ${data.toString()}`)
      proc.stdout?.on('data', log)
      proc.stderr?.on('data', log)
      proc.on('exit', (code) => {
        if (code !== 0 && code !== null) console.warn(`[stems] daemon exited with code ${code}`)
        stemsProc = null
      })
      const stop = () => { try { if (stemsProc?.exitCode === null) stemsProc.kill('SIGTERM') } catch { /* ignore */ } }
      process.once('exit', stop)
      process.once('SIGINT', () => { stop(); process.exit(130) })
      process.once('SIGTERM', stop)
    } catch (err) {
      console.warn('[stems] failed to spawn daemon:', (err as Error).message)
    }
  }

  function proxy(
    req: import('http').IncomingMessage,
    res: import('http').ServerResponse,
    upstreamPath: string,
    body: Buffer,
  ): void {
    const options: http.RequestOptions = {
      hostname: STEMS_HOST,
      port: STEMS_PORT,
      path: upstreamPath,
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
    }
    const upstream = http.request(options, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      })
      upRes.pipe(res)
    })
    upstream.on('error', () => {
      // Daemon may still be booting (cold demucs import ~10-20s) — re-arm the
      // auto-spawn so a slow first request doesn't permanently fail.
      spawnDaemonIfNeeded()
      res.statusCode = 503
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        error: 'Stems daemon unavailable (still loading demucs?).',
        hint: autoSpawnEnabled
          ? 'Retry in a few seconds, or start manually: python tools/python/stems_server.py'
          : 'Check that the `stems` service is running.',
      }))
    })
    if (body.length) upstream.write(body)
    upstream.end()
  }

  return {
    name: 'run-demucs',
    configureServer(server) {
      // Warm the daemon at startup in dev so the first /separate doesn't pay
      // the demucs cold-import penalty.
      if (autoSpawnEnabled) {
        const probe = http.request(
          { hostname: STEMS_HOST, port: STEMS_PORT, path: '/api/stems/health', method: 'GET', timeout: 500 },
          (resp) => { resp.resume(); if (resp.statusCode !== 200) spawnDaemonIfNeeded() },
        )
        probe.on('error', () => spawnDaemonIfNeeded())
        probe.on('timeout', () => { probe.destroy(); spawnDaemonIfNeeded() })
        probe.end()
      }

      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/run-demucs')) return next()

        if (req.method === 'GET' && req.url.startsWith('/api/run-demucs/status/')) {
          const jobId = decodeSegment(req.url.slice('/api/run-demucs/status/'.length), 'jobId')
          if (!jobId) return send400BadSegment(res, 'jobId')
          proxy(req, res, `/api/stems/status/${encodeURIComponent(jobId)}`, Buffer.alloc(0))
          return
        }

        if (req.method === 'DELETE' && req.url.startsWith('/api/run-demucs/cancel/')) {
          const jobId = decodeSegment(req.url.slice('/api/run-demucs/cancel/'.length), 'jobId')
          if (!jobId) return send400BadSegment(res, 'jobId')
          proxy(req, res, `/api/stems/cancel/${encodeURIComponent(jobId)}`, Buffer.alloc(0))
          return
        }

        // Hard kill: SIGKILL the demucs subprocess immediately. Used to
        // escalate when a soft cancel doesn't land within a few seconds.
        if (req.method === 'DELETE' && req.url.startsWith('/api/run-demucs/kill/')) {
          const jobId = decodeSegment(req.url.slice('/api/run-demucs/kill/'.length), 'jobId')
          if (!jobId) return send400BadSegment(res, 'jobId')
          proxy(req, res, `/api/stems/kill/${encodeURIComponent(jobId)}`, Buffer.alloc(0))
          return
        }

        if (req.method !== 'POST') return next()
        const rawSlug = req.url.slice('/api/run-demucs/'.length)
        if (!rawSlug || rawSlug.startsWith('status/') || rawSlug.startsWith('cancel/') || rawSlug.startsWith('kill/')) return next()
        const slug = decodeSegment(rawSlug)
        if (!slug) return send400BadSegment(res, 'slug')

        // Demucs separation is GPU-heavy on the prod VM — team gate.
        {
          const { isOnTeam, annotatorId } = isOnTeamForReq(req)
          if (!annotatorId) return send401MissingAnnotator(res)
          if (!isOnTeam) return send403NotOnTeam(res)
        }

        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          let force = false
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}')
            if (parsed.force === true) force = true
          } catch { /* default */ }
          const body = Buffer.from(JSON.stringify({ slug, force }))
          proxy(req, res, '/api/stems/separate', body)
        })
      })
    },
  }
}

// Persist annotation time per song by embedding a `time_spent_seconds` field
// directly in each annotation JSON (manual-annotations, eye-annotations,
// auto-guess-annotations). The time stays co-located with the annotation it
// describes.
//
// GET  /api/annotation-times/:slug → { slug, perType: { manual, eye, autoGuess } }
// POST /api/annotation-times/:slug body { perType: {...} } — writes the values
//   into each annotation file. A minimal stub `{ song, time_spent_seconds }`
//   is created only when the value is non-zero and no annotation file exists.
function serveAnnotationTimes(): Plugin {
  const manualDir      = DATA_DIRS.manualAnnotations
  const eyeDir       = DATA_DIRS.eyeAnnotations
  const autoGuessDir = DATA_DIRS.autoGuessAnnotations

  type PerType = { manual: number; eye: number; autoGuess: number }

  const readEmbedded = (filePath: string): number => {
    if (!fs.existsSync(filePath)) return 0
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      const v = Number(data?.time_spent_seconds)
      return Number.isFinite(v) && v > 0 ? Math.round(v) : 0
    } catch { return 0 }
  }

  const writeEmbedded = (filePath: string, slug: string, dirPath: string, seconds: number) => {
    const value = Math.max(0, Math.round(seconds))
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        const hasField = typeof data?.time_spent_seconds === 'number'
        // Don't pollute an annotation file with `time_spent_seconds: 0` when it
        // never had one — only update if there's a value to record or a field
        // already exists to keep in sync.
        if (value === 0 && !hasField) return
        fs.writeFileSync(
          filePath,
          JSON.stringify({ ...data, time_spent_seconds: value }, null, 2),
          'utf-8',
        )
        return
      } catch { /* fall through to stub */ }
    }
    if (value > 0) {
      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true })
      fs.writeFileSync(
        filePath,
        JSON.stringify({ song: slug, time_spent_seconds: value }, null, 2),
        'utf-8',
      )
    }
  }

  return {
    name: 'annotation-times',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/annotation-times')) return next()

        const suffix = req.url.slice('/api/annotation-times'.length)
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        const annotatorId = readAnnotatorIdFromReq(req)
        if (!annotatorId) return send401MissingAnnotator(res)

        const match = suffix.match(/^\/([^/]+)$/)
        if (!match) return next()
        const slug = decodeSegment(match[1])
        if (!slug) return send400BadSegment(res, 'slug')

        const manualPath      = ownAnnotationPath(manualDir,      annotatorId, slug)
        const eyePath       = ownAnnotationPath(eyeDir,       annotatorId, slug)
        const autoGuessPath = ownAnnotationPath(autoGuessDir, annotatorId, slug)

        if (req.method === 'GET') {
          const perType: PerType = {
            manual:      readEmbedded(manualPath),
            eye:       readEmbedded(eyePath),
            autoGuess: readEmbedded(autoGuessPath),
          }
          res.end(JSON.stringify({ slug, perType }))
          return
        }

        if (req.method === 'POST') {
          if (rejectIfBodyTooLarge(req, res, MAX_JSON_BODY)) return
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString() })
          req.on('end', () => {
            try {
              const incoming = JSON.parse(body)
              const perType: PerType = {
                manual:      Math.max(0, Math.round(Number(incoming?.perType?.manual)      || 0)),
                eye:       Math.max(0, Math.round(Number(incoming?.perType?.eye)       || 0)),
                autoGuess: Math.max(0, Math.round(Number(incoming?.perType?.autoGuess ?? incoming?.perType?.consensus) || 0)),
              }
              writeEmbedded(manualPath,      slug, path.dirname(manualPath),      perType.manual)
              writeEmbedded(eyePath,       slug, path.dirname(eyePath),       perType.eye)
              writeEmbedded(autoGuessPath, slug, path.dirname(autoGuessPath), perType.autoGuess)
              res.end('{"ok":true}')
            } catch {
              res.statusCode = 400
              res.end('{"error":"invalid json"}')
            }
          })
          return
        }

        next()
      })
    },
  }
}

// Bulk-export all annotations of a given type. Used by the "Download all"
// menu so a single fetch returns every Manual/Eye/Auto-Guess annotation as one
// JSON bundle, rather than the client doing N separate fetches.
//
// GET /api/bulk-annotations/manual        → { exported_at, type, count, annotations: { slug: ann } }
// GET /api/bulk-annotations/eye         → ditto
// GET /api/bulk-annotations/auto-guess  → ditto
// GET /api/bulk-annotations/all         → { exported_at, type:'all', annotations: { slug: { manual, eye, autoGuess } } }
function serveBulkAnnotations(): Plugin {
  const manualDir      = DATA_DIRS.manualAnnotations
  const eyeDir       = DATA_DIRS.eyeAnnotations
  const autoGuessDir = DATA_DIRS.autoGuessAnnotations

  /** Read every annotation file owned by `annotatorId`. */
  function readAllVisible(baseDir: string, annotatorId: string): Record<string, unknown> {
    const files = listOwnAnnotationFiles(baseDir, annotatorId)
    const out: Record<string, unknown> = {}
    for (const [slug, filePath] of Object.entries(files)) {
      try { out[slug] = JSON.parse(fs.readFileSync(filePath, 'utf-8')) }
      catch { /* skip unreadable */ }
    }
    return out
  }

  /** Read across all annotator subdirs: returns slug → annotatorId → annotation. */
  function readAllAnnotators(baseDir: string): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {}
    for (const ann of listAnnotatorDirs(baseDir)) {
      const annDir = path.join(baseDir, ann)
      for (const f of fs.readdirSync(annDir)) {
        if (!f.endsWith('.json')) continue
        const slug = f.slice(0, -5)
        try {
          const data = JSON.parse(fs.readFileSync(path.join(annDir, f), 'utf-8'))
          if (!out[slug]) out[slug] = {}
          out[slug][ann] = data
        } catch { /* skip */ }
      }
    }
    return out
  }

  return {
    name: 'bulk-annotations',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' || !req.url?.startsWith('/api/bulk-annotations/')) return next()

        const url = new URL(req.url, 'http://localhost')
        const kind = url.pathname.slice('/api/bulk-annotations/'.length)
        const scope = url.searchParams.get('scope') ?? 'mine' // 'mine' | 'all'
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        const exported_at = new Date().toISOString()

        // scope=mine requires an annotator header; scope=all is admin- or
        // researcher-only (research / cross-annotator export — exposes
        // every annotator's work).
        let annotatorId: string | null = null
        if (scope === 'all') {
          const info = isResearcherOrAdminForReq(req)
          if (!info.annotatorId) return send401MissingAnnotator(res)
          if (!info.ok) return send403NotAdmin(res)
          annotatorId = info.annotatorId
        } else {
          annotatorId = readAnnotatorIdFromReq(req)
          if (!annotatorId) return send401MissingAnnotator(res)
        }

        if (kind === 'manual' || kind === 'eye' || kind === 'auto-guess') {
          const dir = kind === 'manual' ? manualDir : kind === 'eye' ? eyeDir : autoGuessDir
          if (scope === 'all') {
            const byAnnotator = readAllAnnotators(dir)
            const slugs = Object.keys(byAnnotator).length
            res.end(JSON.stringify({
              exported_at, type: kind, scope: 'all', count: slugs, annotations: byAnnotator,
            }, null, 2))
          } else {
            const annotations = readAllVisible(dir, annotatorId!)
            res.end(JSON.stringify({
              exported_at, type: kind, scope: 'mine', annotator: annotatorId,
              count: Object.keys(annotations).length, annotations,
            }, null, 2))
          }
          return
        }

        if (kind === 'all') {
          if (scope === 'all') {
            const manual      = readAllAnnotators(manualDir)
            const eye       = readAllAnnotators(eyeDir)
            const autoGuess = readAllAnnotators(autoGuessDir)
            const slugs = new Set<string>([
              ...Object.keys(manual), ...Object.keys(eye), ...Object.keys(autoGuess),
            ])
            const annotations: Record<string, {
              manual: Record<string, unknown>;
              eye: Record<string, unknown>;
              autoGuess: Record<string, unknown>;
            }> = {}
            for (const slug of slugs) {
              annotations[slug] = {
                manual: manual[slug] ?? {},
                eye: eye[slug] ?? {},
                autoGuess: autoGuess[slug] ?? {},
              }
            }
            res.end(JSON.stringify({
              exported_at, type: 'all', scope: 'all', count: slugs.size, annotations,
            }, null, 2))
            return
          }
          const manual      = readAllVisible(manualDir,      annotatorId!)
          const eye       = readAllVisible(eyeDir,       annotatorId!)
          const autoGuess = readAllVisible(autoGuessDir, annotatorId!)
          const slugs = new Set<string>([
            ...Object.keys(manual), ...Object.keys(eye), ...Object.keys(autoGuess),
          ])
          const annotations: Record<string, { manual: unknown; eye: unknown; autoGuess: unknown }> = {}
          for (const slug of slugs) {
            annotations[slug] = {
              manual: manual[slug] ?? null,
              eye: eye[slug] ?? null,
              autoGuess: autoGuess[slug] ?? null,
            }
          }
          res.end(JSON.stringify({
            exported_at, type: 'all', scope: 'mine', annotator: annotatorId,
            count: slugs.size, annotations,
          }, null, 2))
          return
        }

        res.statusCode = 404
        res.end('{"error":"unknown bulk type"}')
      })
    },
  }
}

// Cross-annotator bulk read for the user-layer documents (cues/spans/loops/
// patterns live together in one document per (annotator, song)).
//
// GET /api/bulk-annotation-layers?scope=all
//   → { exported_at, scope:'all', count, annotations: { slug: { annotatorId: doc } } }
//     Researcher/admin only — exposes every annotator's user layers.
//
// Exists so the Export Manager can build a {song}/{type}/{annotator}/{layer}.<ext>
// corpus zip without N+1 fetches. The in-process /api/annotation-layers/:slug
// endpoint (serveAnnotationLayers) is still the canonical per-song fetch for
// the current annotator.
function serveLayersBulk(): Plugin {
  const layersDir = DATA_DIRS.annotationLayers

  function readAllAnnotators(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {}
    if (!fs.existsSync(layersDir)) return out
    for (const ann of listAnnotatorDirs(layersDir)) {
      const annDir = path.join(layersDir, ann)
      for (const f of fs.readdirSync(annDir)) {
        if (!f.endsWith('.json')) continue
        const slug = f.slice(0, -5)
        try {
          const data = JSON.parse(fs.readFileSync(path.join(annDir, f), 'utf-8'))
          if (!out[slug]) out[slug] = {}
          out[slug][ann] = data
        } catch { /* skip */ }
      }
    }
    return out
  }

  return {
    name: 'bulk-annotation-layers',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' || !req.url) return next()
        const url = new URL(req.url, 'http://localhost')
        if (url.pathname !== '/api/bulk-annotation-layers') return next()

        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        const scope = url.searchParams.get('scope') ?? 'mine'
        if (scope !== 'all') {
          res.statusCode = 400
          res.end('{"error":"only scope=all is supported here; use /api/annotation-layers/:slug for scope=mine"}')
          return
        }
        const info = isResearcherOrAdminForReq(req)
        if (!info.annotatorId) return send401MissingAnnotator(res)
        if (!info.ok) return send403NotAdmin(res)

        const byAnnotator = readAllAnnotators()
        res.end(JSON.stringify({
          exported_at: new Date().toISOString(),
          scope: 'all',
          count: Object.keys(byAnnotator).length,
          annotations: byAnnotator,
        }, null, 2))
      })
    },
  }
}

// Serve and persist user-created annotation layers at /api/annotation-layers.
// One document per song per annotator holds ALL layer types (cues, spans,
// loops, patterns, lyrics). Served IN-PROCESS so annotation storage never
// depends on the custom-detector sidecar — same model as serveManualAnnotations.
// GET    /api/annotation-layers          → [{ slug, layers: {<type>: {count, status}} }]
// GET    /api/annotation-layers/:slug    → the full layers doc (200 + null if absent)
// POST   /api/annotation-layers/:slug    → write the full doc
// DELETE /api/annotation-layers/:slug    → delete the doc
function serveAnnotationLayers(): Plugin {
  const layersDir = DATA_DIRS.annotationLayers
  if (!fs.existsSync(layersDir)) fs.mkdirSync(layersDir, { recursive: true })

  const LAYER_TYPES = new Set(['cues', 'spans', 'loops', 'patterns', 'lyrics'])

  // Mirror of list_layer_statuses_for_annotator() in custom_server.py: one
  // summary per slug that has a layers doc on disk for this annotator, with the
  // per-type item count and workflow stage the song-list sidebar needs.
  function listStatusesForAnnotator(annotatorId: string) {
    const out: Array<{ slug: string; layers: Record<string, { count: number; status: string }> }> = []
    const annDir = path.join(layersDir, annotatorId)
    if (!fs.existsSync(annDir)) return out
    for (const f of fs.readdirSync(annDir).sort()) {
      if (!f.endsWith('.json')) continue
      let doc: { layers?: unknown; statusByType?: unknown }
      try { doc = JSON.parse(fs.readFileSync(path.join(annDir, f), 'utf-8')) } catch { continue }
      const layers = Array.isArray(doc?.layers) ? doc.layers : null
      if (!layers) continue
      const statusByType = (doc && typeof doc.statusByType === 'object' && doc.statusByType
        ? doc.statusByType : {}) as Record<string, string>
      const perType: Record<string, { count: number; status: string }> = {}
      for (const layer of layers) {
        if (!layer || typeof layer !== 'object') continue
        const t = (layer as { type?: string }).type ?? ''
        if (!LAYER_TYPES.has(t)) continue
        const items = Array.isArray((layer as { items?: unknown }).items) ? (layer as { items: unknown[] }).items : []
        const entry = perType[t] ?? (perType[t] = { count: 0, status: 'in_progress' })
        entry.count += items.length
      }
      for (const t of Object.keys(perType)) {
        const stage = statusByType[t]
        if (stage === 'in_progress' || stage === 'ready_for_review' || stage === 'reviewed') {
          perType[t].status = stage
        }
      }
      if (Object.keys(perType).length > 0) out.push({ slug: f.slice(0, -5), layers: perType })
    }
    return out
  }

  return {
    name: 'annotation-layers',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/annotation-layers')) return next()

        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        const annotatorId = readAnnotatorIdFromReq(req)
        if (!annotatorId) return send401MissingAnnotator(res)

        // Strip the query string before matching the suffix.
        const suffix = req.url.slice('/api/annotation-layers'.length).split('?')[0] // '' | '/' | '/:slug'

        // LIST  GET /api/annotation-layers  or  /api/annotation-layers/
        if (req.method === 'GET' && (suffix === '' || suffix === '/')) {
          res.end(JSON.stringify(listStatusesForAnnotator(annotatorId)))
          return
        }

        const match = suffix.match(/^\/([^/]+)$/)
        if (!match) return next()
        const slug = decodeSegment(match[1])
        if (!slug) return send400BadSegment(res, 'slug')

        const ownPath = path.join(layersDir, annotatorId, `${slug}.json`)

        if (req.method === 'GET') {
          if (fs.existsSync(ownPath)) res.end(fs.readFileSync(ownPath, 'utf-8'))
          // 200 + null body (not 404): "no layers yet for this song" is a
          // normal first-load result, mirroring serveManualAnnotations.
          else res.end('null')
          return
        }

        if (req.method === 'POST') {
          if (rejectIfBodyTooLarge(req, res, MAX_JSON_BODY)) return
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString() })
          req.on('end', () => {
            try {
              const data = JSON.parse(body)
              const ownDir = path.dirname(ownPath)
              if (!fs.existsSync(ownDir)) fs.mkdirSync(ownDir, { recursive: true })
              fs.writeFileSync(ownPath, JSON.stringify(data, null, 2), 'utf-8')
              res.end('{"ok":true}')
            } catch {
              res.statusCode = 400
              res.end('{"error":"invalid json"}')
            }
          })
          return
        }

        if (req.method === 'DELETE') {
          if (fs.existsSync(ownPath)) { fs.unlinkSync(ownPath); res.end('{"ok":true}') }
          else { res.statusCode = 404; res.end('{"ok":false}') }
          return
        }

        next()
      })
    },
  }
}

// List which annotators have any annotation data for a given song, and fetch
// all of them at once for cross-annotator comparison.
//
// GET /api/annotations/:slug/annotators
//   → [{ id, has: { manual, eye, autoGuess } }, ...]
//
// GET /api/annotations/:slug/all
//   → { slug, manual: { <annId>: ManualAnnotation }, eye: {...}, autoGuess: {...} }
//   One round trip; the comparison view uses this instead of N+1 fetches.
function serveAnnotatorListing(): Plugin {
  const manualDir      = DATA_DIRS.manualAnnotations
  const eyeDir       = DATA_DIRS.eyeAnnotations
  const autoGuessDir = DATA_DIRS.autoGuessAnnotations

  function readAllForSlug(baseDir: string, slug: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const annId of listAnnotatorDirs(baseDir)) {
      const p = path.join(baseDir, annId, `${slug}.json`)
      if (!fs.existsSync(p)) continue
      try { out[annId] = JSON.parse(fs.readFileSync(p, 'utf-8')) }
      catch { /* skip */ }
    }
    return out
  }

  // Does any annotation tree already have a subdir for `id`? Used to detect
  // username collisions on the Username sign-in form so two people can't
  // unknowingly share `local-alice`.
  function annotatorIdInUse(id: string): boolean {
    for (const base of [manualDir, eyeDir, autoGuessDir]) {
      if (fs.existsSync(path.join(base, id))) return true
    }
    return false
  }

  return {
    name: 'annotator-listing',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Pre-signup uniqueness check for the Username tab. Public — no auth
        // needed because the caller hasn't signed in yet.
        const availMatch = req.url?.match(/^\/api\/annotators\/id-available\/([^/?]+)(?:\?.*)?$/)
        if (req.method === 'GET' && availMatch) {
          const id = decodeURIComponent(availMatch[1]).toLowerCase()
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Content-Type', 'application/json')
          // Be strict: only allow checking the form that LoginScreen will
          // actually submit (already-prefixed local-... ids). Avoids leaking
          // which Google ids exist. The identity sanitizer permits `@` so
          // an email used as a username (`local-jane@example.com`) is valid.
          if (!/^local-[a-z0-9._@\-]+$/.test(id)) {
            res.statusCode = 400
            res.end('{"error":"invalid id form; expected local-<name>"}')
            return
          }
          res.end(JSON.stringify({ id, available: !annotatorIdInUse(id) }))
          return
        }

        if (req.method !== 'GET' || !req.url?.startsWith('/api/annotations/')) return next()

        const listingMatch = req.url.match(/^\/api\/annotations\/([^/]+)\/annotators(?:\?.*)?$/)
        const allMatch     = req.url.match(/^\/api\/annotations\/([^/]+)\/all(?:\?.*)?$/)
        if (!listingMatch && !allMatch) return next()

        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')
        // /all exposes every annotator's content for a slug — admin or
        // researcher. Researchers need cross-annotator read access for
        // agreement analysis; admins additionally manage members.
        // /annotators only returns which ids have a file, which is metadata
        // the UI needs even for public users (e.g. own-status indicators).
        if (allMatch) {
          const { ok, annotatorId } = isResearcherOrAdminForReq(req)
          if (!annotatorId) return send401MissingAnnotator(res)
          if (!ok) return send403NotAdmin(res)
        } else {
          if (!readAnnotatorIdFromReq(req)) return send401MissingAnnotator(res)
        }

        if (listingMatch) {
          const slug = decodeSegment(listingMatch[1])
          if (!slug) return send400BadSegment(res, 'slug')
          const allIds = new Set<string>([
            ...listAnnotatorDirs(manualDir),
            ...listAnnotatorDirs(eyeDir),
            ...listAnnotatorDirs(autoGuessDir),
          ])
          const fileExists = (base: string, id: string) =>
            fs.existsSync(path.join(base, id, `${slug}.json`))

          const result = Array.from(allIds).map((id) => ({
            id,
            has: {
              manual:      fileExists(manualDir,      id),
              eye:       fileExists(eyeDir,       id),
              autoGuess: fileExists(autoGuessDir, id),
            },
          })).filter((r) => r.has.manual || r.has.eye || r.has.autoGuess)

          res.end(JSON.stringify(result))
          return
        }

        // /all → fan-out fetch for the comparison view
        const slug = decodeSegment(allMatch![1])
        if (!slug) return send400BadSegment(res, 'slug')
        res.end(JSON.stringify({
          slug,
          manual:      readAllForSlug(manualDir,      slug),
          eye:       readAllForSlug(eyeDir,       slug),
          autoGuess: readAllForSlug(autoGuessDir, slug),
        }))
      })
    },
  }
}

// Annotator profile storage — one file per annotator under
// data/annotators/<id>.json. Used so that:
//   • returning Email/Google sign-ins can be recognized and the form can
//     prefill instead of forcing the user to retype name/role/affiliation,
//   • admins can pre-invite annotators from the Team page (writes the
//     profile and adds the email to the team/admin allowlist atomically).
//
// GET    /api/annotators/profile/<id>          → public, 404 if missing
// GET    /api/annotators/profile-by-email/<x>  → public, 404 if no match
// POST   /api/annotators/profile               → public, idempotent
//                                                writes only when missing
// GET    /api/annotators/profiles              → admin-only, list all
// POST   /api/annotators/invite                → admin-only, upsert profile
//                                                + add to team/admin list
// DELETE /api/annotators/profile/<id>          → admin-only
function serveAnnotatorProfiles(): Plugin {
  const profileDir = DATA_DIRS.annotatorProfiles

  /** Ensure the profiles dir exists. Called at startup AND before every
   *  write, so wiping data/annotators (or the whole data/) on a running
   *  server self-heals on the next invite/profile save instead of crashing
   *  with ENOENT (which used to surface as a misleading "invalid json"). */
  function ensureProfileDir(): void {
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true })
  }
  ensureProfileDir()

  function profilePath(id: string): string {
    return path.join(profileDir, `${id}.json`)
  }

  function readProfile(id: string): Record<string, unknown> | null {
    const p = profilePath(id)
    if (!fs.existsSync(p)) return null
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return null }
  }

  function listProfiles(): Array<Record<string, unknown>> {
    if (!fs.existsSync(profileDir)) return []
    const out: Array<Record<string, unknown>> = []
    for (const f of fs.readdirSync(profileDir)) {
      if (!f.endsWith('.json')) continue
      try { out.push(JSON.parse(fs.readFileSync(path.join(profileDir, f), 'utf-8'))) } catch { /* skip */ }
    }
    return out
  }

  function findByEmail(email: string): Record<string, unknown> | null {
    const lower = email.trim().toLowerCase()
    if (!lower) return null
    for (const p of listProfiles()) {
      if (typeof p.email === 'string' && p.email.toLowerCase() === lower) return p
    }
    return null
  }

  function writeAllowlistMutation(mutate: (cfg: Record<string, unknown>) => Record<string, unknown>): void {
    const cfg = readDatasetConfigSafe() ?? {}
    const next = mutate(cfg as Record<string, unknown>)
    // Self-heal: recreate the data dir if it was wiped after server start.
    // Same rationale as ensureProfileDir() — survives an admin clearing the
    // dataset on a running deploy.
    const datasetDir = path.dirname(DATA_FILES.datasetConfig)
    if (!fs.existsSync(datasetDir)) fs.mkdirSync(datasetDir, { recursive: true })
    fs.writeFileSync(DATA_FILES.datasetConfig, JSON.stringify(next, null, 2), 'utf-8')
  }

  function readJsonBody(req: http.IncomingMessage, maxBytes: number = MAX_JSON_BODY): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let body = ''
      let received = 0
      req.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > maxBytes) {
          reject(new Error('request body too large'))
          try { req.destroy() } catch { /* ignore */ }
          return
        }
        body += chunk.toString()
      })
      req.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
      req.on('error', reject)
    })
  }

  return {
    name: 'annotator-profiles',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/annotators/')) return next()
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        // GET /api/annotators/profiles — roster, visible to admin + researcher.
        // Researchers need it to see who has contributed to the dataset.
        if (req.method === 'GET' && req.url.match(/^\/api\/annotators\/profiles(?:\?.*)?$/)) {
          const { ok, annotatorId } = isResearcherOrAdminForReq(req)
          if (!annotatorId) return send401MissingAnnotator(res)
          if (!ok) return send403NotAdmin(res)
          res.end(JSON.stringify({ profiles: listProfiles() }))
          return
        }

        // GET /api/annotators/profile-by-email/<email>
        const byEmail = req.url.match(/^\/api\/annotators\/profile-by-email\/([^/?]+)(?:\?.*)?$/)
        if (req.method === 'GET' && byEmail) {
          const email = decodeURIComponent(byEmail[1])
          const found = findByEmail(email)
          if (!found) { res.statusCode = 404; res.end('{"error":"not found"}'); return }
          res.end(JSON.stringify(found))
          return
        }

        // GET /api/annotators/profile/<id>
        const byIdMatch = req.url.match(/^\/api\/annotators\/profile\/([^/?]+)(?:\?.*)?$/)
        if (req.method === 'GET' && byIdMatch) {
          const id = sanitizeAnnotatorId(decodeURIComponent(byIdMatch[1]))
          if (!id) { res.statusCode = 400; res.end('{"error":"invalid id"}'); return }
          const found = readProfile(id)
          if (!found) { res.statusCode = 404; res.end('{"error":"not found"}'); return }
          res.end(JSON.stringify(found))
          return
        }

        // POST /api/annotators/profile — public, idempotent self-signup
        if (req.method === 'POST' && req.url.match(/^\/api\/annotators\/profile(?:\?.*)?$/)) {
          readJsonBody(req).then((raw) => {
            const data = (raw ?? {}) as Record<string, unknown>
            const id = sanitizeAnnotatorId(typeof data.id === 'string' ? data.id : undefined)
            if (!id) { res.statusCode = 400; res.end('{"error":"invalid or missing id"}'); return }
            if (typeof data.displayName !== 'string' || !data.displayName.trim()) {
              res.statusCode = 400; res.end('{"error":"displayName required"}'); return
            }
            const p = profilePath(id)
            if (fs.existsSync(p)) {
              // Idempotent: don't overwrite an existing profile from an
              // anonymous caller. Admin invites go through /invite which
              // explicitly upserts. Return the existing record so the client
              // can prefill from it.
              res.end(JSON.stringify(readProfile(id)))
              return
            }
            try {
              ensureProfileDir()
              fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8')
            } catch (e) {
              console.error('[annotators/profile] write failed:', p, e)
              res.statusCode = 500
              res.end(JSON.stringify({ error: `profile write failed: ${(e as Error).message}` }))
              return
            }
            res.statusCode = 201
            res.end(JSON.stringify(data))
          }).catch((e) => {
            console.error('[annotators/profile] body parse failed:', e)
            res.statusCode = 400; res.end('{"error":"invalid json"}')
          })
          return
        }

        // POST /api/annotators/invite — admin upserts a profile and adds the
        // identity to the allowlist in one call. The identity field is the
        // same "username or email" string the login screen accepts; the
        // `authMethod` decides which sign-in form gets pre-registered:
        //   - 'google'   → profile stored under the bare email (no prefix);
        //                  invitee must sign in via Google OAuth.
        //   - 'identity' → profile stored under `local-<sanitized>`; if the
        //                  identity is an email the server also pre-authorises
        //                  the Google-form id so the invitee can sign in via
        //                  either route.
        if (req.method === 'POST' && req.url.match(/^\/api\/annotators\/invite(?:\?.*)?$/)) {
          const { isAdmin, annotatorId: caller } = isAdminForReq(req)
          if (!caller) return send401MissingAnnotator(res)
          if (!isAdmin) return send403NotAdmin(res)

          readJsonBody(req).then((raw) => {
            const data = (raw ?? {}) as Record<string, unknown>
            // Accept either the new `identity` field or the legacy `email`
            // field so older callers keep working during the transition.
            const identityRaw = typeof data.identity === 'string'
              ? data.identity.trim()
              : typeof data.email === 'string' ? data.email.trim() : ''
            const displayName = typeof data.displayName === 'string' ? data.displayName.trim() : ''
            const tier: AccessTier = data.tier === 'admin' ? 'admin'
                                    : data.tier === 'researcher' ? 'researcher'
                                    : 'team'
            const authMethod: 'google' | 'identity' = data.authMethod === 'google' ? 'google' : 'identity'
            // Mirror IDENTITY_RE / IDENTITY_MIN_LEN from types/annotator.ts.
            if (!identityRaw || identityRaw.length < 2 || !/^[A-Za-z0-9._@-]+$/.test(identityRaw)) {
              res.statusCode = 400
              res.end('{"error":"valid identity required (username or email, no spaces)"}')
              return
            }
            if (!displayName) {
              res.statusCode = 400; res.end('{"error":"displayName required"}'); return
            }

            const lower = identityRaw.toLowerCase()
            const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lower)
            if (authMethod === 'google' && !isEmail) {
              res.statusCode = 400
              res.end('{"error":"google sign-in requires a valid email"}')
              return
            }
            const sanitized = sanitizeAnnotatorId(lower)!
            // For Google invites: id matches what OAuth produces (bare email).
            // For local invites: id matches what the identity sign-in flow
            // produces (`local-<sanitized>`).
            const id = authMethod === 'google' ? sanitized : `local-${sanitized}`

            const profile = {
              id,
              displayName,
              email: isEmail ? lower : undefined,
              role: typeof data.role === 'string' && data.role.trim() ? data.role.trim() : undefined,
              affiliation: typeof data.affiliation === 'string' && data.affiliation.trim() ? data.affiliation.trim() : undefined,
              authMethod,
              createdAt: new Date().toISOString(),
              invitedBy: caller,
            }
            try {
              ensureProfileDir()
              fs.writeFileSync(profilePath(id), JSON.stringify(profile, null, 2), 'utf-8')

              // Update the unified peopleByEmail allowlist. For Google invites
              // only the bare-email id is registered. For local invites with
              // an email shape, also register the Google-form id so the
              // invitee can sign in via Google equivalently.
              writeAllowlistMutation((cfg) => {
                const seeded = seedPeopleByEmail(cfg as DatasetCfg)
                const now = new Date().toISOString()
                seeded[id] = { tier, invitedAt: now, invitedBy: caller }
                if (authMethod === 'identity' && isEmail) {
                  seeded[sanitized] = { tier, invitedAt: now, invitedBy: caller }
                }
                return writePeopleByEmail(cfg as DatasetCfg, seeded) as unknown as Record<string, unknown>
              })
            } catch (e) {
              console.error('[annotators/invite] write failed for id=', id, e)
              res.statusCode = 500
              res.end(JSON.stringify({ error: `invite write failed: ${(e as Error).message}` }))
              return
            }

            res.statusCode = 201
            res.end(JSON.stringify(profile))
          }).catch((e) => {
            console.error('[annotators/invite] body parse failed:', e)
            res.statusCode = 400; res.end('{"error":"invalid json"}')
          })
          return
        }

        // DELETE /api/annotators/profile/<id> — admin-only.
        if (req.method === 'DELETE' && byIdMatch) {
          const { isAdmin, annotatorId } = isAdminForReq(req)
          if (!annotatorId) return send401MissingAnnotator(res)
          if (!isAdmin) return send403NotAdmin(res)
          const id = sanitizeAnnotatorId(decodeURIComponent(byIdMatch[1]))
          if (!id) { res.statusCode = 400; res.end('{"error":"invalid id"}'); return }
          const p = profilePath(id)
          if (fs.existsSync(p)) fs.unlinkSync(p)
          res.end('{"ok":true}')
          return
        }

        next()
      })
    },
  }
}

// Pre-signup sanity check: does the email's domain accept mail?
//
// GET /api/email/mx-check/<email> → { domain, status }
//   status: "ok"        — MX records resolved (or A/AAAA fallback exists, since
//                         RFC 5321 §5.1 allows mail delivery to an A record
//                         when no MX is published)
//           "no-domain" — NXDOMAIN: the domain does not exist
//           "no-mx"     — domain resolves but has neither MX nor A/AAAA
//           "unknown"   — DNS lookup failed for any other reason (timeout,
//                         servfail, transient network). Client should fail
//                         open here so DNS hiccups don't lock people out.
//
// Public, no auth — used by LoginScreen before the user has signed in to
// catch typos like `gmial.com` and made-up domains like `sapsap.com`. We do
// NOT try to verify the mailbox itself; that requires SMTP probing which
// most providers rate-limit or block.
function serveEmailDomainCheck(): Plugin {
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
  const DNS_TIMEOUT_MS = 3000

  async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('dns-timeout')), ms)),
    ])
  }

  type Status = 'ok' | 'no-domain' | 'no-mx' | 'unknown'

  async function checkDomain(domain: string): Promise<Status> {
    try {
      const mx = await withTimeout(dnsPromises.resolveMx(domain), DNS_TIMEOUT_MS)
      if (mx.length > 0) {
        // RFC 7505 null MX: a single record with priority 0 and an empty
        // exchange ("." on the wire, "" in Node) is an explicit declaration
        // that the domain does NOT accept mail. `sapsap.com` publishes this.
        const allNull = mx.every((r) => r.priority === 0 && (r.exchange === '' || r.exchange === '.'))
        if (allNull) return 'no-mx'
        return 'ok'
      }
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'ENOTFOUND') return 'no-domain'
      if (code !== 'ENODATA') return 'unknown'
      // ENODATA → fall through to A/AAAA fallback
    }
    // No MX but RFC 5321 says mail still delivers to A/AAAA if present.
    try {
      const addrs = await withTimeout(dnsPromises.lookup(domain), DNS_TIMEOUT_MS)
      return addrs.address ? 'ok' : 'no-mx'
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'ENOTFOUND') return 'no-domain'
      return 'unknown'
    }
  }

  return {
    name: 'email-domain-check',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/api\/email\/mx-check\/([^/?]+)(?:\?.*)?$/)
        if (req.method !== 'GET' || !m) return next()

        const email = decodeURIComponent(m[1]).trim().toLowerCase()
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        if (!EMAIL_RE.test(email)) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'invalid email format' }))
          return
        }
        const domain = email.split('@')[1]
        checkDomain(domain).then((status) => {
          res.end(JSON.stringify({ domain, status }))
        }).catch(() => {
          res.end(JSON.stringify({ domain, status: 'unknown' as Status }))
        })
      })
    },
  }
}

// Aggregate per-annotator statistics across every annotation file on disk.
// Used by the Team page to render an at-a-glance dashboard of who has done
// what, how long they spent, and which songs have ≥2 annotators (for the
// agreement view).
//
// GET /api/team-stats
//   → { annotators: [...], multiAnnotatorSongs: string[] }
//
// Walks user dirs only (data/annotations/*) — shipped seeds in data-default
// are excluded so the dashboard reflects real human work.
function serveTeamStats(): Plugin {
  const manualDir      = DATA_DIRS.manualAnnotations
  const eyeDir       = DATA_DIRS.eyeAnnotations
  const autoGuessDir = DATA_DIRS.autoGuessAnnotations
  const customDir    = DATA_DIRS.customAnnotations

  type SourceStats = {
    count: number
    reviewedCount: number
    totalTimeSeconds: number
    totalBoundaries: number
    lastModified: string | null
    songs: string[]
  }

  type CustomStats = {
    count: number
    scripts: string[]
    songs: string[]
  }

  type AnnotatorStats = {
    id: string
    manual: SourceStats
    eye: SourceStats
    autoGuess: SourceStats
    custom: CustomStats
    totalTimeSeconds: number
    totalAnnotations: number
    lastModified: string | null
  }

  function emptySourceStats(): SourceStats {
    return { count: 0, reviewedCount: 0, totalTimeSeconds: 0, totalBoundaries: 0, lastModified: null, songs: [] }
  }

  function newerIso(a: string | null, b: string | null): string | null {
    if (!a) return b
    if (!b) return a
    return a > b ? a : b
  }

  // Walks <baseDir>/<annotatorId>/*.json for manual/eye/autoGuess.
  // `kind` controls how we count "reviewed" and "boundaries" — manual/eye use
  // `reviewed` + `sections`, autoGuess uses `auto_guess_status === 'done'`
  // + `points`.
  function collectStandardSource(
    baseDir: string,
    kind: 'manual' | 'eye' | 'autoGuess',
    accum: Map<string, AnnotatorStats>,
    songAnnotators: Map<string, Set<string>>,
  ) {
    for (const annId of listAnnotatorDirs(baseDir)) {
      const annDir = path.join(baseDir, annId)
      let files: string[] = []
      try { files = fs.readdirSync(annDir).filter((f) => f.endsWith('.json')) }
      catch { continue }

      const entry = accum.get(annId) ?? {
        id: annId,
        manual: emptySourceStats(),
        eye: emptySourceStats(),
        autoGuess: emptySourceStats(),
        custom: { count: 0, scripts: [], songs: [] },
        totalTimeSeconds: 0,
        totalAnnotations: 0,
        lastModified: null,
      }
      const bucket = entry[kind]

      for (const f of files) {
        const slug = f.slice(0, -5)
        let data: Record<string, unknown> = {}
        try { data = JSON.parse(fs.readFileSync(path.join(annDir, f), 'utf-8')) }
        catch { continue }

        bucket.count += 1
        bucket.songs.push(slug)

        const timeSpent = Number(data.time_spent_seconds)
        if (Number.isFinite(timeSpent) && timeSpent > 0) bucket.totalTimeSeconds += timeSpent

        if (kind === 'manual' || kind === 'eye') {
          if (data.reviewed === true) bucket.reviewedCount += 1
          const sections = Array.isArray(data.sections) ? data.sections : []
          bucket.totalBoundaries += sections.length
          const at = typeof data.annotated_at === 'string' ? data.annotated_at : null
          bucket.lastModified = newerIso(bucket.lastModified, at)
        } else {
          if (data.auto_guess_status === 'done') bucket.reviewedCount += 1
          const points = Array.isArray(data.points) ? data.points : []
          bucket.totalBoundaries += points.length
          const at = typeof data.updated_at === 'string'
            ? data.updated_at
            : typeof data.created_at === 'string' ? data.created_at : null
          bucket.lastModified = newerIso(bucket.lastModified, at)
        }

        // Register this (slug, annotator) pair for the multi-annotator song list.
        const set = songAnnotators.get(slug) ?? new Set<string>()
        set.add(annId)
        songAnnotators.set(slug, set)
      }

      accum.set(annId, entry)
    }
  }

  // Walks <customDir>/<script>/<annotatorId>/*.json. Custom annotations are
  // per-script override files; we treat them as a flat count + script list
  // rather than computing boundaries (their schema varies per script).
  function collectCustomSource(
    accum: Map<string, AnnotatorStats>,
    songAnnotators: Map<string, Set<string>>,
  ) {
    if (!fs.existsSync(customDir)) return
    let scripts: string[] = []
    try {
      scripts = fs.readdirSync(customDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch { return }

    for (const script of scripts) {
      const scriptDir = path.join(customDir, script)
      for (const annId of listAnnotatorDirs(scriptDir)) {
        const annDir = path.join(scriptDir, annId)
        let files: string[] = []
        try { files = fs.readdirSync(annDir).filter((f) => f.endsWith('.json')) }
        catch { continue }
        if (files.length === 0) continue

        const entry = accum.get(annId) ?? {
          id: annId,
          manual: emptySourceStats(),
          eye: emptySourceStats(),
          autoGuess: emptySourceStats(),
          custom: { count: 0, scripts: [], songs: [] },
          totalTimeSeconds: 0,
          totalAnnotations: 0,
          lastModified: null,
        }
        entry.custom.count += files.length
        if (!entry.custom.scripts.includes(script)) entry.custom.scripts.push(script)
        for (const f of files) {
          const slug = f.slice(0, -5)
          if (!entry.custom.songs.includes(slug)) entry.custom.songs.push(slug)
          const set = songAnnotators.get(slug) ?? new Set<string>()
          set.add(annId)
          songAnnotators.set(slug, set)
        }
        accum.set(annId, entry)
      }
    }
  }

  return {
    name: 'team-stats',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' || req.url !== '/api/team-stats') return next()

        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')
        // Team Dashboard backend — admin or researcher. Researchers need
        // it for cross-annotator agreement views.
        const { ok, annotatorId } = isResearcherOrAdminForReq(req)
        if (!annotatorId) return send401MissingAnnotator(res)
        if (!ok) return send403NotAdmin(res)

        const accum = new Map<string, AnnotatorStats>()
        const songAnnotators = new Map<string, Set<string>>()
        collectStandardSource(manualDir,      'manual',      accum, songAnnotators)
        collectStandardSource(eyeDir,       'eye',       accum, songAnnotators)
        collectStandardSource(autoGuessDir, 'autoGuess', accum, songAnnotators)
        collectCustomSource(accum, songAnnotators)

        // Roll up per-annotator totals + sort song lists for deterministic output.
        const annotators = Array.from(accum.values()).map((a) => {
          for (const k of ['manual', 'eye', 'autoGuess'] as const) {
            a[k].songs.sort()
          }
          a.custom.songs.sort()
          a.custom.scripts.sort()
          a.totalTimeSeconds = a.manual.totalTimeSeconds + a.eye.totalTimeSeconds + a.autoGuess.totalTimeSeconds
          a.totalAnnotations = a.manual.count + a.eye.count + a.autoGuess.count + a.custom.count
          a.lastModified = newerIso(newerIso(a.manual.lastModified, a.eye.lastModified), a.autoGuess.lastModified)
          return a
        })
        annotators.sort((a, b) => b.totalAnnotations - a.totalAnnotations || a.id.localeCompare(b.id))

        const multiAnnotatorSongs = Array.from(songAnnotators.entries())
          .filter(([, set]) => set.size >= 2)
          .map(([slug]) => slug)
          .sort()

        res.end(JSON.stringify({ annotators, multiAnnotatorSongs }))
      })
    },
  }
}

// GET /api/capabilities → { allin1, demucs, variant, speed, source }
//
// Two detection paths, in order of preference:
//   1. Docker marker: the gpu-tools / cpu-tools / stems image bakes
//      /app/gpu-tools-capabilities.json at build time and its entrypoint
//      publishes it to /app/data/. In a compose deploy the always-on
//      `stems` sidecar guarantees this marker is present within a few
//      seconds of `docker compose up`. We read it as the canonical answer.
//   2. Host-Python probe: when running the dev server outside Docker (e.g.
//      via run.sh), there is no marker — so we spawn `python3` once and
//      try `import allin1; import demucs; torch.cuda.is_available()`.
//      Result is cached for the Vite session. In a CPU-only web container
//      the spawn either times out or fails fast; that's reported as 'absent'.
//
// The richer payload (variant + speed) lets the UI tell the user "fast on
// GPU" vs "works but ~3-5 min/song" vs "not installed", which is the
// actually useful information at the moment they're about to click Run.
type CapabilityVariant = 'cuda' | 'cpu' | 'host' | 'unknown'
type CapabilitySpeed   = 'fast' | 'slow' | 'unknown'
type CapabilitySource  = 'docker-marker' | 'host-python' | 'absent'
interface CapabilitiesPayload {
  allin1: boolean
  demucs: boolean
  variant: CapabilityVariant
  speed: CapabilitySpeed
  source: CapabilitySource
}

// The full `import demucs; import torch; import allin1` chain takes
// ~10-30 s cold on a fresh Python process — too long to block an HTTP
// request on. We kick off the probe asynchronously at server startup and
// once on each ?force=1, so the handler itself stays non-blocking and
// just returns whatever's cached. The 90 s ceiling is generous on
// purpose: a cold first-call after `pip install allin1` on a low-spec
// laptop can flirt with the old 45 s bound.
const PYTHON_PROBE_TIMEOUT_MS = 90_000

// `./run.sh` exports TIMECUES_PYTHON pointing at the interpreter it
// installed model deps into. Honor it so the probe inspects the same
// site-packages — otherwise `spawn('python3', …)` could resolve to a
// different binary on PATH and miss the install.
const PROBE_PYTHON_BIN = process.env.TIMECUES_PYTHON || 'python3'

// Inline Python probe — prints exactly three CSV fields so we don't have to
// pull a JSON parser in. Each `try/except Exception` is broad on purpose:
// the package might fail at import time on any number of upstream issues
// (numpy ABI, missing torch, native deps) and we want "not importable" to
// be one outcome rather than three. This catches broken installs
// (e.g. allin1 with a numpy 2.x conflict) that find_spec would miss.
const PYTHON_PROBE = `
import sys
def _ok(mod):
    try:
        __import__(mod)
        return True
    except Exception:
        return False
has_allin1 = _ok('allin1')
has_demucs = _ok('demucs')
try:
    import torch
    has_cuda = bool(torch.cuda.is_available())
except Exception:
    has_cuda = False
print(f"{int(has_allin1)},{int(has_demucs)},{int(has_cuda)}")
`.trim()

function probeHostPythonAsync(): Promise<CapabilitiesPayload | null> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(PROBE_PYTHON_BIN, ['-c', PYTHON_PROBE], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolve(null)
      return
    }
    let out = ''
    proc.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf-8') })
    // We don't read stderr — torch may print deprecation warnings there which
    // are noise, not signal.
    const killer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* */ } }, PYTHON_PROBE_TIMEOUT_MS)
    proc.on('close', (code) => {
      clearTimeout(killer)
      if (code !== 0) return resolve(null)
      const m = out.trim().match(/^([01]),([01]),([01])$/m)
      if (!m) return resolve(null)
      const allin1 = m[1] === '1'
      const demucs = m[2] === '1'
      const cuda   = m[3] === '1'
      if (!allin1 && !demucs) return resolve(null)
      resolve({
        allin1,
        demucs,
        variant: 'host',
        speed: cuda ? 'fast' : 'slow',
        source: 'host-python',
      })
    })
    proc.on('error', () => { clearTimeout(killer); resolve(null) })
  })
}

function deriveSpeedFromVariant(variant: CapabilityVariant): CapabilitySpeed {
  if (variant === 'cuda') return 'fast'
  if (variant === 'cpu')  return 'slow'
  return 'unknown'
}

const ABSENT_PAYLOAD: CapabilitiesPayload = {
  allin1: false, demucs: false, variant: 'unknown', speed: 'unknown', source: 'absent',
}

function serveCapabilities(): Plugin {
  const markerPath = path.join(REPO_ROOT, 'data', '.gpu-tools-capabilities.json')

  // Background-probe cache. `inflight` lets concurrent ?force=1 requests share
  // a single python process. Cache lives for the Vite session — users who
  // change their Python env just restart the dev server (the typical workflow
  // already requires a restart for new sidecars anyway).
  let probeCache: CapabilitiesPayload | null = null
  let inflight: Promise<CapabilitiesPayload | null> | null = null

  function kickOffProbe(): Promise<CapabilitiesPayload | null> {
    if (!inflight) {
      inflight = probeHostPythonAsync().then((result) => {
        if (result) probeCache = result
        inflight = null
        return result
      })
    }
    return inflight
  }

  function readMarker(): CapabilitiesPayload | null {
    try {
      if (!fs.existsSync(markerPath)) return null
      const raw = JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
      const variant: CapabilityVariant =
        raw.variant === 'cuda' || raw.variant === 'cpu' || raw.variant === 'host'
          ? raw.variant : 'unknown'
      return {
        allin1: raw.allin1 === true,
        demucs: raw.demucs === true,
        variant,
        speed: deriveSpeedFromVariant(variant),
        source: 'docker-marker',
      }
    } catch {
      return null
    }
  }

  return {
    name: 'serve-capabilities',
    configureServer(server) {
      // Warm the cache at server startup so the first Settings-page load
      // is fast. If a marker is already present the probe is skipped.
      if (!readMarker()) kickOffProbe()

      server.middlewares.use((req, res, next) => {
        if (req.url !== '/api/capabilities' && !req.url?.startsWith('/api/capabilities?')) return next()
        if (req.method !== 'GET') return next()
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        // 1. Docker marker is the authoritative source when present (gpu-tools
        //    or cpu-tools profile published it via the container entrypoint).
        const marker = readMarker()
        if (marker) { res.end(JSON.stringify(marker)); return }

        // 2. No marker — return the cached host-python probe result if we have
        //    one. ?force=1 invalidates the cache and kicks off a fresh probe.
        const force = !!req.url?.includes('force=1')
        if (force) {
          probeCache = null
          // Force callers get the freshly-probed answer synchronously (worth
          // a 10-20s wait since this is an explicit user click).
          kickOffProbe().then((result) => {
            res.end(JSON.stringify(result ?? ABSENT_PAYLOAD))
          })
          return
        }
        // Non-force callers get whatever's currently cached. The startup
        // probe will populate it shortly if it hasn't already.
        res.end(JSON.stringify(probeCache ?? ABSENT_PAYLOAD))
      })
    },
  }
}

// After build, remove dist/stems/ to avoid duplicating the large wav files
function excludeStemsFromDist(): Plugin {
  return {
    name: 'exclude-stems-from-dist',
    closeBundle() {
      const stemsDir = path.resolve(__dirname, 'dist/stems')
      if (fs.existsSync(stemsDir)) {
        fs.rmSync(stemsDir, { recursive: true, force: true })
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), serveManifest(), serveAnalysis(), serveSongAudio(), serveStems(), serveManualAnnotations(), serveAutoGuessAnnotations(), serveEyeAnnotations(), serveSongInfo(), serveLyricsText(), serveDatasetConfig(), serveAlgoClusters(), serveAnnotationTimes(), serveUploadSong(), serveUploadStems(), serveSongsAdmin(), serveDatasetAdmin(), serveRunAlgorithms(), serveRunDemucs(), serveBulkAnnotations(), serveLayersBulk(), serveAnnotationLayers(), serveAnnotatorListing(), serveAnnotatorProfiles(), serveEmailDomainCheck(), serveTeamStats(), proxyMirEval(), proxyMir(), proxyRuptures(), proxyBpm(), proxySpan(), proxyBeatnet(), proxyLoop(), proxyPanns(), proxyPitch(), proxyCueExtras(), proxyPercussive(), proxyLyrics(), proxyCustomScripts(), serveSongCacheListing(), serveStorageStats(), serveCapabilities(), excludeStemsFromDist()],
  optimizeDeps: {
    exclude: ['wavesurfer.js'],
  },
  server: {
    // Comma-separated list (e.g. "timecues.example.com,app.example.com")
    // wired in by docker-compose.prod.yml from TIMECUES_DOMAIN. Vite blocks
    // requests whose Host header isn't in this list — necessary when serving
    // behind a reverse proxy on a public domain.
    allowedHosts: process.env.VITE_ALLOWED_HOSTS
      ? process.env.VITE_ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
  },
})
