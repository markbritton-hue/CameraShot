import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_VISCA_PORT } from '../../shared/types'
import type { PtzSetting, PtzStatus } from '../../shared/types'

interface Props {
  host: string
  port: number | undefined
  onPort: (port: number | undefined) => void
  camNumber: number
  rtspPath: string | undefined
  onRtspPath: (path: string | undefined) => void
  /** false when the caller already shows the live picture (the camera viewer window) */
  showLive?: boolean
  /** tighter spacing, for the narrow column beside the pan/tilt pad */
  compact?: boolean
}

interface VideoStatus { state: 'missing' | 'off' | 'starting' | 'ready' | 'error'; port: number; streams: string[]; error?: string }

const DEFAULT_RTSP_PATH = '/2'
// go2rtc only listens on this PC, so the picture can only be shown on the screen CameraShot runs on
const ON_THIS_PC = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)

/**
 * The picture itself (or a message explaining why there isn't one). go2rtc turns the camera's RTSP stream into
 * something the browser can play. `fill` makes it fill its container (the floating window) instead of keeping 16:9.
 */
export function LiveFrame({ camNumber, rtspPath, fill = false }: { camNumber: number; rtspPath: string | undefined; fill?: boolean }) {
  const [video, setVideo] = useState<VideoStatus | null>(null)
  const stream = `cam${camNumber}`

  useEffect(() => {
    if (!ON_THIS_PC) return
    let stop = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const v = (await (await fetch('/api/video/status')).json()) as VideoStatus
        if (stop) return
        setVideo(v)
        // keep checking until the stream is being served (the camera's IP/path is saved a moment after you type it)
        if (!(v.state === 'ready' && v.streams.includes(stream))) timer = window.setTimeout(poll, 1500)
      } catch {
        if (!stop) timer = window.setTimeout(poll, 3000)
      }
    }
    void poll()
    return () => { stop = true; window.clearTimeout(timer) }
  }, [stream, rtspPath])

  const msg = (text: string, bad = false) => <p className={`hint${bad ? ' bad' : ''}${fill ? ' live-msg' : ''}`}>{text}</p>
  if (!ON_THIS_PC) return msg('Live view only works on the PC running CameraShot. Open it there at http://localhost:5173.')
  if (!video) return msg('Checking…')
  if (video.state === 'missing') return msg("The video helper isn't installed (tools/go2rtc/go2rtc.exe).", true)
  if (video.state === 'error') return msg(`${video.error ?? 'The video helper stopped.'} It restarts by itself.`, true)
  if (video.state !== 'ready' || !video.streams.includes(stream)) return msg('Starting the video…')
  return (
    <div className={`live-frame${fill ? ' fill' : ''}`}>
      {/* key forces a fresh connection when the stream path changes */}
      <iframe key={`${stream}-${rtspPath ?? ''}`} title={`Camera ${camNumber} live view`} allow="autoplay"
        src={`http://127.0.0.1:${video.port}/stream.html?src=${stream}&mode=mse`} />
    </div>
  )
}

/** Live picture with a hide button and the RTSP path box, for the setup page and the camera window. */
export function LiveView({ camNumber, rtspPath, onRtspPath }: Pick<Props, 'camNumber' | 'rtspPath' | 'onRtspPath'>) {
  const [open, setOpen] = useState(true)

  return (
    <div className="live">
      <div className="live-bar">
        <button onClick={() => setOpen(!open)}>{open ? 'Hide live view' : 'Show live view'}</button>
        <label className="ptz-port">RTSP path
          <input value={rtspPath ?? DEFAULT_RTSP_PATH} spellCheck={false}
            title="/2 is the lower-resolution stream on most AVKANS cameras; /1 is the main (4K) stream"
            onChange={(e) => { const v = e.target.value.trim(); onRtspPath(v && v !== DEFAULT_RTSP_PATH ? v : undefined) }} />
        </label>
      </div>
      {open && <LiveFrame camNumber={camNumber} rtspPath={rtspPath} />}
    </div>
  )
}

// Names match the camera's own web page. Aperture Priority is VISCA "iris priority" (11).
const EXPOSURE: [number, string][] = [[0, 'Auto'], [3, 'Manual'], [10, 'Shutter priority'], [11, 'Aperture priority'], [13, 'Bright']]
// "Static" (11) is inferred: the camera shows Static and reports 0x0B. It is the colour-temperature mode.
const WB: [number, string][] = [[0, 'Auto mode'], [5, 'Manual mode'], [4, 'Auto tracking'], [3, 'One press WB'], [11, 'Static']]
const SLIDER_DELAY_MS = 250

