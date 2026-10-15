import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { defaultShow, IPV4, normalizeShow } from '../../shared/types'
import type { LiveState, ServerMessage, Show } from '../../shared/types'
import { createAtemLink } from './atem'
import { applySetting, drive, readPosition, readStatus } from './visca'
import { createVideo } from './video'
import { createPtzWatcher } from './ptzWatch'
import type { PtzSetting } from '../../shared/types'
import { DEFAULT_VISCA_PORT } from '../../shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '../..')
const dataDir = process.env.DATA_DIR ?? path.join(root, 'data')
const dataFile = path.join(dataDir, 'show.json')
const clientDist = path.join(root, 'client', 'dist')
const PORT = Number(process.env.PORT ?? 3001)

function loadShow(): Show {
  try {
    return normalizeShow(JSON.parse(fs.readFileSync(dataFile, 'utf8')) as Show)
  } catch {
    return structuredClone(defaultShow)
  }
}

const backupDir = path.join(dataDir, 'backups')
let lastBackup = 0

function saveShow(show: Show) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true })
  // rolling history of the previous file (at most one a minute, newest 30) so a bad edit isn't final
  if (fs.existsSync(dataFile) && Date.now() - lastBackup > 60_000) {
    fs.mkdirSync(backupDir, { recursive: true })
    fs.copyFileSync(dataFile, path.join(backupDir, `show-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))
    lastBackup = Date.now()
    for (const f of fs.readdirSync(backupDir).sort().slice(0, -30)) fs.rmSync(path.join(backupDir, f))
  }
  // write to a temp file then rename, so a crash mid-write can't leave a half-written show
  const tmp = `${dataFile}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(show, null, 2))
  fs.renameSync(tmp, dataFile)
}

let show = loadShow()
let live: LiveState = { program: null, preview: null }
const clients = new Map<string, import('ws').WebSocket>()

function broadcast(msg: ServerMessage, exceptCid?: string) {
  const data = JSON.stringify(msg)
  for (const [cid, ws] of clients) {
    if (cid !== exceptCid && ws.readyState === ws.OPEN) ws.send(data)
  }
}

const atemLink = createAtemLink({
  onLive: (program, preview) => {
    if (live.program === program && live.preview === preview) return // transitions fire many state updates
    live = { program, preview }
    broadcast({ type: 'live', live })
  },
  onStatus: (atem) => broadcast({ type: 'atem', atem }),
})
void atemLink.configure(show.settings.atemIp, show.settings.me)

const video = createVideo({
  exe: path.join(root, 'tools', 'go2rtc', process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc'),
  dataDir,
  port: Number(process.env.GO2RTC_PORT ?? 1984),
})
void video.sync(show.cameras)
/**
 * Camera memory preset N and stage-plan preset N are the same number. When a PTZ camera is sent to
 * preset N (from this app, Companion, or a joystick), the plan follows: the cone takes the aim and
 * zoom saved in stage preset N, if there is one.
 */
function applyStagePreset(cameraId: string, n: number) {
  const cam = show.cameras.find((c) => c.id === cameraId)
  const sp = cam?.presets[n - 1]
  if (!cam || !sp) return
  const same = cam.fov === sp.fov && cam.focus.x === sp.focus.x && cam.focus.y === sp.focus.y && cam.focus.radius === sp.focus.radius
  if (same) return
  cam.fov = sp.fov
  cam.focus = { ...sp.focus }
  show.updatedAt = Date.now()
  saveShow(show)
  broadcast({ type: 'show', show })
}

/** Remember that preset slot n is programmed on this camera (see Camera.slots). Slot 0 means "none recalled yet" on most cameras. */
function addSlot(cameraId: string, n: number) {
  const cam = show.cameras.find((c) => c.id === cameraId)
  if (!cam || !Number.isInteger(n) || n < 1 || n > 127) return
  const slots = cam.slots ?? []
  if (slots.includes(n)) return
  cam.slots = [...slots, n].sort((a, b) => a - b)
  show.updatedAt = Date.now()
  saveShow(show)
  broadcast({ type: 'show', show })
}

const ptzWatch = createPtzWatcher({
  cameras: () => show.cameras,
  onStates: (ptz) => broadcast({ type: 'ptz', ptz }),
  onExternalRecall: applyStagePreset,
  onPresetSeen: addSlot,
  intervalMs: Number(process.env.PTZ_POLL_MS ?? 1000),
})

// stop go2rtc with the server (a hard kill can't run this; the next start cleans up any leftover)
process.on('exit', () => { video.stop(); ptzWatch.stop() })
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0))

const app = Fastify({ logger: { level: 'info' } })
await app.register(websocket)

// Companion's HTTP module may POST with no body or an arbitrary content type; don't 415/400 on that.
app.removeContentTypeParser('application/json')
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  if (!body) return done(null, undefined)
  try {
    done(null, JSON.parse(body as string))
  } catch (e) {
    done(Object.assign(e as Error, { statusCode: 400 })) // bad JSON from a client is a 400, not a server error
  }
})
app.addContentTypeParser('*', (_req, _payload, done) => done(null, undefined))

