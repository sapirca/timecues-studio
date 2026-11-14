// @vitest-environment node
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type http from 'node:http'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  annotatorIdFromReq, initAuth, isLocalRequest, makeSession, parseSession, sessionCookieName,
  setSessionCookie, verifyGoogleIdToken,
} from './auth.mjs'

const CLIENT = 'our-app.apps.googleusercontent.com'
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const getKey = async (kid: string) => (kid === 'k1' ? publicKey : null)

function token(claims: Record<string, unknown>, { kid = 'k1', key = privateKey, alg = 'RS256' } = {}) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${enc({ alg, kid, typ: 'JWT' })}.${enc(claims)}`
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`
}

const good = () => ({
  iss: 'https://accounts.google.com', aud: CLIENT, exp: Math.floor(Date.now() / 1000) + 600,
  email: 'Jane.Doe@Example.com', email_verified: true, name: 'Jane',
})

function req(headers: Record<string, string>, remoteAddress = '127.0.0.1') {
  return { headers, socket: { remoteAddress } } as unknown as http.IncomingMessage
}

beforeAll(() => {
  initAuth({ dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-auth-')) })
})
afterEach(() => vi.unstubAllEnvs())

describe('Google ID tokens', () => {
  it('a genuine token yields its verified address, as the id it always was', async () => {
    expect(await verifyGoogleIdToken(token(good()), CLIENT, { getKey }))
      .toEqual({ email: 'jane.doe@example.com', name: 'Jane' })
  })

  it.each([
    ['another app', { aud: 'someone-else' }],
    ['not Google', { iss: 'https://evil.example' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 1 }],
    ['unverified address', { email_verified: false }],
  ])('refuses a token for %s', async (_why, patch) => {
    await expect(verifyGoogleIdToken(token({ ...good(), ...patch }), CLIENT, { getKey })).rejects.toThrow()
  })

  it('refuses a token signed with any other key', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    await expect(verifyGoogleIdToken(token(good(), { key: other }), CLIENT, { getKey })).rejects.toThrow(/signature/)
  })

  it('refuses an edited token', async () => {
    const [h, , s] = token(good()).split('.')
    const forged = Buffer.from(JSON.stringify({ ...good(), email: 'admin@example.com' })).toString('base64url')
    await expect(verifyGoogleIdToken(`${h}.${forged}.${s}`, CLIENT, { getKey })).rejects.toThrow(/signature/)
  })

  it('refuses an unsigned token', async () => {
    await expect(verifyGoogleIdToken(token(good(), { alg: 'none' }), CLIENT, { getKey })).rejects.toThrow()
  })
})

describe('sessions', () => {
  it('round-trips, and a tampered or expired one is nobody', () => {
    const v = makeSession('jane@example.com', 'google')
    expect(parseSession(v)).toEqual({ id: 'jane@example.com', method: 'google' })
    const [payload, sig] = v.split('.')
    const other = Buffer.from(JSON.stringify({ id: 'admin@example.com', m: 'google', exp: Date.now() + 1e9 }))
      .toString('base64url')
    expect(parseSession(`${other}.${sig}`)).toBeNull()
    expect(parseSession(`${payload}.${sig.slice(0, -2)}AA`)).toBeNull()
    expect(parseSession(makeSession('jane@example.com', 'google', Date.now() - 31 * 864e5))).toBeNull()
  })

  it('a claimed id is ignored; only the session names you', () => {
    const cookie = `tc_session=${makeSession('jane@example.com', 'google')}`
    expect(annotatorIdFromReq(req({ 'x-annotator-id': 'admin@example.com' }))).toBeNull()
    expect(annotatorIdFromReq(req({ cookie: 'annotator_id=admin%40example.com' }))).toBeNull()
    expect(annotatorIdFromReq(req({ 'x-annotator-id': 'admin@example.com', cookie }))).toBe('jane@example.com')
  })

  it('anyone may step down into the demo', () => {
    const cookie = `tc_session=${makeSession('jane@example.com', 'google')}`
    expect(annotatorIdFromReq(req({ 'x-annotator-id': 'demo-anonymous', cookie }))).toBe('demo-anonymous')
    expect(annotatorIdFromReq(req({ cookie: `annotator_id=demo-anonymous; ${cookie}` }))).toBe('demo-anonymous')
  })

  // Two TimeCues on one machine (Docker on :5173, dev on :5174) share every
  // localhost cookie. Signing in on the other used to overwrite ours.
  it('each install keeps its own cookie, so a neighbour cannot sign us out', () => {
    const ours = `${sessionCookieName()}=${makeSession('jane@example.com', 'google')}`
    const neighbours = 'tc_session=forged-by-another-secret.AAAA; tc_session_deadbeef=x.y'
    expect(sessionCookieName()).toMatch(/^tc_session_[0-9a-f]{8}$/)
    expect(annotatorIdFromReq(req({ cookie: `${neighbours}; ${ours}` }))).toBe('jane@example.com')
    expect(annotatorIdFromReq(req({ cookie: neighbours }))).toBeNull()
  })

  it('signing in writes our name and clears the shared legacy one', () => {
    const headers: Record<string, unknown> = {}
    const res = { getHeader: (k: string) => headers[k], setHeader: (k: string, v: unknown) => { headers[k] = v } }
    setSessionCookie(req({}), res, makeSession('jane@example.com', 'google'))
    const set = headers['Set-Cookie'] as string[]
    expect(set[0].startsWith(`${sessionCookieName()}=`)).toBe(true)
    expect(set[1]).toMatch(/^tc_session=; .*Max-Age=0/)
  })

  it('TC_TRUST_ANNOTATOR_HEADER=1 trusts the claim, for dev scripts', () => {
    vi.stubEnv('TC_TRUST_ANNOTATOR_HEADER', '1')
    expect(annotatorIdFromReq(req({ 'x-annotator-id': 'admin@example.com' }))).toBe('admin@example.com')
  })
})

describe('username sign-in is for this machine', () => {
  it('from loopback, unrelayed', () => {
    expect(isLocalRequest(req({}))).toBe(true)
    expect(isLocalRequest(req({}, '::1'))).toBe(true)
  })
  it('not through a proxy, not from elsewhere', () => {
    expect(isLocalRequest(req({ 'x-forwarded-for': '203.0.113.9' }))).toBe(false)
    expect(isLocalRequest(req({}, '172.18.0.5'))).toBe(false)
  })
  it('unless the operator opens it', () => {
    vi.stubEnv('TC_LOCAL_LOGIN', '1')
    expect(isLocalRequest(req({}, '172.18.0.5'))).toBe(true)
  })
})
