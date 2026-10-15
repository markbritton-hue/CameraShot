import { useState } from 'react'
import { IPV4 } from '../../shared/types'
import type { AtemStatus, Camera, Show } from '../../shared/types'
import PtzControls from './PtzControls'

interface Props {
  show: Show
  atem: AtemStatus
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

export default function Setup({ show, atem, serverAvailable, onClose, update }: Props) {
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
            the reachability check now, and is where PTZ control would connect later.
          </p>
          <table className="cam-table">
            <thead><tr><th>Camera</th><th>ATEM input</th><th>IP address</th><th /></tr></thead>
            <tbody>
              {show.cameras.flatMap((c) => {
                const ip = c.ip ?? ''
                const valid = IPV4.test(ip.trim())
                const open = controlsFor === c.id
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
                    <td className="ping-cell">
                      <button disabled={!valid || !serverAvailable} onClick={() => runPing(c.id, ip.trim())}>Test</button>
                      <button disabled={!valid || !serverAvailable} className={open ? 'active' : ''}
                        title="Exposure, gain and white balance for this PTZ camera"
                        onClick={() => setControlsFor(open ? null : c.id)}>Controls</button>
                      <PingBadge result={pings[c.id]} />
                    </td>
                  </tr>,
                  open && (
                    <tr key={`${c.id}-ptz`} className="ptz-row">
                      <td colSpan={4}>
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
