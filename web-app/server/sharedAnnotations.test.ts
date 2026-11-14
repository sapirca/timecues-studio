// Tests for the on-disk half of shared-song editing: the lease arithmetic and
// the per-song git repo. DATA_DIRS is mocked onto a temp tree so nothing here
// touches the real data/ folder.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let TMP = ''

vi.mock('../dataPaths', () => ({
  get DATA_DIRS() {
    return {
      sharedAnnotations: path.join(TMP, 'annotations', 'shared'),
      annotationLocks: path.join(TMP, 'annotations', 'locks'),
      annotationLayers: path.join(TMP, 'annotations', 'layers'),
    }
  },
}))

const mod = await import('./sharedAnnotations')
const {
  HEARTBEAT_MS, STALE_AFTER_MS, IDLE_AFTER_MS,
  sharedDocPath, sharedSongDir, isSharedSong, listSharedSlugs,
  initSharedRepo, commitSharedDoc, historyFor, readVersion, hasGit,
  readLock, writeLock, removeLock, listLocks, newLock, canAcquire, isStale,
  viewLock, touchLockEdit, removeSharedSong, writeJsonAtomic,
  archiveSharedSong, readUnshareRecord, applyUnshareDefault, switchUnshareChoice,
  dismissUnshareNotice, listUnsharedSlugs, listSongArchives, restoreSongArchive,
} = mod

const NAME = (id: string) => (id === 'alice@example.com' ? 'Alice Cohen' : id)

