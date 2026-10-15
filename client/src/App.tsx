import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { aimTargets, defaultShow, normalizeShow } from '../../shared/types'
import type { AtemStatus, Camera, CameraPreset, LiveState, ServerMessage, Show, StageItem } from '../../shared/types'
import StageView, { LIVE_COLOR, PREVIEW_COLOR } from './StageView'
import Setup from './Setup'

const CLIENT_ID = crypto.randomUUID()
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
  const [setupOpen, setSetupOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [display, setDisplay] = useState(false)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const wrapRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<number | undefined>(undefined)
  const syncReady = useRef(false) // true once the server has said hello on the current connection
  const fileRef = useRef<HTMLInputElement>(null)

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDisplay(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const exportShow = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([JSON.stringify(show, null, 2)], { type: 'application/json' }))
    a.download = `${show.name.replace(/[^\w\- ]+/g, '').trim() || 'show'}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const importShow = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text())
      if (!parsed || !Array.isArray(parsed.cameras) || !Array.isArray(parsed.items) || !parsed.stage) throw new Error('not a CameraShot show file')
      update(() => normalizeShow(parsed))
      setSelectedId(null)
      setSelectedItemId(null)
    } catch (e) {
      alert(`Couldn't import that file: ${(e as Error).message}`)
    }
  }

  const selectCamera = useCallback((id: string | null) => {
    setSelectedId(id)
    if (id !== null) setSelectedItemId(null)
  }, [])
  const selectItem = useCallback((id: string | null) => {
    setSelectedItemId(id)
    if (id !== null) setSelectedId(null)
  }, [])

  const patchCamera = useCallback((id: string, patch: Partial<Camera>) =>
    update((s) => ({ ...s, cameras: s.cameras.map((c) => (c.id === id ? { ...c, ...patch } : c)) })), [update])
  const patchItem = useCallback((id: string, patch: Partial<StageItem>) =>
    update((s) => ({ ...s, items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) })), [update])
  const moveItem = useCallback((id: string, x: number, y: number) => patchItem(id, { x, y }), [patchItem])
  const resizeItem = useCallback((id: string, w: number, h: number) =>
    update((s) => ({
      ...s,
      items: s.items.map((i) => (i.id === id
        // keep marked points inside the platform when it shrinks
        ? { ...i, w, h, points: i.points.map((p) => ({ ...p, x: Math.min(p.x, w), y: Math.min(p.y, h) })) }
        : i)),
    })), [update])
  const movePoint = useCallback((itemId: string, pointId: string, x: number, y: number) =>
    update((s) => ({
      ...s,
      items: s.items.map((i) => (i.id === itemId ? { ...i, points: i.points.map((p) => (p.id === pointId ? { ...p, x, y } : p)) } : i)),
    })), [update])

  const addCamera = () => {
    const n = show.cameras.reduce((m, c) => Math.max(m, c.number), 0) + 1
    const cam: Camera = {
      id: crypto.randomUUID(), number: n, name: `Cam ${n}`, color: COLORS[(n - 1) % COLORS.length], atemInput: Math.min(n, 8),
      x: show.stage.width / 2, y: show.stage.depth - 0.5, fov: 40,
      focus: { x: show.stage.width / 2, y: show.stage.depth / 3, radius: 1.5 }, presets: [],
    }
    update((s) => ({ ...s, cameras: [...s.cameras, cam] }))
    selectCamera(cam.id)
  }
  const addPlatform = () => {
    const it: StageItem = { id: crypto.randomUUID(), kind: 'platform', label: 'Platform', x: 1, y: 1, w: 2, h: 1.5, rotation: 0, points: [] }
    update((s) => ({ ...s, items: [...s.items, it] }))
    selectItem(it.id)
  }
  const addPerson = () => {
    const n = show.items.filter((i) => i.kind === 'person').length + 1
    const it: StageItem = { id: crypto.randomUUID(), kind: 'person', label: `Person ${n}`, x: show.stage.width / 2, y: show.stage.depth / 2, w: 0.6, h: 0.6, rotation: 0, points: [] }
    update((s) => ({ ...s, items: [...s.items, it] }))
    selectItem(it.id)
  }
  const addPoint = (item: StageItem) =>
    patchItem(item.id, { points: [...item.points, { id: crypto.randomUUID(), label: `Point ${item.points.length + 1}`, x: item.w / 2, y: item.h / 2 }] })

  const savePreset = (cam: Camera) =>
    patchCamera(cam.id, { presets: [...cam.presets, { id: crypto.randomUUID(), name: `Preset ${cam.presets.length + 1}`, fov: cam.fov, focus: { ...cam.focus } }] })
  const patchPreset = (cam: Camera, id: string, patch: Partial<CameraPreset>) =>
    patchCamera(cam.id, { presets: cam.presets.map((p) => (p.id === id ? { ...p, ...patch } : p)) })

  const selected = show.cameras.find((c) => c.id === selectedId) ?? null
  const selectedItem = show.items.find((i) => i.id === selectedItemId) ?? null
  const targets = useMemo(() => aimTargets(show.items), [show.items])
  const liveCam = useMemo(() => show.cameras.find((c) => c.atemInput === live.program), [show.cameras, live.program])
  const prevCam = useMemo(() => show.cameras.find((c) => c.atemInput === live.preview), [show.cameras, live.preview])

  const simulate = (which: 'program' | 'preview', input: number) => {
    if (STATIC_MODE) return setLive((l) => ({ ...l, [which]: input === 0 ? null : input })) // no server: simulate locally
    return fetch(`/api/atem/${which}/${input}`, { method: 'POST' })
  }

  return (
    <div className={`app ${display ? 'display' : ''}`}>
      <div className="canvas" ref={wrapRef}>
        <div className="banner">
          <span className="tag live" style={{ background: LIVE_COLOR }}>LIVE</span>
          <b>{live.program === null ? '—' : liveCam ? `Cam ${liveCam.number} · ${liveCam.name}` : `Input ${live.program} (not a camera)`}</b>
          <span className="tag" style={{ background: PREVIEW_COLOR }}>NEXT</span>
          <b>{live.preview === null ? '—' : prevCam ? `Cam ${prevCam.number} · ${prevCam.name}` : `Input ${live.preview}`}</b>
          <span className={`conn ${connected ? 'ok' : ''}`}>{STATIC_MODE ? 'planner mode' : connected ? 'connected' : 'offline'}</span>
          {display && <button onClick={() => setDisplay(false)}>Exit display (Esc)</button>}
        </div>
        {!connected && !STATIC_MODE && (
          <div className="offline-bar">
            OFFLINE: no live ATEM updates. Your edits are saved in this browser and will sync when the server is back.
          </div>
        )}
        <StageView show={show} live={live} width={size.w} height={size.h} selectedId={selectedId} selectedItemId={selectedItemId}
          editable={!display} onSelect={selectCamera} onSelectItem={selectItem} onCameraChange={patchCamera}
          onItemMove={moveItem} onItemResize={resizeItem} onPointMove={movePoint} />
      </div>

      {!display && (
        <aside className="side">
          <div className="title-row">
            <h1>CameraShot</h1>
            <button className="gear" title="Setup: ATEM and camera addresses" aria-label="Setup" onClick={() => setSetupOpen(true)}>⚙</button>
          </div>
          <input className="wide" value={show.name} onChange={(e) => update((s) => ({ ...s, name: e.target.value }))} />
          <p className="hint">
            Saved in this browser ✓ · {STATIC_MODE ? 'standalone planner (no server). Use Export to keep a copy.' : connected ? (synced ? 'synced to server ✓' : 'syncing to server…') : 'server offline, will sync later'}
          </p>
          <div className="row">
            <button onClick={exportShow}>Export</button>
            <button onClick={() => fileRef.current?.click()}>Import</button>
            <button onClick={() => setDisplay(true)}>Display mode</button>
          </div>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) importShow(f); e.target.value = '' }} />

          <h2>Stage (metres)</h2>
          <div className="row">
            <label>W <input type="number" min={2} step={0.5} value={show.stage.width} onChange={(e) => update((s) => ({ ...s, stage: { ...s.stage, width: +e.target.value || 2 } }))} /></label>
            <label>D <input type="number" min={2} step={0.5} value={show.stage.depth} onChange={(e) => update((s) => ({ ...s, stage: { ...s.stage, depth: +e.target.value || 2 } }))} /></label>
          </div>

          <h2>Cameras <button onClick={addCamera}>+ Add</button></h2>
          <ul className="cams">
            {show.cameras.map((c) => (
              <li key={c.id} className={c.id === selectedId ? 'sel' : ''} onClick={() => selectCamera(c.id)}>
                <span className="dot" style={{ background: c.color }} />Cam {c.number} · {c.name}
                <small>ATEM {c.atemInput}</small>
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
                  if (t) patchCamera(selected.id, { focus: { ...selected.focus, x: t.x, y: t.y } })
                }}>
                  <option value="">{targets.length ? 'choose a person or point…' : 'add a person or platform point first'}</option>
                  {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              </label>
              <label>Zoom (FOV) {selected.fov}° <input type="range" min={10} max={120} value={selected.fov} onChange={(e) => patchCamera(selected.id, { fov: +e.target.value })} /></label>
              <label>Focus radius {selected.focus.radius.toFixed(1)} m <input type="range" min={0.3} max={5} step={0.1} value={selected.focus.radius} onChange={(e) => patchCamera(selected.id, { focus: { ...selected.focus, radius: +e.target.value } })} /></label>
              <label>Colour <input type="color" value={selected.color} onChange={(e) => patchCamera(selected.id, { color: e.target.value })} /></label>

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
                    <label>Focus radius m
                      <input type="number" min={0.3} max={5} step={0.1} value={p.focus.radius}
                        onChange={(e) => patchPreset(selected, p.id, { focus: { ...p.focus, radius: Math.min(5, Math.max(0.3, +e.target.value || 0.3)) } })} />
                    </label>
                  </div>
                </div>
              ))}
              {selected.presets.length > 0 && <p className="hint">Companion: <code>POST /api/camera/{selected.number}/preset/&lt;n&gt;</code></p>}

              <button className="danger" onClick={() => { update((s) => ({ ...s, cameras: s.cameras.filter((c) => c.id !== selected.id) })); setSelectedId(null) }}>Delete camera</button>
            </div>
          )}

          <h2>Stage items <span><button onClick={addPlatform}>+ Platform</button> <button onClick={addPerson}>+ Person</button></span></h2>
          <ul className="cams">
            {show.items.map((it) => (
              <li key={it.id} className={it.id === selectedItemId ? 'sel' : ''} onClick={() => selectItem(it.id)}>
                <span>{it.kind === 'person' ? '🧍' : '▭'}</span>{it.label}
                {it.kind === 'platform' && <small>{it.points.length} pts</small>}
              </li>
            ))}
          </ul>

          {selectedItem && (
            <div className="editor">
              <label>Label <input value={selectedItem.label} onChange={(e) => patchItem(selectedItem.id, { label: e.target.value })} /></label>
              {selectedItem.kind === 'platform' && (
                <>
                  <div className="row">
                    <label>Width <input type="number" step={0.5} min={0.5} value={selectedItem.w} onChange={(e) => patchItem(selectedItem.id, { w: +e.target.value || 0.5 })} /></label>
                    <label>Depth <input type="number" step={0.5} min={0.5} value={selectedItem.h} onChange={(e) => patchItem(selectedItem.id, { h: +e.target.value || 0.5 })} /></label>
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
              <button className="danger" onClick={() => { update((s) => ({ ...s, items: s.items.filter((i) => i.id !== selectedItem.id) })); setSelectedItemId(null) }}>Delete {selectedItem.kind}</button>
            </div>
          )}

          <h2>ATEM simulator</h2>
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
          {STATIC_MODE
            ? <p className="hint">Live ATEM and Companion control needs the local CameraShot server (npm run dev).</p>
            : <p className="hint">Companion calls: <code>POST {location.origin}/api/atem/program/&lt;input&gt;?me={show.settings.me}</code></p>}
        </aside>
      )}

      {setupOpen && (
        <Setup show={show} atem={atem} serverAvailable={connected && !STATIC_MODE} onClose={() => setSetupOpen(false)} update={update} />
      )}
    </div>
  )
}
