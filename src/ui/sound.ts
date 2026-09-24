/**
 * Sound, in the manner of the PC speaker the DOS game had: square waves, single
 * tones and sweeps, a few milliseconds each. The original's beeps were made by its
 * own code, not kept as data, so these are made here for the same moments — a step,
 * a blow landing or missing, a shot, a spell, a fall — and can be switched off.
 */

let context: AudioContext | undefined
let enabled = true

function ctx(): AudioContext | undefined {
  if (!enabled) return undefined
  try {
    context ??= new AudioContext()
    if (context.state === 'suspended') void context.resume()
    return context
  } catch {
    return undefined
  }
}

/** A square wave gliding from one pitch to another, so many milliseconds, at a modest volume. */
function tone(from: number, to: number, ms: number, volume = 0.06, type: OscillatorType = 'square', at = 0): void {
  const c = ctx()
  if (!c) return
  const start = c.currentTime + at / 1000
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(from, start)
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, start + ms / 1000)
  gain.gain.setValueAtTime(volume, start)
  gain.gain.setValueAtTime(volume, start + ms / 1000 - 0.005)
  gain.gain.linearRampToValueAtTime(0.0001, start + ms / 1000)
  osc.connect(gain).connect(c.destination)
  osc.start(start)
  osc.stop(start + ms / 1000 + 0.01)
}

export type SoundKind = 'step' | 'blocked' | 'hit' | 'miss' | 'shot' | 'spell' | 'bolt' | 'burst' | 'fall' | 'menu' | 'coins' | 'rest'

export function play(kind: SoundKind): void {
  switch (kind) {
    case 'step': tone(110, 90, 22, 0.035); break
    case 'blocked': tone(70, 60, 120, 0.05); break
    case 'hit': tone(900, 140, 110, 0.07); break
    case 'miss': tone(420, 380, 45, 0.04); break
    case 'shot': tone(300, 1400, 130, 0.045); break
    case 'spell': tone(520, 1560, 90, 0.05); tone(1560, 520, 90, 0.05, 'square', 90); tone(520, 2080, 120, 0.05, 'square', 180); break
    case 'bolt': tone(2400, 300, 200, 0.06, 'sawtooth'); break
    case 'burst': tone(160, 40, 320, 0.08, 'sawtooth'); break
    case 'fall': tone(700, 60, 420, 0.06); break
    case 'menu': tone(1200, 1200, 15, 0.025); break
    case 'coins': tone(1800, 1800, 30, 0.04); tone(2400, 2400, 30, 0.04, 'square', 45); break
    case 'rest': tone(330, 330, 120, 0.04); tone(440, 440, 120, 0.04, 'square', 140); tone(550, 550, 200, 0.04, 'square', 280); break
  }
}

export function soundOn(): boolean { return enabled }
export function setSound(on: boolean): void {
  enabled = on
  try { localStorage.setItem('goldbox-web:sound', on ? '1' : '0') } catch { /* no storage: fine */ }
  if (on) play('menu')
}
try { enabled = localStorage.getItem('goldbox-web:sound') !== '0' } catch { enabled = true }
