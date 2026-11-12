import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import 'dotenv/config'

import authRoutes    from './routes/auth.js'
import riskRoutes   from './routes/risk.js'
import alertRoutes  from './routes/alerts.js'
import towerRoutes  from './routes/towers.js'
import droneRoutes  from './routes/drones.js'
import adminRoutes  from './routes/admin.js'
import sensorRoutes from './routes/sensors.js'
import { generateCells }   from './jobs/generateCells.js'
import { importFires }     from './jobs/importFires.js'
import { updateForecasts } from './jobs/updateForecasts.js'
import { loadModel }       from './services/model.js'
import { runMigrations } from './db/migrate.js'
import { recoverDrones } from './jobs/recoverDrones.js'
import { importRecentFires } from './jobs/importRecentFires.js'

const trustedProxies = process.env.TRUST_PROXY?.split(',').map(value => value.trim()).filter(Boolean) ?? []
const app = Fastify({
  logger: {
    redact: {
      paths: ['req.headers.authorization', 'req.headers.x-api-key', 'req.body', 'res.headers["set-cookie"]'],
      censor: '[REDACTED]',
    },
  },
  trustProxy: trustedProxies.length ? trustedProxies : false,
})

await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
})

// Глобален rate limit — 200 req/min
await app.register(rateLimit, { max: 200, timeWindow: '1 minute' })

// CORS — разрешаваме само нашия фронт-енд
const productionOrigins = 'https://fireradar-bg.org,https://www.fireradar-bg.org,https://admin.fireradar-bg.org'
const developmentOrigins = `http://localhost:5173,http://admin.localhost:5173,${productionOrigins}`
const allowedOrigins = (process.env.ALLOWED_ORIGINS ??
  (process.env.NODE_ENV === 'production' ? productionOrigins : developmentOrigins))
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean)
if (process.env.ALLOWED_ORIGINS?.split(',').some(origin => origin.trim() === '*'))
  throw new Error('ALLOWED_ORIGINS must contain explicit origins; wildcard CORS is not allowed')
await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true)
    cb(new Error('Not allowed by CORS'), false)
  },
})

// Краткосрочен access token; активният статус се проверява при всяка екипна заявка.
await app.register(jwt, {
  secret: process.env.JWT_SECRET!,
  sign: { expiresIn: '15m' },
})

await app.register(swagger, {
  openapi: {
    info: { title: 'FireRadar API', version: '1.0.0',
            description: 'API за система за ранно предупреждение при горски пожари. Процентният резултат от модела е относителен риск, а не калибрирана вероятност за пожар.' },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }
    }
  }
})
await app.register(swaggerUi, {
  routePrefix: '/docs',
  transformStaticCSP: header => header.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
})

await app.register(authRoutes,   { prefix: '/auth' })
await app.register(riskRoutes,   { prefix: '/risk' })
await app.register(alertRoutes,  { prefix: '/alerts' })
await app.register(towerRoutes,  { prefix: '/towers' })
await app.register(droneRoutes,  { prefix: '/drones' })
await app.register(adminRoutes,  { prefix: '/admin' })
await app.register(sensorRoutes, { prefix: '/sensors' })

app.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }))

const port = Number(process.env.PORT ?? 3000)
await runMigrations()
await recoverDrones()
await app.listen({ port, host: '0.0.0.0' })

try {
  await loadModel()
  await importFires()
  await generateCells()
  await updateForecasts()
} catch (err) {
  app.log.error('Грешка при инициализация: ' + err)
}

let recentFirmsImportRunning = false
const runRecentFirmsImport = async () => {
  if (recentFirmsImportRunning) {
    app.log.warn('Пропускам FIRMS обновяването: предишната задача още работи.')
    return
  }
  recentFirmsImportRunning = true
  try {
    await importRecentFires()
  } catch (err) {
    app.log.error({ err }, 'Грешка при запис на FIRMS засичанията')
  } finally {
    recentFirmsImportRunning = false
  }
}
void runRecentFirmsImport()
setInterval(() => { void runRecentFirmsImport() }, 60 * 60 * 1000)

setInterval(async () => {
  try { await updateForecasts() }
  catch (err) { app.log.error('Грешка при обновяване: ' + err) }
}, 60 * 60 * 1000)