app.get('/ws', { websocket: true }, (socket, req) => {
  const cid = new URL(req.url, 'http://x').searchParams.get('cid') ?? crypto.randomUUID()
  clients.set(cid, socket)
  socket.on('close', () => clients.delete(cid))
  socket.send(JSON.stringify({ type: 'hello', show, live, atem: atemLink.status(), ptz: ptzWatch.states() } satisfies ServerMessage))
})

app.get('/api/show', async () => show)

app.put<{ Body: Show }>('/api/show', async (req, reply) => {
  const body = req.body
  if (!body || !Array.isArray(body.cameras) || !body.stage) {
    return reply.code(400).send({ error: 'invalid show' })
  }
  show = normalizeShow(body)
  saveShow(show)
  void atemLink.configure(show.settings.atemIp, show.settings.me)
  void video.sync(show.cameras)
  const cid = req.headers['x-client-id']
  broadcast({ type: 'show', show }, typeof cid === 'string' ? cid : undefined)
  return { ok: true }
})

app.get('/api/live', async () => live)
app.get('/api/atem/status', async () => atemLink.status())
app.get('/api/video/status', async () => video.status())

/**
 * Reachability check for the setup page: one ping to a camera or the ATEM.
 * Only private-network IPv4 addresses are accepted, and the address is passed as an
 * argument (no shell), so this can't be used to run commands or probe the internet.
 */
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/
app.get<{ Querystring: { host?: string } }>('/api/ping', async (req, reply) => {
  const host = req.query.host ?? ''
  if (!IPV4.test(host) || !PRIVATE_IP.test(host)) {
    return reply.code(400).send({ ok: false, error: 'enter a local IPv4 address, e.g. 192.168.1.50' })
  }
  const win = process.platform === 'win32'
  const args = win ? ['-n', '1', '-w', '1500', host] : ['-c', '1', '-W', '2', host]
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: 5000 }, (err, stdout) => {
      // Windows exits 0 even for "host unreachable" replies, so look for a real TTL reply
      const alive = win ? /TTL=/i.test(stdout) : !err
      const m = /time[=<]\s*(\d+(?:\.\d+)?)\s*ms/i.exec(stdout)
      resolve({ ok: alive, ms: alive && m ? Number(m[1]) : undefined })
    })
  })
})

/**
 * ATEM state endpoints, called by Companion (Generic: HTTP Requests) or the in-app simulator.
 *   /api/atem/program/3        -> input 3 is live
 *   /api/atem/preview/5        -> input 5 is in preview
 *   /api/atem/program/0        -> clear
 * Optional ?me=2 — ignored unless it matches the M/E configured in settings.
 * Both GET and POST are accepted so Companion can use either.
 */
function setLive(which: 'program' | 'preview') {
  return async (
    req: { params: { input: string }; query: { me?: string } },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    const input = Number(req.params.input)
    if (!Number.isInteger(input) || input < 0 || input > 99) {
      return reply.code(400).send({ error: 'input must be an integer 0-99' })
    }
    if (req.query.me !== undefined && Number(req.query.me) !== show.settings.me) {
      return { ok: true, ignored: `me ${req.query.me} != ${show.settings.me}` }
    }
    live = { ...live, [which]: input === 0 ? null : input }
    broadcast({ type: 'live', live })
    return { ok: true, live }
  }
}
for (const which of ['program', 'preview'] as const) {
  const handler = setLive(which)
  app.get(`/api/atem/${which}/:input`, handler as never)
  app.post(`/api/atem/${which}/:input`, handler as never)
}

/**
 * PTZ camera control (movement, exposure, gain, white balance) over VISCA.
 * Only cameras marked PTZ with an IP entered in this show's setup are reachable, so the endpoints can't
 * be pointed at arbitrary devices on the network or at fixed cameras.
 */
const ptzTarget = (host: string | undefined) => {
  const cam = show.cameras.find((c) => c.ptz && c.ip && c.ip === host)
  return cam ? { id: cam.id, host: cam.ip as string, port: cam.viscaPort ?? DEFAULT_VISCA_PORT } : null
}
const SETTINGS: PtzSetting[] = ['exposureMode', 'gain', 'wbMode', 'redGain', 'blueGain', 'onePush', 'blc', 'expComp', 'expCompLevel', 'saturation', 'hue']
const NOT_CONFIGURED = 'that IP is not a PTZ camera in this show. Tick PTZ and enter its IP in Setup, then wait a moment for it to save.'

