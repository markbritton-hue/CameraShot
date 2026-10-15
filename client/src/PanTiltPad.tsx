import { useRef, useState } from 'react'
import { drive, HoldButton, PAD, useHeldMove } from './ptzDrive'

const ZOOM_SPEED = 3

/** A small pan / tilt / zoom pad that sits over the floating live picture. Hold a button to move; let go to stop. */
export default function PanTiltPad({ host }: { host: string }) {
  const [speed, setSpeed] = useState(6)
  const [error, setError] = useState('')
  const speedRef = useRef(speed)
  speedRef.current = speed
  const held = useHeldMove(host, () => ({ pan: speedRef.current, zoom: ZOOM_SPEED }), (r) => setError(r.ok ? '' : (r.error ?? 'no reply from the camera')))

  return (
    <div className={`mini-pad${error ? ' err' : ''}`} title={error || undefined}>
      <div className="mini-grid" aria-label="Pan and tilt">
        {PAD.map((p) => p.dir === 'stop'
          ? <button key={p.dir} className="pad-stop" title="Stop" onClick={() => { held.stop(); void drive({ host, action: 'stop' }).then((r) => setError(r.ok ? '' : (r.error ?? ''))) }}>■</button>
          : <HoldButton key={p.dir} title={`${p.title} (hold)`} onDown={() => held.start({ action: 'move', dir: p.dir })} onUp={held.stop}>{p.label}</HoldButton>)}
      </div>
      <div className="mini-side">
        <HoldButton title="Zoom in (hold)" onDown={() => held.start({ action: 'zoom', dir: 'in' })} onUp={held.stop}>+</HoldButton>
        <HoldButton title="Zoom out (hold)" onDown={() => held.start({ action: 'zoom', dir: 'out' })} onUp={held.stop}>−</HoldButton>
        <button title="Home position" onClick={() => void drive({ host, action: 'home' }).then((r) => setError(r.ok ? '' : (r.error ?? '')))}>⌂</button>
      </div>
      <input className="mini-speed" type="range" min={1} max={24} value={speed} title={`Pan / tilt speed ${speed}`}
        onChange={(e) => setSpeed(+e.target.value)} />
      {error && <span className="mini-err">{error}</span>}
    </div>
  )
}
