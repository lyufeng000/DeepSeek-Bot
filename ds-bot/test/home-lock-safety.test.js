import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { homeLock } from '../src/host/home-lock.js'
import { install } from '../src/host/store.js'

const TEAM = { version: 1, mainBotIds: [], bots: {}, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, whaleStored: true, revision: 7 }
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const tempHome = (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-lock-safety-'))
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}
const start = (t) => {
  const home = tempHome(t)
  const statePath = join(home, 'state.json')
  const original = JSON.stringify(TEAM)
  fs.writeFileSync(statePath, original)
  let dispose
  const warnings = []
  const rt = {
    home, statePath,
    ctx: { effect: execute => { dispose = execute() } },
    warn: (...args) => warnings.push(args),
    autoRoomName: () => '',
  }
  install(rt)
  return { rt, home, path: join(home, 'state.lock'), original, warnings, dispose: () => dispose() }
}
const blockWrite = (t, statePath) => {
  const entered = deferred()
  const resume = deferred()
  const writeFile = fsp.writeFile
  let blocked = false
  t.mock.method(fsp, 'writeFile', async (path, ...args) => {
    if (!blocked && String(path).startsWith(`${statePath}.`)) {
      blocked = true
      entered.resolve()
      await resume.promise
    }
    return writeFile(path, ...args)
  })
  syncBuiltinESMExports()
  return { entered: entered.promise, resume: resume.resolve }
}

test('state remains read-only when acquiring the lock fails while state I/O works', async (t) => {
  const { rt, path, original, dispose } = start(t)
  const writeFileSync = fs.writeFileSync
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (file === path) throw Object.assign(new Error('synthetic lock failure'), { code: 'EACCES' })
    return writeFileSync(file, ...args)
  })
  syncBuiltinESMExports()
  try {
    await rt.load()
    rt.state.prefs.theme = 'dark'
    await rt.save()
    assert.equal(fs.readFileSync(rt.statePath, 'utf8'), original)
    assert.match(rt.readOnly(), /cannot.*lock/i)
    assert.equal(rt.state.revision, TEAM.revision)
  } finally { await dispose() }
})

test('a failed heartbeat disables further state writes even while its token remains', async (t) => {
  const { rt, path, original, dispose } = start(t)
  let beat
  t.mock.method(globalThis, 'setInterval', callback => {
    beat = callback
    return { unref() {} }
  })
  const utimesSync = fs.utimesSync
  t.mock.method(fs, 'utimesSync', (file, ...args) => {
    if (file === path) throw Object.assign(new Error('synthetic heartbeat failure'), { code: 'EIO' })
    return utimesSync(file, ...args)
  })
  syncBuiltinESMExports()
  try {
    await rt.load()
    beat()
    await rt.refresh()
    rt.state.prefs.theme = 'dark'
    await rt.save()
    assert.equal(fs.readFileSync(rt.statePath, 'utf8'), original)
    assert.match(rt.readOnly(), /cannot.*lock/i)
  } finally { await dispose() }
})

test('neither an in-flight snapshot nor a queued snapshot commits after ownership changes', async (t) => {
  const { rt, path, original, dispose } = start(t)
  await rt.load()
  const gate = blockWrite(t, rt.statePath)
  rt.state.prefs.theme = 'first'
  const first = rt.save()
  await gate.entered
  rt.state.prefs.theme = 'queued'
  const queued = rt.save()
  fs.writeFileSync(path, JSON.stringify({ pid: 303, host: 'another-host', token: 'successor' }))
  gate.resume()
  try {
    const results = await Promise.allSettled([first, queued])
    for (const result of results) {
      assert.equal(result.status, 'rejected')
      assert.equal(result.reason.code, 'DS_BOT_LOCK_LOST')
    }
    assert.equal(fs.readFileSync(rt.statePath, 'utf8'), original)
    assert.equal(rt.state.revision, TEAM.revision)
    assert.match(rt.readOnly(), /another dsh/)
    assert.deepEqual(fs.readdirSync(rt.home).filter(name => name.endsWith('.tmp')), [])
  } finally { gate.resume(); await dispose() }
  assert.equal(JSON.parse(fs.readFileSync(path, 'utf8')).token, 'successor')
})

