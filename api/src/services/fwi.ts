/**
 * Канадска система за пожарна опасност (FWI), Van Wagner 1987.
 *
 * Разлика от опростената версия: има ПАМЕТ между дните.
 * FFMC, DMC, DC са кодове на влажност, натрупани ден след ден.
 * Дъждът ги нулира; студеното влажно време ги задържа ниско.
 * Входни данни: обедни стойности (12:00 местно) + 24-часови валежи.
 */

export interface Weather {
  temp:  number   // °C, обед
  rh:    number   // %, обед (relative humidity)
  wind:  number   // км/ч, обед
  rain:  number   // мм за 24 ч
  month: number   // 1-12
}

export interface FwiState  { ffmc: number; dmc: number; dc: number }
export interface FwiResult extends FwiState {
  isi: number; bui: number; fwi: number
}

// Начални стойности (стандартни за начало на сезон)
export const INITIAL_STATE: FwiState = { ffmc: 85, dmc: 6, dc: 15 }

// Фактори за дължина на деня (DMC) и сезонна корекция (DC) по месеци.
// За умерен северен пояс — добро приближение за България.
const DAY_LENGTH = [6.5, 7.5, 9.0, 12.8, 13.9, 13.9, 12.4, 10.9, 9.2, 8.0, 7.0, 6.0]
const DC_FACTOR  = [-1.6,-1.6,-1.6,  0.9,  3.8,  5.8,  6.4,  5.0, 2.4, 0.4,-1.6,-1.6]

// ── FFMC ─────────────────────────────────────────────────────────────────────
function ffmcNext(f0: number, w: Weather): number {
  const { temp: T, rh: H, wind: W, rain: r } = w
  let mo = (147.2 * (101 - f0)) / (59.5 + f0)

  if (r > 0.5) {
    const rf = r - 0.5
    let mr = mo + 42.5 * rf * Math.exp(-100 / (251 - mo)) * (1 - Math.exp(-6.93 / rf))
    if (mo > 150) mr += 0.0015 * (mo - 150) ** 2 * Math.sqrt(rf)
    mo = Math.min(mr, 250)
  }

  const Ed = 0.942 * H ** 0.679 + 11 * Math.exp((H - 100) / 10)
           + 0.18 * (21.1 - T) * (1 - Math.exp(-0.115 * H))
  let m: number
  if (mo > Ed) {
    const ko = 0.424 * (1 - (H / 100) ** 1.7) + 0.0694 * Math.sqrt(W) * (1 - (H / 100) ** 8)
    const kd = ko * 0.581 * Math.exp(0.0365 * T)
    m = Ed + (mo - Ed) * 10 ** -kd
  } else {
    const Ew = 0.618 * H ** 0.753 + 10 * Math.exp((H - 100) / 10)
             + 0.18 * (21.1 - T) * (1 - Math.exp(-0.115 * H))
    if (mo < Ew) {
      const k1 = 0.424 * (1 - ((100 - H) / 100) ** 1.7)
               + 0.0694 * Math.sqrt(W) * (1 - ((100 - H) / 100) ** 8)
      const kw = k1 * 0.581 * Math.exp(0.0365 * T)
      m = Ew - (Ew - mo) * 10 ** -kw
    } else m = mo
  }
  return Math.min(101, Math.max(0, (59.5 * (250 - m)) / (147.2 + m)))
}

// ── DMC ──────────────────────────────────────────────────────────────────────
function dmcNext(d0: number, w: Weather): number {
  const T = Math.max(w.temp, -1.1)
  const rk = 1.894 * (T + 1.1) * (100 - w.rh) * DAY_LENGTH[w.month - 1] * 1e-4
  let d = d0
  if (w.rain > 1.5) {
    const re = 0.92 * w.rain - 1.27
    const mo = 20 + Math.exp(5.6348 - d0 / 43.43)
    const b = d0 <= 33 ? 100 / (0.5 + 0.3 * d0)
            : d0 <= 65 ? 14 - 1.3 * Math.log(d0)
            : 6.2 * Math.log(d0) - 17.2
    const mr = mo + (1000 * re) / (48.77 + b * re)
    d = Math.max(244.72 - 43.43 * Math.log(mr - 20), 0)
  }
  return d + rk
}

// ── DC ───────────────────────────────────────────────────────────────────────
function dcNext(d0: number, w: Weather): number {
  const T = Math.max(w.temp, -2.8)
  const pe = Math.max((0.36 * (T + 2.8) + DC_FACTOR[w.month - 1]) / 2, 0)
  let d = d0
  if (w.rain > 2.8) {
    const rd = 0.83 * w.rain - 1.27
    const qo = 800 * Math.exp(-d0 / 400)
    d = Math.max(400 * Math.log(800 / (qo + 3.937 * rd)), 0)
  }
  return d + pe
}

