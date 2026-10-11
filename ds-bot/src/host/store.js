// Store: the saved team (state.json), its migrations, the lock that keeps a second dsh
// host on the same data from writing it, and the indexes that map a Session to the Bot
// or group chat it belongs to.
import { mkdirSync, renameSync, statSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LEGACY_THEMES, MAX_EXCHANGES, ROOM_MODES } from './constants.js'
import { homeLock } from './home-lock.js'
import { currentColor, normalize, unquote } from './text.js'

export function install(rt) {
  const { ctx, home, statePath } = rt

  /** @type {{version:1, workspaceId?:string, mainBotIds:string[], bots:Record<string,any>, rooms:Record<string,any>, agents:Record<string,any>, exchanges:any[], exchangeTurns:Record<string,number[]>, revision:number}} */
  const state = { version: 1, mainBotIds: [], bots: {}, rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0 }
  let loaded = null
  let writing = Promise.resolve()
  let stateReadError
  let hadStateFile = false
  let pending = 0
  let closing = false
  let disposing
  const { warn } = rt

  const EMPTY = JSON.stringify(state)
  // The other dsh host that holds state.lock while this one only reads (see home-lock.js);
  // undefined while this host may write.
  let holder
  let lockBroken = false
  let warnedReadOnly = false
  // mtime and size of the state.json this host last read or wrote.
  let seen = ''
  const stamp = () => {
    try {
      const { mtimeMs, size } = statSync(statePath)
      return `${mtimeMs}:${size}`
    } catch {
      return ''
    }
  }
  const lock = homeLock(join(home, 'state.lock'))
  const breakLock = (error) => {
    lockBroken = true
    holder = {}
    warn('ds-bot: cannot lock %s; the Bot team is read-only: %s', home, error)
  }
  const claimLock = () => {
    if (closing || lockBroken) return
    try {
      mkdirSync(home, { recursive: true })
      holder = lock.claim()
    } catch (error) {
      breakLock(error)
    }
  }
  const ownsLock = () => {
    if (lockBroken) return false
    try {
      if (lock.owns()) return true
      holder = lock.read() ?? {}
    } catch (error) { breakLock(error) }
    return false
  }
  const readOnly = () => {
    if (closing) return `The Bot team in ${home} is closing and cannot accept changes.`
    if (holder === undefined) ownsLock()
    if (lockBroken || holder?.guardBusy) return `The Bot team in ${home} cannot safely lock its data. This window cannot change it; close the dsh hosts, check the data directory and reload.`
    if (holder === undefined) return undefined
    const where = holder.pid ? `pid ${holder.pid}${holder.host ? ` on ${holder.host}` : ''}` : 'unknown process'
    return `The Bot team in ${home} is open in another dsh (Web or Desktop, ${where}). This window shows the team but cannot change it; close the other one and reload.`
  }

  const readFileState = async () => {
    try {
      // A replacement during the read must still be noticed by the next refresh.
      const nextSeen = stamp()
      const contents = await readFile(statePath, 'utf8')
      hadStateFile = true
      const parsed = JSON.parse(contents)
      if (parsed?.version !== 1) throw Object.assign(new Error('Unsupported Bot team state version; restore a compatible state.json before saving.'), { code: 'bot/state-version' })
      if (parsed.revision !== undefined && (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0)) throw Object.assign(new Error('Invalid Bot team state revision; restore a valid state.json before saving.'), { code: 'bot/state-invalid' })
      seen = nextSeen
      stateReadError = undefined
      return parsed
    } catch (error) {
      if (error?.code === 'ENOENT' && !hadStateFile) {
        seen = ''
        stateReadError = undefined
        return undefined
      }
      stateReadError = error
      warn('ds-bot: unreadable state %s: %s', statePath, error)
      throw error
    }
  }

  // Fill `state` from the saved file and bring an older team up to date. Returns the
  // groups whose Session titles still need the new name.
  const adopt = (parsed) => {
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, JSON.parse(EMPTY), parsed ?? {})
    state.prefs ??= {}
    // Teams saved before the DSH Agent existed carry no `agents`; corrupt values reset.
    if (state.agents === null || typeof state.agents !== 'object' || Array.isArray(state.agents)) state.agents = {}
    let migrated = false
    for (const bot of Object.values(state.bots)) {
      if (bot.color !== currentColor(bot.color)) {
        bot.color = currentColor(bot.color)
        migrated = true
      }
      // LEGACY: Bots saved with a lab ran on that lab's default model; the model they
      // last ran on becomes their own, so dropping the lab changes nothing for them.
      if ('lab' in bot) {
        if (!bot.model && bot.appliedModel) bot.model = bot.appliedModel
        delete bot.lab
        migrated = true
      }
    }
    // A team from before several Main Bots were allowed names a single one.
    if (!Array.isArray(state.mainBotIds)) state.mainBotIds = []
    if ('mainBotId' in state) {
      if (state.mainBotId && !state.mainBotIds.includes(state.mainBotId)) state.mainBotIds.unshift(state.mainBotId)
      delete state.mainBotId
      migrated = true
    }
    state.mainBotIds = state.mainBotIds.filter(id => state.bots[id])
    // Teams from before the whale was stored at setup: their first Bot, while still a
    // Main Bot, gets it once wherever it has no look of its own. After that the whale is
    // an ordinary look the user can change, and it never passes to another Bot.
    if (state.whaleStored !== true) {
      const first = Object.values(state.bots).reduce((best, bot) => (best === undefined || (bot.createdAt ?? 0) < (best.createdAt ?? 0) ? bot : best), undefined)
      if (first !== undefined && state.mainBotIds.includes(first.id)) {
        if (!first.avatar?.shape && !first.avatar?.image) first.avatar = { ...first.avatar, shape: 'whale' }
        if (!first.color) first.color = 'deepseek'
      }
      state.whaleStored = true
      if (first !== undefined) migrated = true
    }
    if (Object.hasOwn(LEGACY_THEMES, state.prefs.theme ?? '')) {
      state.prefs.theme = LEGACY_THEMES[state.prefs.theme]
      migrated = true
    }
    // Groups from before group settings existed reply in turn, led by a Main Bot member.
    for (const room of Object.values(state.rooms)) {
      if (room.admin !== undefined && ROOM_MODES.includes(room.mode)) continue
      if (room.admin === undefined) room.admin = room.members.find(id => state.mainBotIds.includes(id)) ?? null
      if (!ROOM_MODES.includes(room.mode)) room.mode = 'everyone'
      room.notice ??= ''
      migrated = true
    }
    // Unnamed groups from before names followed their members may still list old names.
    const stale = Object.values(state.rooms).filter(room => !room.named && room.name !== rt.autoRoomName(room.members))
    for (const room of stale) room.name = rt.autoRoomName(room.members)
    indexSessions()
    return { migrated: migrated || stale.length > 0, stale }
  }

  const readState = async () => {
    const parsed = await readFileState()
    try {
      return adopt(parsed)
    } catch (error) {
      stateReadError = error
      warn('ds-bot: invalid state %s: %s', statePath, error)
      throw error
    }
  }

  const load = () => {
    if (loaded !== null) return loaded
    const job = (async () => {
      claimLock()
      if (readOnly() !== undefined) warn('ds-bot: %s', readOnly())
      const { migrated, stale } = await readState()
      if (readOnly() !== undefined) return
      if (migrated) await save()
      // Not awaited: renaming a session must not hold up the first roster read.
      for (const room of stale) void rt.retitleRoom(room)
    })()
    loaded = job
    // Startup also loads in the background; callers that await still get the error.
    void job.catch(() => { if (loaded === job) loaded = null })
    return job
  }

  // A reading host follows the file and takes over once the other host has gone.
  const refresh = async () => {
    await load()
    if (closing) return
    if (holder === undefined && ownsLock()) {
      if (stateReadError !== undefined) await readState()
      return
    }
    claimLock()
    if (!lockBroken && holder === undefined) {
      warn('ds-bot: the other dsh has closed; this one now saves the Bot team')
      warnedReadOnly = false
      await readState()
      return
    }
    if (stateReadError !== undefined || stamp() !== seen) await readState()
  }

  const writable = () => {
    if (!closing && holder === undefined && ownsLock()) return true
    if (!warnedReadOnly) {
      warnedReadOnly = true
      warn('ds-bot: not saving the Bot team: %s', readOnly())
    }
    return false
  }

  const save = () => {
    if (stateReadError !== undefined) {
      const job = Promise.reject(stateReadError)
      // Turn listeners also save without awaiting; the read failure was already logged.
      void job.catch(() => {})
      return job
    }
    indexSessions()
    // A reading host keeps the file's revision, so its window does not skip the next change.
    if (!writable()) return writing
    state.exchanges = state.exchanges.slice(-MAX_EXCHANGES)
    const snapshot = JSON.parse(JSON.stringify(state))
    const lease = lock.lease()
    pending += 1
    const job = writing.then(async () => {
      if (stateReadError !== undefined) throw stateReadError
      const lost = () => Object.assign(new Error('Cannot save the Bot team after its state lock ownership changed.'), { code: 'DS_BOT_LOCK_LOST' })
      if (!ownsLock() || lock.lease() !== lease) throw lost()
      // Only successful replacements advance the revision, including queued saves.
      snapshot.revision = state.revision + 1
      await mkdir(home, { recursive: true })
      const temp = `${statePath}.${process.pid}.${lease}.tmp`
      try {
        await writeFile(temp, JSON.stringify(snapshot, null, 2), 'utf8')
        if (stateReadError !== undefined) throw stateReadError
        if (!await lock.commit(lease, () => {
          renameSync(temp, statePath)
          state.revision = snapshot.revision
          hadStateFile = true
          seen = stamp()
        })) {
          ownsLock()
          throw lost()
        }
      } finally {
        await unlink(temp).catch(error => {
          if (error?.code !== 'ENOENT') warn('ds-bot: state temporary file cleanup failed: %s', error)
        })
      }
    }).finally(() => { pending -= 1 })
    // Recover the queue without turning this job's rejection into success.
    writing = job.catch(error => {
      try { warn('ds-bot: state write failed: %s', error) } catch {}
    })
    return job
  }

  const releaseLock = () => {
    const failed = error => warn('ds-bot: state lock release failed: %s', error)
    try { return lock.release()?.catch(failed) } catch (error) { failed(error) }
  }
  ctx.effect(() => () => {
    if (closing) return disposing
    closing = true
    if (pending === 0) return disposing = releaseLock()
    return disposing = writing.finally(releaseLock)
  }, 'ds-bot: state lock')

  const botOf = id => (id === undefined ? undefined : state.bots[id])
  const roomOf = id => (id === undefined ? undefined : state.rooms[id])
  const isMain = id => id !== undefined && state.mainBotIds.includes(id)

  // Group Sessions. A member speaks in each group from a hidden Session of its own,
  // `room.sessions[botId]`, that renders the same system prompt and tools as its own
  // chat: the provider's prefix cache is shared, and a group turn never re-reads the
  // member's private context. Created on the member's first turn in the group.
  //
  // Segments. A long conversation moves to a fresh Session at a context line (see
  // parts.js). A Bot's id is the Session id of its first own-chat segment and
  // never changes; `bot.sessionId` is the current one. Earlier segments, of the own
  // chat (`bot.segments`) and of each group Session (`room.segments[botId]`), are
  // archived and stay readable.
  /** @type {Map<string, string>} */
  const chatOwners = new Map()
  /** @type {Map<string, {botId:string, roomId:string}>} */
  const groupOwners = new Map()
  /** @type {Map<string, {botId:string, roomId?:string}>} */
  const pastOwners = new Map()
  const chatOf = botId => botOf(botId)?.sessionId ?? botId
  const indexSessions = () => {
    chatOwners.clear()
    groupOwners.clear()
    pastOwners.clear()
    for (const bot of Object.values(state.bots)) {
      for (const segment of bot.segments ?? []) pastOwners.set(segment.sessionId, { botId: bot.id })
      chatOwners.set(chatOf(bot.id), bot.id)
    }
    for (const room of Object.values(state.rooms)) {
      for (const [botId, segments] of Object.entries(room.segments ?? {})) {
        for (const segment of segments) pastOwners.set(segment.sessionId, { botId, roomId: room.id })
      }
      for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) groupOwners.set(sessionId, { botId, roomId: room.id })
    }
    // The agents module owns the DSH Agent session index; it installs after this.
    rt.indexAgents?.()
  }
  // The Bot a Session speaks for: its own chat, one of its group Sessions, or an
  // earlier segment of either.
  const selfOf = id => chatOwners.get(id) ?? groupOwners.get(id)?.botId ?? pastOwners.get(id)?.botId
  // A Session where the Bot speaks now, as opposed to an archived segment.
  const isBotSession = id => chatOwners.has(id) || groupOwners.has(id)
  const groupSessionsOf = botId => Object.values(state.rooms).map(room => room.sessions?.[botId]).filter(Boolean)
  const dropGroupSession = (room, botId) => {
    const sessionId = room.sessions?.[botId]
    if (sessionId === undefined) return
    delete room.sessions[botId]
    if (room.segments !== undefined) delete room.segments[botId]
    groupOwners.delete(sessionId)
    void ctx.workspaceRegistry.archiveSession(sessionId).catch(() => {})
  }
  const findBot = (ref) => {
    if (ref === undefined) return undefined
    if (state.bots[ref]) return state.bots[ref]
    const wanted = normalize(ref).replace(/^@/, '')
    return Object.values(state.bots).find(bot => normalize(bot.name) === wanted)
  }
  // Every group chat whose id or name matches; callers refuse an ambiguous name.
  const findRooms = (ref) => {
    if (ref === undefined || ref === null) return []
    if (state.rooms[ref]) return [state.rooms[ref]]
    const wanted = normalize(unquote(ref))
    return Object.values(state.rooms).filter(room => normalize(room.name) === wanted)
  }
  const isAdminOf = (room, id) => id !== undefined && room.admin === id

  Object.assign(rt, {
    state, load, save, refresh, readOnly,
    botOf, roomOf, isMain, chatOf, selfOf, isBotSession,
    chatOwners, groupOwners, pastOwners,
    groupSessionsOf, dropGroupSession, findBot, findRooms, isAdminOf,
  })
}