test('dispose stops new saves and holds the lock until accepted writes have drained', async (t) => {
  const { rt, path, dispose } = start(t)
  await rt.load()
  const gate = blockWrite(t, rt.statePath)
  rt.state.prefs.theme = 'first'
  const first = rt.save()
  await gate.entered
  rt.state.prefs.theme = 'queued'
  const queued = rt.save()
  const revision = rt.state.revision
  const closing = dispose()
  try {
    assert.equal(fs.existsSync(path), true, 'the lock must survive the drain')
    assert.match(rt.readOnly(), /closing/i)
    rt.state.prefs.theme = 'too late'
    const refused = rt.save()
    assert.equal(rt.state.revision, revision)
    gate.resume()
    await Promise.all([first, queued, refused, closing])
    assert.equal(JSON.parse(fs.readFileSync(rt.statePath, 'utf8')).prefs.theme, 'queued')
    assert.equal(fs.existsSync(path), false)
  } finally { gate.resume(); await dispose() }
})

test('disposing before load never acquires a lock or writes state later', async (t) => {
  const { rt, path, original, dispose } = start(t)
  await dispose()
  await rt.load()
  await rt.save()
  assert.equal(fs.existsSync(path), false)
  assert.equal(fs.readFileSync(rt.statePath, 'utf8'), original)
  assert.match(rt.readOnly(), /closing/i)
})

test('a paused live process on the same host is not evicted by lease age', (t) => {
  const path = join(tempHome(t), 'state.lock')
  const now = Date.now()
  fs.writeFileSync(path, JSON.stringify({ pid: 101, host: hostname(), token: 'paused' }))
  const old = new Date(now - 120_000)
  fs.utimesSync(path, old, old)
  const lock = homeLock(path, { pid: 202, isAlive: () => true, now: () => now })
  try {
    assert.equal(lock.claim().token, 'paused')
    assert.equal(lock.owns(), false)
  } finally { lock.release() }
})

test('two plugin instances in one live process do not steal each other\'s lock', (t) => {
  const path = join(tempHome(t), 'state.lock')
  const first = homeLock(path, { pid: 101, isAlive: () => true })
  const second = homeLock(path, { pid: 101, isAlive: () => true })
  try {
    assert.equal(first.claim(), undefined)
    assert.equal(second.claim().pid, 101)
    assert.equal(first.owns(), true)
  } finally { second.release(); first.release() }
})

test('reclamation rechecks the holder instead of deleting a replacement seen after liveness inspection', (t) => {
  const path = join(tempHome(t), 'state.lock')
  fs.writeFileSync(path, JSON.stringify({ pid: 101, host: hostname(), token: 'dead' }))
  const successor = { pid: 303, host: hostname(), token: 'successor' }
  const lock = homeLock(path, {
    pid: 202,
    isAlive: (pid) => {
      if (pid === 101) {
        fs.writeFileSync(path, JSON.stringify(successor))
        return false
      }
      return true
    },
  })
  try {
    assert.equal(lock.claim().token, 'successor')
    assert.equal(JSON.parse(fs.readFileSync(path, 'utf8')).token, 'successor')
  } finally { lock.release() }
})

test('an unreadable lock never becomes permission to replace it', (t) => {
  const path = join(tempHome(t), 'state.lock')
  const original = JSON.stringify({ pid: 101, host: hostname(), token: 'private' })
  fs.writeFileSync(path, original)
  const readFileSync = fs.readFileSync
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === path) throw Object.assign(new Error('synthetic read failure'), { code: 'EACCES' })
    return readFileSync(file, ...args)
  })
  syncBuiltinESMExports()
  const lock = homeLock(path, { pid: 202 })
  try { assert.throws(() => lock.claim(), { code: 'EACCES' }) } finally { lock.release() }
  assert.equal(readFileSync(path, 'utf8'), original)
})

test('a fake clock expires a remote lease and the old holder cannot commit or remove the new lock', async (t) => {
  const path = join(tempHome(t), 'state.lock')
  let now = Date.now()
  const first = homeLock(path, { host: 'first-host', pid: 101, now: () => now })
  const second = homeLock(path, { host: 'second-host', pid: 202, now: () => now })
  try {
    first.claim()
    const lease = first.lease()
    now = fs.statSync(path).mtimeMs + 60_001
    assert.equal(second.claim(), undefined)
    let committed = false
    assert.equal(await first.commit(lease, () => { committed = true }), false)
    assert.equal(committed, false)
    await first.release()
    assert.equal(second.owns(), true)
  } finally { await first.release(); await second.release() }
})

