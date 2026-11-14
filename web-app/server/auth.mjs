// ─── Sign-in sessions ────────────────────────────────────────────────────────
//
// Who a request comes from used to be whatever it said: the X-Annotator-Id
// header, or the annotator_id cookie the page writes for itself. Typing an
// admin's address into either was being that admin. Now the server decides.
//
//   • Google sign-in posts the ID token Google handed the page. We check
//     Google's signature on it (RS256 against Google's published keys), that
//     it was issued for OUR client id, that it has not expired and that the
//     address is verified — and only then is the address an identity.
//   • Username sign-in is passwordless, so it proves nothing. It opens a
//     session only from this machine (a dev server, an SSH tunnel), or where
//     the operator says so with TC_LOCAL_LOGIN=1. On the public site it is
//     refused and Google is the way in.
//
// Either way the server answers with its own session: an HttpOnly cookie
// carrying {id, method, exp}, HMAC-signed with a secret that never leaves the
// server. The page cannot read it or forge it.
//
// The header and the annotator_id cookie still matter for one thing: they can
// say "demo-anonymous". Stepping DOWN into the public demo needs no proof, so a
// member who opens the demo is a demo visitor. Any other claim is ignored —
// the session alone says who you are.
//
// No dependency: node:crypto verifies the JWT and signs the cookie.
//
// Shared by vite.config.ts and the private server/ext.mjs, hence plain ESM.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const DEMO_ID = 'demo-anonymous'
export const SESSION_COOKIE = 'tc_session'
const SESSION_DAYS = 30
const ANNOTATOR_ID_RE = /^[a-z0-9._@+\-]+$/
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])

export function sanitizeAnnotatorId(raw) {
  if (raw == null) return null
  const v = (Array.isArray(raw) ? raw[0] : raw).trim().toLowerCase()
  if (!v || v === '.' || v === '..') return null
  if (v.includes('/') || v.includes('\\') || v.includes('..')) return null
  return ANNOTATOR_ID_RE.test(v) ? v : null
}

export function readCookie(req, name) {
  const raw = req.headers.cookie
  if (typeof raw !== 'string' || raw.length === 0) return null
  for (const pair of raw.split(';')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    if (pair.slice(0, eq).trim() !== name) continue
    try { return decodeURIComponent(pair.slice(eq + 1).trim()) } catch { return null }
  }
  return null
}

// ── the secret ───────────────────────────────────────────────────────────────

let secret = null

/** TC_SESSION_SECRET when set; otherwise a random one kept at
 *  <dataRoot>/.auth-secret (gitignored with the rest of data/), so sessions
 *  survive a restart. Rotating it signs everybody out. */
export function initAuth({ dataRoot }) {
  if (secret) return
  if (process.env.TC_SESSION_SECRET) {
    secret = Buffer.from(process.env.TC_SESSION_SECRET, 'utf-8')
    return
  }
  const file = path.join(dataRoot, '.auth-secret')
  try {
    secret = Buffer.from(fs.readFileSync(file, 'utf-8').trim(), 'base64')
    if (secret.length >= 32) return
  } catch { /* first start */ }
  secret = crypto.randomBytes(48)
  fs.mkdirSync(dataRoot, { recursive: true })
  fs.writeFileSync(file, secret.toString('base64') + '\n', { mode: 0o600 })
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url')
}

function sign(payload) {
  if (!secret) throw new Error('initAuth() was not called')
  return crypto.createHmac('sha256', secret).update(payload).digest()
}

// ── sessions ─────────────────────────────────────────────────────────────────

export function makeSession(id, method, now = Date.now()) {
  const payload = b64url(JSON.stringify({ id, m: method, exp: now + SESSION_DAYS * 864e5 }))
  return `${payload}.${b64url(sign(payload))}`
}

/** {id, method} from a valid, unexpired session value, else null. */
export function parseSession(value, now = Date.now()) {
  if (typeof value !== 'string' || !secret) return null
  const dot = value.indexOf('.')
  if (dot < 1) return null
  const payload = value.slice(0, dot)
  let given
  try { given = Buffer.from(value.slice(dot + 1), 'base64url') } catch { return null }
  const want = sign(payload)
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null
  let data
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) } catch { return null }
  if (!data || typeof data.exp !== 'number' || data.exp <= now) return null
  const id = sanitizeAnnotatorId(data.id)
  if (!id || id === DEMO_ID) return null
  return { id, method: data.m === 'google' ? 'google' : 'local' }
}

/** This install's own session cookie: `tc_session_<8 hex of its secret>`.
 *
 *  Cookies are scoped by host, not port, so every TimeCues on localhost — the
 *  Docker app on :5173, a dev server on :5174 — reads and writes the same
 *  `tc_session`. Each signs it with its own secret, so signing in on one
 *  replaced the other's cookie with one it could not verify: that install
 *  then saw nobody, while its page still showed the saved name. A name per
 *  secret lets them sit side by side. */
