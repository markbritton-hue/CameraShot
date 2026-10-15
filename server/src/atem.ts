import { Atem } from 'atem-connection'
import type { AtemStatus } from '../../shared/types'

interface Options {
  onLive: (program: number | null, preview: number | null) => void
  onStatus: (status: AtemStatus) => void
}

/**
 * Keeps one direct connection to the ATEM and reports which input is on program / preview
 * for the chosen M/E. The ATEM allows several clients, so this runs alongside Companion.
 */
export function createAtemLink({ onLive, onStatus }: Options) {
  let atem: Atem | null = null
  let ip = ''
  let me = 1
  let status: AtemStatus = { state: 'off' }

  const setStatus = (s: AtemStatus) => {
    status = s
    onStatus(s)
  }

  function readLive() {
    const mix = atem?.state?.video.mixEffects[me - 1]
    // input 0 is the ATEM's black source: treat it as "nothing live"
    if (mix) onLive(mix.programInput || null, mix.previewInput || null)
  }

  async function stop() {
    const old = atem
    atem = null
    if (!old) return
    old.removeAllListeners()
    old.on('error', () => {}) // a late socket error after teardown must not crash the process
    try { await old.disconnect() } catch { /* already gone */ }
  }

  /** (Re)connect when the IP changes; just re-read when only the M/E changed. Empty IP disconnects. */
  async function configure(nextIp: string, nextMe: number) {
    const ipChanged = nextIp !== ip
    ip = nextIp
    me = nextMe
    if (!ipChanged && atem) return readLive()
    if (!ipChanged && !ip) return
    await stop()
    if (!ip) return setStatus({ state: 'off' })

    setStatus({ state: 'connecting' })
    const a = new Atem()
    atem = a
    a.on('error', (msg) => setStatus({ state: 'error', error: String(msg) }))
    a.on('connected', () => {
      const info = a.state?.info
      setStatus({ state: 'connected', model: info?.productIdentifier, mixEffects: info?.capabilities?.mixEffects })
      readLive()
    })
    a.on('disconnected', () => setStatus({ state: 'connecting' })) // the library keeps retrying by itself
    a.on('stateChanged', (_state, paths) => {
      if (paths.some((p) => p.startsWith('video.mixEffects'))) readLive()
    })
    a.connect(ip).catch((e: unknown) => setStatus({ state: 'error', error: e instanceof Error ? e.message : String(e) }))
  }

  return { configure, status: () => status, stop }
}
