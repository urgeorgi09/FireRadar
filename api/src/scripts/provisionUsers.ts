/**
 * Provision скрипт за екипни акаунти.
 * Употреба:
 *   docker compose exec -e ADMIN_EMAIL -e ADMIN_PASSWORD \
 *     -e DISPATCHER_EMAIL -e DISPATCHER_PASSWORD api npm run provision:users
 *
 * Скриптът:
 * - Създава или обновява admin акаунта
 * - Създава или обновява dispatcher акаунта
 * - Премахва legacy citizen@fireradar.bg ако съществува (пази сигналите)
 * - Извежда резюме без пароли
 */
import 'dotenv/config'
import bcrypt from 'bcrypt'
import sql from '../db/client.js'

async function provision() {
  const adminEmail      = process.env.ADMIN_EMAIL
  const adminPassword   = process.env.ADMIN_PASSWORD
  const dispEmail       = process.env.DISPATCHER_EMAIL
  const dispPassword    = process.env.DISPATCHER_PASSWORD

  if (!adminEmail || !adminPassword || !dispEmail || !dispPassword) {
    console.error('❌ Задай ADMIN_EMAIL, ADMIN_PASSWORD, DISPATCHER_EMAIL, DISPATCHER_PASSWORD')
    process.exit(1)
  }
  if (adminPassword.length < 14 || dispPassword.length < 14) {
    console.error('❌ Паролите трябва да са поне 14 знака')
    process.exit(1)
  }
  if (adminEmail === dispEmail) {
    console.error('❌ Admin и Dispatcher трябва да имат различни имейли')
    process.exit(1)
  }

  const adminHash = await bcrypt.hash(adminPassword, 12)
  const dispHash  = await bcrypt.hash(dispPassword, 12)

  // Upsert admin
  await sql`
    INSERT INTO users (email, password, role, active)
    VALUES (${adminEmail}, ${adminHash}, 'admin', true)
    ON CONFLICT (email) DO UPDATE SET
      password = EXCLUDED.password,
      role     = 'admin',
      active   = true
  `
  console.log(`✓ Admin: ${adminEmail}`)

  // Upsert dispatcher
  await sql`
    INSERT INTO users (email, password, role, active)
    VALUES (${dispEmail}, ${dispHash}, 'dispatcher', true)
    ON CONFLICT (email) DO UPDATE SET
      password = EXCLUDED.password,
      role     = 'dispatcher',
      active   = true
  `
  console.log(`✓ Dispatcher: ${dispEmail}`)

  // Премахваме legacy тестовите акаунти (ако съществуват)
  const legacy = ['citizen@fireradar.bg', 'dispatcher@fireradar.bg', 'admin@fireradar.bg']
  const legacyToRemove = legacy.filter(e => e !== adminEmail && e !== dispEmail)
  for (const email of legacyToRemove) {
    const result = await sql`DELETE FROM users WHERE email = ${email} RETURNING email`
    if (result.length > 0) console.log(`  Изтрит legacy акаунт: ${email}`)
  }

  console.log('\n✅ Екипните акаунти са готови. Не публикувай паролите.')
  await sql.end()
}

provision().catch(err => {
  console.error('Грешка:', err.message)
  process.exit(1)
})
