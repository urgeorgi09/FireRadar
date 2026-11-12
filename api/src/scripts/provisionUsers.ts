import 'dotenv/config'
import bcrypt from 'bcrypt'
import sql from '../db/client.js'

function requiredCredentials(role: 'ADMIN' | 'DISPATCHER') {
  const email = process.env[`${role}_EMAIL`]?.trim().toLowerCase()
  const password = process.env[`${role}_PASSWORD`]
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error(`${role}_EMAIL must be a valid email address`)
  if (!password || password.length < 14)
    throw new Error(`${role}_PASSWORD must be at least 14 characters`)
  return { email, password }
}

async function main() {
  const admin = requiredCredentials('ADMIN')
  const dispatcher = requiredCredentials('DISPATCHER')
  if (admin.email === dispatcher.email)
    throw new Error('ADMIN_EMAIL and DISPATCHER_EMAIL must be different')

  const [adminHash, dispatcherHash] = await Promise.all([
    bcrypt.hash(admin.password, 12),
    bcrypt.hash(dispatcher.password, 12),
  ])

  await sql.begin(async tx => {
    await tx`
      INSERT INTO users (email, password, role, active)
      VALUES (${admin.email}, ${adminHash}, 'admin', true)
      ON CONFLICT (email) DO UPDATE
      SET password = EXCLUDED.password, role = EXCLUDED.role, active = true
    `
    await tx`
      INSERT INTO users (email, password, role, active)
      VALUES (${dispatcher.email}, ${dispatcherHash}, 'dispatcher', true)
      ON CONFLICT (email) DO UPDATE
      SET password = EXCLUDED.password, role = EXCLUDED.role, active = true
    `
    await tx`
      UPDATE alerts
      SET user_id = NULL
      WHERE user_id = (SELECT id FROM users WHERE email = 'citizen@fireradar.bg')
    `
    await tx`DELETE FROM users WHERE email = 'citizen@fireradar.bg'`
  })

  console.log(`Provisioned admin account: ${admin.email}`)
  console.log(`Provisioned dispatcher account: ${dispatcher.email}`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Account provisioning failed')
  process.exitCode = 1
} finally {
  await sql.end()
}
