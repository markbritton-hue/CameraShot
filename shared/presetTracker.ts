/**
 * Works out whether a camera is still sitting on the preset it last recalled.
 *
 * The camera only reports the LAST RECALLED preset number, and VISCA can't read what a preset's stored
 * position is. So we watch for a recall (the number changes, or we just sent one), wait for the
 * camera to come to rest, and remember that spot. After that, any drift away from it means "moved".
 * If we start watching when the camera may already have been moved, we say "unknown" rather than guess.
 */
export interface Pos { preset: number; pan: number; tilt: number; zoom: number }

export type PresetStatus = 'unknown' | 'moving' | 'on' | 'moved'

export interface TrackerState {
  prev: Pos | null
  /** where the camera came to rest after the recall we saw */
  rest: Pos | null
  settling: boolean
  /** consecutive readings at (nearly) the same spot since the recall */
  stable: number
  status: PresetStatus
}

export const initialTracker: TrackerState = { prev: null, rest: null, settling: false, stable: 0, status: 'unknown' }

// position units are the camera's own steps; these absorb read jitter without hiding a real move
const TOL_PAN_TILT = 3
const TOL_ZOOM = 8
/**
 * Right after a recall the camera often hasn't started moving yet, so one still reading proves nothing.
 * Three still readings in a row (about 2 s at one reading a second) means it has really arrived.
 */
const STABLE_READINGS = 3

const near = (a: Pos, b: Pos) =>
  Math.abs(a.pan - b.pan) <= TOL_PAN_TILT && Math.abs(a.tilt - b.tilt) <= TOL_PAN_TILT && Math.abs(a.zoom - b.zoom) <= TOL_ZOOM

/**
 * One new reading from the camera. `recalled` is true when we have just sent a "go to preset"
 * (covers re-recalling the same number, which changes nothing in the camera's reported number).
 */
export function trackPreset(s: TrackerState, p: Pos, recalled: boolean): TrackerState {
  const recallSeen = recalled || (s.prev !== null && s.prev.preset !== p.preset)
  let { rest, settling, stable } = s

  if (recallSeen) {
    rest = null
    settling = true
    stable = 1
  } else if (settling) {
    stable = s.prev && near(s.prev, p) ? stable + 1 : 1
  }

  if (settling && stable >= STABLE_READINGS) {
    rest = p
    settling = false
  }

  const status: PresetStatus = rest ? (near(rest, p) ? 'on' : 'moved') : settling ? 'moving' : 'unknown'
  return { prev: p, rest, settling, stable, status }
}
