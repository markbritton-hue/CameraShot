import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IPV4 } from '../../shared/types'
import type { Camera } from '../../shared/types'
import PtzControls, { LiveView } from './PtzControls'

interface Props {
  camera: Camera
  /** false on GitHub Pages or when the CameraShot server isn't connected */
  serverAvailable: boolean
  /** this camera is on the ATEM's program output right now */
  onAir: boolean
  onClose: () => void
  onOpenSetup: () => void
  onPatch: (patch: Partial<Camera>) => void
}

type Held = { action: 'move' | 'zoom'; dir: string }

// While a button is held the page re-sends the command this often; the server stops the camera
// itself if they stop arriving (see the watchdog in the server), so a closed tab can't leave it moving.
const KEEPALIVE_MS = 600

async function drive(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch('/api/ptz/drive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return await r.json()
  } catch {
    return { ok: false, error: 'could not reach the CameraShot server' }
  }
}

/** A button that acts while it is pressed and releases when the pointer lifts, leaves or is cancelled. */
function HoldButton({ onDown, onUp, title, className, children }: {
  onDown: () => void; onUp: () => void; title: string; className?: string; children: ReactNode
}) {
  const held = useRef(false)
  const end = () => { if (held.current) { held.current = false; onUp() } }
  return (
    <button className={className} title={title}
      onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); held.current = true; onDown() }}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onContextMenu={(e) => e.preventDefault()}>
      {children}
    </button>
  )
}

const PAD: { dir: string; label: string; title: string }[] = [
  { dir: 'leftup', label: '↖', title: 'Up and left' }, { dir: 'up', label: '↑', title: 'Up' }, { dir: 'rightup', label: '↗', title: 'Up and right' },
  { dir: 'left', label: '←', title: 'Left' }, { dir: 'stop', label: '■', title: 'Stop' }, { dir: 'right', label: '→', title: 'Right' },
  { dir: 'leftdown', label: '↙', title: 'Down and left' }, { dir: 'down', label: '↓', title: 'Down' }, { dir: 'rightdown', label: '↘', title: 'Down and right' },
]

