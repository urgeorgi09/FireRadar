# FireRadar — Checklist за НОИТ

Последна актуализация: 06.11.2026

---

## Технически статус (06.11.2026)

### ✅ НАПЪЛНО ГОТОВО

| Компонент | Бележка |
|-----------|---------|
| Docker Compose (5 услуги: DB, API, Web, Caddy, Cloudflared) | `restart: unless-stopped` за всички |
| PostgreSQL + PostGIS, schema, индекси | 4 нови performance индекса добавени |
| JWT auth — 15 мин, auto-refresh, exp check при tab wake | Axios interceptor за 401 → logout |
| Helmet, rate-limit (login 10/15мин, alerts 5/час), Zod, bcrypt | |
| 1358 клетки само в България (ST_Intersects с граница) | Румъния/Сърбия отрязани |
| Истински FWI Van Wagner 1987 (FFMC/DMC/DC с памет) | 8 unit теста минават |
| IDW интерполация на метеото | Вместо nearest-neighbor |
| Hourly метео → обедни стойности за FWI | Изискване на стандарта |
| Batch predictRisk — Promise.all(100) вместо N×3 await | ~10x по-бързо |
| loadModel() преди listen() | Сървърът не приема заявки преди ONNX |
| Грешен old_role в audit log — поправен | Четем преди UPDATE |
| Двойна JWT верификация — премахната | admin.ts, drones.ts, alerts.ts, sensors.ts |
| LightGBM → ONNX → Node.js с fallback на FWI | |
| Карта: Живо / Повторение / Симулация | |
| Демо сценарий 2024-07-18 (278 засичания) | Бутон 🎬 |
| Loading/empty states навсякъде | OperationsPage, AlertsPage, AdminPage |
| returnDrone грешка видима в UI | |
| XSS fix — setDOMContent навсякъде | |
| Replay само при натискане "Покажи" | Не при всеки символ |
| Дронове с анимирано движение + FOR UPDATE SKIP LOCKED | |
| Кули, дронове, tower alerts, sensor API | |
| Admin панел: потребители, роли, audit log, статистика | |
| provision:users скрипт | `npm run provision:users` |
| CI — unit tests + web build + Docker builds + integration | |
| .gitignore — __pycache__, data/*.geojson, data/*.csv | |
| Graceful fallback при Open-Meteo грешка | |
| `.env` — почистен от дублиран ред | |

---

## ⚠️ ЗАПОЧНАТО — ОСТАВА ДА СЕ ДОВЪРШИ

### 1. Turnstile (5 мин работа)
**Какво е готово:** Кодът е напълно готов — `VITE_TURNSTILE_SITE_KEY` и `TURNSTILE_SECRET_KEY` са в `.env` и docker-compose.yml, frontend компонентът и backend валидацията са написани.

**Какво остава:** Вземи реални ключове от [dash.cloudflare.com](https://dash.cloudflare.com) → Turnstile → Add site → замени в `.env` → `docker compose up --build -d web api`.

---

### 2. Регистрация за НОИТ (до 20.11)
**Какво е готово:** Нищо.

**Какво остава:**
- Регистрирай се на сайта на домакина
- Имена на участник, ръководител, училище — точно
- Декларации: Приложение 4 + декларация за съгласие → до директора

---

### 3. Git cleanup (30 мин)
**Какво е готово:** `.gitignore` е правилен.

**Какво остава:**
```bash
git log -p | grep -i "SECRET\|PASSWORD\|TOKEN" | head -20
# Ако намериш нещо → ротирай тайните
git rm -r --cached ml/__pycache__ 2>/dev/null; true
git add -A
git commit -m "chore: cleanup gitignore and remove cached pycache"
git push
# CI трябва да стане зелен
git tag v1.0-noit
git push origin v1.0-noit
```

---

### 4. Тестови акаунти за комисията (10 мин)
**Какво е готово:** `npm run provision:users` скриптът е готов.

**Какво остава:** Пусни го с отделни имейли и дълги пароли. **НЕ ги слагай в README.**

---

## ❌ НЕ Е ПИПАНО

### Фаза Б: Устойчивост
| Задача | Колко труд |
|--------|-----------|
| UptimeRobot на `/api/health` | 5 мин |
| pg_dump бекъп + cron | 30 мин |
| SSH само с ключ | 15 мин (внимавай!) |
| Спящ режим изключен на сървъра | 2 мин |

### Фаза Г: Документи (НОСИ НАЙ-МНОГО ТОЧКИ — 20т)
| Задача |
|--------|
| Документация до 5 А4 (структурата е в стария CHECKLIST) |
| Диплянка (1 стр.) с QR код |
| Тестов протокол (1 стр.) |
| Сценарий за защита — подготви и репетирай |
| Запис на екрана (резерв) |

### Фаза Е: Допълнителни тестове
| Задача | Колко труд |
|--------|-----------|
| E2E тестове с Playwright | 2-3 ч |
| k6 load тест | 1 ч |
| Калибрация модел (графика) | 1 ч |

---

## Отговори на очаквани въпроси

**"Защо двойната JWT проверка я премахнахте?"**
`requireActiveUser` hook вика `jwtVerify` и проверява ролята за целия plugin. Допълнителното `jwtVerify()` в handler-а е мъртъв код — изпълнява се веднъж излишно за всяка заявка.

**"Защо FWI с памет е важно?"**
Старата формула даваше FWI ~90 за 12°C/50% влажност/15км/ч. Истинският Van Wagner дава ~18. Разликата идва от DC кода — той "помни" сухотата от предишните месеци.

**"Precision 0.56 — не е ли слаб?"**
Изходът е **относителен риск**, не абсолютна вероятност. 56% precision означава: от всички случаи класифицирани като висок риск, 56% са имали реално засичане. За предупредителна система е разумно.

**"Кулите реални ли са?"**
Не — симулирани. Имаме готов `POST /sensors/tower-alert` с `X-API-Key` за реална интеграция.

**"httpOnly cookie защо го няма?"**
Съзнателен избор за демо — 15-мин access токен, CSP headers от Helmet, ролева проверка на сървъра, rate-limit. Следваща стъпка е httpOnly cookie за refresh.
