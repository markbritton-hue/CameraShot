import type { Camera, PtzCal } from './types'

/**
 * Turns "where the cone points on the plan" into VISCA absolute pan / tilt / zoom, and back into a calibration.
 *
 * Assumptions (standard for PTZOptics / AVKANS style cameras): pan +-170 degrees over +-2448 units, tilt 90 degrees
 * over 1296 units (up positive), optical zoom 0..0x4000 with roughly 20x at the far end. The zoom curve is only
 * approximately linear on real lenses, so the cone's width is a good guide rather than exact.
 *
 * Plan angles: 0 degrees points right, increasing clockwise (the plan's y axis points down the screen).
 */
export const PAN_DEG_PER_UNIT = 170 / 2448
export const TILT_DEG_PER_UNIT = 90 / 1296
export const PAN_LIMIT = 2448
export const TILT_MIN = -432
export const TILT_MAX = 1296
export const ZOOM_MAX = 0x4000
export const MAX_MAGNIFICATION = 20
export const DEFAULT_HEIGHT_FT = 6

export interface PtzPose { pan: number; tilt: number; zoom: number }

const RAD = Math.PI / 180
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180
const magnification = (zoom: number) => 1 + ((MAX_MAGNIFICATION - 1) * clamp(zoom, 0, ZOOM_MAX)) / ZOOM_MAX
const heading = (cam: Pick<Camera, 'x' | 'y'>, fx: number, fy: number) => Math.atan2(fy - cam.y, fx - cam.x) / RAD

/** The camera is physically pointing at the plan's focus point right now: learn how pan, tilt and zoom line up with the plan. */
export function calibrate(cam: Camera, now: PtzPose): PtzCal {
  const dist = Math.hypot(cam.focus.x - cam.x, cam.focus.y - cam.y)
  const tiltDeg = now.tilt * TILT_DEG_PER_UNIT
  return {
    panZero: wrap180(heading(cam, cam.focus.x, cam.focus.y) - now.pan * PAN_DEG_PER_UNIT),
    // looking down at a spot `dist` feet away, tilt = -atan(height / dist): solve for the camera's height
    height: tiltDeg < -1 && dist > 0.5 ? clamp(dist * Math.tan(-tiltDeg * RAD), 1, 40) : DEFAULT_HEIGHT_FT,
    fovWide: clamp((2 * Math.atan(Math.tan((cam.fov / 2) * RAD) * magnification(now.zoom))) / RAD, 20, 120),
  }
}

/** The pan / tilt / zoom that points a calibrated camera at (fx, fy) with the given cone angle. */
export function aim(cam: Pick<Camera, 'x' | 'y'>, cal: PtzCal, fx: number, fy: number, fov: number): PtzPose {
  const dist = Math.hypot(fx - cam.x, fy - cam.y)
  const panDeg = wrap180(heading(cam, fx, fy) - cal.panZero)
  const tiltDeg = -Math.atan2(cal.height, dist) / RAD
  const m = Math.tan((cal.fovWide / 2) * RAD) / Math.tan((clamp(fov, 5, 120) / 2) * RAD)
  return {
    pan: clamp(Math.round(panDeg / PAN_DEG_PER_UNIT), -PAN_LIMIT, PAN_LIMIT),
    tilt: clamp(Math.round(tiltDeg / TILT_DEG_PER_UNIT), TILT_MIN, TILT_MAX),
    zoom: clamp(Math.round(((m - 1) / (MAX_MAGNIFICATION - 1)) * ZOOM_MAX), 0, ZOOM_MAX),
  }
}
