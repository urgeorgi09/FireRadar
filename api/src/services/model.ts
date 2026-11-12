/**
 * Зарежда ONNX модела и прави предсказвания.
 * Ако моделът не е наличен → пада back на истинския FWI.
 */
import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  fwiStep, fwiToRiskLevel, fwiToExplanation,
  INITIAL_STATE,
  type Weather, type FwiState, type FwiResult
} from './fwi.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MODEL_ROOT = existsSync('/app/ml/fire_risk.onnx')
  ? '/app/ml'
  : join(__dirname, '../../../ml')
const MODEL_PATH = join(MODEL_ROOT, 'fire_risk.onnx')
const META_PATH  = join(MODEL_ROOT, 'model_meta.json')

let session: any    = null
let features: string[] = []
let riskThresholds: { moderate: number; high: number; extreme: number } | null = null

type RiskLevel = 'low' | 'moderate' | 'high' | 'extreme'

export function classifyModelRiskLevel(
  score: number,
  fwi: number,
  thresholds: { moderate: number; high: number; extreme: number }
): RiskLevel {
  if (fwi < 3) return 'low'
  if (score >= thresholds.extreme) return 'extreme'
  if (score >= thresholds.high) return 'high'
  if (score >= thresholds.moderate) return 'moderate'
  return 'low'
}

function modelRiskLevel(score: number, fwi: number): RiskLevel | null {
  if (!riskThresholds) return null
  return classifyModelRiskLevel(score, fwi, riskThresholds)
}

function relativeRiskExplanation(explanation: string, level: RiskLevel): string {
  const labels: Record<RiskLevel, string> = {
    low: 'Нисък', moderate: 'Умерен', high: 'Висок', extreme: 'Екстремен',
  }
  return explanation.replace(
    /^(Нисък|Умерен|Висок|Екстремен) риск/,
    `${labels[level]} относителен риск`,
  )
}

export async function loadModel() {
  if (!existsSync(MODEL_PATH)) {
    console.log('ONNX модел не е намерен — ще се използва истинският FWI (Van Wagner 1987)')
    return
  }
  try {
    const meta: unknown = JSON.parse(readFileSync(META_PATH, 'utf-8'))
    if (!meta || typeof meta !== 'object') throw new Error('Невалиден model_meta.json')
    const config = meta as {
      features?: unknown
      risk_semantics?: unknown
      risk_thresholds?: { moderate?: unknown; high?: unknown; extreme?: unknown }
    }
    if (config.risk_semantics !== 'relative')
      throw new Error('Моделът не е маркиран като модел за относителен риск')
    if (!Array.isArray(config.features) || !config.features.every(feature => typeof feature === 'string'))
      throw new Error('Липсва валиден списък с признаци в model_meta.json')
    const thresholds = config.risk_thresholds
    if (!thresholds || !['moderate', 'high', 'extreme'].every(key =>
      typeof thresholds[key as keyof typeof thresholds] === 'number' &&
      Number.isFinite(thresholds[key as keyof typeof thresholds]) &&
      (thresholds[key as keyof typeof thresholds] as number) >= 0 &&
      (thresholds[key as keyof typeof thresholds] as number) <= 1
    )) throw new Error('Липсват валидни прагове за относителен риск в model_meta.json')
    const moderate = thresholds.moderate as number
    const high = thresholds.high as number
    const extreme = thresholds.extreme as number
    if (moderate > high || high > extreme) throw new Error('Невалиден ред на праговете за относителен риск')

    const ort = await import('onnxruntime-node')
    session = await ort.InferenceSession.create(MODEL_PATH)
    features = config.features
    riskThresholds = { moderate, high, extreme }
    console.log(`[OK] ONNX модел зареден (${features.length} признака)`)
  } catch (err) {
    console.warn('Грешка при зареждане на ONNX модел:', err)
  }
}

