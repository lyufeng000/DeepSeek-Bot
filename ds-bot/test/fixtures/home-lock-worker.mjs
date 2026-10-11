import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { install } from '../../src/host/store.js'

const home = resolve(process.argv[2] ?? '')
if (!home.startsWith(`${resolve(tmpdir())}${sep}ds-bot-process-lock-`)) throw new Error('The lock fixture only accepts its own temporary test directory.')
const mode = process.argv[3]
if (!['probe', 'write'].includes(mode)) throw new Error('Unknown lock fixture mode.')
let dispose
const rt = { home, statePath: join(home, 'state.json'), ctx: { effect: execute => { dispose = execute() } }, warn() {}, autoRoomName: () => '' }
install(rt)
try {
  await rt.load()
  if (mode === 'write' && rt.readOnly() !== undefined) throw new Error('The successor could not acquire the lock.')
  rt.state.prefs.theme = mode === 'write' ? 'successor' : 'blocked'
  await rt.save()
  console.log(JSON.stringify({ pid: process.pid, readOnly: rt.readOnly() ?? null, revision: rt.state.revision }))
} finally { await dispose() }
