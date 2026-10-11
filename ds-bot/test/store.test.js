import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/store.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: [],
  bots: {},
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: { theme: 'light' },
  whaleStored: true,
  revision: 7,
}

function start(t, contents = JSON.stringify(TEAM), onWarning) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-persistence-'))
  const statePath = join(home, 'state.json')
  writeFileSync(statePath, contents)
  const ctx = fakeContext()
  const warnings = []
  const rt = {
    ctx, home, statePath,
    warn: (...args) => { warnings.push(args); onWarning?.(...args) },
    autoRoomName: members => members.join(', '),
    retitleRoom: async () => {},
  }
  install(rt)
  t.after(() => {
    ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  return { rt, home, statePath, warnings }
}

function mockIo(t, name, implementation) {
  const method = t.mock.method(fs, name, implementation)
  syncBuiltinESMExports()
  t.after(() => {
    method.mock.restore()
    syncBuiltinESMExports()
  })
  return method
}

for (const [operation, code] of [['mkdir', 'EACCES'], ['writeFile', 'ENOSPC'], ['rename', 'EPERM']]) {
  test(`a failed ${operation} rejects its save, preserves the file and lets the next save succeed`, async (t) => {
    const { rt, home, statePath, warnings } = start(t)
    await rt.load()
    const before = readFileSync(statePath, 'utf8')
    const fault = Object.assign(new Error(`mock ${operation} failure`), { code })
    const original = fs[operation]
    let fail = true
    mockIo(t, operation, async (...args) => {
      if (fail) {
        fail = false
        throw fault
      }
      return original(...args)
    })
    rt.state.prefs.theme = 'dark'
    await assert.rejects(rt.save(), error => error === fault)
    assert.equal(readFileSync(statePath, 'utf8'), before)
    assert.equal(rt.state.revision, TEAM.revision)
    assert.equal(warnings.length, 1)
    assert.equal(readdirSync(home).some(name => name.endsWith('.tmp')), false)

    rt.state.prefs.accent = '#123456'
    await rt.save()
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.deepEqual(saved.prefs, { theme: 'dark', accent: '#123456' })
    assert.equal(saved.revision, TEAM.revision + 1)
    assert.equal(rt.state.revision, saved.revision)
  })
}

test('an already queued save survives an earlier failure and keeps its own snapshot', async (t) => {
  const { rt, statePath } = start(t)
  await rt.load()
  const fault = Object.assign(new Error('mock queued write failure'), { code: 'ENOSPC' })
  const original = fs.writeFile
  let release
  let entered
  const held = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  let first = true
  mockIo(t, 'writeFile', async (...args) => {
    if (first) {
      first = false
      entered()
      await held
      throw fault
    }
    return original(...args)
  })
  rt.state.prefs.theme = 'dark'
  const failed = assert.rejects(rt.save(), error => error === fault)
  await started
  rt.state.prefs.theme = 'paper'
  const queued = rt.save()
  rt.state.prefs.theme = 'mono'
  const pendingRevision = rt.state.revision
  release()
  const results = await Promise.allSettled([failed, queued])
  for (const result of results) if (result.status === 'rejected') throw result.reason
  assert.equal(pendingRevision, TEAM.revision)
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(saved.prefs.theme, 'paper')
  assert.equal(saved.revision, TEAM.revision + 1)
  assert.equal(rt.state.revision, saved.revision)

  await rt.save()
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).prefs.theme, 'mono')
  assert.equal(rt.state.revision, TEAM.revision + 2)
})

test('successful queued saves advance the revision only after each rename', async (t) => {
  const { rt, statePath } = start(t)
  await rt.load()
  const original = fs.rename
  const revisions = []
  mockIo(t, 'rename', async (...args) => {
    const snapshot = JSON.parse(readFileSync(args[0], 'utf8'))
    revisions.push([rt.state.revision, snapshot.revision])
    return original(...args)
  })
  rt.state.prefs.theme = 'dark'
  const first = rt.save()
  rt.state.prefs.theme = 'paper'
  const second = rt.save()
  await Promise.all([first, second])
  assert.deepEqual(revisions, [[7, 8], [8, 9]])
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(saved.prefs.theme, 'paper')
  assert.equal(saved.revision, 9)
  assert.equal(rt.state.revision, 9)
})

for (const [name, contents, pattern] of [
  ['broken JSON', '{"version":1,"bots":', /JSON/],
  ['an unsupported version', JSON.stringify({ ...TEAM, version: 2 }), /Unsupported.*version/i],
  ['a missing version', JSON.stringify({ bots: TEAM.bots }), /Unsupported.*version/i],
  ['an invalid revision', JSON.stringify({ ...TEAM, revision: '7' }), /Invalid.*revision/i],
]) {
  test(`loading ${name} refuses saves and preserves the original file until recovery`, async (t) => {
    const { rt, statePath, warnings } = start(t, contents)
    await assert.rejects(rt.load(), pattern)
    await assert.rejects(rt.save(), pattern)
    assert.equal(readFileSync(statePath, 'utf8'), contents)
    assert.equal(rt.state.revision, 0)
    assert.equal(warnings.length, 1)

    writeFileSync(statePath, JSON.stringify(TEAM))
    await rt.load()
    rt.state.prefs.theme = 'dark'
    await rt.save()
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(saved.prefs.theme, 'dark')
    assert.equal(saved.revision, TEAM.revision + 1)
  })
}

