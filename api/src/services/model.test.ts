import { describe, expect, it } from 'vitest'
import { fwiStep, INITIAL_STATE } from './fwi.js'
import { classifyModelRiskLevel, predictRisk } from './model.js'

describe('predictRisk', () => {
  it('keeps zero and low FWI in the low-risk class even if model score is high', () => {
    const thresholds = { moderate: 0.38, high: 0.46, extreme: 0.49 }
    expect(classifyModelRiskLevel(0.99, 0, thresholds)).toBe('low')
    expect(classifyModelRiskLevel(0.99, 2.99, thresholds)).toBe('low')
    expect(classifyModelRiskLevel(0.99, 3, thresholds)).toBe('extreme')
  })

  it('uses the same FWI value for the risk level and explanation', async () => {
    const weather = { temp: 35, humidity: 20, windSpeed: 30, precip: 0, month: 7 }
    const fwiResult = fwiStep(INITIAL_STATE, {
      temp: weather.temp,
      rh: weather.humidity,
      wind: weather.windSpeed,
      rain: weather.precip,
      month: weather.month,
    })
    const prediction = await predictRisk({
      ...weather,
      doy: 200,
      fwi_override: 0,
    }, fwiResult)

    expect(prediction.risk_level).toBe('low')
    expect(prediction.explanation).toContain('Нисък риск (FWI 0.0)')
  })

  it('keeps a cold wet day low and classifies a hot dry windy run as high risk', async () => {
    const coldWet = fwiStep(INITIAL_STATE, {
      temp: 8,
      rh: 75,
      wind: 10,
      rain: 1.5,
      month: 11,
    })
    const coldPrediction = await predictRisk({
      temp: 8,
      humidity: 75,
      windSpeed: 10,
      precip: 1.5,
      month: 11,
      doy: 310,
      fwi_override: coldWet.fwi,
    }, coldWet)
    expect(coldPrediction.risk_level).toBe('low')

    const hotDry = fwiStep(INITIAL_STATE, {
      temp: 34,
      rh: 20,
      wind: 30,
      rain: 0,
      month: 7,
    })
    const hotPrediction = await predictRisk({
      temp: 34,
      humidity: 20,
      windSpeed: 30,
      precip: 0,
      month: 7,
      doy: 200,
      fwi_override: hotDry.fwi,
    }, hotDry)
    expect(['high', 'extreme']).toContain(hotPrediction.risk_level)
  })
})
