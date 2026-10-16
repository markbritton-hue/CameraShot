/** A saved PTZ-style position: where the camera looks, how wide, and how big the focus area is. */
export interface CameraPreset {
  id: string
  name: string
  fov: number
  focus: { x: number; y: number; radius: number }
}

export interface Camera {
  id: string
  number: number
  name: string
  color: string
  /** ATEM input number this camera is plugged into (1-8 on the Extreme ISO) */
  atemInput: number
  /** the camera's own IP address on the network (for reachability checks; later PTZ control) */
  ip?: string
  /** a PTZ camera: unlocks pan/tilt/zoom and the image controls (VISCA). Off for fixed cameras. */
  ptz?: boolean
  /**
   * The camera's own memory preset numbers that are known to be programmed. VISCA can't list them, so this is
   * built from slots saved through CameraShot, slots the camera has been seen going to, and ones added by hand.
   */
  slots?: number[]
  /** UDP port for VISCA over IP; 1259 for most cameras (AVKANS / PTZOptics style) */
  viscaPort?: number
  /** RTSP path for the live view, e.g. "/2" (the lower-resolution stream on most AVKANS cameras) */
  rtspPath?: string
  /** position on stage, feet */
  x: number
  y: number
  /** horizontal field of view, degrees */
  fov: number
  /** what the camera is aimed at / focused on; heading is derived from this */
  focus: { x: number; y: number; radius: number }
  presets: CameraPreset[]
}

/** A named spot on a platform that cameras can aim at. Coordinates are feet from the item's top-left, before rotation. */
export interface ItemPoint {
  id: string
  label: string
  x: number
  y: number
}

export interface StageItem {
  id: string
  kind: 'platform' | 'stairs' | 'person'
  label: string
  /** stairs only: number of steps (default 3); they rise towards the top of the plan, i.e. upstage */
  steps?: number
  /** platform: top-left corner. person: center. feet */
  x: number
  y: number
  w: number
  h: number
  rotation: number
  /** only used by platforms */
  points: ItemPoint[]
  /** platforms only: fill color as #rrggbb; absent means the default steel gray */
  color?: string
  /** locked items cannot be dragged, resized or rotated on the grid (or have their size changed in the panel) */
  locked?: boolean
}

export interface Show {
  name: string
  /** ms timestamp of the last edit; whichever copy (browser or server) is newer wins on reconnect */
  updatedAt: number
  /** every length in the show (stage, items, cameras, focus areas) is in this unit; older shows were meters and are converted on load */
  units?: 'ft'
  /** width and depth of the stage in feet, and the size of one grid square in feet (default 2) */
  stage: { width: number; depth: number; grid?: number }
  items: StageItem[]
  cameras: Camera[]
  settings: {
    /** IP address of the ATEM; when set, the server reads program/preview straight from it */
    atemIp: string
    /** which ATEM M/E's program/preview we follow (Extreme ISO has 2) */
    me: number
    /**
     * ATEM simulator on (true) or off (false/absent, the default). While it is on the simulator buttons show and the
     * grid is locked against edits; off means the grid is editable. Saved with the show so it is the same in every browser.
     */
    simulator?: boolean
    companionHost: string
    companionPort: number
  }
}

/** Camera image settings read from / written to a PTZ camera over VISCA. */
export interface PtzStatus {
  /** 0 full auto, 3 manual, 10 shutter priority, 11 iris priority, 13 bright */
  exposureMode: number
  /** index; adjustable in manual exposure */
  gain: number
  /** 0 auto, 1 indoor, 2 outdoor, 3 one-push, 4 ATW, 5 manual (other values exist on some models) */
  wbMode: number
  /** 0-255; adjustable in manual white balance */
  redGain: number
  blueGain: number
  iris: number
  shutter: number
  /** backlight compensation on */
  blc: boolean
  /** exposure compensation on, and its level (0-14, 7 is neutral on most cameras) */
  expComp: boolean
  expCompLevel: number
  /** color saturation and hue, 0-14 */
  saturation: number
  hue: number
}

export type PtzSetting =
  | 'exposureMode' | 'gain' | 'wbMode' | 'redGain' | 'blueGain' | 'onePush'
  | 'blc' | 'expComp' | 'expCompLevel' | 'saturation' | 'hue'

export const DEFAULT_VISCA_PORT = 1259

export interface LiveState {
  program: number | null
  preview: number | null
}

export interface AtemStatus {
  state: 'off' | 'connecting' | 'connected' | 'error'
  /** e.g. "ATEM Mini Extreme ISO", read from the switcher once connected */
  model?: string
  mixEffects?: number
  error?: string
}

/** What a PTZ camera is doing right now, as watched by the server: its last recalled preset and whether it is still there. */
export interface PtzCameraState {
  preset: number
  status: 'unknown' | 'moving' | 'on' | 'moved'
}

/** keyed by camera id; cameras that are not PTZ, or can't be reached, are absent */
export type PtzStates = Record<string, PtzCameraState>