test('a read permission error is reported without overwriting the existing file', async (t) => {
  const { rt, statePath } = start(t)
  const before = readFileSync(statePath, 'utf8')
  const fault = Object.assign(new Error('mock state read failure'), { code: 'EACCES' })
  const original = fs.readFile
  let fail = true
  mockIo(t, 'readFile', async (...args) => {
    if (fail) {
      fail = false
      throw fault
    }
    return original(...args)
  })
  await assert.rejects(rt.load(), error => error === fault)
  await assert.rejects(rt.save(), error => error === fault)
  assert.equal(readFileSync(statePath, 'utf8'), before)
  await rt.load()
  assert.equal(rt.state.revision, TEAM.revision)
  await rt.save()
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).revision, TEAM.revision + 1)
})

test('state that fails migration cannot overwrite the original file', async (t) => {
  const contents = JSON.stringify({ ...TEAM, bots: null })
  const { rt, statePath } = start(t, contents)
  await assert.rejects(rt.load(), TypeError)
  await assert.rejects(rt.save(), TypeError)
  assert.equal(readFileSync(statePath, 'utf8'), contents)
  writeFileSync(statePath, JSON.stringify(TEAM))
  await rt.load()
  await rt.save()
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).revision, TEAM.revision + 1)
})

test('background loads and saves keep read failures handled while callers can still await them', async (t) => {
  const contents = '{"version":1,"bots":'
  let notify
  const warning = new Promise(resolve => { notify = resolve })
  const { rt, statePath } = start(t, contents, notify)
  void rt.load()
  await warning
  await new Promise(resolve => setImmediate(resolve))
  void rt.save()
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(rt.load(), /JSON/)
  await assert.rejects(rt.save(), /JSON/)
  assert.equal(readFileSync(statePath, 'utf8'), contents)
})

test('a migration save failure is reported and a later load can retry it', async (t) => {
  const contents = JSON.stringify({ ...TEAM, prefs: { theme: 'grok' } })
  const { rt, statePath } = start(t, contents)
  const fault = Object.assign(new Error('mock migration rename failure'), { code: 'EPERM' })
  const original = fs.rename
  let fail = true
  mockIo(t, 'rename', async (...args) => {
    if (fail) {
      fail = false
      throw fault
    }
    return original(...args)
  })
  await assert.rejects(rt.load(), error => error === fault)
  assert.equal(readFileSync(statePath, 'utf8'), contents)
  assert.equal(rt.state.revision, TEAM.revision)
  await rt.load()
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(saved.prefs.theme, 'mono')
  assert.equal(saved.revision, TEAM.revision + 1)
})

test('a reading host keeps its loaded team when the state file disappears', async (t) => {
  const { rt, home, statePath } = start(t)
  const lockPath = join(home, 'state.lock')
  writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  await rt.load()
  rmSync(statePath)
  await assert.rejects(rt.refresh(), error => error.code === 'ENOENT')
  await assert.rejects(rt.save(), error => error.code === 'ENOENT')
  assert.equal(existsSync(statePath), false)
  assert.equal(rt.state.revision, TEAM.revision)
  assert.deepEqual(rt.state.prefs, TEAM.prefs)

  writeFileSync(statePath, JSON.stringify({ ...TEAM, revision: 8, prefs: { theme: 'paper' } }))
  await rt.refresh()
  assert.equal(rt.state.revision, 8)
  assert.equal(rt.state.prefs.theme, 'paper')
})

test('a reading host notices a state replacement that happens during its read', async (t) => {
  const { rt, home, statePath } = start(t)
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  await rt.load()
  writeFileSync(statePath, JSON.stringify({ ...TEAM, revision: 8, prefs: { theme: 'dark' } }))
  const original = fs.readFile
  let replace = true
  mockIo(t, 'readFile', async (...args) => {
    const contents = await original(...args)
    if (args[0] === statePath && replace) {
      replace = false
      writeFileSync(statePath, JSON.stringify({ ...TEAM, revision: 9, prefs: { theme: 'paper' } }))
    }
    return contents
  })
  await rt.refresh()
  assert.equal(rt.state.revision, 8)
  await rt.refresh()
  assert.equal(rt.state.revision, 9)
  assert.equal(rt.state.prefs.theme, 'paper')
})

test('a takeover refuses incompatible state until a later refresh reads a restored file', async (t) => {
  const { rt, home, statePath } = start(t)
  const lockPath = join(home, 'state.lock')
  writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  await rt.load()
  const incompatible = JSON.stringify({ ...TEAM, version: 2 })
  writeFileSync(statePath, incompatible)
  rmSync(lockPath)
  await assert.rejects(rt.refresh(), /Unsupported.*version/i)
  await assert.rejects(rt.save(), /Unsupported.*version/i)
  assert.equal(readFileSync(statePath, 'utf8'), incompatible)
  assert.equal(rt.state.revision, TEAM.revision)

  writeFileSync(statePath, JSON.stringify({ ...TEAM, revision: 8, prefs: { theme: 'paper' } }))
  await rt.refresh()
  rt.state.prefs.theme = 'dark'
  await rt.save()
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(saved.prefs.theme, 'dark')
  assert.equal(saved.revision, 9)
})

test('a first missing state file starts a new team and saves normally', async (t) => {
  const { rt, statePath, warnings } = start(t)
  rmSync(statePath)
  await rt.load()
  assert.equal(existsSync(statePath), false)
  assert.equal(rt.state.revision, 0)
  rt.state.prefs.theme = 'paper'
  await rt.save()
  assert.deepEqual(warnings, [])
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(saved.version, 1)
  assert.equal(saved.prefs.theme, 'paper')
  assert.equal(saved.revision, 1)
  assert.equal(warnings.length, 0)
})
