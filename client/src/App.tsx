import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { aimTargets, defaultShow, normalizeShow } from '../../shared/types'
import { aim, calibrate } from '../../shared/ptzAim'
import type { AtemStatus, Camera, CameraPreset, LiveState, PtzStates, ServerMessage, Show, StageItem } from '../../shared/types'
import StageView, { DEFAULT_PLATFORM_COLOR, LIVE_COLOR, PREVIEW_COLOR } from './StageView'
import Setup from './Setup'
import StartPage from './StartPage'
import CameraView from './CameraView'
import LiveWindow from './LiveWindow'
import { useCloud } from './cloud'

// crypto.randomUUID only exists on https or localhost, so an iPad opening http://<pc address>:3001 would crash on it
function uid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 3) | 8).toString(16)
  })
}
const CLIENT_ID = uid()
// platform colors: the default steel gray first, then black, wood, gray, red, blue, green, gold, purple, white
const PLATFORM_COLORS = [DEFAULT_PLATFORM_COLOR, '#111827', '#6b4f3a', '#8b8f99', '#b91c1c', '#1d4ed8', '#15803d', '#a16207', '#7e22ce', '#e5e7eb']
const COLORS = ['#38bdf8', '#a78bfa', '#fbbf24', '#f472b6', '#34d399', '#fb923c', '#60a5fa', '#c084fc']

// On GitHub Pages there is no Node server: the app runs as a standalone planner that saves in the browser.
const STATIC_MODE = location.hostname.endsWith('.github.io')

const LOCAL_KEY = 'camerashot.show.v1'
function readLocal(): Show {
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    if (raw) return normalizeShow(JSON.parse(raw))
  } catch { /* storage unavailable or corrupt: fall back to the default show */ }
  return defaultShow
}
function writeLocal(s: Show) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(s)) } catch { /* storage full or blocked */ }
}

/** 12 -> 12', 13.12 -> 13.1' */
const feet = (n: number) => `${+n.toFixed(1)}'`

const near = (a: number, b: number) => Math.abs(a - b) < 0.01
const presetActive = (c: Camera, p: CameraPreset) =>
  near(c.fov, p.fov) && near(c.focus.x, p.focus.x) && near(c.focus.y, p.focus.y) && near(c.focus.radius, p.focus.radius)

