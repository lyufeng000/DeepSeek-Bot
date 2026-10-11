// One writer per plugin home. The token identifies an acquisition, including when
// a host takes the lock again after following another writer's state.
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === 'EPERM'
  }
}

export function homeLock(path, { staleMs = 60_000, beatMs = 15_000, host = hostname(), pid = process.pid, isAlive = pidAlive, now = Date.now } = {}) {
  let token = randomUUID()
  let timer
  let held = false
  let failure
  const guard = `${path}.guard`

  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  const broken = (error) => {
    failure ??= error
    stop()
    throw failure
  }

  // Serialize replacement, heartbeat, release and the state commit. Never age out
  // this short-lived guard: doing so would recreate the compare/unlink race. A crash
  // inside the guarded operation leaves the home read-only until it is inspected.
  const guarded = (action) => {
    try {
      writeFileSync(guard, JSON.stringify({ pid, host, token }), { flag: 'wx' })
    } catch (error) {
      if (error?.code === 'EEXIST') throw Object.assign(new Error('The Bot team lock is busy or needs inspection.'), { code: 'DS_BOT_LOCK_BUSY' })
      return broken(error)
    }
    try { return action() } finally {
      try { unlinkSync(guard) } catch (error) { broken(error) }
    }
  }
  const retryGuard = async (action) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      await delay(10)
      try { return guarded(action) } catch (error) {
        if (error?.code !== 'DS_BOT_LOCK_BUSY') throw error
      }
    }
    return broken(new Error('Cannot acquire the Bot team lock guard; close the dsh hosts and inspect the data directory.'))
  }
  const waitForGuard = (action) => {
    try { return guarded(action) } catch (error) {
      if (error?.code !== 'DS_BOT_LOCK_BUSY') throw error
      return retryGuard(action)
    }
  }

  // undefined: no file; null: incomplete or invalid contents. I/O errors propagate.
  const read = () => {
    try {
      const holder = JSON.parse(readFileSync(path, 'utf8'))
      return holder && typeof holder.token === 'string' && typeof holder.host === 'string' && Number.isInteger(holder.pid) && holder.pid > 0 ? holder : null
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      if (error instanceof SyntaxError) return null
      throw error
    }
  }
  const age = () => now() - statSync(path).mtimeMs
  const live = (holder) => {
    if (holder === undefined) return false
    if (holder === null) return true
    // A paused process is still a writer, including another plugin in this process.
    if (holder.host === host) return holder.pid === pid || isAlive(holder.pid)
    return age() < staleMs
  }
  const owns = () => {
    if (failure !== undefined) throw failure
    return held && read()?.token === token
  }

  const beat = () => {
    const failed = (error) => { failure ??= error; stop() }
    try {
      const job = waitForGuard(() => {
        if (!owns()) { stop(); return }
        const time = new Date(now())
        utimesSync(path, time, time)
      })
      job?.catch(failed)
    } catch (error) { failed(error) }
  }

  // undefined means acquired; otherwise return the rival holder. A failed lock
  // operation never grants ownership, even when the state file itself is writable.
  function claim() {
    if (owns()) return undefined
    const take = () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        token = randomUUID()
        try {
          writeFileSync(path, JSON.stringify({ pid, host, token, since: now() }), { flag: 'wx' })
          held = true
          stop()
          timer = setInterval(beat, beatMs)
          timer.unref?.()
          return undefined
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
        }
        const holder = read()
        if (live(holder)) return holder ?? {}
        const current = read()
        if (holder === undefined || current?.token !== holder.token) continue
        try { unlinkSync(path) } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
      return read() ?? {}
    }
    try { return guarded(take) } catch (error) {
      if (error?.code !== 'DS_BOT_LOCK_BUSY') throw error
      return read() ?? { guardBusy: true }
    }
  }

  // The callback must be synchronous: ownership and the final rename share the
  // guard, so a waiting takeover cannot slip between verification and submission.
  function commit(expected, action) {
    return waitForGuard(() => {
      if (token !== expected || !owns()) return false
      action()
      return true
    })
  }

  function release() {
    stop()
    if (!held) return
    return waitForGuard(() => {
      if (read()?.token === token) unlinkSync(path)
      held = false
    })
  }

  return { claim, owns, release, read, commit, lease: () => token }
}
