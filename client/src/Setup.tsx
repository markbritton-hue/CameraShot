import { useEffect, useState } from 'react'
import { IPV4 } from '../../shared/types'
import type { AtemStatus, Camera, Show } from '../../shared/types'
import PtzControls from './PtzControls'

/** "Open this on an iPad": the addresses of this PC that other devices on the network can use. */
function OtherDevices({ serverAvailable }: { serverAvailable: boolean }) {
  const [net, setNet] = useState<{ port: number; addresses: { address: string; kind: 'lan' | 'tailscale' }[] } | null>(null)
  useEffect(() => {
    if (!serverAvailable) return
    fetch('/api/network').then((r) => r.json()).then(setNet).catch(() => setNet(null))
  }, [serverAvailable])

  return (
    <section>
      <h3>iPad, phone and other devices</h3>
      {!serverAvailable && <p className="hint">Start the CameraShot server on your PC (Start CameraShot.bat) to use it from other devices.</p>}
      {serverAvailable && net && (
        <>
          <p className="hint">On a device on the same network as this PC, open Safari or Chrome and go to:</p>
          {net.addresses.length === 0 && <p className="hint bad">No network address found. Is this PC connected to the network?</p>}
          {net.addresses.map((a) => (
            <code className="block" key={a.address}>
              http://{a.address}:{net.port} <span className="addr-kind">{a.kind === 'tailscale' ? '(Tailscale, works from anywhere you have Tailscale)' : '(this network)'}</span>
            </code>
          ))}
          <p className="hint">
            On an iPad: open that address in Safari, tap Share, then <b>Add to Home Screen</b>. CameraShot then opens full screen like an app.
            Everything you do there happens through this PC, which has to stay on and running CameraShot.
          </p>
          <p className="hint warn">
            Anyone on the same network who opens that address can control the cameras and ATEM, and watch the live video. There is no passcode.
          </p>
        </>
      )}
    </section>
  )
}

interface Props {
  show: Show
  atem: AtemStatus
  /** the grid cannot be resized while the ATEM simulator is on */
  gridLocked: boolean
  /** false on GitHub Pages / when the Node server is unreachable: connections can't be made */
  serverAvailable: boolean
  onClose: () => void
  update: (fn: (s: Show) => Show) => void
}

type PingResult = { ok: boolean; ms?: number; error?: string } | 'checking'

async function ping(host: string): Promise<PingResult> {
  try {
    const r = await fetch(`/api/ping?host=${encodeURIComponent(host)}`)
    return await r.json()
  } catch {
    return { ok: false, error: 'server not reachable' }
  }
}

function PingBadge({ result }: { result?: PingResult }) {
  if (!result) return null
  if (result === 'checking') return <span className="ping">checking…</span>
  if (result.ok) return <span className="ping ok">✓ {result.ms !== undefined ? `${result.ms} ms` : 'reply'}</span>
  return <span className="ping bad">✗ {result.error ?? 'no reply'}</span>
}

function atemSummary(a: AtemStatus): { text: string; cls: string } {
  switch (a.state) {
    case 'connected': return { text: `Connected${a.model ? `: ${a.model}` : ''}${a.mixEffects ? ` · ${a.mixEffects} M/E` : ''}`, cls: 'ok' }
    case 'connecting': return { text: 'Connecting… (check the IP and that the ATEM is on this network)', cls: 'warn' }
    case 'error': return { text: `Error: ${a.error ?? 'could not connect'}`, cls: 'bad' }
    default: return { text: 'Not connected', cls: '' }
  }
}

