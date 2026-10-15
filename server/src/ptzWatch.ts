import { DEFAULT_VISCA_PORT, IPV4 } from '../../shared/types'
import type { Camera, PtzStates } from '../../shared/types'
import { initialTracker, trackPreset } from '../../shared/presetTracker'
import type { TrackerState } from '../../shared/presetTracker'
import { readPosition } from './visca'

interface Options {
  cameras: () => Camera[]
  /** called whenever any camera's preset number or status changes */
  onStates: (states: PtzStates) => void
  /** a camera's preset number changed without us asking (a joystick, GearOps, the camera's remote) */
  onExternalRecall: (cameraId: string, preset: number) => void
  /** the camera reported a preset number (the first time we see it, and whenever it changes): proof that slot is in use */
  onPresetSeen: (cameraId: string, preset: number) => void
  intervalMs?: number
}

/**
 * Keeps an eye on every camera marked PTZ: reads its last-recalled preset and position about once a
 * second and works out whether it is still on that preset. Runs on the server so every open screen
 * (and the main stage page) gets the same answer without each one polling the cameras.
 */
export function createPtzWatcher({ cameras, onStates, onExternalRecall, onPresetSeen, intervalMs = 1000 }: Options) {
  const trackers = new Map<string, TrackerState>()
  const pending = new Set<string>() // cameras we just sent a recall to
  const busy = new Set<string>()
  const states: PtzStates = {}
  let lastJson = '{}'

  async function poll(cam: Camera) {
    if (busy.has(cam.id) || !cam.ip) return
    busy.add(cam.id)
    try {
      const pos = await readPosition(cam.ip, cam.viscaPort ?? DEFAULT_VISCA_PORT)
      const before = trackers.get(cam.id) ?? initialTracker
      const recalled = pending.delete(cam.id)
      const after = trackPreset(before, pos, recalled)
      trackers.set(cam.id, after)
      states[cam.id] = { preset: pos.preset, status: after.status }
      // only when the number is new to us, so a slot you removed by hand isn't re-added every second
      if (!before.prev || before.prev.preset !== pos.preset) onPresetSeen(cam.id, pos.preset)
      if (!recalled && before.prev && before.prev.preset !== pos.preset) onExternalRecall(cam.id, pos.preset)
    } catch {
      // unreachable right now: hide its bubble and forget what we knew, so we never claim a stale position
      delete states[cam.id]
      trackers.delete(cam.id)
    } finally {
      busy.delete(cam.id)
    }
  }

  async function tick() {
    const watched = cameras().filter((c) => c.ptz && c.ip && IPV4.test(c.ip))
    for (const id of Object.keys(states)) {
      if (!watched.some((c) => c.id === id)) { delete states[id]; trackers.delete(id) } // no longer PTZ, or its IP was removed
    }
    await Promise.all(watched.map(poll))
    const json = JSON.stringify(states)
    if (json !== lastJson) {
      lastJson = json
      onStates(JSON.parse(json))
    }
  }

  const timer = setInterval(() => void tick(), intervalMs)

  return {
    /** call right after sending a preset recall so the arrival is tracked even for the same number */
    noteRecall: (cameraId: string) => { pending.add(cameraId) },
    states: (): PtzStates => JSON.parse(JSON.stringify(states)),
    stop: () => clearInterval(timer),
  }
}
