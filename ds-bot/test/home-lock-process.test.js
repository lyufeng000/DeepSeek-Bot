import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { install } from '../src/host/store.js'

const runFile = promisify(execFile)
const worker = fileURLToPath(new URL('./fixtures/home-lock-worker.mjs', import.meta.url))
const TEAM = { version: 1, mainBotIds: [], bots: {}, rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, whaleStored: true, revision: 7 }

test('a real second process cannot write until the first releases its lease', { timeout: 20_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-process-lock-'))
  const statePath = join(home, 'state.json')
  writeFileSync(statePath, JSON.stringify(TEAM))
  let dispose
  const rt = { home, statePath, ctx: { effect: execute => { dispose = execute() } }, warn() {}, autoRoomName: () => '' }
  install(rt)
  const run = async (mode) => {
    const { stdout } = await runFile(process.execPath, [worker, home, mode], { timeout: 5_000, windowsHide: true, env: { ...process.env, DSH_HOME: home } })
    return JSON.parse(stdout)
  }
  try {
    await rt.load()
    rt.state.prefs.theme = 'owner'
    await rt.save()
    const before = readFileSync(statePath, 'utf8')
    const blocked = await run('probe')
    assert.notEqual(blocked.pid, process.pid)
    assert.match(blocked.readOnly, /another dsh/)
    assert.equal(blocked.revision, 8)
    assert.equal(readFileSync(statePath, 'utf8'), before)
    await dispose()
    const successor = await run('write')
    assert.notEqual(successor.pid, process.pid)
    assert.equal(successor.readOnly, null)
    assert.equal(successor.revision, 9)
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(saved.prefs.theme, 'successor')
    assert.equal(saved.revision, 9)
    assert.equal(existsSync(join(home, 'state.lock')), false)
    assert.equal(existsSync(join(home, 'state.lock.guard')), false)
  } finally {
    await dispose()
    assert.ok(resolve(home).startsWith(`${resolve(tmpdir())}${sep}ds-bot-process-lock-`))
    rmSync(home, { recursive: true, force: true })
  }
})
