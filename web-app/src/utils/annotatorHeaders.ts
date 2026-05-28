// Shared helper for the X-Annotator-Id request header.
//
// Every write/delete endpoint in vite.config.ts that mutates user data calls
// readAnnotatorIdFromReq() and 401s if the header is missing. Read endpoints
// that expose another annotator's work (e.g. /api/annotations/:slug/all,
// /api/bulk-annotations/:kind) do the same. Use these helpers anywhere a
// client fetch hits one of those endpoints — passing them on read-only public
// routes is harmless.

import { getCurrentAnnotatorId } from '../context/AnnotatorContext';

/** Merge `X-Annotator-Id` (from AnnotatorContext) into a header bag. Returns
 *  a plain Record so callers can spread/extend it. */
export function annotatorHeaders(extra?: HeadersInit): Record<string, string> {
  const id = getCurrentAnnotatorId();
  const base: Record<string, string> = id ? { 'X-Annotator-Id': id } : {};
  if (!extra) return base;
  return { ...base, ...(extra as Record<string, string>) };
}

/** fetch() wrapper that always sends the annotator id. Use this for requests
 *  that don't need any other custom init — keeps call sites a single line. */
export function fetchWithAnnotator(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, headers: annotatorHeaders(init.headers) });
}
