import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultShow, normalizeShow } from '../../shared/types'
import type { LiveState, ServerMessage, Show } from '../../shared/types'

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

const app = Fastify({ logger: { level: 'info' } })
await app.register(websocket)

// Companion's HTTP module may POST with no body or an arbitrary content type; don't 415/400 on that.
app.removeContentTypeParser('application/json')
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  if (!body) return done(null, undefined)
  try { done(null, JSON.parse(body as string)) } catch (e) { done(e as Error) }
})
app.addContentTypeParser('*', (_req, _payload, done) => done(null, undefined))

app.get('/ws', { websocket: true }, (socket, req) => {
  const cid = new URL(req.url, 'http://x').searchParams.get('cid') ?? crypto.randomUUID()
  clients.set(cid, socket)
  socket.on('close', () => clients.delete(cid))
  socket.send(JSON.stringify({ type: 'hello', show, live } satisfies ServerMessage))
})

app.get('/api/show', async () => show)

app.put<{ Body: Show }>('/api/show', async (req, reply) => {
  const body = req.body
  if (!body || !Array.isArray(body.cameras) || !body.stage) {
    return reply.code(400).send({ error: 'invalid show' })
  }
  show = normalizeShow(body)
  saveShow(show)
  const cid = req.headers['x-client-id']
  broadcast({ type: 'show', show }, typeof cid === 'string' ? cid : undefined)
  return { ok: true }
})

app.get('/api/live', async () => live)

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
