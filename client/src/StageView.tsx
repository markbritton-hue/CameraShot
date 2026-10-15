import { Arrow, Circle, Ellipse, Group, Layer, Line, Rect, Stage, Text, Wedge } from 'react-konva'
import type { Camera, LiveState, Show } from '../../shared/types'

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
  onItemMove: (id: string, x: number, y: number) => void
  onItemResize: (id: string, w: number, h: number) => void
  onItemRotate: (id: string, rotation: number) => void
  onPointMove: (itemId: string, pointId: string, x: number, y: number) => void
}

export default function StageView({ show, live, width, height, selectedId, selectedItemId, editable, onSelect, onSelectItem, onCameraChange, onItemMove, onItemResize, onItemRotate, onPointMove }: Props) {
  const clearSelection = () => { onSelect(null); onSelectItem(null) }
  const { stage } = show
  const pad = 24
  const s = Math.min((width - pad * 2) / stage.width, (height - pad * 2) / stage.depth)
  const ox = (width - stage.width * s) / 2
  const oy = (height - stage.depth * s) / 2
  const anyLive = live.program !== null || live.preview !== null
  const selectedPlatform = show.items.find((i) => i.id === selectedItemId && i.kind !== 'person') ?? null
  const selectedPerson = show.items.find((i) => i.id === selectedItemId && i.kind === 'person') ?? null
  const personR = Math.max(12, 0.3 * s)

  // Angle (snapped to 5°) that points the item's "up" at the mouse, for a handle dragged around centre (cx, cy) in stage units
  const rotationToPointer = (e: { target: { getStage: () => { getPointerPosition: () => { x: number; y: number } | null } | null } }, cx: number, cy: number) => {
    const p = e.target.getStage()?.getPointerPosition()
    if (!p) return null
    const deg = (Math.atan2(p.y - (oy + cy * s), p.x - (ox + cx * s)) * 180) / Math.PI + 90
    return (((Math.round(deg / 5) * 5) % 360) + 360) % 360
  }

  const gridLines = []
  for (let x = 0; x <= stage.width; x++) gridLines.push(<Line key={`gx${x}`} points={[x * s, 0, x * s, stage.depth * s]} stroke="#2a3140" strokeWidth={1} listening={false} />)
  for (let y = 0; y <= stage.depth; y++) gridLines.push(<Line key={`gy${y}`} points={[0, y * s, stage.width * s, y * s]} stroke="#2a3140" strokeWidth={1} listening={false} />)

  const statusOf = (cam: Camera) =>
    cam.atemInput === live.program ? 'live' : cam.atemInput === live.preview ? 'preview' : 'idle'

  // draw idle cameras first so live/preview sit on top
  const order = { idle: 0, preview: 1, live: 2 } as const
  const cameras = [...show.cameras].sort((a, b) => order[statusOf(a)] - order[statusOf(b)])

  return (
    <Stage width={width} height={height} onMouseDown={(e) => e.target === e.target.getStage() && clearSelection()}>
      <Layer x={ox} y={oy}>
        <Rect width={stage.width * s} height={stage.depth * s} fill="#161b25" stroke="#4b5568" strokeWidth={2} onMouseDown={clearSelection} />
        {gridLines}
        <Text text="AUDIENCE" x={0} y={stage.depth * s + 6} width={stage.width * s} align="center" fill="#6b7587" fontSize={12} listening={false} />

        {show.items.map((it) => {
          const picked = it.id === selectedItemId
          const dragItem = (e: { target: { x: () => number; y: () => number }; currentTarget: unknown }) => {
            if (e.target !== e.currentTarget) return // ignore bubbled drags from child points
            // platforms/stairs sit on a centre pivot, so the group position is the centre; items store the top-left
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
                  <Rect width={it.w * s} height={it.h * s} fill="#2b3447" stroke={picked ? '#fff' : '#5b6780'} strokeWidth={picked ? 2 : 1} />
                  <Text text={it.label} width={it.w * s} height={it.h * s} align="center" verticalAlign="middle" fill="#b6c0d4" fontSize={13} listening={false} />
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
          return (
            <Group key={cam.id} opacity={dimmed ? 0.35 : 1}>
              <Wedge x={cx} y={cy} radius={coneLen} angle={cam.fov} rotation={heading - cam.fov / 2}
                fill={col} opacity={status === 'live' ? 0.32 : status === 'preview' ? 0.22 : 0.1}
                stroke={col} strokeWidth={emphasis ? 2 : 1} listening={false} />
              <Line points={[cx, cy, fx, fy]} stroke={col} strokeWidth={emphasis ? 2 : 1} dash={[6, 6]} listening={false} />
              {/* focus area */}
              <Group x={fx} y={fy} draggable={editable}
                onDragMove={(e) => onCameraChange(cam.id, { focus: { ...cam.focus, x: e.target.x() / s, y: e.target.y() / s } })}
                onMouseDown={() => onSelect(cam.id)}>
                {/* the big circle is click-through so it never blocks what's underneath; only the centre grabs */}
                <Circle radius={cam.focus.radius * s} fill={col} opacity={emphasis ? 0.35 : 0.15}
                  stroke={col} strokeWidth={emphasis ? 3 : 1.5} dash={[8, 5]} listening={false} />
                <Circle radius={12} fill="#000" opacity={0.01} />
                <Line points={[-8, 0, 8, 0]} stroke={col} strokeWidth={2} listening={false} />
                <Line points={[0, -8, 0, 8]} stroke={col} strokeWidth={2} listening={false} />
                {emphasis && <Text text="FOCUS" y={-cam.focus.radius * s - 16} x={-30} width={60} align="center" fill={col} fontStyle="bold" fontSize={12} listening={false} />}
              </Group>
              {/* camera body */}
              <Group x={cx} y={cy} draggable={editable}
                onDragMove={(e) => onCameraChange(cam.id, { x: e.target.x() / s, y: e.target.y() / s })}
                onMouseDown={() => onSelect(cam.id)}>
                {emphasis && <Circle radius={26} fill={col} opacity={0.25} listening={false} />}
                <Circle radius={16} fill={col} stroke={cam.id === selectedId ? '#fff' : '#0b0e14'} strokeWidth={cam.id === selectedId ? 3 : 2} />
                <Text text={String(cam.number)} x={-16} y={-8} width={32} align="center" fontStyle="bold" fontSize={16} fill="#0b0e14" listening={false} />
                <Text text={status === 'live' ? 'LIVE' : status === 'preview' ? 'NEXT' : cam.name} x={-40} y={20} width={80} align="center" fontStyle={emphasis ? 'bold' : 'normal'} fontSize={12} fill={col} listening={false} />
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
                    const w = edge === 's' ? selectedPlatform.w : Math.max(0.5, Math.round((e.target.x() / s) * 10) / 10)
                    const h = edge === 'e' ? selectedPlatform.h : Math.max(0.5, Math.round((e.target.y() / s) * 10) / 10)
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
