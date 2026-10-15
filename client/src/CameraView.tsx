import { useCallback, useEffect, useRef, useState } from 'react'
import { IPV4 } from '../../shared/types'
import type { Camera, PtzCameraState } from '../../shared/types'
import PtzControls, { LiveView } from './PtzControls'
import { drive, HoldButton, KEEPALIVE_MS, PAD } from './ptzDrive'
import type { Held } from './ptzDrive'

interface Props {
  camera: Camera
  /** false on GitHub Pages or when the CameraShot server isn't connected */
  serverAvailable: boolean
  /** this camera is on the ATEM's program output right now */
  onAir: boolean
  /** the server's reading of which preset the camera is on, and whether it is still there (absent if unreachable) */
  ptzState: PtzCameraState | undefined
  onClose: () => void
  onOpenSetup: () => void
  onPatch: (patch: Partial<Camera>) => void
}


/** Window opened by double-clicking a camera on the stage: live picture, pan/tilt/zoom, and the image controls. */
export default function CameraView({ camera, serverAvailable, onAir, ptzState, onClose, onOpenSetup, onPatch }: Props) {
  const host = (camera.ip ?? '').trim()
  const ready = serverAvailable && IPV4.test(host)
  const isPtz = camera.ptz === true // pan/tilt/zoom and image controls only exist for cameras ticked PTZ in Setup

  const [panSpeed, setPanSpeed] = useState(8)
  const [zoomSpeed, setZoomSpeed] = useState(3)
  const [more, setMore] = useState(false)
  const [error, setError] = useState('')
  // camera memory presets: tap a number to recall; arm "Save" first to store the current position into that number
  const [armed, setArmed] = useState(false)
  const [note, setNote] = useState('')
  const [editList, setEditList] = useState(false) // show the editor for which preset numbers are listed
  const slots = camera.slots ?? []
  const addSlot = (raw: string) => {
    const n = Math.round(Number(raw))
    if (!Number.isFinite(n) || n < 1 || n > 127 || slots.includes(n)) return false
    onPatch({ slots: [...slots, n].sort((a, b) => a - b) })
    return true
  }
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
    if (r.ok) setNote(store ? `Saved the camera's current position as preset ${n}.` : '')
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
          <div className="head-actions">
            {ready && isPtz && (
              <button className={more ? 'active' : ''} onClick={() => setMore(!more)}
                title="Exposure, gain and white balance, shown beside the pad">{more ? '◂ Fewer controls' : 'More controls ▸'}</button>
            )}
            <button onClick={onClose}>Close</button>
          </div>
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
            <div className={`camview-main${isPtz ? '' : ' single'}${isPtz && more ? ' more' : ''}`}>
              <div className="cv-left">
              <LiveView camNumber={camera.number} rtspPath={camera.rtspPath} onRtspPath={(p) => onPatch({ rtspPath: p })} />
                {isPtz && (
                <div className="presets">
                  <div className="presets-head">
                    <b>Camera presets</b>
                    <button className={armed ? 'armed' : ''} onClick={toggleArm}
                      title="Arm, then tap a number to store the camera's current position there">{armed ? 'Cancel save' : 'Save…'}</button>
                  </div>
                  <div className="preset-grid">
                    {[...new Set([...Array.from({ length: 10 }, (_, i) => i + 1), ...(camera.slots ?? [])])].sort((a, b) => a - b).map((n) => (
                      <button key={n} className={armed ? 'armed' : ptzState?.preset === n ? `cur cur-${ptzState.status}` : camera.slots?.includes(n) ? 'known' : ''}
                        title={armed ? `Store the current position as preset ${n}` : `Go to preset ${n}`}
                        onClick={() => void usePreset(n)}>{n}</button>
                    ))}
                  </div>
                  <p className={`hint${armed ? ' warn' : ''}`}>
                    {armed
                      ? 'SAVE MODE: tap a number to store where the camera is pointing now (overwrites that preset).'
                      : 'Tap a number to move the camera there. Lit numbers are presets known to be set; the current one is red.'}
                  </p>
                  {ptzState && !armed && (
                    <p className={`hint preset-status ${ptzState.status}`}>
                      {ptzState.status === 'on' && `● On preset ${ptzState.preset}`}
                      {ptzState.status === 'moving' && `… Moving to preset ${ptzState.preset}`}
                      {ptzState.status === 'moved' && `◌ Preset ${ptzState.preset} was recalled, but the camera has moved since`}
                      {ptzState.status === 'unknown' && `? Last recalled: preset ${ptzState.preset} (can't tell if the camera is still there)`}
                    </p>
                  )}
                  {note && <p className="hint ok">{note}</p>}

                  <button className="link" onClick={() => setEditList(!editList)}>{editList ? 'Done editing the list' : 'Edit the preset list'}</button>
                  {editList && (
                    <div className="list-editor">
                      <div className="slot-list">
                        {slots.length === 0 && <span className="hint">No presets listed yet.</span>}
                        {slots.map((n) => (
                          <span key={n} className={`slot${n === ptzState?.preset ? ' cur' : ''}`}>
                            <button onClick={() => void usePreset(n)} title={`Go to preset ${n}`}>P{n}</button>
                            <button className="x" title={`Take preset ${n} off the list (does not change the camera)`}
                              onClick={() => onPatch({ slots: slots.filter((s) => s !== n) })}>×</button>
                          </span>
                        ))}
                      </div>
                      <form className="row" onSubmit={(e) => {
                        e.preventDefault()
                        const input = e.currentTarget.elements.namedItem('slot') as HTMLInputElement
                        if (addSlot(input.value)) input.value = ''
                      }}>
                        <input name="slot" type="number" min={1} max={127} placeholder="Add a preset number" />
                        <button type="submit">Add</button>
                      </form>
                      <p className="hint">
                        The camera can't say which presets are programmed, so this list is the ones saved here, the ones the camera has been
                        seen going to, and the ones you add. Taking one off the list doesn't touch the camera.
                      </p>
                    </div>
                  )}
                </div>
                )}
              </div>

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

                {error && <p className="hint bad">{error}</p>}
              </div>}

              {isPtz && more && (
                <div className="cv-more">
                  <PtzControls host={host} port={camera.viscaPort} onPort={(p) => onPatch({ viscaPort: p })}
                    camNumber={camera.number} rtspPath={camera.rtspPath} onRtspPath={(p) => onPatch({ rtspPath: p })} showLive={false} compact />
                </div>
              )}
            </div>

            {!isPtz && (
              <p className="hint">
                This isn't set as a PTZ camera, so there are no movement or image controls.{' '}
                <button className="link" onClick={onOpenSetup}>Tick PTZ in Setup</button> to control it.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