export type ServerMessage =
  | { type: 'hello'; show: Show; live: LiveState; atem: AtemStatus; ptz: PtzStates }
  | { type: 'show'; show: Show }
  | { type: 'live'; live: LiveState }
  | { type: 'atem'; atem: AtemStatus }
  | { type: 'ptz'; ptz: PtzStates }

export const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

export const DEFAULT_GRID_FT = 2
const FT_PER_M = 3.28084
const toFt = (v: number) => Math.round(v * FT_PER_M * 100) / 100

/** Shows saved before feet were the unit were drawn in meters: convert every length once and mark the show as feet. */
function metersToFeet(s: Show): Show {
  const focus = (f: { x: number; y: number; radius: number }) => ({ x: toFt(f.x), y: toFt(f.y), radius: toFt(f.radius) })
  return {
    ...s,
    units: 'ft',
    stage: { ...s.stage, width: toFt(s.stage.width), depth: toFt(s.stage.depth) },
    items: s.items.map((i) => ({
      ...i, x: toFt(i.x), y: toFt(i.y), w: toFt(i.w), h: toFt(i.h),
      points: i.points.map((p) => ({ ...p, x: toFt(p.x), y: toFt(p.y) })),
    })),
    cameras: s.cameras.map((c) => ({
      ...c, x: toFt(c.x), y: toFt(c.y), focus: focus(c.focus),
      presets: c.presets.map((p) => ({ ...p, focus: focus(p.focus) })),
    })),
  }
}

/** Fill in fields added after a show was first saved, and bring older shows (meters) up to feet. Safe to run repeatedly. */
export function normalizeShow(s: Show): Show {
  const n: Show = {
    ...s,
    updatedAt: s.updatedAt ?? 0,
    settings: { ...s.settings, atemIp: s.settings.atemIp ?? '' },
    items: s.items.map((i) => ({ ...i, kind: i.kind ?? 'platform', points: i.points ?? [] })),
    // shows saved before the PTZ checkbox existed: a camera that already has an IP was being controlled, so keep it PTZ
    cameras: s.cameras.map((c) => ({ ...c, presets: c.presets ?? [], ptz: c.ptz ?? Boolean(c.ip), slots: c.slots ?? [] })),
  }
  const out = n.units === 'ft' ? n : metersToFeet(n)
  return { ...out, stage: { ...out.stage, grid: out.stage.grid ?? DEFAULT_GRID_FT } }
}

/** Stage-space position of a point on a (possibly rotated) platform. Items rotate about their center. */
export function itemPointWorld(it: StageItem, p: ItemPoint): { x: number; y: number } {
  const r = (it.rotation * Math.PI) / 180
  const dx = p.x - it.w / 2
  const dy = p.y - it.h / 2
  return {
    x: it.x + it.w / 2 + dx * Math.cos(r) - dy * Math.sin(r),
    y: it.y + it.h / 2 + dx * Math.sin(r) + dy * Math.cos(r),
  }
}

/** Everything a camera can be aimed at: each person, and each marked point on a platform. */
export function aimTargets(items: StageItem[]): { key: string; label: string; x: number; y: number }[] {
  return items.flatMap((it) =>
    it.kind === 'person'
      ? [{ key: it.id, label: it.label, x: it.x, y: it.y }]
      : it.points.map((p) => ({ key: `${it.id}:${p.id}`, label: `${it.label} › ${p.label}`, ...itemPointWorld(it, p) })),
  )
}

export const defaultShow: Show = {
  name: 'New Show',
  updatedAt: 0,
  units: 'ft',
  stage: { width: 40, depth: 24, grid: DEFAULT_GRID_FT },
  items: [
    {
      id: 'i1', kind: 'platform', label: 'Riser', x: 14, y: 4, w: 12, h: 6, rotation: 0,
      points: [
        { id: 'p1', label: 'Left', x: 3, y: 3 },
        { id: 'p2', label: 'Right', x: 9, y: 3 },
      ],
    },
    { id: 'i2', kind: 'person', label: 'Speaker', x: 20, y: 14, w: 2, h: 2, rotation: 0, points: [] },
  ],
  cameras: [
    { id: 'c1', number: 1, name: 'Wide', color: '#38bdf8', atemInput: 1, x: 20, y: 23, fov: 60, focus: { x: 20, y: 9, radius: 8 }, presets: [] },
    { id: 'c2', number: 2, name: 'Left', color: '#a78bfa', atemInput: 2, x: 3, y: 18, fov: 35, focus: { x: 16, y: 6, radius: 4 }, presets: [] },
    { id: 'c3', number: 3, name: 'Right', color: '#fbbf24', atemInput: 3, x: 37, y: 18, fov: 35, focus: { x: 23, y: 6, radius: 4 }, presets: [] },
  ],
  settings: { atemIp: '', me: 1, companionHost: '127.0.0.1', companionPort: 8000 },
}