function doc(rev: number, items: number) {
  return {
    song: 'a-song', rev,
    layers: [{ id: 'l1', type: 'boundaries', name: 'Structure', items: Array.from({ length: items }, (_, i) => ({ time: i })) }],
  }
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shared-'))
  fs.mkdirSync(path.join(TMP, 'annotations', 'shared'), { recursive: true })
  fs.mkdirSync(path.join(TMP, 'annotations', 'locks'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

const meta = (over: Partial<Parameters<typeof commitSharedDoc>[1]> = {}) => ({
  event: 'seed' as const,
  holder: 'alice@example.com',
  holderName: 'Alice Cohen',
  rev: 1,
  ...over,
})

describe('shared song folder', () => {
  it('is what makes a song shared', () => {
    expect(isSharedSong('a-song')).toBe(false)
    initSharedRepo('a-song', meta(), doc(1, 3))
    expect(isSharedSong('a-song')).toBe(true)
    expect(listSharedSlugs()).toEqual(['a-song'])
    expect(JSON.parse(fs.readFileSync(sharedDocPath('a-song'), 'utf-8')).rev).toBe(1)
  })

  it('refuses to re-seed an existing shared song', () => {
    initSharedRepo('a-song', meta(), doc(1, 3))
    const again = initSharedRepo('a-song', meta({ rev: 99 }), doc(99, 0))
    expect(again.created).toBe(false)
    // The team's work survives a second "make this collaborative" click.
    expect(JSON.parse(fs.readFileSync(sharedDocPath('a-song'), 'utf-8')).rev).toBe(1)
  })

  it('removes document, history and lease together', () => {
    initSharedRepo('a-song', meta(), doc(1, 3))
    writeLock(newLock('a-song', 'alice@example.com', 's1', Date.now()))
    removeSharedSong('a-song')
    expect(fs.existsSync(sharedSongDir('a-song'))).toBe(false)
    expect(readLock('a-song')).toBeNull()
  })
})

describe.runIf(hasGit())('git history', () => {
  it('commits the seed', () => {
    const r = initSharedRepo('a-song', meta(), doc(1, 3))
    expect(r.created).toBe(true)
    expect(r.committed).toBe(true)
    const log = historyFor('a-song')
    expect(log).toHaveLength(1)
    expect(log[0].event).toBe('seed')
    expect(log[0].rev).toBe(1)
    expect(log[0].email).toBe('alice@example.com')
  })

  it('records one version per hand-off, newest first', () => {
    initSharedRepo('a-song', meta(), doc(1, 3))
    writeJsonAtomic(sharedDocPath('a-song'), doc(2, 7))
    commitSharedDoc('a-song', meta({ event: 'unlock', rev: 2 }))
    writeJsonAtomic(sharedDocPath('a-song'), doc(3, 11))
    commitSharedDoc('a-song', meta({ event: 'takeover', rev: 3, holder: 'bob@example.com', holderName: 'Bob Levi' }))

    const log = historyFor('a-song')
    expect(log.map((e) => e.event)).toEqual(['takeover', 'unlock', 'seed'])
    expect(log[0].author).toBe('Bob Levi')
  })

  it('writes nothing when a holder locked and unlocked without editing', () => {
    initSharedRepo('a-song', meta(), doc(1, 3))
    const second = commitSharedDoc('a-song', meta({ event: 'unlock', rev: 1 }))
    expect(second.committed).toBe(false)
    expect(historyFor('a-song')).toHaveLength(1)
  })

  it('can read back the document as it stood at an older version', () => {
    initSharedRepo('a-song', meta(), doc(1, 3))
    const first = historyFor('a-song')[0].sha
    writeJsonAtomic(sharedDocPath('a-song'), doc(2, 50))
    commitSharedDoc('a-song', meta({ event: 'unlock', rev: 2 }))

    const old = readVersion('a-song', first) as ReturnType<typeof doc>
    expect(old.rev).toBe(1)
    expect(old.layers[0].items).toHaveLength(3)
    // The live document is untouched by reading history.
    expect(JSON.parse(fs.readFileSync(sharedDocPath('a-song'), 'utf-8')).rev).toBe(2)
  })

  it('rejects a malformed revision id instead of shelling out', () => {
    initSharedRepo('a-song', meta(), doc(1, 3))
    expect(readVersion('a-song', 'HEAD; rm -rf /')).toBeNull()
    expect(readVersion('a-song', '../../etc/passwd')).toBeNull()
  })
})

describe('the lease', () => {
  const NOW = Date.parse('2026-09-12T12:00:00.000Z')

  it('is free to take when nobody holds it', () => {
    expect(canAcquire(null, 'alice@example.com', NOW)).toBe(true)
  })

  it('is not takeable while someone else is beating', () => {
    const rec = newLock('a-song', 'alice@example.com', 's1', NOW)
    expect(canAcquire(rec, 'bob@example.com', NOW + HEARTBEAT_MS)).toBe(false)
  })

  it('becomes takeable once the heartbeat has been silent long enough', () => {
    const rec = newLock('a-song', 'alice@example.com', 's1', NOW)
    expect(isStale(rec, NOW + STALE_AFTER_MS - 1)).toBe(false)
    expect(isStale(rec, NOW + STALE_AFTER_MS + 1)).toBe(true)
    expect(canAcquire(rec, 'bob@example.com', NOW + STALE_AFTER_MS + 1)).toBe(true)
  })

  it('always lets the same person back in — a reload must not cost the lock', () => {
    const rec = newLock('a-song', 'alice@example.com', 's1', NOW)
    expect(canAcquire(rec, 'alice@example.com', NOW + STALE_AFTER_MS * 10)).toBe(true)
  })

  it('derives idle from the last write, not the last heartbeat', () => {
    const rec = newLock('a-song', 'alice@example.com', 's1', NOW)
    rec.renewedAt = new Date(NOW + IDLE_AFTER_MS + 60_000).toISOString()  // still beating
    const view = viewLock(rec, NOW + IDLE_AFTER_MS + 60_000, NAME)
    expect(view.stale).toBe(false)      // the tab is open
    expect(view.idle).toBe(true)        // but nothing has been written
    expect(view.holderName).toBe('Alice Cohen')
  })

  it('counts idle from the last edit once there has been one', () => {
    const rec = newLock('a-song', 'alice@example.com', 's1', NOW)
    rec.lastEditAt = new Date(NOW + IDLE_AFTER_MS).toISOString()
    const view = viewLock(rec, NOW + IDLE_AFTER_MS + 1000, NAME)
    expect(view.idleMs).toBe(1000)
    expect(view.idle).toBe(false)
  })

  it('stamps edits only for the holder', () => {
    writeLock(newLock('a-song', 'alice@example.com', 's1', NOW))
    touchLockEdit('a-song', 'bob@example.com', NOW + 5000)
    expect(readLock('a-song')!.lastEditAt).toBeNull()
    touchLockEdit('a-song', 'alice@example.com', NOW + 5000)
    expect(readLock('a-song')!.lastEditAt).toBe(new Date(NOW + 5000).toISOString())
  })

  it('lists and removes leases', () => {
    writeLock(newLock('a', 'alice@example.com', 's1', NOW))
    writeLock(newLock('b', 'bob@example.com', 's2', NOW))
    expect(listLocks().map((l) => l.slug).sort()).toEqual(['a', 'b'])
    removeLock('a')
    expect(listLocks().map((l) => l.slug)).toEqual(['b'])
  })

  it('survives a corrupt lock file instead of throwing', () => {
    fs.writeFileSync(path.join(TMP, 'annotations', 'locks', 'a-song.json'), '{not json', 'utf-8')
    expect(readLock('a-song')).toBeNull()
    expect(listLocks()).toEqual([])
  })
})

describe('atomic writes', () => {
  it('leaves no temp file behind', () => {
    const p = path.join(TMP, 'annotations', 'shared', 'x', 'layers.json')
    writeJsonAtomic(p, { a: 1 })
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ a: 1 })
    expect(fs.readdirSync(path.dirname(p))).toEqual(['layers.json'])
  })
})

describe('after collaboration stops', () => {
  const ALICE = 'alice@example.com'
  const own = (id = ALICE) => path.join(TMP, 'annotations', 'layers', id, 'a-song.json')
  const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'))
  const T0 = Date.parse('2026-10-01T00:00:00Z')

  /** Alice's own file, written at `at`; then a team document; then un-share. */
  function setup({ ownAt, teamAt }: { ownAt: number | null; teamAt: number }) {
    if (ownAt !== null) {
      writeJsonAtomic(own(), { song: 'a-song', rev: 4, layers: [{ id: 'mine', items: [] }], time_spent_seconds: 90 })
      fs.utimesSync(own(), ownAt / 1000, ownAt / 1000)
    }
    initSharedRepo('a-song', meta(), { ...doc(7, 3), seededFrom: 'bob', time_spent_seconds: 5 })
    fs.utimesSync(sharedDocPath('a-song'), teamAt / 1000, teamAt / 1000)
    return archiveSharedSong('a-song', teamAt + 1000)
  }

  it('archives the folder, drops the lease, and leaves a record', () => {
    writeLock(newLock('a-song', ALICE, 's1', T0))
    const rec = setup({ ownAt: null, teamAt: T0 })
    expect(isSharedSong('a-song')).toBe(false)
    expect(readLock('a-song')).toBeNull()
    expect(listUnsharedSlugs()).toEqual(['a-song'])
    expect(fs.existsSync(path.join(TMP, 'annotations', 'shared-archive', rec.archive, 'layers.json'))).toBe(true)
  })

  it('gives the team version when it is newer, keeping a copy of the old file', () => {
    setup({ ownAt: T0, teamAt: T0 + 60_000 })
    const c = applyUnshareDefault('a-song', ALICE, own(), T0 + 120_000)!
    expect(c).toMatchObject({ kept: 'team', automatic: true, hadOwn: true })
    const now = read(own())
    expect(now.layers[0].id).toBe('l1')
    expect(now.seededFrom).toBeUndefined()
    // Her clock travels with her; rev climbs past both documents.
    expect(now.time_spent_seconds).toBe(90)
    expect(now.rev).toBe(8)
    const rec = readUnshareRecord('a-song')!
    expect(read(path.join(TMP, 'annotations', 'shared-archive', rec.archive, c.ownCopy!)).layers[0].id).toBe('mine')
  })

  it('leaves the own file alone when it is newer', () => {
    setup({ ownAt: T0 + 60_000, teamAt: T0 })
    const before = fs.readFileSync(own(), 'utf-8')
    expect(applyUnshareDefault('a-song', ALICE, own(), T0 + 120_000)).toMatchObject({ kept: 'own', automatic: true })
    expect(fs.readFileSync(own(), 'utf-8')).toBe(before)
  })

  it('gives the team version to someone who had nothing', () => {
    setup({ ownAt: null, teamAt: T0 })
    expect(applyUnshareDefault('a-song', ALICE, own(), T0 + 5000)).toMatchObject({ kept: 'team', hadOwn: false })
    expect(read(own()).layers[0].id).toBe('l1')
  })

  it('decides once — later edits are never overwritten by a second read', () => {
    setup({ ownAt: null, teamAt: T0 })
    applyUnshareDefault('a-song', ALICE, own(), T0 + 5000)
    writeJsonAtomic(own(), { song: 'a-song', rev: 20, layers: [] })
    applyUnshareDefault('a-song', ALICE, own(), T0 + 9000)
    expect(read(own()).rev).toBe(20)
  })

  it('switches back and forth without losing an edit on either side', () => {
    setup({ ownAt: T0, teamAt: T0 + 60_000 })
    applyUnshareDefault('a-song', ALICE, own(), T0 + 120_000)
    // She edits the team version, then goes back to her own…
    writeJsonAtomic(own(), { ...read(own()), layers: [{ id: 'team-edited', items: [] }] })
    expect(switchUnshareChoice('a-song', ALICE, own(), T0 + 130_000)).toMatchObject({ kept: 'own', automatic: false })
    expect(read(own()).layers[0].id).toBe('mine')
    // …edits that, and returns to the team version — her edit to it is there.
    writeJsonAtomic(own(), { ...read(own()), layers: [{ id: 'mine-edited', items: [] }] })
    switchUnshareChoice('a-song', ALICE, own(), T0 + 140_000)
    expect(read(own()).layers[0].id).toBe('team-edited')
    switchUnshareChoice('a-song', ALICE, own(), T0 + 150_000)
    expect(read(own()).layers[0].id).toBe('mine-edited')
  })

  it('switching away from the team version with no own file means no file', () => {
    setup({ ownAt: null, teamAt: T0 })
    applyUnshareDefault('a-song', ALICE, own(), T0 + 5000)
    switchUnshareChoice('a-song', ALICE, own(), T0 + 6000)
    expect(fs.existsSync(own())).toBe(false)
  })

  it('records each annotator separately', () => {
    setup({ ownAt: T0 + 60_000, teamAt: T0 })
    applyUnshareDefault('a-song', ALICE, own(), T0 + 120_000)
    applyUnshareDefault('a-song', 'bob', own('bob'), T0 + 120_000)
    const rec = readUnshareRecord('a-song')!
    expect(rec.choices[ALICE].kept).toBe('own')
    expect(rec.choices.bob.kept).toBe('team')
    expect(dismissUnshareNotice('a-song', 'bob')?.dismissed).toBe(true)
  })

  it('forgets the record when the song is deleted', () => {
    setup({ ownAt: null, teamAt: T0 })
    removeSharedSong('a-song')
    expect(readUnshareRecord('a-song')).toBeNull()
    expect(applyUnshareDefault('a-song', ALICE, own(), T0)).toBeNull()
  })
})

describe('restoring an archived team copy', () => {
  const T0 = Date.parse('2026-10-01T00:00:00Z')

  it('lists only this song\'s archives, newest first, with rev and item count', () => {
    initSharedRepo('a-song', meta(), doc(3, 2))
    archiveSharedSong('a-song', T0)
    initSharedRepo('a-song', meta(), doc(5, 4))
    archiveSharedSong('a-song', T0 + 60_000)
    initSharedRepo('a-song-two', meta(), doc(1, 1))
    archiveSharedSong('a-song-two', T0)
    const list = listSongArchives('a-song')
    expect(list.map((a) => [a.rev, a.items])).toEqual([[5, 4], [3, 2]])
    expect(list[0].archivedAt).toBe(new Date(T0 + 60_000).toISOString())
  })

  it('moves the folder back with its history and drops the un-share record', () => {
    initSharedRepo('a-song', meta(), doc(3, 2))
    const rec = archiveSharedSong('a-song', T0)
    expect(restoreSongArchive('a-song', rec.archive)).toBeNull()
    expect(isSharedSong('a-song')).toBe(true)
    expect(JSON.parse(fs.readFileSync(sharedDocPath('a-song'), 'utf-8')).rev).toBe(3)
    expect(readUnshareRecord('a-song')).toBeNull()
    expect(listSongArchives('a-song')).toEqual([])
    if (hasGit()) expect(historyFor('a-song').length).toBe(1)
  })

  it('refuses another song\'s archive, a path, or a shared song', () => {
    initSharedRepo('a-song-two', meta(), doc(1, 1))
    const other = archiveSharedSong('a-song-two', T0)
    expect(restoreSongArchive('a-song', other.archive)).not.toBeNull()
    expect(restoreSongArchive('a-song', '../shared/a-song-2026-10-01T00-00-00-000Z')).not.toBeNull()
    initSharedRepo('a-song', meta(), doc(1, 1))
    const mine = archiveSharedSong('a-song', T0)
    initSharedRepo('a-song', meta(), doc(2, 1))
    expect(restoreSongArchive('a-song', mine.archive)).toBe('already shared')
  })
})
