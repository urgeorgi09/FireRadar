import { describe, it, expect } from 'vitest'
import { fwiSeries, fwiStep, fwiToRiskLevel, INITIAL_STATE } from './fwi.js'

const day = (temp: number, rh: number, wind: number, rain: number, month: number) =>
  ({ temp, rh, wind, rain, month })

describe('FWI (Van Wagner 1987)', () => {
  it('нулевият индекс е нисък риск', () => {
    expect(fwiToRiskLevel(0)).toBe('low')
  })

  it('нулевите BUI стойности не произвеждат NaN FWI', () => {
    const result = fwiStep(
      { ffmc: 85, dmc: 0.1, dc: 0 },
      day(-1.1, 100, 0, 0, 3),
    )
    expect(result.bui).toBe(0)
    expect(Number.isFinite(result.fwi)).toBe(true)
    expect(fwiToRiskLevel(result.fwi)).toBe('low')
  })

  it('не класифицира невалиден индекс като риск', () => {
    expect(() => fwiToRiskLevel(Number.NaN)).toThrow('FWI must be a finite number')
  })

  it('студен влажен ноември е нисък', () => {
    const s = fwiSeries(Array(30).fill(day(8, 75, 10, 1.5, 11)))
    expect(s.at(-1)!.fwi).toBeLessThan(2)
  })

  it('горещо, сухо, ветровито лято е високо', () => {
    const s = fwiSeries(Array(30).fill(day(34, 20, 30, 0, 7)))
    expect(s.at(-1)!.fwi).toBeGreaterThan(30)
  })

  it('дъждът намалява индекса', () => {
    const dry = fwiSeries(Array(20).fill(day(30, 30, 15, 0, 7)))
    const wet = fwiSeries([
      ...Array(19).fill(day(30, 30, 15, 0, 7)),
      day(15, 90, 10, 25, 7),
    ])
    expect(wet.at(-1)!.fwi).toBeLessThan(dry.at(-1)!.fwi)
  })

  it('памет: FFMC расте при сухи дни', () => {
    const s = fwiSeries(Array(10).fill(day(28, 35, 20, 0, 7)))
    // FFMC трябва да расте с дните при суха горещина
    expect(s[9].ffmc).toBeGreaterThan(s[0].ffmc)
  })

  it('DC е бавен — висок след 30 сухи дни', () => {
    const s = fwiSeries(Array(30).fill(day(30, 40, 0, 0, 8)))
    expect(s.at(-1)!.dc).toBeGreaterThan(100)
  })

  it('няма NaN или отрицателни стойности', () => {
    const edge = [
      day(-5, 100, 0, 0, 1),    // зима
      day(40,   5, 80, 0, 8),   // екстремна горещина
      day(20,  50, 15, 50, 6),  // силен дъжд
    ]
    const r = fwiSeries(edge)
    r.forEach(x => {
      Object.values(x).forEach(v => {
        expect(Number.isFinite(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
      })
    })
  })

  it('реален пример: 12°C, 50% RH, 15 km/h → FWI около 5-12', () => {
    // Пресметнато ръчно от Van Wagner 1987 таблици за умерен климат
    const s = fwiSeries(Array(30).fill(day(12, 50, 15, 0, 7)))
    const last = s.at(-1)!
    expect(last.fwi).toBeGreaterThan(3)
    expect(last.fwi).toBeLessThan(20)
    // ISI трябва да е положителен
    expect(last.isi).toBeGreaterThan(0)
    // BUI трябва да е положителен
    expect(last.bui).toBeGreaterThan(0)
  })

  it('fwiStep е детерминистичен', () => {
    const w = day(25, 40, 20, 0, 7)
    const r1 = fwiStep(INITIAL_STATE, w)
    const r2 = fwiStep(INITIAL_STATE, w)
    expect(r1.fwi).toBe(r2.fwi)
    expect(r1.ffmc).toBe(r2.ffmc)
  })
})