/** Window opened by double-clicking a camera on the stage: live picture, pan/tilt/zoom, and the image controls. */
export default function CameraView({ camera, serverAvailable, onAir, onClose, onOpenSetup, onPatch }: Props) {
  const host = (camera.ip ?? '').trim()
  const ready = serverAvailable && IPV4.test(host)
  const isPtz = camera.ptz === true // pan/tilt/zoom and image controls only exist for cameras ticked PTZ in Setup

  const [panSpeed, setPanSpeed] = useState(8)
  const [zoomSpeed, setZoomSpeed] = useState(3)
  const [more, setMore] = useState(false)
  const [error, setError] = useState('')
  // camera memory presets: tap a number to recall; arm "Save" first to store the current position into that number
  const [armed, setArmed] = useState(false)
  const [lastPreset, setLastPreset] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const armTimer = useRef<number | undefined>(undefined)
  // the keep-alive reads the live slider values so you can change speed mid-move
  const speeds = useRef({ pan: panSpeed, zoom: zoomSpeed })
  speeds.current = { pan: panSpeed, zoom: zoomSpeed }
  const timer = useRef<number | undefined>(undefined)

  const report = (r: { ok: boolean; error?: string }) => setError(r.ok ? '' : (r.error ?? 'the camera did not respond'))

  const stopHeld = useCallback(() => {
    if (timer.current === undefined) return
    window.clearInterval(timer.current)
    timer.current = undefined
    void drive({ host, action: 'stop' }).then(report)
  }, [host])

  const startHeld = (h: Held) => {
    window.clearInterval(timer.current)
    const send = () => void drive({ host, action: h.action, dir: h.dir, speed: h.action === 'zoom' ? speeds.current.zoom : speeds.current.pan }).then(report)
    send()
    timer.current = window.setInterval(send, KEEPALIVE_MS)
  }

  const disarm = () => { window.clearTimeout(armTimer.current); setArmed(false) }
  const toggleArm = () => {
    if (armed) return disarm()
    setArmed(true)
    setNote('')
    armTimer.current = window.setTimeout(() => setArmed(false), 10_000) // never stay armed by accident
  }
  const usePreset = async (n: number) => {
    const store = armed
    disarm()
    const r = await drive({ host, action: store ? 'store' : 'recall', n })
    report(r)
    if (r.ok) { setLastPreset(n); setNote(store ? `Saved the camera's current position as preset ${n}.` : '') }
  }
  useEffect(() => () => window.clearTimeout(armTimer.current), [])

  // App recreates onClose on every render; read it through a ref so a re-render can't tear down (and stop) a held move
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // never leave the camera moving: stop on close, on losing focus, and when the tab is hidden
  useEffect(() => {
    const onHide = () => stopHeld()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current()
    window.addEventListener('blur', onHide)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('blur', onHide)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('keydown', onKey)
      stopHeld()
    }
  }, [stopHeld])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal camview" role="dialog" aria-label={`Camera ${camera.number}`}>
        <div className="modal-head">
          <h2><span className="dot" style={{ background: camera.color }} /> Cam {camera.number} · {camera.name}</h2>
          <button onClick={onClose}>Close</button>
        </div>

        {onAir && (
          <p className="onair">● ON AIR: this camera is live on the ATEM. Moving it or changing its picture is visible to viewers.</p>
        )}

        {!ready ? (
          <p className="notice">
            {!serverAvailable
              ? 'Camera control needs the CameraShot server running on this PC (npm run dev).'
              : 'This camera has no IP address yet.'}{' '}
            {serverAvailable && <button className="link" onClick={onOpenSetup}>Open Setup</button>}
          </p>
        ) : (
          <>
            <div className={`camview-main${isPtz ? '' : ' single'}`}>
              <LiveView camNumber={camera.number} rtspPath={camera.rtspPath} onRtspPath={(p) => onPatch({ rtspPath: p })} />

              {isPtz && <div className="drive">
                <div className="pad" aria-label="Pan and tilt">
                  {PAD.map((p) => p.dir === 'stop'
                    ? <button key={p.dir} className="pad-stop" title={p.title} onClick={() => { stopHeld(); void drive({ host, action: 'stop' }).then(report) }}>{p.label}</button>
                    : <HoldButton key={p.dir} title={`${p.title} (hold)`} onDown={() => startHeld({ action: 'move', dir: p.dir })} onUp={stopHeld}>{p.label}</HoldButton>)}
                </div>

                <label>Pan / tilt speed {panSpeed}
                  <input type="range" min={1} max={24} value={panSpeed} onChange={(e) => setPanSpeed(+e.target.value)} />
                </label>

                <div className="zoom-row">
                  <HoldButton title="Zoom out (hold)" onDown={() => startHeld({ action: 'zoom', dir: 'out' })} onUp={stopHeld}>Zoom −</HoldButton>
                  <HoldButton title="Zoom in (hold)" onDown={() => startHeld({ action: 'zoom', dir: 'in' })} onUp={stopHeld}>Zoom +</HoldButton>
                  <button title="Return to the camera's home position" onClick={() => void drive({ host, action: 'home' }).then(report)}>Home</button>
                </div>
                <label>Zoom speed {zoomSpeed}
                  <input type="range" min={1} max={7} value={zoomSpeed} onChange={(e) => setZoomSpeed(+e.target.value)} />
                </label>

                <div className="presets">
                  <div className="presets-head">
                    <b>Camera presets</b>
                    <button className={armed ? 'armed' : ''} onClick={toggleArm}
                      title="Arm, then tap a number to store the camera's current position there">{armed ? 'Cancel save' : 'Save…'}</button>
                  </div>
                  <div className="preset-grid">
                    {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                      <button key={n} className={`${armed ? 'armed' : ''}${!armed && lastPreset === n ? ' last' : ''}`}
                        title={armed ? `Store the current position as preset ${n}` : `Go to preset ${n}`}
                        onClick={() => void usePreset(n)}>{n}</button>
                    ))}
                  </div>
                  <p className={`hint${armed ? ' warn' : ''}`}>
                    {armed ? 'SAVE MODE: tap a number to store where the camera is pointing now (overwrites that preset).' : 'Tap a number to move the camera there.'}
                  </p>
                  {note && <p className="hint ok">{note}</p>}
                </div>

                {error && <p className="hint bad">{error}</p>}
              </div>}
            </div>

            {!isPtz && (
              <p className="hint">
                This isn't set as a PTZ camera, so there are no movement or image controls.{' '}
                <button className="link" onClick={onOpenSetup}>Tick PTZ in Setup</button> to control it.
              </p>
            )}

            {isPtz && <button className="more-toggle" onClick={() => setMore(!more)}>{more ? '▾ Fewer controls' : '▸ More controls (exposure, white balance)'}</button>}
            {isPtz && more && (
              <PtzControls host={host} port={camera.viscaPort} onPort={(p) => onPatch({ viscaPort: p })}
                camNumber={camera.number} rtspPath={camera.rtspPath} onRtspPath={(p) => onPatch({ rtspPath: p })} showLive={false} />
            )}
          </>
        )}
      </div>
    </div>
  )
}
