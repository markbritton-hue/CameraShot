import os from 'node:os'
import type { FastifyInstance } from 'fastify'
import type { createVideo } from './video'

type Video = ReturnType<typeof createVideo>

/**
 * Lets other devices on the network (an iPad) watch the live video THROUGH this server.
 *
 * go2rtc itself stays bound to 127.0.0.1, because its web API can add streams and change its config. Only what a
 * player needs is passed on: the three player files, and the video websocket for one stream named camN. Anything else
 * under /video/ is a 404, so the helper's admin pages are never reachable from the network.
 */
const PLAYER_FILES = new Set(['stream.html', 'video-stream.js', 'video-rtc.js'])
const STREAM_NAME = /^cam\d{1,3}$/

export function registerVideoProxy(app: FastifyInstance, video: Video) {
  // the player page and its two scripts
  app.get<{ Params: { file: string } }>('/video/:file', async (req, reply) => {
    const { file } = req.params
    if (!PLAYER_FILES.has(file)) return reply.code(404).send('not found')
    const st = video.status()
    if (st.state !== 'ready') return reply.code(503).send('the video helper is not running')
    try {
      const r = await fetch(`http://127.0.0.1:${st.port}/${file}`, { signal: AbortSignal.timeout(5000) })
      return reply.code(r.status).header('content-type', r.headers.get('content-type') ?? 'text/plain').header('cache-control', 'no-store').send(Buffer.from(await r.arrayBuffer()))
    } catch {
      return reply.code(502).send('the video helper did not answer')
    }
  })

  // the video itself: the browser's player opens this websocket and we relay it to go2rtc, both ways
  app.get('/video/api/ws', { websocket: true }, (socket, req) => {
    const src = new URL(req.url, 'http://x').searchParams.get('src') ?? ''
    const st = video.status()
    if (!STREAM_NAME.test(src) || st.state !== 'ready' || !st.streams.includes(src)) {
      socket.close(1008, 'unknown stream')
      return
    }
    const upstream = new WebSocket(`ws://127.0.0.1:${st.port}/api/ws?src=${src}`)
    upstream.binaryType = 'arraybuffer'
    const waiting: (string | Buffer)[] = [] // messages that arrive before the upstream socket is open
    // Node's built-in WebSocket takes Buffers fine; its typings are just stricter than the `ws` package's
    const sendUp = (m: string | Buffer) => upstream.send(m as never)
    upstream.onopen = () => { for (const m of waiting.splice(0)) sendUp(m) }
    upstream.onmessage = (e) => socket.send(typeof e.data === 'string' ? e.data : Buffer.from(e.data as ArrayBuffer))
    upstream.onclose = () => socket.close()
    upstream.onerror = () => socket.close()
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      const m = isBinary ? data : data.toString()
      if (upstream.readyState === WebSocket.OPEN) sendUp(m)
      else waiting.push(m)
    })
    socket.on('close', () => upstream.close())
    socket.on('error', () => upstream.close())
  })
}

/** This PC's private-network addresses, so the app can say "open this on the iPad". Tailscale's 100.64/10 range is labelled. */
export function networkAddresses() {
  const out: { address: string; kind: 'lan' | 'tailscale' }[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) out.push({ address: i.address, kind: 'lan' })
      else if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(i.address)) out.push({ address: i.address, kind: 'tailscale' })
    }
  }
  return out
}
