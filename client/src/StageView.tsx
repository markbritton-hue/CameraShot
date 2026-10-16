import { Arrow, Circle, Ellipse, Group, Layer, Line, Rect, Stage, Text, Wedge } from 'react-konva'
import { IPV4 } from '../../shared/types'
import type { Camera, LiveState, PtzCameraState, PtzStates, Show } from '../../shared/types'

// The preset the camera is on is drawn RED; the other known presets are quiet blue-gray.
// Solid red = on it, darker red = on its way, dashed = it has moved off, outline only = can't tell.
const CURRENT = {
  on: { stroke: '#fca5a5', fill: '#b91c1c', text: '#ffffff' },
  moving: { stroke: '#f87171', fill: '#7f1d1d', text: '#fecaca' },
  moved: { stroke: '#ef4444', fill: '#3b0d0d', text: '#fca5a5' },
  unknown: { stroke: '#ef4444', fill: '#1f2937', text: '#fca5a5' },
} as const
const OTHER = { stroke: '#3a4760', fill: '#1c2433', text: '#9fb0cc' }

/** A dark version of a color for tag backgrounds: `amount` of the color mixed into the stage's dark base. */
function darken(hex: string, amount: number) {
  const base = [16, 21, 30]
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  if (c.some(Number.isNaN)) return '#1c2433'
  return `rgb(${c.map((v, i) => Math.round(v * amount + base[i] * (1 - amount))).join(',')})`
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
/** a #rrggbb color as rgba() with the given alpha (the color itself if it isn't a valid hex) */
const withAlpha = (hex: string, a: number) => (/^#[0-9a-fA-F]{6}$/.test(hex) ? `rgba(${rgb(hex).join(',')},${a})` : hex)
/** `t` of color a mixed with the rest b, as an rgb() string */
function mixHex(a: string, b: string, t: number) {
  const x = rgb(a), y = rgb(b)
  if (x.some(Number.isNaN) || y.some(Number.isNaN)) return a
  return `rgb(${x.map((v, i) => Math.round(v * t + y[i] * (1 - t))).join(',')})`
}
/** perceived lightness 0 (black) to 1 (white) */
function lightness(hex: string) {
  const [r, g, b] = rgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/**
 * Platforms are drawn pale and see-through, so the grid shows through them and they stay in the background,
 * with a light white border (brighter and thicker while the platform is selected).
 * (Transparency alone would only make a color look darker on the dark stage, so the color is also lightened.)
 */
export const DEFAULT_PLATFORM_COLOR = '#9fb3d1'
const PLATFORM_ALPHA = 0.5
const STAGE_BG = '#161b25'
const toHex = (c: number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
const mixRgb = (a: number[], b: number[], t: number) => a.map((v, i) => v * t + b[i] * (1 - t))

/** colors for a platform: a pale see-through fill, a solid edge in the chosen color, and text that stays readable on it */
export function platformLook(color: string | undefined) {
  const base = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_PLATFORM_COLOR
  const pale = mixRgb(rgb(base), [255, 255, 255], 0.7) // 70% the chosen color + 30% white
  // what the fill really looks like once it sits over the dark stage: the text color is chosen against THIS
  const onStage = mixRgb(pale, rgb(STAGE_BG), PLATFORM_ALPHA)
  // near-black text wins over white text once the background is lighter than ~0.19 (where their contrast ratios cross)
  const light = lightness(toHex(onStage)) > 0.19
  return {
    fill: `rgba(${pale.map(Math.round).join(',')},${PLATFORM_ALPHA})`,
    edge: 'rgba(255,255,255,0.7)', // a light white border around every platform
    text: light ? '#0b0e14' : '#ffffff',
    sub: light ? 'rgba(11,14,20,.78)' : 'rgba(255,255,255,.82)',
  }
}

/** 12 -> 12', 13.12 -> 13.1' */
const feet = (n: number) => `${+n.toFixed(1)}'`

const CHIP_H = 22
const COLUMN_X = 34 // distance (px) from the camera's center to the first column of preset chips
const ROW_PITCH = CHIP_H + 4
const MAX_ROWS = 8 // chips per column before starting another column to the right
const COLUMN_GAP = 6

/**
 * Stack preset chips in a vertical column to the right of the camera circle, centered on the camera and
 * left-aligned. Past MAX_ROWS the next chips start a new column further right, so any number fits.
 * Returns each chip's center relative to the camera's center.
 */
function placeInColumns<T extends { w: number }>(items: T[]) {
  const placed: (T & { x: number; y: number })[] = []
  let x0 = COLUMN_X
  for (let i = 0; i < items.length; i += MAX_ROWS) {
    const column = items.slice(i, i + MAX_ROWS)
    const colWidth = Math.max(...column.map((c) => c.w))
    column.forEach((item, row) => {
      placed.push({ ...item, x: x0 + item.w / 2, y: (row - (column.length - 1) / 2) * ROW_PITCH })
    })
    x0 += colWidth + COLUMN_GAP
  }
  return placed
}

export const LIVE_COLOR = '#ef4444'
export const PREVIEW_COLOR = '#22c55e'

/** Higher steps are drawn lighter, so the rise reads at a glance from above. */
function stepColor(level: number, steps: number) {
  const t = steps > 1 ? (level - 1) / (steps - 1) : 0
  const lo = [43, 52, 71], hi = [104, 122, 158]
  return `rgb(${lo.map((c, i) => Math.round(c + (hi[i] - c) * t)).join(',')})`
}

interface Props {
  show: Show
  live: LiveState
  width: number
  height: number
  selectedId: string | null
  selectedItemId: string | null
  editable: boolean
  onSelect: (id: string | null) => void
  onSelectItem: (id: string | null) => void
  onCameraChange: (id: string, patch: Partial<Camera>) => void
  /** double-click (or double-tap) a camera icon */
  onCameraOpen: (id: string) => void
  /** which preset each PTZ camera is on (from the server's watcher) */
  ptz: PtzStates
  /** click one preset chip: send the camera to that preset */
  onPresetChip: (id: string, preset: number) => void
  /** click a "P3" label at a preset's aim point on the grid: take that preset */
  onPresetTag: (id: string, preset: number) => void
  /** click the little camera badge: open a floating live picture of that camera */
  onLiveIcon: (id: string) => void
  onItemMove: (id: string, x: number, y: number) => void
  onItemResize: (id: string, w: number, h: number) => void
  onItemRotate: (id: string, rotation: number) => void
  onPointMove: (itemId: string, pointId: string, x: number, y: number) => void
}

export default function StageView({ show, live, width, height, selectedId, selectedItemId, editable, onSelect, onSelectItem, onCameraChange, onCameraOpen, ptz, onPresetChip, onPresetTag, onLiveIcon, onItemMove, onItemResize, onItemRotate, onPointMove }: Props) {
  const clearSelection = () => { onSelect(null); onSelectItem(null) }
  const { stage } = show
  const pad = 24
  const s = Math.min((width - pad * 2) / stage.width, (height - pad * 2) / stage.depth)
  const ox = (width - stage.width * s) / 2
  const oy = (height - stage.depth * s) / 2
  const anyLive = live.program !== null || live.preview !== null
  const selectedPlatform = show.items.find((i) => i.id === selectedItemId && i.kind !== 'person') ?? null
  const selectedPerson = show.items.find((i) => i.id === selectedItemId && i.kind === 'person') ?? null
  const personR = Math.max(9, 0.6 * s) // drawn about 1.2 ft across (a real adult is ~1.6 ft; shown smaller to keep the plan uncluttered)

  // Angle (snapped to 5°) that points the item's "up" at the mouse, for a handle dragged around center (cx, cy) in stage units
  const rotationToPointer = (e: { target: { getStage: () => { getPointerPosition: () => { x: number; y: number } | null } | null } }, cx: number, cy: number) => {
    const p = e.target.getStage()?.getPointerPosition()
    if (!p) return null
    const deg = (Math.atan2(p.y - (oy + cy * s), p.x - (ox + cx * s)) * 180) / Math.PI + 90
    return (((Math.round(deg / 5) * 5) % 360) + 360) % 360
  }

  const gridLines = []
  // Everything on the stage is in feet. One grid square is `grid` feet (default 2); every fifth line is brighter and
  // labeled with its distance from the top-left corner, so the plan can be read like a tape measure.
  const grid = stage.grid && stage.grid > 0 ? stage.grid : 2
  const major = 5
  const EPS = 1e-6
  for (let i = 0; i * grid <= stage.width + EPS; i++) {
    const x = i * grid * s
    const isMajor = i % major === 0
    gridLines.push(<Line key={`gx${i}`} points={[x, 0, x, stage.depth * s]} stroke={isMajor ? '#3a4560' : '#2a3140'} strokeWidth={isMajor ? 1.5 : 1} listening={false} />)
    if (isMajor && i > 0) gridLines.push(<Text key={`lx${i}`} text={`${+(i * grid).toFixed(1)}'`} x={x + 3} y={3} fontSize={10} fill="#7b879c" listening={false} />)
  }
  for (let j = 0; j * grid <= stage.depth + EPS; j++) {
    const y = j * grid * s
    const isMajor = j % major === 0
    gridLines.push(<Line key={`gy${j}`} points={[0, y, stage.width * s, y]} stroke={isMajor ? '#3a4560' : '#2a3140'} strokeWidth={isMajor ? 1.5 : 1} listening={false} />)
    if (isMajor && j > 0) gridLines.push(<Text key={`ly${j}`} text={`${+(j * grid).toFixed(1)}'`} x={4} y={y + 3} fontSize={10} fill="#7b879c" listening={false} />)
  }

  /**
   * A "P3" tag for a preset's aim point, in the camera's own color, or red when it is the camera's current preset.
   * `dot` draws a small dot at the aim point itself (used for presets the focus circle isn't sitting on).
   */
  // pointer cursor over things that can be clicked
  const hand = (on: boolean) => (e: { target: { getStage: () => { container: () => HTMLElement } | null } }) => {
    const c = e.target.getStage()?.container()
    if (c) c.style.cursor = on ? 'pointer' : ''
  }

  const presetTag = (camId: string, key: string, x: number, y: number, n: number, st: PtzCameraState | undefined, dot: boolean, camColor: string) => {
    const cur = !!st && st.preset === n
    const look = cur && st ? CURRENT[st.status] : { stroke: camColor, fill: darken(camColor, 0.28), text: camColor }
    const label = `P${n}`
    // label size: 14 px bold text in a 22 px tall pill (was 11 px in 17 px), a little larger so it reads from across the room
    const FONT = 14, HEIGHT = 22
    const w = 18 + 9 * label.length
    const tx = dot ? 8 : 12
    const ty = dot ? -(HEIGHT + 8) : 10
    // clicking the label takes that preset (the camera goes there and the plan's aim follows)
    const go = (e: { cancelBubble: boolean }) => { e.cancelBubble = true; onPresetTag(camId, n) }
    return (
      <Group key={key} x={x} y={y}>
        {dot && <Circle radius={5} fill={look.fill} stroke={look.stroke} strokeWidth={2.5} listening={false} />}
        <Group onClick={go} onTap={go} onMouseEnter={hand(true)} onMouseLeave={hand(false)}>
          <Rect x={tx} y={ty} width={w} height={HEIGHT} cornerRadius={HEIGHT / 2} fill={look.fill} stroke={look.stroke} strokeWidth={cur ? 2.5 : 1.5}
            dash={cur && st?.status === 'moved' ? [3, 2] : undefined} />
          <Text text={label} x={tx} y={ty + (HEIGHT - FONT) / 2 - 0.5} width={w} align="center" fontStyle="bold" fontSize={FONT} fill={look.text} listening={false} />
        </Group>
      </Group>
    )
  }

  const statusOf = (cam: Camera) =>
    cam.atemInput === live.program ? 'live' : cam.atemInput === live.preview ? 'preview' : 'idle'

  // draw idle cameras first so live/preview sit on top
  const order = { idle: 0, preview: 1, live: 2 } as const
  const cameras = [...show.cameras].sort((a, b) => order[statusOf(a)] - order[statusOf(b)])

  // Drawing order for the grid items: platforms at the very back, then stairs, then people on top (cameras and their
  // cones are drawn after all of these). Items of the same kind keep the order they were added in.
  const layer = { platform: 0, stairs: 1, person: 2 } as const
  const orderedItems = [...show.items].sort((a, b) => layer[a.kind] - layer[b.kind])

  return (
    <Stage width={width} height={height} onMouseDown={(e) => e.target === e.target.getStage() && clearSelection()}>
      <Layer x={ox} y={oy}>
        <Rect width={stage.width * s} height={stage.depth * s} fill="#161b25" stroke="#4b5568" strokeWidth={2} onMouseDown={clearSelection} />
        {gridLines}
        <Text text="AUDIENCE" x={0} y={stage.depth * s + 6} width={stage.width * s} align="center" fill="#6b7587" fontSize={12} listening={false} />

        {orderedItems.map((it) => {
          const picked = it.id === selectedItemId
          const dragItem = (e: { target: { x: () => number; y: () => number }; currentTarget: unknown }) => {
            if (e.target !== e.currentTarget) return // ignore bubbled drags from child points
            // platforms/stairs sit on a center pivot, so the group position is the center; items store the top-left
            const dx = it.kind === 'person' ? 0 : it.w / 2
            const dy = it.kind === 'person' ? 0 : it.h / 2
            onItemMove(it.id, e.target.x() / s - dx, e.target.y() / s - dy)
          }
          if (it.kind === 'person') {
            const r = personR
            return (
              <Group key={it.id} x={it.x * s} y={it.y * s} draggable={editable} onDragMove={dragItem} onMouseDown={() => { onSelect(null); onSelectItem(it.id) }}>
                {/* top-down figure facing the audience at 0°: shoulders, then head slightly forward. The label never rotates. */}
                <Group rotation={it.rotation}>
                  <Ellipse radiusX={r} radiusY={r * 0.55} y={-r * 0.1} fill="#5b7fa8" stroke={picked ? '#fff' : '#1f3550'} strokeWidth={picked ? 3 : 2} />
                  <Circle radius={r * 0.46} y={r * 0.12} fill="#e7c7a0" stroke={picked ? '#fff' : '#8a6a44'} strokeWidth={picked ? 2 : 1.5} listening={false} />
                </Group>
                <Text text={it.label} x={-50} y={r + 4} width={100} align="center" fill="#e6d3b3" fontSize={12} listening={false} />
              </Group>
            )
          }
          return (
            <Group key={it.id} x={(it.x + it.w / 2) * s} y={(it.y + it.h / 2) * s} offsetX={(it.w * s) / 2} offsetY={(it.h * s) / 2}
              rotation={it.rotation} draggable={editable} onDragMove={dragItem}
              onMouseDown={() => { onSelect(null); onSelectItem(it.id) }}>
              {it.kind === 'stairs' ? (() => {
                const n = Math.max(2, Math.min(8, it.steps ?? 3))
                const treadH = (it.h * s) / n
                return (
                  <>
                    {/* top of the plan is the highest step */}
                    {Array.from({ length: n }, (_, i) => (
                      <Rect key={i} y={i * treadH} width={it.w * s} height={treadH} fill={stepColor(n - i, n)} stroke="#0b0e14" strokeWidth={1} />
                    ))}
                    <Rect width={it.w * s} height={it.h * s} stroke={picked ? '#fff' : '#7d8cab'} strokeWidth={picked ? 2 : 1.5} listening={false} />
                    <Arrow points={[it.w * s * 0.14, it.h * s * 0.88, it.w * s * 0.14, it.h * s * 0.12]} stroke="#e6ecf8" fill="#e6ecf8" strokeWidth={2}
                      pointerLength={7} pointerWidth={8} opacity={0.75} listening={false} />
                    <Text text={it.label} x={it.w * s * 0.2} width={it.w * s * 0.8} height={it.h * s} align="center" verticalAlign="middle" fill="#f0f4fc" fontSize={13} listening={false} />
                  </>
                )
              })() : (
                <>
                  {(() => {
                    const look = platformLook(it.color)
                    return (
                      <>
                        <Rect width={it.w * s} height={it.h * s} fill={look.fill} stroke={picked ? '#fff' : look.edge} strokeWidth={picked ? 3 : 1.5} />
                        {it.w * s >= 64 && it.h * s >= 40 ? (
                          <>
                            {/* platforms show their size in feet under the name (only when there is room for two lines) */}
                            <Text text={it.label} width={it.w * s} y={(it.h * s) / 2 - 17} align="center" fill={look.text} fontSize={13} listening={false} />
                            <Text text={`${feet(it.w)} × ${feet(it.h)}`} width={it.w * s} y={(it.h * s) / 2 + 2} align="center" fill={look.sub} fontSize={11} listening={false} />
                          </>
                        ) : (
                          <Text text={it.label} width={it.w * s} height={it.h * s} align="center" verticalAlign="middle" fill={look.text} fontSize={13} listening={false} />
                        )}
                      </>
                    )
                  })()}
                </>
              )}
              {/* plain markers; once the platform is selected its editable points move to the top layer below */}
              {!picked && it.points.map((p) => (
                <Circle key={p.id} x={p.x * s} y={p.y * s} radius={5} fill="#fde047" stroke="#0b0e14" strokeWidth={1.5} listening={false} />
              ))}
            </Group>
          )
        })}

        {cameras.map((cam) => {
          const status = statusOf(cam)
          const dimmed = anyLive && status === 'idle'
          const col = status === 'live' ? LIVE_COLOR : status === 'preview' ? PREVIEW_COLOR : cam.color
          const cx = cam.x * s, cy = cam.y * s
          const fx = cam.focus.x * s, fy = cam.focus.y * s
          const dx = fx - cx, dy = fy - cy
          const heading = (Math.atan2(dy, dx) * 180) / Math.PI
          const dist = Math.hypot(dx, dy)
          const coneLen = dist + cam.focus.radius * s
          const emphasis = status !== 'idle'
          const ptzNow = ptz[cam.id]
          // which of this camera's saved presets the focus circle is sitting on right now, if any
          const here = cam.presets.findIndex((p) => Math.hypot(p.focus.x - cam.focus.x, p.focus.y - cam.focus.y) < 0.05)
          return (
            <Group key={cam.id} opacity={dimmed ? 0.55 : 1}>
              <Wedge x={cx} y={cy} radius={coneLen} angle={cam.fov} rotation={heading - cam.fov / 2}
                fill={withAlpha(col, status === 'live' ? 0.4 : status === 'preview' ? 0.3 : 0.17)}
                stroke={withAlpha(col, emphasis ? 0.9 : 0.55)} strokeWidth={emphasis ? 2.5 : 1.5} listening={false} />
              <Line points={[cx, cy, fx, fy]} stroke={col} strokeWidth={emphasis ? 2 : 1} dash={[6, 6]} listening={false} />
              {/* where each of this camera's other presets aims: a dot with its P-number */}
              {cam.presets.map((p, i) => (i === here ? null : presetTag(cam.id, p.id, p.focus.x * s, p.focus.y * s, i + 1, ptzNow, true, cam.color)))}
              {/* focus area */}
              <Group x={fx} y={fy} draggable={editable}
                onDragMove={(e) => onCameraChange(cam.id, { focus: { ...cam.focus, x: e.target.x() / s, y: e.target.y() / s } })}
                onMouseDown={() => onSelect(cam.id)}>
                {/* the big circle is click-through so it never blocks what's underneath; only the center grabs */}
                {/* Brighter focus area: a stronger tint, a full-strength outline (the old single `opacity` faded the outline
                    along with the fill), and a soft glow in the camera's color. */}
                <Circle radius={cam.focus.radius * s} fill={withAlpha(col, emphasis ? 0.55 : 0.4)}
                  stroke={col} strokeWidth={emphasis ? 4 : 2.5} dash={[8, 5]}
                  shadowColor={col} shadowBlur={emphasis ? 22 : 12} shadowOpacity={0.9} listening={false} />
                <Circle radius={12} fill="#000" opacity={0.01} />
                <Line points={[-8, 0, 8, 0]} stroke={col} strokeWidth={2} listening={false} />
                <Line points={[0, -8, 0, 8]} stroke={col} strokeWidth={2} listening={false} />
                {emphasis && <Text text="FOCUS" y={-cam.focus.radius * s - 16} x={-30} width={60} align="center" fill={col} fontStyle="bold" fontSize={12} listening={false} />}
                {/* the focus point is on one of the saved presets: label it (red when that is the camera's current preset) */}
                {here >= 0 && presetTag(cam.id, `here-${cam.id}`, 0, 0, here + 1, ptzNow, false, cam.color)}
              </Group>
              {/* camera body */}
              <Group x={cx} y={cy} draggable={editable}
                onDragMove={(e) => onCameraChange(cam.id, { x: e.target.x() / s, y: e.target.y() / s })}
                onMouseDown={() => onSelect(cam.id)}
                onDblClick={() => onCameraOpen(cam.id)} onDblTap={() => onCameraOpen(cam.id)}>
                {emphasis && <Circle radius={26} fill={col} opacity={0.25} listening={false} />}
                <Circle radius={16} fill={col} stroke={cam.id === selectedId ? '#fff' : '#0b0e14'} strokeWidth={cam.id === selectedId ? 3 : 2} />
                <Text text={String(cam.number)} x={-16} y={-8} width={32} align="center" fontStyle="bold" fontSize={16} fill="#0b0e14" listening={false} />
                {(() => {
                  const st = ptz[cam.id] // absent for fixed cameras, and for a PTZ camera that can't be reached
                  // every preset known on this camera, plus the one it reports now even if it isn't listed yet
                  const slots = st ? [...new Set([...(cam.slots ?? []), ...(st.preset > 0 ? [st.preset] : [])])].sort((a, b) => a - b) : []
                  // the presets, stacked in a column beside the camera circle
                  const placed = placeInColumns(slots.map((n) => ({ n, label: `P${n}`, w: 14 + 8 * `P${n}`.length })))
                  const tap = (n: number) => (e: { cancelBubble: boolean }) => { e.cancelBubble = true; onPresetChip(cam.id, n) }
                  const hasLive = !!cam.ip && IPV4.test(cam.ip)
                  const openLive = (e: { cancelBubble: boolean }) => { e.cancelBubble = true; onLiveIcon(cam.id) }
                  return (
                    <>
                      {st && placed.map((c) => {
                        const cur = c.n === st.preset
                        const look = cur ? CURRENT[st.status] : OTHER
                        return (
                          <Group key={c.n} x={c.x - c.w / 2} y={c.y - CHIP_H / 2} onClick={tap(c.n)} onTap={tap(c.n)} onMouseEnter={hand(true)} onMouseLeave={hand(false)}>
                            <Rect width={c.w} height={CHIP_H} cornerRadius={CHIP_H / 2} fill={look.fill} stroke={look.stroke} strokeWidth={cur ? 2.5 : 1.5}
                              dash={cur && st.status === 'moved' ? [4, 3] : undefined} />
                            <Text text={c.label + (cur && st.status === 'unknown' ? '?' : '')} width={c.w} y={5} align="center" fontStyle="bold" fontSize={12} fill={look.text} listening={false} />
                          </Group>
                        )
                      })}
                      {/* live view badge on the circle's lower left: opens a small floating live picture */}
                      {hasLive && (
                        <Group x={-12} y={12} onClick={openLive} onTap={openLive}>
                          <Circle radius={9} fill="#1d4ed8" stroke="#bfdbfe" strokeWidth={1.5} />
                          <Rect x={-5.5} y={-3.5} width={7} height={7} cornerRadius={1.5} fill="#fff" listening={false} />
                          <Line points={[2.5, -1.5, 6, -3.5, 6, 3.5, 2.5, 1.5]} closed fill="#fff" listening={false} />
                        </Group>
                      )}
                      <Text text={status === 'live' ? 'LIVE' : status === 'preview' ? 'NEXT' : cam.name} x={-40} y={20} width={80} align="center" fontStyle={emphasis ? 'bold' : 'normal'} fontSize={12} fill={col} listening={false} />
                    </>
                  )
                })()}
              </Group>
            </Group>
          )
        })}
      </Layer>

      {/* Top layer: the selected platform's points and resize handles sit above everything so they can always be grabbed */}
      {selectedPlatform && (
        <Layer x={ox} y={oy}>
          <Group x={(selectedPlatform.x + selectedPlatform.w / 2) * s} y={(selectedPlatform.y + selectedPlatform.h / 2) * s}
            offsetX={(selectedPlatform.w * s) / 2} offsetY={(selectedPlatform.h * s) / 2} rotation={selectedPlatform.rotation}>
            {editable && (
              <>
                {/* rotation handle: drag it around the item; it snaps to 5° steps */}
                <Line points={[(selectedPlatform.w * s) / 2, 0, (selectedPlatform.w * s) / 2, -26]} stroke="#5b8def" strokeWidth={2} listening={false} />
                <Circle x={(selectedPlatform.w * s) / 2} y={-26} radius={8} fill="#5b8def" stroke="#fff" strokeWidth={2} draggable
                  onDragMove={(e) => {
                    const deg = rotationToPointer(e, selectedPlatform.x + selectedPlatform.w / 2, selectedPlatform.y + selectedPlatform.h / 2)
                    e.target.position({ x: (selectedPlatform.w * s) / 2, y: -26 })
                    if (deg !== null) onItemRotate(selectedPlatform.id, deg)
                  }} />
              </>
            )}
            {selectedPlatform.points.map((p) => (
              <Group key={p.id} x={p.x * s} y={p.y * s} draggable={editable}
                onDragMove={(e) => onPointMove(selectedPlatform.id, p.id, e.target.x() / s, e.target.y() / s)}>
                <Circle radius={8} fill="#fde047" stroke="#0b0e14" strokeWidth={1.5} />
                <Text text={p.label} x={-40} y={11} width={80} align="center" fill="#fde047" fontSize={11} listening={false} />
              </Group>
            ))}
            {editable && (['e', 's', 'se'] as const).map((edge) => {
              // handles live in the platform's own (rotated) space, so resizing works at any rotation
              const place = (w: number, h: number) => ({ x: (edge === 's' ? w / 2 : w) * s, y: (edge === 'e' ? h / 2 : h) * s })
              const pos = place(selectedPlatform.w, selectedPlatform.h)
              return (
                <Rect key={edge} x={pos.x} y={pos.y} width={12} height={12} offsetX={6} offsetY={6} fill="#fff" stroke="#5b8def" strokeWidth={2} draggable
                  onDragMove={(e) => {
                    // sizes snap to half a foot, never smaller than one foot
                    const w = edge === 's' ? selectedPlatform.w : Math.max(1, Math.round((e.target.x() / s) * 2) / 2)
                    const h = edge === 'e' ? selectedPlatform.h : Math.max(1, Math.round((e.target.y() / s) * 2) / 2)
                    e.target.position(place(w, h)) // keep the handle on the snapped/clamped edge
                    onItemResize(selectedPlatform.id, w, h)
                  }} />
              )
            })}
          </Group>
        </Layer>
      )}

      {selectedPerson && editable && (
        <Layer x={ox} y={oy}>
          <Group x={selectedPerson.x * s} y={selectedPerson.y * s} rotation={selectedPerson.rotation}>
            <Line points={[0, -personR, 0, -personR - 22]} stroke="#5b8def" strokeWidth={2} listening={false} />
            <Circle y={-personR - 22} radius={8} fill="#5b8def" stroke="#fff" strokeWidth={2} draggable
              onDragMove={(e) => {
                const deg = rotationToPointer(e, selectedPerson.x, selectedPerson.y)
                e.target.position({ x: 0, y: -personR - 22 })
                if (deg !== null) onItemRotate(selectedPerson.id, deg)
              }} />
          </Group>
        </Layer>
      )}
    </Stage>
  )
}
