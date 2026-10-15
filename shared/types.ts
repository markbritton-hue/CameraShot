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
  /** position on stage, metres */
  x: number
  y: number
  /** horizontal field of view, degrees */
  fov: number
  /** what the camera is aimed at / focused on; heading is derived from this */
  focus: { x: number; y: number; radius: number }
  presets: CameraPreset[]
}

/** A named spot on a platform that cameras can aim at. Coordinates are metres from the item's top-left, before rotation. */
export interface ItemPoint {
  id: string
  label: string
  x: number
  y: number
}

export interface StageItem {
  id: string
  kind: 'platform' | 'person'
  label: string
  /** platform: top-left corner. person: centre. metres */
  x: number
  y: number
  w: number
  h: number
  rotation: number
  /** only used by platforms */
  points: ItemPoint[]
}

export interface Show {
  name: string
  /** ms timestamp of the last edit; whichever copy (browser or server) is newer wins on reconnect */
  updatedAt: number
  stage: { width: number; depth: number }
  items: StageItem[]
  cameras: Camera[]
  settings: {
    /** IP address of the ATEM; when set, the server reads program/preview straight from it */
    atemIp: string
    /** which ATEM M/E's program/preview we follow (Extreme ISO has 2) */
    me: number
    companionHost: string
    companionPort: number
  }
}

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

export type ServerMessage =
  | { type: 'hello'; show: Show; live: LiveState; atem: AtemStatus }
  | { type: 'show'; show: Show }
  | { type: 'live'; live: LiveState }
  | { type: 'atem'; atem: AtemStatus }

export const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** Fill in fields added after a show was first saved. */
export function normalizeShow(s: Show): Show {
  return {
    ...s,
    updatedAt: s.updatedAt ?? 0,
    settings: { ...s.settings, atemIp: s.settings.atemIp ?? '' },
    items: s.items.map((i) => ({ ...i, kind: i.kind ?? 'platform', points: i.points ?? [] })),
    cameras: s.cameras.map((c) => ({ ...c, presets: c.presets ?? [] })),
  }
}

/** Stage-space position of a point on a (possibly rotated) platform. */
export function itemPointWorld(it: StageItem, p: ItemPoint): { x: number; y: number } {
  const r = (it.rotation * Math.PI) / 180
  return {
    x: it.x + p.x * Math.cos(r) - p.y * Math.sin(r),
    y: it.y + p.x * Math.sin(r) + p.y * Math.cos(r),
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
  stage: { width: 12, depth: 8 },
  items: [
    {
      id: 'i1', kind: 'platform', label: 'Riser', x: 4, y: 1, w: 4, h: 2, rotation: 0,
      points: [
        { id: 'p1', label: 'Left', x: 1, y: 1 },
        { id: 'p2', label: 'Right', x: 3, y: 1 },
      ],
    },
    { id: 'i2', kind: 'person', label: 'Speaker', x: 6, y: 4.5, w: 0.6, h: 0.6, rotation: 0, points: [] },
  ],
  cameras: [
    { id: 'c1', number: 1, name: 'Wide', color: '#38bdf8', atemInput: 1, x: 6, y: 7.5, fov: 60, focus: { x: 6, y: 3, radius: 2.5 }, presets: [] },
    { id: 'c2', number: 2, name: 'Left', color: '#a78bfa', atemInput: 2, x: 1, y: 6, fov: 35, focus: { x: 5, y: 2, radius: 1.2 }, presets: [] },
    { id: 'c3', number: 3, name: 'Right', color: '#fbbf24', atemInput: 3, x: 11, y: 6, fov: 35, focus: { x: 7, y: 2, radius: 1.2 }, presets: [] },
  ],
  settings: { atemIp: '', me: 1, companionHost: '127.0.0.1', companionPort: 8000 },
}
