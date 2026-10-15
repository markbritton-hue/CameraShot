import { useEffect, useRef, useState } from 'react'
import { IPV4 } from '../../shared/types'
import type { Camera } from '../../shared/types'
import { LiveFrame } from './PtzControls'
import PanTiltPad from './PanTiltPad'

interface Props {
  camera: Camera
  /** this camera is on the ATEM's program output right now */
  onAir: boolean
  /** the stage area this window floats over, so it can't be dragged out of sight */
  bounds: { w: number; h: number }
  /** stacking order: the window clicked last is on top */
  z: number
  /** where to put it the first time, if it has never been moved */
  startAt: { x: number; y: number }
  onFocus: () => void
  onClose: () => void
  /** double-click the title to open the full camera window */
  onOpenControls: () => void
}

const DEFAULT_SIZE = { w: 300, h: 300 }
const MIN_SIZE = { w: 180, h: 140 }
const KEY = 'camerashot.livewin.v1'

type Saved = Record<string, { x: number; y: number; w: number; h: number }>
const read = (): Saved => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch { return {} } }
const write = (id: string, v: Saved[string]) => { try { localStorage.setItem(KEY, JSON.stringify({ ...read(), [id]: v })) } catch { /* storage blocked */ } }

/**
 * A small floating live picture of one camera. Starts at 300 x 300; drag the title bar to move it and
 * the bottom-right corner to resize it. Position and size are remembered for each camera.
 */
export default function LiveWindow({ camera, onAir, bounds, z, startAt, onFocus, onClose, onOpenControls }: Props) {
  const host = (camera.ip ?? '').trim()
  const canMove = camera.ptz === true && IPV4.test(host) // pan/tilt only for cameras ticked PTZ in Setup
  const [pad, setPad] = useState(true) // show the small pan/tilt pad over the picture
  const saved = useRef(read()[camera.id])
  const [pos, setPos] = useState({ x: saved.current?.x ?? startAt.x, y: saved.current?.y ?? startAt.y })
  const [size, setSize] = useState({ w: saved.current?.w ?? DEFAULT_SIZE.w, h: saved.current?.h ?? DEFAULT_SIZE.h })
  // while dragging or resizing, the video iframe would swallow the mouse; this lets the page keep it
  const [busy, setBusy] = useState(false)
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  const resize = useRef<{ x: number; y: number; w: number; h: number } | null>(null)

  const clampPos = (x: number, y: number, w = size.w) => ({
    x: Math.min(Math.max(0, x), Math.max(0, bounds.w - Math.min(w, 80))),
    y: Math.min(Math.max(0, y), Math.max(0, bounds.h - 32)),
  })

  useEffect(() => { write(camera.id, { ...pos, ...size }) }, [camera.id, pos, size])

  const move = (e: PointerEvent) => {
    if (drag.current) setPos(clampPos(e.clientX - drag.current.dx, e.clientY - drag.current.dy))
    if (resize.current) {
      const r = resize.current
      setSize({ w: Math.max(MIN_SIZE.w, r.w + e.clientX - r.x), h: Math.max(MIN_SIZE.h, r.h + e.clientY - r.y) })
    }
  }
  const end = () => { drag.current = null; resize.current = null; setBusy(false) }

  useEffect(() => {
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  })

  return (
    <div className="live-win" style={{ left: pos.x, top: pos.y, width: size.w, height: size.h, zIndex: z }} onPointerDown={onFocus}>
      <div className="live-win-title"
        onPointerDown={(e) => { drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }; setBusy(true) }}
        onDoubleClick={onOpenControls} title="Drag to move. Double-click for camera controls.">
        <span className="dot" style={{ background: camera.color }} />
        <span className="live-win-name">Cam {camera.number} · {camera.name}</span>
        {onAir && <span className="live-win-air" title="This camera is live on the ATEM: moving it shows on air">● ON AIR</span>}
        {canMove && (
          <button className={pad ? 'active' : ''} onPointerDown={(e) => e.stopPropagation()} onClick={() => setPad(!pad)}
            title={pad ? 'Hide the pan / tilt pad' : 'Show the pan / tilt pad'} aria-label="Pan and tilt pad">✥</button>
        )}
        <button onPointerDown={(e) => e.stopPropagation()} onClick={onClose} aria-label="Close live view">×</button>
      </div>
      <div className={`live-win-body${busy ? ' busy' : ''}`}>
        <LiveFrame camNumber={camera.number} rtspPath={camera.rtspPath} fill />
        {canMove && pad && <PanTiltPad host={host} />}
      </div>
      <div className="live-win-grip" title="Drag to resize"
        onPointerDown={(e) => { e.stopPropagation(); resize.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h }; setBusy(true) }} />
    </div>
  )
}
