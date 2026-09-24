// Shared-song annotation storage: the on-disk half of collaborative editing.
//
// A song is either SOLO (every annotator keeps their own layers document at
// annotations/layers/<annotator>/<slug>.json — the default, and the only mode
// before this module existed) or SHARED (one document for the whole team).
//
// A shared song gets a FOLDER rather than a file:
//
//   data/annotations/shared/<slug>/layers.json   the one document
//   data/annotations/shared/<slug>/.git/         one commit per handover
//
// The git repo is the point. Editing rights pass from person to person, and
// every pass is a commit, so "who had it, what did they leave behind, put it
// back the way Alice had it" are `git log` / `git show` rather than features we
// have to build. The repo is initialised when the shared folder is created and
// is never rewritten — restoring an old version writes a NEW commit.
//
// The lease that says who may write lives OUTSIDE the repo, at
// annotations/locks/<slug>.json, so acquiring and releasing a lock — which
// happens constantly and changes no annotation — never shows up in history.
//
// Everything here is best-effort and non-throwing: a missing git binary, a
// corrupt lock file or a failed commit must never take down an annotation
// save. Callers get `false`/`null` and the annotation still lands on disk.

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { DATA_DIRS } from '../dataPaths'

// ─── Timing ─────────────────────────────────────────────────────────────────
//
// Two independent signals, because they answer different questions:
//
//   renewedAt  — the holder's tab said "still here" (heartbeat). Proves a tab
//                is OPEN, nothing more, so the client only beats while the
//                document is visible.
//   lastEditAt — a write actually landed. Proves a PERSON is working.
//
// Nothing is ever auto-released on either signal. They only decide what the UI
// says and how loudly a take-over asks for confirmation, which is why being
// approximately right is good enough.

/** How often a holder's tab re-asserts the lease. */
export const HEARTBEAT_MS = 60_000
/** Missed beats before we stop claiming the holder's tab is open. Three, so a
 *  wifi flap or a lid-close-and-reopen doesn't declare anyone gone. */
export const STALE_AFTER_MS = 3 * HEARTBEAT_MS
/** Holder is present but has written nothing for this long. Cosmetic only. */
export const IDLE_AFTER_MS = 10 * 60_000

// ─── Paths ──────────────────────────────────────────────────────────────────

export function sharedSongDir(slug: string): string {
  return path.join(DATA_DIRS.sharedAnnotations, slug)
}

export function sharedDocPath(slug: string): string {
  return path.join(sharedSongDir(slug), 'layers.json')
}

export function lockPath(slug: string): string {
  return path.join(DATA_DIRS.annotationLocks, `${slug}.json`)
}

/** Fallback version store used only when no git binary is available. Keeps the
 *  "every handover is recoverable" promise on installs we can't commit on. */
function versionsDir(slug: string): string {
  return path.join(sharedSongDir(slug), '.versions')
}

/** Is this song set up for shared editing? The folder IS the answer — a shared
 *  song has one, a solo song doesn't — so nothing can drift out of sync with a
 *  flag somewhere else. */
export function isSharedSong(slug: string): boolean {
  try { return fs.statSync(sharedSongDir(slug)).isDirectory() } catch { return false }
}