export interface PredictInput {
  // Метео
  temp:      number
  humidity:  number   // rh в Weather интерфейса
  windSpeed: number   // wind в Weather интерфейса
  precip:    number   // rain в Weather интерфейса
  month:     number
  doy:       number
  veg_type?: number
  // FWI lag
  fwi_lag1?: number
  fwi_lag2?: number
  fwi_lag3?: number
  temp_lag1?: number
  temp_lag2?: number
  temp_lag3?: number
  precip_lag1?: number
  precip_lag2?: number
  precip_lag3?: number
  // Нови: FWI компоненти с памет
  fwi_override?: number  // реалния FWI от серията (ако е изчислен)
  ffmc?: number
  dmc?:  number
  dc?:   number
  isi?:  number
  bui?:  number
}

export async function predictRisk(
  input: PredictInput,
  fwiRes?: FwiResult   // ако вече е изчислен от updateForecasts
): Promise<{
  risk_score:  number
  risk_level:  string
  explanation: string
  fwi:         number
  source:      'model' | 'fwi'
}> {
  // Конвертираме входа към Weather интерфейса
  const w: Weather = {
    temp:  input.temp,
    rh:    input.humidity,
    wind:  input.windSpeed,
    rain:  input.precip,
    month: input.month,
  }

  // Изчисляваме FWI ако не е подаден
  const result: FwiResult = fwiRes ?? fwiStep(INITIAL_STATE, w)
  const fwi = input.fwi_override ?? result.fwi
  const fwiResult = { ...result, fwi }

  if (!session) {
    return {
      risk_score: Math.min(fwi / 30, 1),
      risk_level:  fwiToRiskLevel(fwi),
      explanation: fwiToExplanation(w, fwiResult),
      fwi,
      source: 'fwi'
    }
  }

  try {
    const ort = await import('onnxruntime-node')
    const featureMap: Record<string, number> = {
      temp:       input.temp,
      humidity:   input.humidity,
      wind_speed: input.windSpeed,
      precip:     input.precip,
      fwi,
      // Нови FWI компоненти с памет — много по-информативни
      ffmc:  input.ffmc ?? result.ffmc,
      dmc:   input.dmc  ?? result.dmc,
      dc:    input.dc   ?? result.dc,
      isi:   input.isi  ?? result.isi,
      bui:   input.bui  ?? result.bui,
      month:     input.month,
      doy:       input.doy,
      veg_type:  input.veg_type ?? 4,
      fwi_lag1:  input.fwi_lag1  ?? fwi,
      fwi_lag2:  input.fwi_lag2  ?? fwi,
      fwi_lag3:  input.fwi_lag3  ?? fwi,
      temp_lag1:  input.temp_lag1 ?? input.temp,
      temp_lag2:  input.temp_lag2 ?? input.temp,
      temp_lag3:  input.temp_lag3 ?? input.temp,
      precip_lag1: input.precip_lag1 ?? input.precip,
      precip_lag2: input.precip_lag2 ?? input.precip,
      precip_lag3: input.precip_lag3 ?? input.precip,
    }

    const values = new Float32Array(features.map(f => featureMap[f] ?? 0))
    const tensor = new ort.Tensor('float32', values, [1, features.length])
    const res = await session.run({ float_input: tensor })
    const probabilities = res.probabilities
    if (!probabilities?.data || probabilities.data.length < 2)
      throw new Error('ONNX моделът не върна двукласови вероятности')
    const prob = Number(probabilities.data[1])
    if (!Number.isFinite(prob) || prob < 0 || prob > 1)
      throw new Error('ONNX моделът върна невалиден относителен риск')

    const riskLevel = modelRiskLevel(prob, fwi)
    if (!riskLevel) {
      return {
        risk_score: Math.min(fwi / 30, 1),
        risk_level: fwiToRiskLevel(fwi),
        explanation: fwiToExplanation(w, fwiResult),
        fwi,
        source: 'fwi'
      }
    }
    return {
      risk_score: prob,
      risk_level: riskLevel,
      explanation: relativeRiskExplanation(fwiToExplanation(w, fwiResult), riskLevel),
      fwi,
      source: 'model'
    }
  } catch (err) {
    console.warn('Грешка при предсказване с ONNX модел — използвам FWI:', err)
    return {
      risk_score: Math.min(fwi / 30, 1),
      risk_level:  fwiToRiskLevel(fwi),
      explanation: fwiToExplanation(w, fwiResult),
      fwi,
      source: 'fwi'
    }
  }
}