export default function Setup({ show, atem, gridLocked, serverAvailable, onClose, update }: Props) {
  // IP boxes are drafts: they are applied on Connect / when you leave the box, not on every keystroke
  const [atemDraft, setAtemDraft] = useState(show.settings.atemIp)
  const [pings, setPings] = useState<Record<string, PingResult>>({})
  const [controlsFor, setControlsFor] = useState<string | null>(null) // camera whose image controls are open

  const draftValid = IPV4.test(atemDraft.trim())
  const summary = atemSummary(atem)
  const meCount = Math.max(2, atem.mixEffects ?? 2)

  const setSettings = (patch: Partial<Show['settings']>) => update((s) => ({ ...s, settings: { ...s.settings, ...patch } }))
  const patchCamera = (id: string, patch: Partial<Camera>) =>
    update((s) => ({ ...s, cameras: s.cameras.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))

  const runPing = async (key: string, host: string) => {
    setPings((p) => ({ ...p, [key]: 'checking' }))
    const result = await ping(host)
    setPings((p) => ({ ...p, [key]: result }))
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Setup">
        <div className="modal-head">
          <h2>⚙ Setup</h2>
          <button onClick={onClose}>Close</button>
        </div>

        {!serverAvailable && (
          <p className="notice">
            The CameraShot server isn't connected, so connections can't be made from here. You can still fill in the
            addresses; they're saved with the show and used once the server is running (<code>npm run dev</code>).
          </p>
        )}

        <section>
          <h3>Grid size (feet)</h3>
          <fieldset className="lockable" disabled={gridLocked}>
            <div className="row">
              <label>Width <input type="number" min={4} step={1} value={show.stage.width} onChange={(e) => update((s) => ({ ...s, stage: { ...s.stage, width: +e.target.value || 4 } }))} /></label>
              <label>Depth <input type="number" min={4} step={1} value={show.stage.depth} onChange={(e) => update((s) => ({ ...s, stage: { ...s.stage, depth: +e.target.value || 4 } }))} /></label>
              <label>Grid square <input type="number" min={0.5} step={0.5} value={show.stage.grid ?? 2} title="Size of one grid square, in feet"
                onChange={(e) => update((s) => ({ ...s, stage: { ...s.stage, grid: Math.max(0.5, +e.target.value || 2) } }))} /></label>
            </div>
          </fieldset>
          <p className="hint">Each square is {show.stage.grid ?? 2} ft. The brighter lines (every {5 * (show.stage.grid ?? 2)} ft) are numbered from the top-left corner. Enter the real size of your stage.{gridLocked ? ' The grid is locked while the ATEM simulator is on; switch it off to change the size.' : ''}</p>
        </section>

        <section>
          <h3>ATEM switcher</h3>
          <p className="hint">CameraShot reads program and preview straight from the ATEM, so Companion isn't needed for the highlighting.</p>
          <div className="row">
            <label>ATEM IP address
              <input value={atemDraft} placeholder="192.168.1.240" inputMode="decimal"
                onChange={(e) => setAtemDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && draftValid && setSettings({ atemIp: atemDraft.trim() })} />
            </label>
            <label>M/E to follow
              <select value={show.settings.me} onChange={(e) => setSettings({ me: +e.target.value })}>
                {Array.from({ length: meCount }, (_, i) => <option key={i} value={i + 1}>ME{i + 1}</option>)}
              </select>
            </label>
          </div>
          <div className="row actions">
            <button disabled={!draftValid} onClick={() => setSettings({ atemIp: atemDraft.trim() })}>
              {show.settings.atemIp === atemDraft.trim() && show.settings.atemIp ? 'Reconnect' : 'Connect'}
            </button>
            <button disabled={!show.settings.atemIp} onClick={() => { setAtemDraft(''); setSettings({ atemIp: '' }) }}>Disconnect</button>
            <button disabled={!draftValid || !serverAvailable} onClick={() => runPing('atem', atemDraft.trim())}>Ping</button>
            <PingBadge result={pings.atem} />
          </div>
          {atemDraft.trim() !== '' && !draftValid && <p className="hint bad">That doesn't look like an IP address (e.g. 192.168.1.240).</p>}
          <p className={`status ${summary.cls}`}>● {summary.text}</p>
        </section>

        <section>
          <h3>Cameras</h3>
          <p className="hint">
            Match each camera to the ATEM input it's plugged into, and enter its network address. The address is used for
            the reachability check and for control. Tick <b>PTZ</b> on pan/tilt/zoom cameras to unlock their
            Controls here and the pan/tilt buttons when you double-click the camera on the stage.
          </p>
          <table className="cam-table">
            <thead><tr><th>Camera</th><th>ATEM input</th><th>IP address</th><th title="Tick for a pan/tilt/zoom camera you want to control from CameraShot">PTZ</th><th /></tr></thead>
            <tbody>
              {show.cameras.flatMap((c) => {
                const ip = c.ip ?? ''
                const valid = IPV4.test(ip.trim())
                const open = controlsFor === c.id && !!c.ptz
                return [
                  <tr key={c.id}>
                    <td><span className="dot" style={{ background: c.color }} /> {c.number} · {c.name}</td>
                    <td>
                      <select value={c.atemInput} onChange={(e) => patchCamera(c.id, { atemInput: +e.target.value })}>
                        {Array.from({ length: 8 }, (_, i) => <option key={i} value={i + 1}>Input {i + 1}</option>)}
                      </select>
                    </td>
                    <td>
                      <input value={ip} placeholder="192.168.1.50" inputMode="decimal"
                        className={ip && !valid ? 'invalid' : ''}
                        onChange={(e) => patchCamera(c.id, { ip: e.target.value.trim() })} />
                    </td>
                    <td className="ptz-check">
                      <input type="checkbox" checked={!!c.ptz} aria-label={`Camera ${c.number} is a PTZ camera`}
                        onChange={(e) => { patchCamera(c.id, { ptz: e.target.checked }); if (!e.target.checked && controlsFor === c.id) setControlsFor(null) }} />
                    </td>
                    <td className="ping-cell">
                      <button disabled={!valid || !serverAvailable} onClick={() => runPing(c.id, ip.trim())}>Test</button>
                      {c.ptz && (
                        <button disabled={!valid || !serverAvailable} className={open ? 'active' : ''}
                          title="Live view, exposure, gain and white balance for this PTZ camera"
                          onClick={() => setControlsFor(open ? null : c.id)}>Controls</button>
                      )}
                      <PingBadge result={pings[c.id]} />
                    </td>
                  </tr>,
                  open && (
                    <tr key={`${c.id}-ptz`} className="ptz-row">
                      <td colSpan={5}>
                        <PtzControls host={ip.trim()} port={c.viscaPort} onPort={(p) => patchCamera(c.id, { viscaPort: p })}
                          camNumber={c.number} rtspPath={c.rtspPath} onRtspPath={(p) => patchCamera(c.id, { rtspPath: p })} />
                      </td>
                    </tr>
                  ),
                ]
              })}
            </tbody>
          </table>
        </section>

        <OtherDevices serverAvailable={serverAvailable} />

        <section>
          <h3>Companion (optional)</h3>
          <p className="hint">
            Companion buttons can still drive CameraShot, for example to recall a camera preset:
          </p>
          <code className="block">POST /api/camera/&lt;camera number&gt;/preset/&lt;preset number&gt;</code>
        </section>
      </div>
    </div>
  )
}
