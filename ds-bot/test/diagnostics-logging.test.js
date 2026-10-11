import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { format } from 'node:util'
import { install as installDiagnostics } from '../src/host/diagnostics.js'

function host(extra = {}) {
  const warnings = []
  const rt = {
    ctx: { logger: { warn: (...args) => warnings.push(args) } },
    home: join(tmpdir(), 'ds-bot-diag-unwritten'),
    config: { diagnosticsFile: false },
    state: { bots: {}, mainBotIds: [], rooms: {} },
    ...extra,
  }
  installDiagnostics(rt)
  return { rt, warnings }
}

function redactor(values) {
  return text => values.reduce((out, value, index) => out.replaceAll(value, `[hidden:${index}]`), text)
}

function outputs(warnings, stderr) {
  const calls = [...warnings, ...stderr.mock.calls.map(call => call.arguments)]
  for (const args of calls) assert.ok(args.every(arg => typeof arg === 'string'), 'sinks receive only safe strings')
  return calls.map(args => format(...args)).join('\n')
}

test('warnings redact templates and ordinary arguments before every sink', async (t) => {
  const values = ['SYNTHETIC_LOG_TEMPLATE', 'SYNTHETIC_LOG_ARGUMENT', 'SYNTHETIC_LOG_NESTED']
  const stderr = t.mock.method(console, 'error', () => {})
  const { rt, warnings } = host({ redactSecrets: redactor(values) })
  rt.warn(`ds-bot: lookup ${values[0]}: %s %j`, values[1], { route: 'r1', nested: { value: values[2] } })

  const [entry] = await rt.diagnostics.entries()
  const text = 'lookup [hidden:0]: [hidden:1] {"route":"r1","nested":{"value":"[hidden:2]"}}'
  assert.equal(entry.text, text)
  assert.equal(warnings.length, 1)
  assert.equal(stderr.mock.callCount(), 1)
  assert.equal(format(...warnings[0]), `ds-bot: ${text}`)
  assert.equal(format(...stderr.mock.calls[0].arguments), `[ds-bot] ${text}`)
  const out = outputs(warnings, stderr)
  for (const value of values) assert.ok(!out.includes(value), 'synthetic secrets stay inside the formatter')
})

test('warnings redact Error messages, codes and stack frames before every sink', async (t) => {
  const values = ['SYNTHETIC_LOG_MESSAGE', 'SYNTHETIC_LOG_FRAME', 'SYNTHETIC_LOG_CODE']
  const stderr = t.mock.method(console, 'error', () => {})
  const { rt, warnings } = host({ redactSecrets: redactor(values) })
  const error = Object.assign(new TypeError(`cannot open fixture with ${values[0]}`), {
    code: `EACCES:${values[2]}`,
    stack: `TypeError: cannot open fixture with ${values[0]}\n    at writeState (/fixture/${values[1]}/state.js:10:2)\n    at save (/fixture/store.js:20:3)`,
  })
  rt.warn('ds-bot: state write failed: %s', error)

  const [entry] = await rt.diagnostics.entries()
  assert.equal(entry.text, 'state write failed: TypeError: cannot open fixture with [hidden:0]')
  assert.equal(entry.code, 'EACCES:[hidden:2]')
  assert.equal(entry.stack, 'at writeState (/fixture/[hidden:1]/state.js:10:2)\nat save (/fixture/store.js:20:3)')
  const message = `[${entry.code}] ${entry.text}\n${entry.stack}`
  assert.equal(format(...warnings[0]), `ds-bot: ${message}`)
  assert.equal(format(...stderr.mock.calls[0].arguments), `[ds-bot] ${message}`)
  const out = outputs(warnings, stderr)
  for (const value of values) assert.ok(!out.includes(value), 'no raw Error field reaches a sink')
  assert.match(out, /EACCES/)
  assert.match(out, /writeState .*state\.js:10:2/)
})

test('warnings hide unsaved credential shapes and preserve literal format characters', async (t) => {
  const stderr = t.mock.method(console, 'error', () => {})
  const { rt, warnings } = host()
  const credential = ['sk-', 'SYNTHETIC123456'].join('')
  const error = Object.assign(new Error(`request rejected with ${credential}`), {
    code: 'AUTH',
    stack: `Error: request rejected with ${credential}\n    at request (https://fixture.invalid/?token=SYNTHETIC_TOKEN:12:3)`,
  })
  rt.warn('ds-bot: progress 100%%: %s; literal %s', error, '%s %j')

  const [entry] = await rt.diagnostics.entries()
  assert.equal(entry.text, 'progress 100%: request rejected with sk-[hidden]; literal %s %j')
  const out = outputs(warnings, stderr)
  assert.ok(!out.includes(credential))
  assert.ok(!out.includes('SYNTHETIC_TOKEN'))
  assert.match(out, /\[AUTH\]/)
  assert.match(out, /literal %s %j/)
  assert.match(out, /at request .*token=\[hidden\]/)
})

test('warning sinks, persisted diagnostics and reports share the sanitized content', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-diag-logging-'))
  const values = ['SYNTHETIC_LOG_DISK_ARGUMENT', 'SYNTHETIC_LOG_DISK_MESSAGE', 'SYNTHETIC_LOG_DISK_FRAME']
  const stderr = t.mock.method(console, 'error', () => {})
  const { rt, warnings } = host({ home, config: {}, redactSecrets: redactor(values) })
  t.after(async () => {
    await rt.diagnostics.clear()
    rmSync(home, { recursive: true, force: true })
  })
  const error = Object.assign(new Error(`fixture unavailable: ${values[1]}`), {
    code: 'ENOENT',
    stack: `Error: fixture unavailable: ${values[1]}\n    at loadFixture (/fixture/${values[2]}/config.js:4:2)`,
  })
  rt.warn('ds-bot: read %s: %s', values[0], error)

  const [entry] = await rt.diagnostics.entries()
  const path = join(home, 'logs', 'diagnostics.jsonl')
  let disk
  for (let attempt = 0; attempt < 100; attempt += 1) {
    disk = await readFile(path, 'utf8').catch(() => '')
    if (disk.endsWith('\n')) break
    await setTimeout(10)
  }
  assert.ok(disk?.endsWith('\n'), 'the queued diagnostic write completes')
  assert.deepEqual(JSON.parse(disk), entry)
  const report = await rt.diagnostics.report()
  const log = await rt.diagnostics.logText()
  assert.deepEqual(report.entries, [entry])
  const out = [outputs(warnings, stderr), disk, JSON.stringify(report), log].join('\n')
  for (const value of values) assert.ok(!out.includes(value), 'every output hides the synthetic secret')
  for (const text of [format(...warnings[0]), format(...stderr.mock.calls[0].arguments), report.markdown, log]) {
    assert.ok(text.includes(entry.text), 'the useful warning message is retained')
    assert.match(text, /ENOENT/)
    assert.match(text, /loadFixture .*config\.js:4:2/)
  }
})
