import { describe, expect, it } from 'vitest';
import { detectMobileMode, isMobileHost, DESKTOP_SITE_KEY, type DetectEnv } from './mobileMode';

function memStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    dump: () => Object.fromEntries(m),
  };
}

const env = (over: Partial<DetectEnv> = {}): DetectEnv => ({
  hostname: 'timecues-studio.lol',
  search: '',
  storage: memStorage(),
  matchesPhone: false,
  ...over,
});

describe('detectMobileMode', () => {
  it('gives the desktop shell to a desktop visitor on the main host', () => {
    expect(detectMobileMode(env())).toBe(false);
  });

  it('gives the phone shell on an m. host, in production and in dev', () => {
    expect(detectMobileMode(env({ hostname: 'm.timecues-studio.lol' }))).toBe(true);
    expect(detectMobileMode(env({ hostname: 'm.localhost' }))).toBe(true);
  });

  it('gives the phone shell to a phone on the main host', () => {
    expect(detectMobileMode(env({ matchesPhone: true }))).toBe(true);
  });

  it('honours ?mobile for this visit only, and remembers nothing', () => {
    const storage = memStorage();
    expect(detectMobileMode(env({ hostname: 'localhost', search: '?mobile=1', storage }))).toBe(true);
    expect(storage.dump()).toEqual({});
    // The next visit to the same address is the desktop shell again — a single
    // ?mobile=1 used to leave the browser stuck in the phone shell.
    expect(detectMobileMode(env({ hostname: 'localhost', storage }))).toBe(false);
  });

  it('lets ?mobile=0 look at the desktop shell on the phone host', () => {
    expect(detectMobileMode(env({ hostname: 'm.timecues-studio.lol', search: '?mobile=0' }))).toBe(false);
  });

  it('keeps a phone on the desktop site once it has asked for it', () => {
    const storage = memStorage({ [DESKTOP_SITE_KEY]: '1' });
    expect(detectMobileMode(env({ matchesPhone: true, storage }))).toBe(false);
    // ...but the phone address still means the phone shell.
    expect(detectMobileMode(env({ hostname: 'm.timecues-studio.lol', matchesPhone: true, storage }))).toBe(true);
  });

  it('still decides when storage is unavailable', () => {
    expect(detectMobileMode(env({ hostname: 'm.example.org', storage: null }))).toBe(true);
    expect(detectMobileMode(env({ matchesPhone: true, storage: null }))).toBe(true);
  });
});

describe('isMobileHost', () => {
  it('matches only a leading m. label', () => {
    expect(isMobileHost('m.timecues-studio.lol')).toBe(true);
    expect(isMobileHost('m.203-0-113-7.nip.io')).toBe(true);
    expect(isMobileHost('m.localhost')).toBe(true);
    expect(isMobileHost('timecues-studio.lol')).toBe(false);
    expect(isMobileHost('mm.example.org')).toBe(false);
  });
});