// ── ISI, BUI, FWI ─────────────────────────────────────────────────────────────
function calcISI(ffmc: number, wind: number): number {
  const fm = (147.2 * (101 - ffmc)) / (59.5 + ffmc)
  const fF = 91.9 * Math.exp(-0.1386 * fm) * (1 + fm ** 5.31 / 4.93e7)
  return 0.208 * Math.exp(0.05039 * wind) * fF
}

function calcBUI(dmc: number, dc: number): number {
  if (dmc === 0 && dc === 0) return 0
  if (dmc <= 0.4 * dc) return (0.8 * dmc * dc) / (dmc + 0.4 * dc)
  return Math.max(0, dmc - (1 - (0.8 * dc) / (dmc + 0.4 * dc)) * (0.92 + (0.0114 * dmc) ** 1.7))
}

function calcFWI(isiV: number, buiV: number): number {
  const fD = buiV <= 80 ? 0.626 * buiV ** 0.809 + 2
                        : 1000 / (25 + 108.64 * Math.exp(-0.023 * buiV))
  const B = 0.1 * isiV * fD
  return B > 1 ? Math.exp(2.72 * (0.434 * Math.log(B)) ** 0.647) : B
}

// ── Публичен API ──────────────────────────────────────────────────────────────

/** Един ден: взема вчерашното FWI-състояние и днешното метео. */
export function fwiStep(prev: FwiState, w: Weather): FwiResult {
  const ffmc = ffmcNext(prev.ffmc, w)
  const dmc  = dmcNext(prev.dmc, w)
  const dc   = dcNext(prev.dc, w)
  const isiV = calcISI(ffmc, w.wind)
  const buiV = calcBUI(dmc, dc)
  return { ffmc, dmc, dc, isi: isiV, bui: buiV, fwi: calcFWI(isiV, buiV) }
}

/** Серия от дни — връща масив с един резултат на ден. */
export function fwiSeries(days: Weather[], start: FwiState = INITIAL_STATE): FwiResult[] {
  const out: FwiResult[] = []
  let state = start
  for (const d of days) {
    const r = fwiStep(state, d)
    out.push(r)
    state = { ffmc: r.ffmc, dmc: r.dmc, dc: r.dc }
  }
  return out
}

// ── Нива на риск (по процентили от историята, не канадски прагове) ─────────────
// Калибрирани за България: прагове от реалното разпределение на FWI 2018-2024.
// Канадските нива (5/10/20/30) НЕ са подходящи директно — климатите се различават.
export function fwiToRiskLevel(fwi: number): 'low' | 'moderate' | 'high' | 'extreme' {
  if (!Number.isFinite(fwi)) throw new RangeError('FWI must be a finite number')
  if (fwi <= 0) return 'low'
  if (fwi < 3)  return 'low'
  if (fwi < 10) return 'moderate'
  if (fwi < 22) return 'high'
  return 'extreme'
}

/** Генерира обяснение на български. */
export function fwiToExplanation(w: Weather, result: FwiResult): string {
  const level = fwiToRiskLevel(result.fwi)
  const parts: string[] = []

  if (w.rh < 25)         parts.push(`ниска влажност ${w.rh}%`)
  else if (w.rh < 35)    parts.push('умерена влажност')
  if (w.temp > 35)       parts.push(`висока температура ${w.temp}°C`)
  else if (w.temp > 28)  parts.push(`топло ${w.temp}°C`)
  if (w.wind > 40)       parts.push(`силен вятър ${w.wind} км/ч`)
  else if (w.wind > 25)  parts.push(`вятър ${w.wind} км/ч`)
  if (w.rain === 0)      parts.push('без валежи')
  else if (w.rain > 5)   parts.push(`валежи ${w.rain} мм`)
  if (result.dc > 400)   parts.push('суха почва')

  const levelBg: Record<string, string> = {
    low: 'Нисък', moderate: 'Умерен', high: 'Висок', extreme: 'Екстремен'
  }
  const reason = parts.length ? `: ${parts.join(', ')}` : ''
  return `${levelBg[level]} риск (FWI ${result.fwi.toFixed(1)})${reason}`
}

// Псевдоним за обратна съвместимост с model.ts
export type WeatherInput = Weather & { windSpeed?: number }
export { calcFWI as calcFireDangerIndex }
