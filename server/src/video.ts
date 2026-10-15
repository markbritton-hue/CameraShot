import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { IPV4 } from '../../shared/types'
import type { Camera } from '../../shared/types'

/**
 * Live video for the setup page. Browsers can't play a camera's RTSP stream, so go2rtc (a small
 * open-source program in tools/go2rtc) pulls it and serves a browser-playable version.
 *
 * Safety: go2rtc is bound to 127.0.0.1 only (this PC's own screen), its RTSP/WebRTC servers are off,
 * and stream addresses are built here from a validated private IPv4 address and a plain path, never
 * from free text, so nothing like an `exec:` source can be injected.
 */
const PATH_OK = /^\/[A-Za-z0-9_\-/]{0,40}$/
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/
const DEFAULT_PATH = '/2'

export interface VideoStatus {
  state: 'missing' | 'off' | 'starting' | 'ready' | 'error'
  port: number
  /** stream names go2rtc is serving, e.g. cam1 */
  streams: string[]
  error?: string
}

interface Options {
  exe: string
  dataDir: string
  port: number
}

export function createVideo({ exe, dataDir, port }: Options) {
  const cfgFile = path.join(dataDir, 'go2rtc.yaml')
  const pidFile = path.join(dataDir, 'go2rtc.pid')
  const logFile = path.join(dataDir, 'go2rtc.log')
  let child: ChildProcess | null = null
  let runningConfig = ''
  let lastCameras: Camera[] = []
  let failures = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let status: VideoStatus = { state: fs.existsSync(exe) ? 'off' : 'missing', port, streams: [] }

  /** A go2rtc left behind by a previous server run (e.g. killed on restart). Only kill it if the PID really is go2rtc. */
  function killLeftover() {
    try {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'))
      if (pid > 0) {
        if (process.platform === 'win32') {
          const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
          if (/go2rtc\.exe/i.test(out)) execFileSync('taskkill', ['/PID', String(pid), '/F'])
        } else {
          const name = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' })
          if (/go2rtc/.test(name)) process.kill(pid)
        }
      }
    } catch { /* nothing left over, or already gone */ }
    try { fs.rmSync(pidFile) } catch { /* no pid file */ }
  }

  function stop() {
    clearTimeout(retryTimer)
    const c = child
    child = null
    runningConfig = ''
    if (c) { try { c.kill() } catch { /* already exited */ } }
    try { fs.rmSync(pidFile) } catch { /* no pid file */ }
  }

  async function waitReady(c: ChildProcess) {
    for (let i = 0; i < 25 && child === c; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api`, { signal: AbortSignal.timeout(400) })
        if (r.ok) return
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error('go2rtc did not start (is another program using port ' + port + '?)')
  }

  /** Make go2rtc serve exactly the cameras that have a valid IP. Restarts it only when that set changes. */
  async function sync(cameras: Camera[]) {
    lastCameras = cameras
    if (!fs.existsSync(exe)) { status = { state: 'missing', port, streams: [] }; return }

    const streams = new Map<string, string>()
    for (const c of cameras) {
      if (!c.ip || !IPV4.test(c.ip) || !PRIVATE_IP.test(c.ip)) continue
      const p = c.rtspPath && PATH_OK.test(c.rtspPath) ? c.rtspPath : DEFAULT_PATH
      streams.set(`cam${c.number}`, `rtsp://${c.ip}:554${p}`)
    }
    if (streams.size === 0) { stop(); status = { state: 'off', port, streams: [] }; return }

    const config = [
      'api:', `  listen: "127.0.0.1:${port}"`,
      'rtsp:', '  listen: ""',
      'webrtc:', '  listen: ""',
      'streams:', ...[...streams].map(([name, url]) => `  ${name}: "${url}"`),
      '',
    ].join('\n')
    if (child && config === runningConfig) return

    killLeftover() // read the pid file before stop() deletes it
    stop()
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(cfgFile, config)
    const log = fs.openSync(logFile, 'a')
    status = { state: 'starting', port, streams: [...streams.keys()] }
    const c = spawn(exe, ['-config', cfgFile], { stdio: ['ignore', log, log], windowsHide: true })
    fs.closeSync(log)
    child = c
    runningConfig = config
    if (c.pid) fs.writeFileSync(pidFile, String(c.pid))
    c.on('exit', (code) => {
      if (child !== c) return // stopped on purpose by us
      child = null
      runningConfig = ''
      status = { ...status, state: 'error', error: `go2rtc stopped (exit ${code})` }
      // it died by itself (crashed, or someone killed it): start it again, backing off up to 30 s, giving up after 5 tries
      if (failures < 5) {
        retryTimer = setTimeout(() => void sync(lastCameras), Math.min(30_000, 2_000 * 2 ** failures))
        failures++
      }
    })
    c.on('error', (e) => { status = { ...status, state: 'error', error: e.message } })
    try {
      await waitReady(c)
      if (child === c) { status = { ...status, state: 'ready', error: undefined }; failures = 0 }
    } catch (e) {
      if (child === c) status = { ...status, state: 'error', error: e instanceof Error ? e.message : String(e) }
    }
  }

  return { sync, stop, status: () => status }
}