test('taking the lock again invalidates old queued snapshots and adopts the successor state', async (t) => {
  const { rt, path, dispose } = start(t)
  await rt.load()
  const gate = blockWrite(t, rt.statePath)
  rt.state.prefs.theme = 'stale'
  const first = rt.save()
  await gate.entered
  const queued = rt.save()
  fs.writeFileSync(path, JSON.stringify({ pid: 303, host: 'another-host', token: 'successor' }))
  const successor = JSON.stringify({ ...TEAM, revision: 55, prefs: { theme: 'successor' } })
  fs.writeFileSync(rt.statePath, successor)
  assert.match(rt.readOnly(), /another dsh/)
  fs.unlinkSync(path)
  try {
    await rt.refresh()
    assert.equal(rt.readOnly(), undefined)
    gate.resume()
    const results = await Promise.allSettled([first, queued])
    for (const result of results) {
      assert.equal(result.status, 'rejected')
      assert.equal(result.reason.code, 'DS_BOT_LOCK_LOST')
    }
    assert.equal(fs.readFileSync(rt.statePath, 'utf8'), successor)
    assert.equal(rt.state.revision, 55)
    rt.state.prefs.theme = 'fresh'
    await rt.save()
    assert.equal(JSON.parse(fs.readFileSync(rt.statePath, 'utf8')).prefs.theme, 'fresh')
  } finally { gate.resume(); await dispose() }
})

test('a lock handoff cannot enter the gap between the ownership check and synchronous commit', async (t) => {
  const path = join(tempHome(t), 'state.lock')
  let now = Date.now()
  const first = homeLock(path, { host: 'first-host', pid: 101, now: () => now })
  const second = homeLock(path, { host: 'second-host', pid: 202, now: () => now })
  try {
    first.claim()
    now = fs.statSync(path).mtimeMs + 60_001
    const lease = first.lease()
    assert.equal(await first.commit(lease, () => {
      assert.equal(second.claim().token, lease)
      assert.equal(first.owns(), true)
      assert.equal(fs.existsSync(`${path}.guard`), true)
    }), true)
    assert.equal(second.claim(), undefined)
    assert.equal(second.owns(), true)
  } finally { await first.release(); await second.release() }
})

test('brief guard contention delays commit without deleting the other operation\'s guard', async (t) => {
  const path = join(tempHome(t), 'state.lock')
  const lock = homeLock(path)
  try {
    lock.claim()
    fs.writeFileSync(`${path}.guard`, 'synthetic competing operation', { flag: 'wx' })
    let committed = false
    const saving = lock.commit(lock.lease(), () => { committed = true })
    assert.equal(committed, false)
    assert.equal(fs.readFileSync(`${path}.guard`, 'utf8'), 'synthetic competing operation')
    fs.unlinkSync(`${path}.guard`)
    assert.equal(await saving, true)
    assert.equal(committed, true)
    assert.equal(lock.owns(), true)
  } finally { await lock.release() }
})

test('a leftover guard keeps state read-only and is never automatically removed', async (t) => {
  const { rt, path, original, dispose } = start(t)
  const guard = `${path}.guard`
  fs.writeFileSync(guard, 'synthetic abandoned operation', { flag: 'wx' })
  try {
    await rt.load()
    assert.match(rt.readOnly(), /cannot.*lock/i)
    rt.state.prefs.theme = 'blocked'
    await rt.save()
    assert.equal(fs.readFileSync(rt.statePath, 'utf8'), original)
    assert.equal(fs.readFileSync(guard, 'utf8'), 'synthetic abandoned operation')
    assert.equal(fs.existsSync(path), false)
  } finally { await dispose() }
})

test('dispose also waits for a busy release guard without admitting new writes', async (t) => {
  const { rt, path, dispose } = start(t)
  await rt.load()
  fs.writeFileSync(`${path}.guard`, 'synthetic competing operation', { flag: 'wx' })
  const closing = dispose()
  assert.equal(fs.existsSync(path), true)
  assert.match(rt.readOnly(), /closing/i)
  assert.equal(dispose(), closing)
  fs.unlinkSync(`${path}.guard`)
  await closing
  assert.equal(fs.existsSync(path), false)
})