type SliderKey = 'gain' | 'redGain' | 'blueGain' | 'expCompLevel' | 'saturation' | 'hue'

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`

/** Exposure, white balance and colour for one PTZ camera, read from and sent to the camera over VISCA. */
export default function PtzControls({ host, port, onPort, camNumber, rtspPath, onRtspPath, showLive = true, compact = false }: Props) {
  const [status, setStatus] = useState<PtzStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // slider positions while dragging; the camera is only sent a value once you pause
  const [drafts, setDrafts] = useState<Partial<Record<SliderKey, number>>>({})
  const timers = useRef<Record<string, number>>({})

  const apply = (r: { ok: boolean; status?: PtzStatus; error?: string }) => {
    if (!r.ok) { setError(r.error ?? 'the camera did not accept that'); return }
    setError('')
    if (r.status) { setStatus(r.status); setDrafts({}) }
  }

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const r = await fetch(`/api/ptz/status?host=${encodeURIComponent(host)}`)
      apply(await r.json())
    } catch {
      setError('could not reach the CameraShot server')
    }
    setBusy(false)
  }, [host])

  useEffect(() => {
    void load()
    const t = timers.current
    return () => Object.values(t).forEach((id) => window.clearTimeout(id))
  }, [load, port]) // re-read if the port changes

  const send = async (setting: PtzSetting, value?: number) => {
    setBusy(true)
    try {
      const r = await fetch('/api/ptz/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host, setting, value }),
      })
      apply(await r.json())
    } catch {
      setError('could not reach the CameraShot server')
    }
    setBusy(false)
  }

  const slide = (setting: SliderKey, value: number) => {
    setDrafts((d) => ({ ...d, [setting]: value }))
    window.clearTimeout(timers.current[setting])
    timers.current[setting] = window.setTimeout(() => void send(setting, value), SLIDER_DELAY_MS)
  }

  const manualWb = status?.wbMode === 5
  const known = (list: [number, string][], v: number) => list.some(([n]) => n === v)

  const slider = (key: SliderKey, label: string, max: number, enabled = true, hint?: string) => status && (
    <label>{label} {drafts[key] ?? status[key]}
      <input type="range" min={0} max={max} value={drafts[key] ?? status[key]} disabled={!enabled}
        onChange={(e) => slide(key, +e.target.value)} />
      {!enabled && hint && <span className="hint">{hint}</span>}
    </label>
  )

  return (
    <div className={`ptz${compact ? ' compact' : ''}`}>
      {showLive &&<LiveView camNumber={camNumber} rtspPath={rtspPath} onRtspPath={onRtspPath} />}
      <div className="ptz-bar">
        <button onClick={() => void load()} disabled={busy}>{busy ? 'Working…' : 'Read from camera'}</button>
        <label className="ptz-port">VISCA port
          <input type="number" min={1} max={65535} value={port ?? DEFAULT_VISCA_PORT}
            onChange={(e) => { const v = +e.target.value; onPort(v && v !== DEFAULT_VISCA_PORT ? v : undefined) }} />
        </label>
      </div>

      {error && <p className="hint bad">{error}</p>}

      {status && (
        <>
          <h4>Exposure</h4>
          <div className="ptz-grid">
            <label>Exposure mode
              <select value={status.exposureMode} disabled={busy} onChange={(e) => void send('exposureMode', +e.target.value)}>
                {!known(EXPOSURE, status.exposureMode) && <option value={status.exposureMode} disabled>Other ({hex(status.exposureMode)})</option>}
                {EXPOSURE.map(([n, name]) => <option key={n} value={n}>{name}</option>)}
              </select>
            </label>
            {/* not limited to Manual: this camera lets gain move in Aperture Priority too, and it refuses (with a message) where it can't */}
            {slider('gain', 'Gain', 15)}
            {slider('expCompLevel', 'Exposure level', 14)}
            <div className="ptz-switches">
              <label className="check"><input type="checkbox" checked={status.expComp} disabled={busy} onChange={(e) => void send('expComp', e.target.checked ? 1 : 0)} /> Exposure comp</label>
              <label className="check"><input type="checkbox" checked={status.blc} disabled={busy} onChange={(e) => void send('blc', e.target.checked ? 1 : 0)} /> BLC (backlight)</label>
            </div>
          </div>

          <h4>White balance</h4>
          <div className="ptz-grid">
            <label>White balance mode
              <select value={status.wbMode} disabled={busy} onChange={(e) => void send('wbMode', +e.target.value)}>
                {!known(WB, status.wbMode) && <option value={status.wbMode} disabled>Other ({hex(status.wbMode)})</option>}
                {WB.map(([n, name]) => <option key={n} value={n}>{name}</option>)}
              </select>
              {status.wbMode === 3 && (
                <button className="ptz-onepush" disabled={busy} onClick={() => void send('onePush')}>
                  Set white now (point the camera at something white)
                </button>
              )}
            </label>
            {slider('saturation', 'WB saturation', 14)}
            {slider('hue', 'Hue', 14)}
            {slider('redGain', 'Red gain', 255, manualWb, 'Switch to Manual mode to change red and blue gain.')}
            {slider('blueGain', 'Blue gain', 255, manualWb)}
          </div>

          <p className="hint ptz-note">
            Iris {status.iris} · Shutter {status.shutter} (read only for now). Color temperature and G-gain are only on the camera's own page.
          </p>
        </>
      )}
    </div>
  )
}
