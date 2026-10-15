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
import { applySetting, readStatus } from './visca'
import { createVideo } from './video'
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
// stop go2rtc with the server (a hard kill can't run this; the next start cleans up any leftover)
process.on('exit', () => video.stop())
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
  socket.send(JSON.stringify({ type: 'hello', show, live, atem: atemLink.status() } satisfies ServerMessage))
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
 * PTZ camera image controls (exposure, gain, white balance) over VISCA.
 * Only cameras whose IP is entered in this show's setup are reachable, so the endpoint can't be
 * pointed at arbitrary devices on the network.
 */
const ptzTarget = (host: string | undefined) => {
  const cam = show.cameras.find((c) => c.ip && c.ip === host)
  return cam ? { host: cam.ip as string, port: cam.viscaPort ?? DEFAULT_VISCA_PORT } : null
}
const SETTINGS: PtzSetting[] = ['exposureMode', 'gain', 'wbMode', 'redGain', 'blueGain', 'onePush', 'blc', 'expComp', 'expCompLevel', 'saturation', 'hue']
const NOT_CONFIGURED = 'that IP is not a camera in this show. Enter it in Setup and wait a moment for it to save.'

app.get<{ Querystring: { host?: string } }>('/api/ptz/status', async (req, reply) => {
  const t = ptzTarget(req.query.host)
  if (!t) return reply.code(404).send({ ok: false, error: NOT_CONFIGURED })
  try {
    return { ok: true, status: await readStatus(t.host, t.port) }
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
 * Recall a camera preset, like a PTZ memory button.
 *   /api/camera/2/preset/3  -> camera number 2 moves to its 3rd saved preset
 * GET and POST both work so a Companion button can call it directly.
 */
const recallPreset = async (
  req: { params: { number: string; index: string } },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) => {
  const cam = show.cameras.find((c) => c.number === Number(req.params.number))
  if (!cam) return reply.code(404).send({ error: `no camera ${req.params.number}` })
  const preset = cam.presets[Number(req.params.index) - 1]
  if (!preset) return reply.code(404).send({ error: `camera ${cam.number} has no preset ${req.params.index}` })
  cam.fov = preset.fov
  cam.focus = { ...preset.focus }
  show.updatedAt = Date.now()
  saveShow(show)
  broadcast({ type: 'show', show })
  return { ok: true, camera: cam.number, preset: preset.name }
}
app.get('/api/camera/:number/preset/:index', recallPreset as never)
app.post('/api/camera/:number/preset/:index', recallPreset as never)

if (fs.existsSync(clientDist)) {
  await app.register(fastifyStatic, { root: clientDist })
}

await app.listen({ port: PORT, host: '0.0.0.0' })