test('a guard that never clears fails closed after bounded retries', async (t) => {
  const path = join(tempHome(t), 'state.lock')
  const lock = homeLock(path)
  lock.claim()
  const guard = `${path}.guard`
  fs.writeFileSync(guard, 'synthetic abandoned operation', { flag: 'wx' })
  let committed = false
  try {
    await assert.rejects(lock.commit(lock.lease(), () => { committed = true }), /Cannot acquire.*guard/)
    assert.equal(committed, false)
    assert.throws(() => lock.owns(), /Cannot acquire.*guard/)
    assert.equal(fs.readFileSync(guard, 'utf8'), 'synthetic abandoned operation')
  } finally { fs.unlinkSync(guard); await lock.release() }
})

test('a second store in the same process follows the first and takes over after disposal', async (t) => {
  const first = start(t)
  let disposeSecond
  const second = {
    home: first.home, statePath: first.rt.statePath,
    ctx: { effect: execute => { disposeSecond = execute() } },
    warn() {}, autoRoomName: () => '',
  }
  install(second)
  try {
    await first.rt.load()
    first.rt.state.prefs.theme = 'first'
    await first.rt.save()
    await second.load()
    assert.equal(second.state.prefs.theme, 'first')
    assert.match(second.readOnly(), /another dsh/)
    await first.dispose()
    await second.refresh()
    assert.equal(second.readOnly(), undefined)
    second.state.prefs.theme = 'second'
    await second.save()
    assert.equal(JSON.parse(fs.readFileSync(second.statePath, 'utf8')).prefs.theme, 'second')
  } finally { await first.dispose(); await disposeSecond() }
})

test('dispose releases the lock after a queued commit fails and removes its temporary file', async (t) => {
  const { rt, path, original, dispose } = start(t)
  await rt.load()
  const gate = blockWrite(t, rt.statePath)
  const renameSync = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === rt.statePath) throw Object.assign(new Error('synthetic rename failure'), { code: 'EACCES' })
    return renameSync(from, to)
  })
  syncBuiltinESMExports()
  rt.state.prefs.theme = 'blocked'
  const saving = rt.save()
  await gate.entered
  const closing = dispose()
  try {
    assert.equal(fs.existsSync(path), true)
    gate.resume()
    const [saved, closed] = await Promise.allSettled([saving, closing])
    assert.equal(saved.status, 'rejected')
    assert.equal(saved.reason.code, 'EACCES')
    assert.equal(closed.status, 'fulfilled')
    assert.equal(rt.state.revision, TEAM.revision)
    assert.equal(fs.existsSync(path), false)
    assert.equal(fs.readFileSync(rt.statePath, 'utf8'), original)
    assert.deepEqual(fs.readdirSync(rt.home).filter(name => name.endsWith('.tmp')), [])
  } finally { gate.resume(); await dispose() }
})

test('dispose drains a failed save and a queued retry before releasing the lease', async (t) => {
  const { rt, path, dispose } = start(t)
  await rt.load()
  const lease = JSON.parse(fs.readFileSync(path, 'utf8')).token
  const entered = deferred()
  const resume = deferred()
  const writeFile = fsp.writeFile
  const fault = Object.assign(new Error('synthetic first write failure'), { code: 'ENOSPC' })
  const temporaryFiles = []
  let first = true
  t.mock.method(fsp, 'writeFile', async (file, ...args) => {
    if (String(file).startsWith(`${rt.statePath}.`)) {
      temporaryFiles.push(file)
      if (first) {
        first = false
        entered.resolve()
        await resume.promise
        throw fault
      }
    }
    return writeFile(file, ...args)
  })
  syncBuiltinESMExports()
  rt.state.prefs.theme = 'failed'
  const failed = assert.rejects(rt.save(), error => error === fault)
  await entered.promise
  rt.state.prefs.theme = 'queued'
  const queued = rt.save()
  const closing = dispose()
  try {
    assert.equal(fs.existsSync(path), true)
    assert.equal(rt.state.revision, TEAM.revision)
    resume.resolve()
    await Promise.all([failed, queued, closing])
    const saved = JSON.parse(fs.readFileSync(rt.statePath, 'utf8'))
    assert.equal(saved.prefs.theme, 'queued')
    assert.equal(saved.revision, TEAM.revision + 1)
    assert.equal(rt.state.revision, saved.revision)
    assert.deepEqual(temporaryFiles, [0, 1].map(() => `${rt.statePath}.${process.pid}.${lease}.tmp`))
    assert.equal(fs.existsSync(path), false)
    assert.deepEqual(fs.readdirSync(rt.home).filter(name => name.endsWith('.tmp')), [])
  } finally { resume.resolve(); await dispose() }
})