/** Every slug currently set up for shared editing. */
export function listSharedSlugs(): string[] {
  try {
    return fs.readdirSync(DATA_DIRS.sharedAnnotations, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch { return [] }
}

// ─── Atomic document writes ─────────────────────────────────────────────────

/** Write JSON via temp-file + rename so a crash mid-write can't truncate a
 *  document. The previous whole-file overwrite left a half-written annotation
 *  on disk if the process died between open and close. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function readJsonSafe<T>(filePath: string): T | null {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T } catch { return null }
}

// ─── The lease ──────────────────────────────────────────────────────────────

export interface LockRecord {
  slug: string
  /** Annotator id. The lease belongs to the PERSON, not the tab, so a reload
   *  reclaims it instead of losing it. */
  holder: string
  /** Which tab holds it. A second tab of the same person takes over from the
   *  first (and the first is told so) rather than both writing blind. */
  sessionId: string
  acquiredAt: string
  /** Last heartbeat. */
  renewedAt: string
  /** Last time a write landed. Null until the holder actually changes something. */
  lastEditAt: string | null
  /** Set when this lease displaced a live one, for the history trail. */
  stolenFrom?: string | null
}

/** A lease as the UI needs it: the record plus everything derived from `now`,
 *  computed server-side so a browser with a skewed clock can't render
 *  "idle -3 minutes". */
export interface LockView extends LockRecord {
  holderName: string
  expiresAt: string
  /** No heartbeat for STALE_AFTER_MS — the holder's tab is probably gone.
   *  Note "probably": we observed silence, not a closed tab. */
  stale: boolean
  /** Present, but nothing written for IDLE_AFTER_MS. */
  idle: boolean
  /** Since the last write (or since acquisition, if they never wrote). */
  idleMs: number
  heldMs: number
}

export function readLock(slug: string): LockRecord | null {
  const rec = readJsonSafe<LockRecord>(lockPath(slug))
  if (!rec || typeof rec.holder !== 'string' || typeof rec.sessionId !== 'string') return null
  return rec
}

export function writeLock(rec: LockRecord): void {
  writeJsonAtomic(lockPath(rec.slug), rec)
}

export function removeLock(slug: string): void {
  try { fs.rmSync(lockPath(slug), { force: true }) } catch { /* best-effort */ }
}

export function listLocks(): LockRecord[] {
  let names: string[]
  try { names = fs.readdirSync(DATA_DIRS.annotationLocks) } catch { return [] }
  const out: LockRecord[] = []
  for (const f of names) {
    if (!f.endsWith('.json')) continue
    const rec = readLock(f.slice(0, -5))
    if (rec) out.push(rec)
  }
  return out
}

export function isStale(rec: LockRecord, now: number): boolean {
  return now - Date.parse(rec.renewedAt) > STALE_AFTER_MS
}

export function viewLock(
  rec: LockRecord,
  now: number,
  resolveName: (id: string) => string,
): LockView {
  const since = Date.parse(rec.lastEditAt ?? rec.acquiredAt)
  const idleMs = Math.max(0, now - since)
  return {
    ...rec,
    holderName: resolveName(rec.holder),
    expiresAt: new Date(Date.parse(rec.renewedAt) + STALE_AFTER_MS).toISOString(),
    stale: isStale(rec, now),
    idle: idleMs > IDLE_AFTER_MS,
    idleMs,
    heldMs: Math.max(0, now - Date.parse(rec.acquiredAt)),
  }
}

/** May `annotatorId` (in tab `sessionId`) take the lease right now?
 *
 *  Free, stale, or already theirs → yes. Someone else's live lease → no, and
 *  the caller surfaces WHO, so the decision to take over is a human one made
 *  with the evidence visible. */
export function canAcquire(
  rec: LockRecord | null,
  annotatorId: string,
  now: number,
): boolean {
  if (!rec) return true
  if (rec.holder === annotatorId) return true
  return isStale(rec, now)
}

export function newLock(
  slug: string,
  holder: string,
  sessionId: string,
  now: number,
  stolenFrom?: string | null,
): LockRecord {
  const iso = new Date(now).toISOString()
  return {
    slug, holder, sessionId,
    acquiredAt: iso,
    renewedAt: iso,
    lastEditAt: null,
    stolenFrom: stolenFrom ?? null,
  }
}

/** Stamp "a write landed" onto the live lease. Called from the annotation save
 *  path, so activity is measured by writes hitting disk — not by mouse
 *  movement, and not by a timer the client could get wrong. */
export function touchLockEdit(slug: string, annotatorId: string, now: number): void {
  const rec = readLock(slug)
  if (!rec || rec.holder !== annotatorId) return
  rec.lastEditAt = new Date(now).toISOString()
  rec.renewedAt = rec.lastEditAt
  try { writeLock(rec) } catch { /* best-effort */ }
}

// ─── Git ────────────────────────────────────────────────────────────────────

let gitAvailable: boolean | null = null

/** Is there a git binary? Probed once per process. The docker web image
 *  installs one (see docker/web.Dockerfile); a bare `npm run dev` uses the
 *  host's. When there is none we fall back to timestamped copies, so history
 *  degrades in fidelity but never disappears. */
export function hasGit(): boolean {
  if (gitAvailable === null) {
    try {
      gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0
    } catch { gitAvailable = false }
  }
  return gitAvailable
}

/** For tests: forget the cached probe. */
export function resetGitProbe(): void { gitAvailable = null }

interface GitResult { ok: boolean; stdout: string; stderr: string }

/** Run git inside a shared song's repo.
 *
 *  Hermetic on purpose: system and global config are switched off so a
 *  maintainer's `~/.gitconfig` (hooks, templates, signing, a `commit.gpgsign`
 *  that would block every commit) can never reach into the server's write
 *  path. `safe.directory` is set per-call because the data tree is bind-mounted
 *  and may be owned by a different uid than the process. */
function runGit(dir: string, args: string[]): GitResult {
  if (!hasGit()) return { ok: false, stdout: '', stderr: 'git not available' }
  try {
    const r = spawnSync('git', ['-C', dir, '-c', `safe.directory=${dir}`, ...args], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  } catch (err) {
    return { ok: false, stdout: '', stderr: String(err) }
  }
}

/** Commits are attributed to the annotator, so `git log` reads as a record of
 *  who did what. The id is an email in every real deployment; ids that aren't
 *  (the `local-…` usernames) get a synthetic address git will accept. */
function identityArgs(holder: string, holderName: string): string[] {
  const email = holder.includes('@') ? holder : `${holder}@timecues.local`
  const name = holderName || holder
  return [
    '-c', `user.name=${name}`,
    '-c', `user.email=${email}`,
    '-c', 'commit.gpgsign=false',
  ]
}

export interface CommitMeta {
  /** What moved the document between people. */
  event: 'seed' | 'unlock' | 'takeover' | 'stale-claim' | 'acquire' | 'restore'
  holder: string
  holderName: string
  rev: number
  /** Seconds the outgoing holder held the lease, when known. */
  heldSeconds?: number | null
  /** For `restore`: the commit whose content was brought back. */
  restoredFrom?: string | null
  counts?: Record<string, number>
}

function commitMessage(slug: string, meta: CommitMeta): string {
  const subject = `${meta.event}(${slug}): ${meta.holderName || meta.holder}`
  const trailers = [
    `Event: ${meta.event}`,
    `Annotator: ${meta.holder}`,
    `Rev: ${meta.rev}`,
  ]
  if (meta.heldSeconds != null) trailers.push(`Held-Seconds: ${Math.round(meta.heldSeconds)}`)
  if (meta.restoredFrom) trailers.push(`Restored-From: ${meta.restoredFrom}`)
  if (meta.counts && Object.keys(meta.counts).length > 0) {
    trailers.push(`Items: ${Object.entries(meta.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  }
  return `${subject}\n\n${trailers.join('\n')}\n`
}

/** Create the shared folder and its repo. Idempotent: an existing folder is
 *  left exactly as it is, so a second "make this collaborative" click can't
 *  wipe the team's work. */
export function initSharedRepo(slug: string, meta: CommitMeta, doc: unknown): {
  created: boolean; committed: boolean; sha: string | null
} {
  const dir = sharedSongDir(slug)
  if (fs.existsSync(dir)) return { created: false, committed: false, sha: null }

  fs.mkdirSync(dir, { recursive: true })
  writeJsonAtomic(sharedDocPath(slug), doc)

  if (hasGit()) {
    // `-c init.defaultBranch` silences git's advice banner; the branch name is
    // immaterial here since nothing ever pushes.
    runGit(dir, ['-c', 'init.defaultBranch=main', 'init', '-q'])
  }
  const { committed, sha } = commitSharedDoc(slug, meta)
  return { created: true, committed, sha }
}

/** Record the current state of a shared document as one version.
 *
 *  Called on every lease transition. Returns `committed: false` when nothing
 *  changed — a lock/unlock with no edits in between leaves no trace, so the
 *  history stays a list of real changes rather than a list of clicks. */
export function commitSharedDoc(slug: string, meta: CommitMeta): {
  committed: boolean; sha: string | null
} {
  const dir = sharedSongDir(slug)
  if (!fs.existsSync(sharedDocPath(slug))) return { committed: false, sha: null }

  if (!hasGit()) return { committed: fallbackVersion(slug, meta), sha: null }

  const add = runGit(dir, ['add', '--', 'layers.json'])
  if (!add.ok) return { committed: false, sha: null }

  // Nothing staged → nothing happened worth recording. `diff --cached --quiet`
  // exits 0 when the index matches HEAD; on a fresh repo with no HEAD it fails,
  // which is correct — the seed commit must go through.
  const hasHead = runGit(dir, ['rev-parse', '--verify', '-q', 'HEAD']).ok
  if (hasHead && runGit(dir, ['diff', '--cached', '--quiet']).ok) {
    return { committed: false, sha: null }
  }

  const commit = runGit(dir, [
    ...identityArgs(meta.holder, meta.holderName),
    'commit', '-q', '--no-verify', '-m', commitMessage(slug, meta),
  ])
  if (!commit.ok) return { committed: false, sha: null }

  const sha = runGit(dir, ['rev-parse', 'HEAD']).stdout.trim()
  return { committed: true, sha: sha || null }
}

/** No git binary: keep a full copy per handover instead. Same promise, no
 *  diffing. */
function fallbackVersion(slug: string, meta: CommitMeta): boolean {
  try {
    const dir = versionsDir(slug)
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.copyFileSync(
      sharedDocPath(slug),
      path.join(dir, `${stamp}-${meta.event}-${meta.holder}.json`),
    )
    return true
  } catch { return false }
}

export interface HistoryEntry {
  sha: string
  date: string
  author: string
  email: string
  subject: string
  event: string
  rev: number | null
}

const FIELD_SEP = '\x1f'
/** Commits are separated by a record mark, not a newline: a trailer value
 *  expands with its own trailing newline, so one-line-per-commit parsing
 *  silently splits every entry into three. */
const RECORD_SEP = '\x1e'

/** Version history for a shared song, newest first. */
export function historyFor(slug: string, limit = 100): HistoryEntry[] {
  const dir = sharedSongDir(slug)
  if (!hasGit() || !fs.existsSync(path.join(dir, '.git'))) return []
  const fmt = [
    '%H', '%aI', '%an', '%ae', '%s',
    '%(trailers:key=Event,valueonly)',
    '%(trailers:key=Rev,valueonly)',
  ].join(FIELD_SEP) + RECORD_SEP
  const r = runGit(dir, ['log', `--max-count=${limit}`, `--pretty=format:${fmt}`])
  if (!r.ok || !r.stdout.trim()) return []
  return r.stdout.split(RECORD_SEP)
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, date, author, email, subject, event, rev] = rec.split(FIELD_SEP)
      const revText = (rev ?? '').trim()
      return {
        sha: (sha ?? '').trim(),
        date: (date ?? '').trim(),
        author: (author ?? '').trim(),
        email: (email ?? '').trim(),
        subject: (subject ?? '').trim(),
        event: (event ?? '').trim(),
        rev: revText && Number.isFinite(Number(revText)) ? Number(revText) : null,
      }
    })
}

/** The document as it stood at one commit. Used to preview or restore a
 *  version; restoring writes a NEW commit rather than moving the branch, so
 *  history is append-only and a wrong restore is itself undoable. */
export function readVersion(slug: string, sha: string): unknown | null {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) return null
  const r = runGit(sharedSongDir(slug), ['show', `${sha}:layers.json`])
  if (!r.ok) return null
  try { return JSON.parse(r.stdout) } catch { return null }
}

/** Remove everything belonging to a shared song. Called when a song is deleted
 *  — the shared document, its whole version history, and any lease. */
export function removeSharedSong(slug: string): void {
  try { fs.rmSync(sharedSongDir(slug), { recursive: true, force: true }) } catch { /* best-effort */ }
  removeLock(slug)
}
