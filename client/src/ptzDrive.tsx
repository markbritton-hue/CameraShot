import { useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

export type Held = { action: 'move' | 'zoom'; dir: string }
export type DriveResult = { ok: boolean; error?: string }

// While a button is held the page re-sends the command this often; the server stops the camera
// itself if they stop arriving (see the watchdog in the server), so a closed tab can't leave it moving.
export const KEEPALIVE_MS = 600

export async function drive(body: Record<string, unknown>): Promise<DriveResult> {
  try {
    const r = await fetch('/api/ptz/drive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return await r.json()
  } catch {
    return { ok: false, error: 'could not reach the CameraShot server' }
  }
}

/** A button that acts while it is pressed and releases when the pointer lifts, leaves or is cancelled. */
export function HoldButton({ onDown, onUp, title, className, children }: {
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

export const PAD: { dir: string; label: string; title: string }[] = [
  { dir: 'leftup', label: '↖', title: 'Up and left' }, { dir: 'up', label: '↑', title: 'Up' }, { dir: 'rightup', label: '↗', title: 'Up and right' },
  { dir: 'left', label: '←', title: 'Left' }, { dir: 'stop', label: '■', title: 'Stop' }, { dir: 'right', label: '→', title: 'Right' },
  { dir: 'leftdown', label: '↙', title: 'Down and left' }, { dir: 'down', label: '↓', title: 'Down' }, { dir: 'rightdown', label: '↘', title: 'Down and right' },
]

/**
 * Hold-to-move for one camera. start() sends the command now and again every KEEPALIVE_MS until stop().
 * On top of the server's own watchdog this stops the camera when the component goes away, the window loses
 * focus, or the tab is hidden. `speeds` is read on every send, so a slider can change the speed mid-move.
 */
export function useHeldMove(host: string, speeds: () => { pan: number; zoom: number }, onResult?: (r: DriveResult) => void) {
  const timer = useRef<number | undefined>(undefined)
  const speedsRef = useRef(speeds)
  speedsRef.current = speeds
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult

  const stop = useCallback(() => {
    if (timer.current === undefined) return
    window.clearInterval(timer.current)
    timer.current = undefined
    void drive({ host, action: 'stop' }).then((r) => onResultRef.current?.(r))
  }, [host])

  const start = useCallback((h: Held) => {
    window.clearInterval(timer.current)
    const send = () => {
      const sp = speedsRef.current()
      void drive({ host, action: h.action, dir: h.dir, speed: h.action === 'zoom' ? sp.zoom : sp.pan }).then((r) => onResultRef.current?.(r))
    }
    send()
    timer.current = window.setInterval(send, KEEPALIVE_MS)
  }, [host])

  useEffect(() => {
    const onHide = () => stop()
    window.addEventListener('blur', onHide)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('blur', onHide)
      document.removeEventListener('visibilitychange', onHide)
      stop()
    }
  }, [stop])

  return { start, stop }
}