app.get<{ Querystring: { host?: string } }>('/api/ptz/status', async (req, reply) => {
  const t = ptzTarget(req.query.host)
  if (!t) return reply.code(404).send({ ok: false, error: NOT_CONFIGURED })
  try {
    return { ok: true, status: await readStatus(t.host, t.port) }
  } catch (e) {
    return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
})

/** Current preset number and pan/tilt/zoom position, polled by the camera window. */
app.get<{ Querystring: { host?: string } }>('/api/ptz/position', async (req, reply) => {
  const t = ptzTarget(req.query.host)
  if (!t) return reply.code(404).send({ ok: false, error: NOT_CONFIGURED })
  try {
    return { ok: true, position: await readPosition(t.host, t.port) }
  } catch (e) {
    return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
})

app.post<{ Body: { host?: string; setting?: PtzSetting; value?: number } }>('/api/ptz/control', async (req, reply) => {
  const { host, setting, value } = req.body ?? {}
  const t = ptzTarget(host)
  if (!t) return reply.code(404).send({ ok: false, error: NOT_CONFIGURED })
  if (!setting || !SETTINGS.includes(setting)) return reply.code(400).send({ ok: false, error: 'unknown setting' })
  try {
    await applySetting(t.host, t.port, setting, value)
  } catch (e) {
    const bad = e instanceof RangeError
    return reply.code(bad ? 400 : 502).send({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
  // read it back so the page shows what the camera is really doing
  try {
    return { ok: true, status: await readStatus(t.host, t.port) }
  } catch {
    return { ok: true }
  }
})

/**
 * Pan / tilt / zoom. The page sends "move" repeatedly while a button is held; if those stop arriving
 * (tab closed, network drop, lost "stop" packet) this watchdog stops the camera by itself.
 */
const WATCHDOG_MS = 1500
const moveWatchdogs = new Map<string, ReturnType<typeof setTimeout>>()
const armWatchdog = (t: { host: string; port: number }) => {
  const key = `${t.host}:${t.port}`
  clearTimeout(moveWatchdogs.get(key))
  moveWatchdogs.set(key, setTimeout(() => {
    moveWatchdogs.delete(key)
    void drive.stop(t.host, t.port).catch(() => {})
  }, WATCHDOG_MS))
}

app.post<{ Body: { host?: string; action?: string; dir?: string; speed?: number; n?: number } }>('/api/ptz/drive', async (req, reply) => {
  const { host, action, dir, speed, n } = req.body ?? {}
  const t = ptzTarget(host)
  if (!t) return reply.code(404).send({ ok: false, error: NOT_CONFIGURED })
  try {
    switch (action) {
      case 'move': await drive.move(t.host, t.port, String(dir), speed); armWatchdog(t); break
      case 'zoom': await drive.zoom(t.host, t.port, String(dir), speed); armWatchdog(t); break
      case 'stop': clearTimeout(moveWatchdogs.get(`${t.host}:${t.port}`)); await drive.stop(t.host, t.port); break
      case 'home': await drive.home(t.host, t.port); break
      case 'recall':
      case 'store':
        await drive.preset(t.host, t.port, action, n)
        if (action === 'recall') { ptzWatch.noteRecall(t.id); applyStagePreset(t.id, Number(n)) }
        else addSlot(t.id, Number(n)) // saved here, so it is certainly programmed
        break
      default: return reply.code(400).send({ ok: false, error: 'action must be move, zoom, stop, home, recall or store' })
    }
    return { ok: true }
  } catch (e) {
    return reply.code(e instanceof RangeError ? 400 : 502).send({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
})

/**
 * Recall a camera preset, like a PTZ memory button.
 *   /api/camera/2/preset/3  -> camera number 2 goes to preset 3
 * For a PTZ camera that is the camera's own memory preset 3 (it physically moves) plus stage-plan preset 3
 * if one exists (the cone follows). For any other camera it is the stage-plan preset only.
 * GET and POST both work so a Companion button can call it directly.
 */
const recallPreset = async (
  req: { params: { number: string; index: string } },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) => {
  const cam = show.cameras.find((c) => c.number === Number(req.params.number))
  if (!cam) return reply.code(404).send({ error: `no camera ${req.params.number}` })
  const n = Number(req.params.index)
  const preset = cam.presets[n - 1]
  const physical = cam.ptz === true && !!cam.ip && IPV4.test(cam.ip)
  if (!preset && !physical) return reply.code(404).send({ error: `camera ${cam.number} has no preset ${req.params.index}` })
  if (physical) {
    try {
      await drive.preset(cam.ip as string, cam.viscaPort ?? DEFAULT_VISCA_PORT, 'recall', n)
      ptzWatch.noteRecall(cam.id)
    } catch (e) {
      const bad = e instanceof RangeError
      return reply.code(bad ? 400 : 502).send({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  if (preset) {
    cam.fov = preset.fov
    cam.focus = { ...preset.focus }
    show.updatedAt = Date.now()
    saveShow(show)
    broadcast({ type: 'show', show })
  }
  return { ok: true, camera: cam.number, preset: preset?.name ?? `preset ${n}`, moved: physical }
}
app.get('/api/camera/:number/preset/:index', recallPreset as never)
app.post('/api/camera/:number/preset/:index', recallPreset as never)

if (fs.existsSync(clientDist)) {
  await app.register(fastifyStatic, { root: clientDist })
}

await app.listen({ port: PORT, host: '0.0.0.0' })