export default function App() {
  const [show, setShow] = useState<Show>(readLocal)
  const showRef = useRef(show)
  const [synced, setSynced] = useState(true)
  const [live, setLive] = useState<LiveState>({ program: null, preview: null })
  const [connected, setConnected] = useState(false)
  const [atem, setAtem] = useState<AtemStatus>({ state: 'off' })
  const [ptz, setPtz] = useState<PtzStates>({}) // each PTZ camera's current preset, watched by the server
  const [setupOpen, setSetupOpen] = useState(false)
  const [viewCameraId, setViewCameraId] = useState<string | null>(null) // camera whose live view window is open
  const [liveWins, setLiveWins] = useState<string[]>([]) // floating live pictures, last = on top
  const openLiveWin = useCallback((id: string) => setLiveWins((w) => [...w.filter((x) => x !== id), id]), [])
  // the start page (sign in, pick or create a show) comes first; the editor stays mounted behind it
  // (opening the app at /?screen=editor goes straight to the editor; handy for the home-screen icon and for screenshots)
  const [screen, setScreen] = useState<'start' | 'editor'>(() => (new URLSearchParams(location.search).get('screen') === 'editor' ? 'editor' : 'start'))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [display, setDisplay] = useState(false)
  // on a narrow screen (an iPad held upright) the sidebar is a drawer that slides in from the right
  const [sideOpen, setSideOpen] = useState(() => new URLSearchParams(location.search).get('side') === 'open')
  const [size, setSize] = useState({ w: 800, h: 600 })
  const wrapRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<number | undefined>(undefined)
  const syncReady = useRef(false) // true once the server has said hello on the current connection

  // take a show as the current one (from the server) and cache it in the browser
  const adopt = useCallback((s: Show) => {
    showRef.current = s
    setShow(s)
    writeLocal(s)
    setSynced(true)
  }, [])

  const pushToServer = useCallback((s: Show) => {
    fetch('/api/show', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-client-id': CLIENT_ID },
      body: JSON.stringify(s),
    })
      .then((r) => { if (r.ok && showRef.current.updatedAt === s.updatedAt) setSynced(true) })
      .catch(() => setSynced(false))
  }, [])

  // Every edit is stored in this browser immediately; it is sent to the server too when connected.
  const update = useCallback((fn: (s: Show) => Show) => {
    const next = { ...fn(showRef.current), updatedAt: Date.now() }
    showRef.current = next
    setShow(next)
    writeLocal(next)
    setSynced(false)
    window.clearTimeout(saveTimer.current)
    if (syncReady.current) saveTimer.current = window.setTimeout(() => pushToServer(showRef.current), 300)
  }, [pushToServer])

  // websocket with auto-reconnect
  useEffect(() => {
    if (STATIC_MODE) return
    let ws: WebSocket | null = null
    let timer: number | undefined
    let closed = false
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws?cid=${CLIENT_ID}`)
      ws.onopen = () => setConnected(true)
      ws.onclose = () => {
        setConnected(false)
        syncReady.current = false
        if (!closed) timer = window.setTimeout(connect, 1500)
      }
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as ServerMessage
        if (msg.type === 'hello') {
          setLive(msg.live)
          setAtem(msg.atem)
          setPtz(msg.ptz ?? {})
          const server = normalizeShow(msg.show)
          syncReady.current = true
          // whichever copy was edited last wins, so offline edits are pushed up and never overwritten
          if (showRef.current.updatedAt > server.updatedAt) { setSynced(false); pushToServer(showRef.current) }
          else adopt(server)
        } else if (msg.type === 'show') {
          const incoming = normalizeShow(msg.show)
          if (incoming.updatedAt >= showRef.current.updatedAt) adopt(incoming)
        } else if (msg.type === 'live') setLive(msg.live)
        else if (msg.type === 'atem') setAtem(msg.atem)
        else if (msg.type === 'ptz') setPtz(msg.ptz)
      }
    }
    connect()
    return () => { closed = true; window.clearTimeout(timer); ws?.close() }
  }, [adopt, pushToServer])

  // fit canvas to its container
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // While the ATEM simulator is ON the grid is locked, so nothing gets moved, resized, added or deleted by accident
  // during a demo. Switch the simulator OFF (the default) and the grid is editable. Cameras can always be picked,
  // opened, moved with the pad, and sent to presets.
  const locked = show.settings.simulator === true

  // Everything that depends on "which camera is live" goes through this: the red/green coloring, the LIVE / NEXT names,
  // the ON AIR badges and the "move it on air?" question. With the simulator OFF nothing is live as far as the app is
  // concerned, even if a real ATEM is connected and reporting a program camera.
  const liveShown = useMemo<LiveState>(() => (locked ? live : { program: null, preview: null }), [locked, live])

  // one tap on a preset chip sends the camera there; if it is live on the ATEM, ask first
  const recallSlot = useCallback((cameraId: string, n: number) => {
    const cam = show.cameras.find((c) => c.id === cameraId)
    if (!cam?.ip) return
    if (cam.atemInput === liveShown.program && !window.confirm(`Cam ${cam.number} is live on the ATEM. Move it to preset ${n} on air?`)) return
    void fetch('/api/ptz/drive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: cam.ip, action: 'recall', n }) })
  }, [show.cameras, liveShown.program])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDisplay(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const cloud = useCloud(show, (s) => {
    update(() => s)
    setSelectedId(null)
    setSelectedItemId(null)
  })

  // a new show starts empty but keeps your cameras (inputs, IPs) and ATEM settings, without their presets
  const startNewShow = (name: string) => {
    const base: Show = {
      ...structuredClone(show),
      name,
      items: [],
      // no presets (neither the plan's nor the camera memory slots learned from the last show), and the cameras start in
      // an even row near the audience edge, each aimed straight out (up the plan) at the middle of the stage
      cameras: show.cameras.map((c, i, all) => ({
        ...c, presets: [], slots: [], positionLocked: undefined,
        x: Math.round(((show.stage.width * (i + 1)) / (all.length + 1)) * 2) / 2,
        y: show.stage.depth - 2,
        focus: { ...c.focus, x: Math.round(((show.stage.width * (i + 1)) / (all.length + 1)) * 2) / 2, y: show.stage.depth / 2 },
      })),
    }
    void cloud.create(base)
    setScreen('editor')
  }

  const selectCamera = useCallback((id: string | null) => {
    setSelectedId(id)
    if (id !== null) setSelectedItemId(null)
  }, [])
  const selectItem = useCallback((id: string | null) => {
    if (locked && id !== null) return // locked: platforms, stairs and people can't be picked (the editor would open)
    setSelectedItemId(id)
    if (id !== null) setSelectedId(null)
  }, [locked])
  useEffect(() => { if (locked) setSelectedItemId(null) }, [locked])

  const patchCamera = useCallback((id: string, patch: Partial<Camera>) =>
    update((s) => ({ ...s, cameras: s.cameras.map((c) => (c.id === id ? { ...c, ...patch } : c)) })), [update])
  // Live follow: while a calibrated PTZ camera has 'move the real camera' on, dragging its focus point or cone aims it too.
  // At most ~5 moves a second; the last position always gets sent so the camera ends up where the cone is.
  const followState = useRef(new Map<string, { last: number; timer?: ReturnType<typeof setTimeout> }>())
  const followCamera = useCallback((cam: Camera) => {
    if (STATIC_MODE || !cam.ptz || !cam.ip || !cam.ptzFollow || !cam.ptzCal) return
    const st = followState.current.get(cam.id) ?? { last: 0 }
    followState.current.set(cam.id, st)
    const send = () => {
      st.last = Date.now(); st.timer = undefined
      void fetch('/api/ptz/drive', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: cam.ip, action: 'goto', ...aim(cam, cam.ptzCal!, cam.focus.x, cam.focus.y, cam.fov) }) }).catch(() => {})
    }
    clearTimeout(st.timer)
    const wait = 200 - (Date.now() - st.last)
    if (wait <= 0) send(); else st.timer = setTimeout(send, wait)
  }, [])
  const changeCamera = useCallback((id: string, patch: Partial<Camera>) => {
    patchCamera(id, patch)
    const cam = show.cameras.find((c) => c.id === id)
    if (!cam) return
    const moved = patch.focus !== undefined && (patch.focus.x !== cam.focus.x || patch.focus.y !== cam.focus.y)
    if (moved || (patch.fov !== undefined && patch.fov !== cam.fov)) followCamera({ ...cam, ...patch })
  }, [patchCamera, show.cameras, followCamera])
  // Calibrate: the camera is physically aimed at the plan's focus point right now, so read where it is and remember how that lines up
  const [calibrating, setCalibrating] = useState('')
  const calibrateCamera = async (cam: Camera) => {
    if (!cam.ip) return
    setCalibrating('reading the camera…')
    try {
      const r = await fetch(`/api/ptz/position?host=${encodeURIComponent(cam.ip)}`)
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'could not read the camera')
      patchCamera(cam.id, { ptzCal: calibrate(cam, j.position) })
      setCalibrating('')
    } catch (e) {
      setCalibrating(e instanceof Error ? e.message : String(e))
    }
  }
  const patchItem = useCallback((id: string, patch: Partial<StageItem>) =>
    update((s) => ({ ...s, items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) })), [update])
  const moveItem = useCallback((id: string, x: number, y: number) => patchItem(id, { x, y }), [patchItem])
  const resizeItem = useCallback((id: string, w: number, h: number) =>
    update((s) => ({
      ...s,
      items: s.items.map((i) => {
        if (i.id !== id) return i
        // Items rotate about their center, so resizing from the corner handle must move the center to keep the
        // top-left corner where it is on screen (at any rotation). x/y store the unrotated top-left.
        const r = (i.rotation * Math.PI) / 180
        const cos = Math.cos(r), sin = Math.sin(r)
        const cornerX = i.x + i.w / 2 - (i.w / 2) * cos + (i.h / 2) * sin
        const cornerY = i.y + i.h / 2 - (i.w / 2) * sin - (i.h / 2) * cos
        const centerX = cornerX + (w / 2) * cos - (h / 2) * sin
        const centerY = cornerY + (w / 2) * sin + (h / 2) * cos
        return {
          ...i, w, h, x: centerX - w / 2, y: centerY - h / 2,
          // keep marked points inside the platform when it shrinks
          points: i.points.map((p) => ({ ...p, x: Math.min(p.x, w), y: Math.min(p.y, h) })),
        }
      }),
    })), [update])
  const rotateItem = useCallback((id: string, rotation: number) => patchItem(id, { rotation }), [patchItem])
  const movePoint = useCallback((itemId: string, pointId: string, x: number, y: number) =>
    update((s) => ({
      ...s,
      items: s.items.map((i) => (i.id === itemId ? { ...i, points: i.points.map((p) => (p.id === pointId ? { ...p, x, y } : p)) } : i)),
    })), [update])

  const addCamera = () => {
    const n = show.cameras.reduce((m, c) => Math.max(m, c.number), 0) + 1
    const cam: Camera = {
      id: uid(), number: n, name: `Cam ${n}`, color: COLORS[(n - 1) % COLORS.length], atemInput: Math.min(n, 8),
      x: show.stage.width / 2, y: show.stage.depth - 2, fov: 40,
      focus: { x: show.stage.width / 2, y: show.stage.depth / 3, radius: 5 }, presets: [],
    }
    update((s) => ({ ...s, cameras: [...s.cameras, cam] }))
    selectCamera(cam.id)
  }
  const addPlatform = () => {
    const it: StageItem = { id: uid(), kind: 'platform', label: 'Platform', x: 4, y: 4, w: 8, h: 4, rotation: 0, points: [] }
    update((s) => ({ ...s, items: [...s.items, it] }))
    selectItem(it.id)
  }
  const addStairs = () => {
    const it: StageItem = { id: uid(), kind: 'stairs', label: 'Stairs', steps: 3, x: 4, y: 4, w: 6, h: 3, rotation: 0, points: [] }
    update((s) => ({ ...s, items: [...s.items, it] }))
    selectItem(it.id)
  }
  const addPerson = () => {
    const n = show.items.filter((i) => i.kind === 'person').length + 1
    const it: StageItem = { id: uid(), kind: 'person', label: `Person ${n}`, x: show.stage.width / 2, y: show.stage.depth / 2, w: 1.5, h: 1.5, rotation: 0, points: [] }
    update((s) => ({ ...s, items: [...s.items, it] }))
    selectItem(it.id)
  }
  const addPoint = (item: StageItem) =>
    patchItem(item.id, { points: [...item.points, { id: uid(), label: `Point ${item.points.length + 1}`, x: item.w / 2, y: item.h / 2 }] })

  const savePreset = (cam: Camera) =>
    patchCamera(cam.id, { presets: [...cam.presets, { id: uid(), name: `Preset ${cam.presets.length + 1}`, fov: cam.fov, focus: { ...cam.focus } }] })
  const patchPreset = (cam: Camera, id: string, patch: Partial<CameraPreset>) =>
    patchCamera(cam.id, { presets: cam.presets.map((p) => (p.id === id ? { ...p, ...patch } : p)) })

  const selected = show.cameras.find((c) => c.id === selectedId) ?? null
  const selectedItem = show.items.find((i) => i.id === selectedItemId) ?? null
  const targets = useMemo(() => aimTargets(show.items), [show.items])
  const liveCam = useMemo(() => show.cameras.find((c) => c.atemInput === liveShown.program), [show.cameras, liveShown.program])
  const prevCam = useMemo(() => show.cameras.find((c) => c.atemInput === liveShown.preview), [show.cameras, liveShown.preview])

  // A click on a "P3" label at a preset's aim point on the grid only moves the PLAN: the camera's cone and focus circle
  // take that preset's saved aim and zoom. It never sends anything to the real camera (that is what the chips beside
  // the camera, the camera window and Companion are for), so it is safe to click while a camera is live.
  const applyPresetTag = useCallback((cameraId: string, n: number) => {
    const sp = show.cameras.find((c) => c.id === cameraId)?.presets[n - 1]
    if (sp) patchCamera(cameraId, { fov: sp.fov, focus: { ...sp.focus } })
  }, [show.cameras, patchCamera])

  const simulate = (which: 'program' | 'preview', input: number) => {
    if (STATIC_MODE) return setLive((l) => ({ ...l, [which]: input === 0 ? null : input })) // no server: simulate locally
    return fetch(`/api/atem/${which}/${input}`, { method: 'POST' })
  }

  // The ATEM simulator buttons can be switched off. The choice is saved WITH THE SHOW (not in this browser), so it
  // stays off in every browser and at every address (localhost:5173, :3001, the launcher...).
  const simOn = locked // simulator on <=> grid locked
  const toggleSim = (on: boolean) => {
    update((s) => ({ ...s, settings: { ...s.settings, simulator: on } }))
    // switching ON with a real ATEM connected: show what the ATEM says right now, not whatever was cleared when it went off
    if (on) { if (!STATIC_MODE && atem.state === 'connected') void fetch('/api/atem/refresh', { method: 'POST' }); return }
    // Switching it off clears every ATEM button back to zero: no program and no preview camera, so no highlight is left
    // over from the simulator. (A real ATEM that is connected lights them again at its next cut.)
    void simulate('program', 0)
    void simulate('preview', 0)
  }

  // Display mode turns the simulator On (live / next coloring), and leaving it for the main screen turns it Off again
  const wasDisplay = useRef(false)
  useEffect(() => {
    if (display === wasDisplay.current) return
    wasDisplay.current = display
    if (display !== simOn) toggleSim(display)
  }, [display]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`app ${display ? 'display' : ''}`}>
      <div className="canvas" ref={wrapRef}>
        <div className="banner">
          {/* small, at the left end of the bar (the live / next names and the connection status are on the right) */}
          {display && <button className="exit-display" title="Leave display mode (Esc)" onClick={() => setDisplay(false)}>✕ Exit (Esc)</button>}
          {locked ? (
            <>
              <span className="tag live" style={{ background: LIVE_COLOR }}>LIVE</span>
              <b>{liveShown.program === null ? '—' : liveCam ? `Cam ${liveCam.number} · ${liveCam.name}` : `Input ${liveShown.program} (not a camera)`}</b>
              <span className="tag" style={{ background: PREVIEW_COLOR }}>NEXT</span>
              <b>{liveShown.preview === null ? '—' : prevCam ? `Cam ${prevCam.number} · ${prevCam.name}` : `Input ${liveShown.preview}`}</b>
            </>
          ) : (
            <span className="live-off" title="The ATEM switch in the sidebar is Off, so no live or next coloring is shown.">live / next coloring off</span>
          )}
          <span className={`conn ${connected ? 'ok' : ''}`}>{STATIC_MODE ? 'planner mode' : connected ? 'connected' : 'offline'}</span>
          {!display && <button className="side-toggle" aria-label="Menu" title="Menu" onClick={() => setSideOpen(!sideOpen)}>☰</button>}
          {locked && <span className="lock-tag" title="The ATEM simulator is on, so the grid is locked. Switch the simulator off to edit.">🔒 grid locked</span>}
        </div>
        {!connected && !STATIC_MODE && (
          <div className="offline-bar">
            OFFLINE: no live ATEM updates. Your edits are saved in this browser and will sync when the server is back.
          </div>
        )}
        <StageView show={show} live={liveShown} width={size.w} height={size.h} selectedId={selectedId} selectedItemId={selectedItemId}
          editable={!display && !locked} onSelect={selectCamera} onSelectItem={selectItem} onCameraChange={changeCamera} onCameraOpen={setViewCameraId}
          ptz={ptz} onPresetChip={recallSlot} onPresetTag={applyPresetTag} onLiveIcon={openLiveWin}
          onItemMove={moveItem} onItemResize={resizeItem} onItemRotate={rotateItem} onPointMove={movePoint} />

        {/* floating live pictures: 300 x 300 to start, drag the title to move, drag the corner to resize */}
        {liveWins.map((id, i) => {
          const cam = show.cameras.find((c) => c.id === id)
          if (!cam) return null
          return (
            <LiveWindow key={id} camera={cam} onAir={cam.atemInput === liveShown.program} bounds={{ w: size.w, h: size.h }} z={6 + i} startAt={{ x: 24 + i * 28, y: 70 + i * 28 }}
              onFocus={() => openLiveWin(id)} onClose={() => setLiveWins((w) => w.filter((x) => x !== id))}
              onOpenControls={() => setViewCameraId(id)} />
          )
        })}

      </div>

      {!display && sideOpen && <div className="side-backdrop" onClick={() => setSideOpen(false)} />}
      {!display && (
        // the panel takes on the selected camera's color (a tint, so the text stays readable)
        <aside className={`side${selected ? ' has-cam' : ''}${sideOpen ? ' open' : ''}`} style={selected ? ({ '--cam': selected.color } as React.CSSProperties) : undefined}>
          {/* the show-level options (title, shows list, setup) only appear when no camera is picked */}
          {!selected && (<>
          <div className="title-row">
            <h1>CameraShot</h1>
            <button onClick={() => setScreen('start')} title="Back to the shows list">Shows</button>
            <button className="gear" title="Setup: ATEM and camera addresses" aria-label="Setup" onClick={() => setSetupOpen(true)}>⚙</button>
          </div>
          <input className="wide" value={show.name} onChange={(e) => update((s) => ({ ...s, name: e.target.value }))} />
          <p className="hint">
            Saved in this browser ✓ · {STATIC_MODE ? 'standalone planner (no server). Sign in to keep shows in the cloud.' : connected ? (synced ? 'synced to server ✓' : 'syncing to server…') : 'server offline, will sync later'}
          </p>
          <button onClick={() => setDisplay(true)}>Display mode</button>


          </>)}

          <h2>Cameras <button onClick={addCamera} disabled={locked}>+ Add</button></h2>
          <ul className="cams">
            {show.cameras.map((c) => (
              <li key={c.id} className={`${c.id === selectedId ? 'sel' : ''}${c.hidden ? ' cam-hidden' : ''}`} onClick={() => selectCamera(c.id)}
                title="Double-click to open the camera window" onDoubleClick={() => setViewCameraId(c.id)}>
                <span className="dot" style={{ background: c.color }} />Cam {c.number} · {c.name}
                <small>ATEM {c.atemInput}</small>
                <button className="item-lock cam-eye" aria-pressed={c.hidden !== true}
                  title={c.hidden ? 'Hidden from the grid: click to show it' : 'Click to hide this camera from the grid'}
                  onClick={(e) => { e.stopPropagation(); patchCamera(c.id, { hidden: c.hidden ? undefined : true }) }}>{c.hidden ? '🚫' : '👁'}</button>
                <button className={`item-lock`} aria-pressed={c.positionLocked === true}
                  title={c.positionLocked ? 'Position locked: click to unlock' : 'Click to lock the camera\'s position on the grid'}
                  onClick={(e) => { e.stopPropagation(); patchCamera(c.id, { positionLocked: c.positionLocked ? undefined : true }) }}>{c.positionLocked ? '🔒' : '🔓'}</button>
              </li>
            ))}
          </ul>

          {selected && (
            <div className="editor">
              <label>Name <input value={selected.name} onChange={(e) => patchCamera(selected.id, { name: e.target.value })} /></label>
              <div className="row">
                <label>Number <input type="number" min={1} value={selected.number} onChange={(e) => patchCamera(selected.id, { number: +e.target.value })} /></label>
                <label>ATEM input <input type="number" min={1} max={8} value={selected.atemInput} onChange={(e) => patchCamera(selected.id, { atemInput: +e.target.value })} /></label>
              </div>
              <label>Aim at
                <select value="" onChange={(e) => {
                  const t = targets.find((x) => x.key === e.target.value)
                  if (t) changeCamera(selected.id, { focus: { ...selected.focus, x: t.x, y: t.y } })
                }}>
                  <option value="">{targets.length ? 'choose a person or point…' : 'add a person or platform point first'}</option>
                  {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              </label>
              <label>Zoom (FOV) {selected.fov}° <input type="range" min={10} max={120} value={selected.fov} onChange={(e) => changeCamera(selected.id, { fov: +e.target.value })} /></label>
              <label>Focus radius {selected.focus.radius.toFixed(1)} ft <input type="range" min={1} max={16} step={0.5} value={selected.focus.radius} onChange={(e) => patchCamera(selected.id, { focus: { ...selected.focus, radius: +e.target.value } })} /></label>
              <label>Color <input type="color" value={selected.color} onChange={(e) => patchCamera(selected.id, { color: e.target.value })} /></label>
              {selected.ptz && selected.ip && !STATIC_MODE && (
                <div className="follow">
                  <h3>Move the real camera</h3>
                  <p className="hint">Aim the camera at this plan's focus point (use the camera window), then press Calibrate. After that, dragging the focus point or the cone on the plan moves the camera too.</p>
                  <div className="row">
                    <button onClick={() => void calibrateCamera(selected)}>{selected.ptzCal ? 'Recalibrate' : 'Calibrate'}</button>
                    <label className="check"><input type="checkbox" disabled={!selected.ptzCal} checked={selected.ptzFollow === true}
                      onChange={(e) => patchCamera(selected.id, { ptzFollow: e.target.checked || undefined })} /> Camera follows the cone</label>
                  </div>
                  {calibrating && <p className="hint">{calibrating}</p>}
                  {selected.ptzCal && !calibrating && <p className="hint">Calibrated (mounted about {selected.ptzCal.height.toFixed(0)} ft up, widest view {selected.ptzCal.fovWide.toFixed(0)}°).</p>}
                </div>
              )}

              <h3>Presets <button onClick={() => savePreset(selected)}>+ Save current</button></h3>
              {selected.presets.length === 0 && <p className="hint">Aim and zoom the camera, then save it as a preset.</p>}
              {selected.presets.map((p, idx) => (
                <div className="preset-card" key={p.id}>
                  <div className="preset">
                    <span className="num">{idx + 1}</span>
                    <input value={p.name} onChange={(e) => patchPreset(selected, p.id, { name: e.target.value })} />
                    <button className={presetActive(selected, p) ? 'active' : ''} title="Recall" onClick={() => patchCamera(selected.id, { fov: p.fov, focus: { ...p.focus } })}>Go</button>
                    <button title="Overwrite with the camera's current aim, zoom and focus radius" onClick={() => patchPreset(selected, p.id, { fov: selected.fov, focus: { ...selected.focus } })}>Set</button>
                    <button title="Delete" onClick={() => patchCamera(selected.id, { presets: selected.presets.filter((x) => x.id !== p.id) })}>×</button>
                  </div>
                  <div className="row">
                    <label>FOV °
                      <input type="number" min={10} max={120} step={1} value={p.fov}
                        onChange={(e) => patchPreset(selected, p.id, { fov: Math.min(120, Math.max(10, +e.target.value || 10)) })} />
                    </label>
                    <label>Focus radius ft
                      <input type="number" min={1} max={16} step={0.5} value={p.focus.radius}
                        onChange={(e) => patchPreset(selected, p.id, { focus: { ...p.focus, radius: Math.min(16, Math.max(1, +e.target.value || 1)) } })} />
                    </label>
                  </div>
                </div>
              ))}
              {selected.presets.length > 0 && <p className="hint">Companion: <code>POST /api/camera/{selected.number}/preset/&lt;n&gt;</code></p>}

              <button className="danger" disabled={locked} title={locked ? 'Locked while the simulator is on' : undefined} onClick={() => { update((s) => ({ ...s, cameras: s.cameras.filter((c) => c.id !== selected.id) })); setSelectedId(null) }}>Delete camera</button>
            </div>
          )}

          <h2>Grid items <span><button onClick={addPlatform} disabled={locked}>+ Platform</button> <button onClick={addStairs} disabled={locked}>+ Stairs</button> <button onClick={addPerson} disabled={locked}>+ Person</button></span></h2>
          {locked && <p className="hint lock-hint">🔒 The grid is locked while the ATEM simulator is on. Switch the simulator off (at the bottom of this panel) to edit the layout.</p>}
          <ul className="cams">
            {show.items.map((it) => (
              <li key={it.id} className={it.id === selectedItemId ? 'sel' : ''} onClick={() => selectItem(it.id)}>
                <span>{it.kind === 'person' ? '🧍' : it.kind === 'stairs' ? '🪜' : '▭'}</span>{it.label}
                {it.kind === 'platform' && <small>{feet(it.w)} × {feet(it.h)}</small>}
                <button className={`item-lock`} aria-pressed={it.locked === true}
                  title={it.locked ? 'Locked: click to unlock' : 'Click to lock its position and size'}
                  onClick={(e) => { e.stopPropagation(); patchItem(it.id, { locked: it.locked ? undefined : true }) }}>{it.locked ? '🔒' : '🔓'}</button>
              </li>
            ))}
          </ul>

          {selectedItem && (
            <div className="editor">
              <label>Label <input value={selectedItem.label} onChange={(e) => patchItem(selectedItem.id, { label: e.target.value })} /></label>
              {selectedItem.kind === 'platform' && (
                <div className="swatch-field">
                  <span>Color</span>
                  <div className="swatches">
                    {PLATFORM_COLORS.map((c) => (
                      <button key={c} className={`swatch${(selectedItem.color ?? DEFAULT_PLATFORM_COLOR).toLowerCase() === c ? ' on' : ''}`}
                        style={{ background: c }} title={c === DEFAULT_PLATFORM_COLOR ? 'Default (light steel)' : c}
                        onClick={() => patchItem(selectedItem.id, { color: c === DEFAULT_PLATFORM_COLOR ? undefined : c })} />
                    ))}
                    <input type="color" value={selectedItem.color ?? DEFAULT_PLATFORM_COLOR} title="Pick any color"
                      onChange={(e) => patchItem(selectedItem.id, { color: e.target.value })} />
                  </div>
                </div>
              )}
              <fieldset className="lockable" disabled={selectedItem.locked === true}>
              {selectedItem.kind !== 'person' && (
                <>
                  {selectedItem.kind === 'stairs' && (
                    <label>Steps {selectedItem.steps ?? 3}
                      <input type="range" min={2} max={8} value={selectedItem.steps ?? 3} onChange={(e) => patchItem(selectedItem.id, { steps: +e.target.value })} />
                      <span className="hint">Stairs rise towards the top of the plan (upstage). Rotate to turn them.</span>
                    </label>
                  )}
                  <div className="row">
                    <label>Width ft <input type="number" step={0.5} min={1} value={selectedItem.w} onChange={(e) => patchItem(selectedItem.id, { w: +e.target.value || 1 })} /></label>
                    <label>Depth ft <input type="number" step={0.5} min={1} value={selectedItem.h} onChange={(e) => patchItem(selectedItem.id, { h: +e.target.value || 1 })} /></label>
                    <label>Rotate° <input type="number" step={5} value={selectedItem.rotation} onChange={(e) => patchItem(selectedItem.id, { rotation: +e.target.value })} /></label>
                  </div>
                  <h3>Points <button onClick={() => addPoint(selectedItem)}>+ Add point</button></h3>
                  {selectedItem.points.length === 0 && <p className="hint">Add a point, then drag the yellow dot on the platform. Cameras can aim at it.</p>}
                  {selectedItem.points.map((p) => (
                    <div className="row item" key={p.id}>
                      <input value={p.label} onChange={(e) => patchItem(selectedItem.id, { points: selectedItem.points.map((q) => (q.id === p.id ? { ...q, label: e.target.value } : q)) })} />
                      <button onClick={() => patchItem(selectedItem.id, { points: selectedItem.points.filter((q) => q.id !== p.id) })}>×</button>
                    </div>
                  ))}
                </>
              )}
              <div className="row rotate-row">
                <button title="Turn 90° anticlockwise" onClick={() => patchItem(selectedItem.id, { rotation: (((selectedItem.rotation - 90) % 360) + 360) % 360 })}>⟲ 90°</button>
                <button title="Turn 90° clockwise" onClick={() => patchItem(selectedItem.id, { rotation: (selectedItem.rotation + 90) % 360 })}>⟳ 90°</button>
                {selectedItem.kind === 'person' && (
                  <label>Facing°
                    <input type="number" step={5} value={selectedItem.rotation} onChange={(e) => patchItem(selectedItem.id, { rotation: +e.target.value })} />
                  </label>
                )}
              </div>
              <p className="hint">Drag the blue dot above the item to rotate it (snaps to 5°).</p>
              <button className="danger" onClick={() => { update((s) => ({ ...s, items: s.items.filter((i) => i.id !== selectedItem.id) })); setSelectedItemId(null) }}>Delete {selectedItem.kind}</button>
              </fieldset>
            </div>
          )}

          <h2>ATEM simulator
            <button className={`sim-toggle ${simOn ? 'on' : 'off'}`} onClick={() => toggleSim(!simOn)}
              title={simOn ? 'On: live / next coloring is shown and the grid is locked. Click to switch off.' : 'Off: no live / next coloring and the grid is editable. Click to switch on.'}>
              {simOn ? 'On' : 'Off'}
            </button>
          </h2>
          {!simOn && <p className="hint">Off: no live or next coloring is shown, and the grid can be edited. Switch it On to show the ATEM's live and next cameras (the grid locks).</p>}
          {simOn && (
            <>
              <p className="hint">
                {atem.state === 'connected' ? <>Reading the real ATEM (ME{show.settings.me}); these buttons override it until the next cut.</> : <>For testing without the ATEM.</>}
                {' '}Set the ATEM address under ⚙.
              </p>
              {(['program', 'preview'] as const).map((which) => (
                <div key={which} className="sim">
                  <small>{which}</small>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                    <button key={n} className={live[which] === n ? which : ''} onClick={() => simulate(which, n)}>{n}</button>
                  ))}
                  <button onClick={() => simulate(which, 0)}>✕</button>
                </div>
              ))}
            </>
          )}
          {STATIC_MODE
            ? <p className="hint">Live ATEM and Companion control needs the local CameraShot server (npm run dev).</p>
            : <p className="hint">Companion calls: <code>POST {location.origin}/api/atem/program/&lt;input&gt;?me={show.settings.me}</code></p>}
        </aside>
      )}

      {screen === 'start' && (
        <StartPage
          cloud={cloud}
          lastOpenedId={cloud.cloudId}
          onOpen={(c) => { cloud.open(c); setScreen('editor') }}
          onNew={startNewShow}
          onLocal={() => { cloud.unlink(); setScreen('editor') }}
        />
      )}

      {viewCameraId && show.cameras.some((c) => c.id === viewCameraId) && (
        <CameraView
          camera={show.cameras.find((c) => c.id === viewCameraId)!}
          serverAvailable={connected && !STATIC_MODE}
          onAir={show.cameras.find((c) => c.id === viewCameraId)?.atemInput === liveShown.program}
          ptzState={ptz[viewCameraId]}
          onClose={() => setViewCameraId(null)}
          onOpenSetup={() => { setViewCameraId(null); setSetupOpen(true) }}
          onPatch={(patch) => patchCamera(viewCameraId, patch)} />
      )}

      {setupOpen && (
        <Setup show={show} atem={atem} gridLocked={locked} serverAvailable={connected && !STATIC_MODE} onClose={() => setSetupOpen(false)} update={update} />
      )}
    </div>
  )
}
