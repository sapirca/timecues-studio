import type http from 'node:http'

export const DEMO_ID: 'demo-anonymous'
export const SESSION_COOKIE: string
export function sessionCookieName(): string
export interface Session { id: string; method: 'google' | 'local' }

export function sanitizeAnnotatorId(raw: string | string[] | undefined | null): string | null
export function readCookie(req: http.IncomingMessage, name: string): string | null
export function initAuth(opts: { dataRoot: string }): void
export function makeSession(id: string, method: 'google' | 'local', now?: number): string
export function parseSession(value: string | null | undefined, now?: number): Session | null
export function sessionFromReq(req: http.IncomingMessage): Session | null
export function setSessionCookie(req: http.IncomingMessage, res: http.ServerResponse, value: string): void
export function annotatorIdFromReq(req: http.IncomingMessage): string | null
export function isLocalRequest(req: http.IncomingMessage): boolean
export function verifyGoogleIdToken(
  token: string,
  clientId: string,
  opts?: { getKey?: (kid: string) => Promise<unknown>; now?: number },
): Promise<{ email: string; name: string }>