export function sessionCookieName() {
  if (!secret) throw new Error('initAuth() was not called')
  return `${SESSION_COOKIE}_${crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8)}`
}

export function sessionFromReq(req) {
  // The shared legacy name is still honoured, so sessions issued before the
  // per-install name keep working — it only counts if this install signed it.
  return parseSession(readCookie(req, sessionCookieName()))
    ?? parseSession(readCookie(req, SESSION_COOKIE))
}

function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true
  const proto = req.headers['x-forwarded-proto']
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https'
}

export function setSessionCookie(req, res, value) {
  const cookie = (name, v) => {
    const parts = [`${name}=${v}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${v ? SESSION_DAYS * 86400 : 0}`]
    if (isHttps(req)) parts.push('Secure')
    return parts.join('; ')
  }
  // Signing in or out also clears the shared legacy cookie, which may hold
  // this install's old session or a neighbour's — either way not ours to keep.
  const next = [cookie(sessionCookieName(), value), cookie(SESSION_COOKIE, '')]
  const prev = res.getHeader('Set-Cookie')
  res.setHeader('Set-Cookie', prev ? [].concat(prev, next) : next)
}

/** Who this request is from. A claim of the demo id is honoured (stepping
 *  down needs no proof); otherwise only the signed session counts.
 *  TC_TRUST_ANNOTATOR_HEADER=1 restores the old trust-the-claim behaviour, for
 *  scripts on a dev machine that cannot sign in — never set it on a server
 *  anyone else can reach. */
export function annotatorIdFromReq(req) {
  const claim = sanitizeAnnotatorId(req.headers['x-annotator-id'])
    ?? sanitizeAnnotatorId(readCookie(req, 'annotator_id'))
  if (claim === DEMO_ID) return DEMO_ID
  if (process.env.TC_TRUST_ANNOTATOR_HEADER === '1' && claim) return claim
  return sessionFromReq(req)?.id ?? null
}

// ── username sign-in: this machine only ──────────────────────────────────────

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** A request from this machine that no proxy relayed. A reverse proxy on the
 *  same host also connects from loopback, but it says X-Forwarded-For. */
export function isLocalRequest(req) {
  if (process.env.TC_LOCAL_LOGIN === '1') return true
  if (req.headers['x-forwarded-for'] || req.headers['forwarded']) return false
  return LOOPBACK.has(req.socket?.remoteAddress ?? '')
}

// ── Google ID tokens ─────────────────────────────────────────────────────────

let googleKeys = null // { keys: Map<kid, KeyObject>, until: ms }

async function googleKey(kid) {
  const now = Date.now()
  if (!googleKeys || googleKeys.until <= now || !googleKeys.keys.has(kid)) {
    const res = await fetch(GOOGLE_CERTS_URL)
    if (!res.ok) throw new Error(`Google keys: HTTP ${res.status}`)
    const body = await res.json()
    const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')
    const keys = new Map()
    for (const jwk of body.keys ?? []) {
      if (jwk.kid) keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }))
    }
    googleKeys = { keys, until: now + (maxAge ? Number(maxAge[1]) * 1000 : 3600_000) }
  }
  return googleKeys.keys.get(kid) ?? null
}

/** The verified {email, name} in a Google ID token, or throws why not.
 *  `getKey` is injectable for tests. */
export async function verifyGoogleIdToken(token, clientId, { getKey = googleKey, now = Date.now() } = {}) {
  if (!clientId) throw new Error('Google sign-in is not configured on the server')
  const parts = typeof token === 'string' ? token.split('.') : []
  if (parts.length !== 3) throw new Error('malformed token')
  const [h, p, s] = parts
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf-8'))
  if (header.alg !== 'RS256') throw new Error('unexpected token algorithm')
  const key = await getKey(header.kid)
  if (!key) throw new Error('token signed by an unknown key')
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))
  if (!ok) throw new Error('bad token signature')
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf-8'))
  if (!GOOGLE_ISSUERS.has(claims.iss)) throw new Error('token not issued by Google')
  if (claims.aud !== clientId) throw new Error('token issued for another app')
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) throw new Error('token expired')
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new Error('email not verified by Google')
  // The id is built exactly as buildAnnotatorId({method: 'google'}) in
  // src/types/annotator.ts does, so it is the id this person always had.
  const email = sanitizeAnnotatorId(typeof claims.email === 'string'
    ? claims.email.trim().toLowerCase().replace(/[^a-z0-9._@+-]/g, '_')
      .replace(/\.{2,}/g, '_').replace(/^\.+/, '_')
    : null)
  if (!email) throw new Error('no usable email in token')
  return { email, name: typeof claims.name === 'string' && claims.name ? claims.name : email }
}
