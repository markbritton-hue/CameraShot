import dgram from 'node:dgram'
import type { PtzSetting, PtzStatus } from '../../shared/types'

/**
 * VISCA over IP, plain payloads over UDP (no Sony 8-byte header), the same way GearOps talks to
 * AVKANS / PTZOptics-style cameras. Each exchange uses its own short-lived socket, so replies can
 * never be mixed up between requests or cameras.
 *
 * Replies: 90 4z FF ack, 90 5z FF completion, 90 50 ... FF inquiry answer, 90 6z ee FF error.
 */
function exchange(host: string, port: number, bytes: number[], kind: 'command' | 'inquiry', timeoutMs = 1200): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4')
    let acked = false
    let finished = false
    const finish = (err: Error | null, reply?: number[]) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try { sock.close() } catch { /* already closed */ }
      err ? reject(err) : resolve(reply ?? [])
    }
    const timer = setTimeout(() => {
      // a command that was acknowledged but never reported completion still counts as accepted
      acked ? finish(null, [0x90, 0x41, 0xff]) : finish(new Error('camera did not respond (check its IP, port and that VISCA over IP is on)'))
    }, timeoutMs)
    sock.on('error', (e) => finish(e))
    sock.on('message', (m) => {
      const b = [...m]
      const type = (b[1] ?? 0) >> 4
      if (type === 6) {
        const code = b[2]
        const why = code === 0x41 ? 'not executable in the camera\'s current mode' : code === 0x02 ? 'syntax error' : `error 0x${(code ?? 0).toString(16)}`
        return finish(new Error(`camera rejected the command: ${why}`))
      }
      if (kind === 'inquiry' && type === 5) return finish(null, b)
      if (kind === 'command' && type === 4) acked = true
      if (kind === 'command' && type === 5) finish(null, b)
    })
    sock.send(Buffer.from(bytes), port, host, (err) => { if (err) finish(err) })
  })
}

const command = (host: string, port: number, bytes: number[]) => exchange(host, port, bytes, 'command')
const inquire = (host: string, port: number, bytes: number[]) => exchange(host, port, bytes, 'inquiry')

/** 8-bit value sent as two nibbles: 8x 01 04 <cmd> 00 00 0p 0q FF */
const direct = (cmd: number, value: number) => [0x81, 0x01, 0x04, cmd, 0x00, 0x00, (value >> 4) & 0x0f, value & 0x0f, 0xff]
const parseDirect = (r: number[]) => (((r[4] ?? 0) & 0x0f) << 4) | ((r[5] ?? 0) & 0x0f)

export async function readStatus(host: string, port: number): Promise<PtzStatus> {
  // sequential on purpose: gentle on cameras with small UDP stacks
  const exposureMode = (await inquire(host, port, [0x81, 0x09, 0x04, 0x39, 0xff]))[2] ?? 0
  const wbMode = (await inquire(host, port, [0x81, 0x09, 0x04, 0x35, 0xff]))[2] ?? 0
  const gain = parseDirect(await inquire(host, port, [0x81, 0x09, 0x04, 0x4c, 0xff]))
  const redGain = parseDirect(await inquire(host, port, [0x81, 0x09, 0x04, 0x43, 0xff]))
  const blueGain = parseDirect(await inquire(host, port, [0x81, 0x09, 0x04, 0x44, 0xff]))
  const iris = parseDirect(await inquire(host, port, [0x81, 0x09, 0x04, 0x4b, 0xff]))
  const shutter = parseDirect(await inquire(host, port, [0x81, 0x09, 0x04, 0x4a, 0xff]))
  // on/off inquiries answer 02 (on) or 03 (off)
  const blc = (await inquire(host, port, [0x81, 0x09, 0x04, 0x33, 0xff]))[2] === 0x02
  const expComp = (await inquire(host, port, [0x81, 0x09, 0x04, 0x3e, 0xff]))[2] === 0x02
  const expCompLevel = parseDirect(await inquire(host, port, [0x81, 0x09, 0x04, 0x4e, 0xff]))
  const saturation = parseDirect(await inquire(host, port, [0x81, 0x09, 0x04, 0x49, 0xff]))
  const hue = parseDirect(await inquire(host, port, [0x81, 0x09, 0x04, 0x4f, 0xff]))
  return { exposureMode, wbMode, gain, redGain, blueGain, iris, shutter, blc, expComp, expCompLevel, saturation, hue }
}

export const EXPOSURE_MODES = [0x00, 0x03, 0x0a, 0x0b, 0x0d] // full auto, manual, shutter pri, iris pri, bright
// auto, indoor, outdoor, one-push, ATW, manual, and 0x0B ("Static", the colour-temperature mode on AVKANS-style cameras)
export const WB_MODES = [0, 1, 2, 3, 4, 5, 0x0b]
const MAX_GAIN = 15

/** Validate and apply one setting. Throws a plain-English Error for bad values. */
export async function applySetting(host: string, port: number, setting: PtzSetting, value: number | undefined) {
  const int = Number.isInteger(value) ? (value as number) : NaN
  switch (setting) {
    case 'exposureMode':
      if (!EXPOSURE_MODES.includes(int)) throw new RangeError('exposureMode must be 0, 3, 10, 11 or 13')
      return command(host, port, [0x81, 0x01, 0x04, 0x39, int, 0xff])
    case 'gain':
      if (!(int >= 0 && int <= MAX_GAIN)) throw new RangeError(`gain must be 0-${MAX_GAIN}`)
      return command(host, port, direct(0x4c, int))
    case 'wbMode':
      if (!WB_MODES.includes(int)) throw new RangeError('wbMode must be 0-5 or 11')
      return command(host, port, [0x81, 0x01, 0x04, 0x35, int, 0xff])
    case 'redGain':
      if (!(int >= 0 && int <= 255)) throw new RangeError('redGain must be 0-255')
      return command(host, port, direct(0x43, int))
    case 'blueGain':
      if (!(int >= 0 && int <= 255)) throw new RangeError('blueGain must be 0-255')
      return command(host, port, direct(0x44, int))
    case 'blc':
    case 'expComp':
      if (int !== 0 && int !== 1) throw new RangeError(`${setting} must be 0 (off) or 1 (on)`)
      return command(host, port, [0x81, 0x01, 0x04, setting === 'blc' ? 0x33 : 0x3e, int ? 0x02 : 0x03, 0xff])
    case 'expCompLevel':
    case 'saturation':
    case 'hue':
      if (!(int >= 0 && int <= 14)) throw new RangeError(`${setting} must be 0-14`)
      return command(host, port, direct(setting === 'expCompLevel' ? 0x4e : setting === 'saturation' ? 0x49 : 0x4f, int))
    case 'onePush':
      // take a white reading from whatever the camera is looking at (WB mode must already be one-push)
      return command(host, port, [0x81, 0x01, 0x04, 0x10, 0x05, 0xff])
    default:
      throw new RangeError('unknown setting')
  }
}
