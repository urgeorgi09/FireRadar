# FireRadar

Система за ранно предупреждение за горски пожари в България.

## Стартиране

Създай `.env` в основната директория и задай `JWT_SECRET`, `POSTGRES_PASSWORD` и локалния CORS allowlist, след което:

```env
JWT_SECRET=<дълга-случайна-тайна>
POSTGRES_PASSWORD=<силна-уникална-парола-за-базата>
ALLOWED_ORIGINS=http://localhost:5173,http://admin.localhost:5173
```

```bash
docker compose up
```

- Публична карта и сигнали: http://localhost:5173
- Защитен панел за екипа: http://admin.localhost:5173
- API: http://localhost:3001
- Документация: http://localhost:3001/docs

Гражданите използват публичната карта и подават сигнали без акаунт. Входът за екипа е на отделния поддомейн `admin.*`; диспечерите имат оперативен достъп, а само администраторите виждат администраторските функции.

Production адреси:
- Публична карта: https://fireradar-bg.org
- Панел за диспечери и администратори: https://admin.fireradar-bg.org
- По желание: https://www.fireradar-bg.org

За production настрой DNS записи `A` за `fireradar-bg.org`, `www.fireradar-bg.org` и `admin.fireradar-bg.org` към публичния IP на Docker сървъра. Разреши входящи TCP портове 80 и 443 (и UDP 443 за HTTP/3), попълни `.env` със силни `JWT_SECRET` и `POSTGRES_PASSWORD` и реални Turnstile ключове. Преди да отвориш достъп, изпълни секцията за създаване на екипни акаунти:

```env
JWT_SECRET=<дълга-случайна-тайна>
POSTGRES_PASSWORD=<силна-уникална-парола-за-базата>
ALLOWED_ORIGINS=https://fireradar-bg.org,https://www.fireradar-bg.org,https://admin.fireradar-bg.org
VITE_TURNSTILE_SITE_KEY=<Turnstile-site-key>
TURNSTILE_SECRET_KEY=<Turnstile-secret-key>
FIRMS_MAP_KEY=<NASA-FIRMS-map-key>
```

Не пренасяй локалните `ALLOWED_ORIGINS` стойности на production сървъра; там разреши само домейните на FireRadar.
`FIRMS_MAP_KEY` се използва само от API сървъра за почасово зареждане на VIIRS засичания от последните два дни от Suomi-NPP, NOAA-20 и NOAA-21. След добавяне или промяна на ключа пресъздай API контейнера, за да го получи. Без него историческите данни и API остават работещи, но живите спътникови точки няма да се обновяват. В празен период или когато няма засичания с номинална/висока увереност, живият слой остава празен.

Добави `fireradar-bg.org`, `www.fireradar-bg.org` и `admin.fireradar-bg.org` към разрешените hostnames на Turnstile. След като DNS вече сочи към сървъра, стартирай production proxy с `docker compose --profile production up --build -d`. Caddy издава и подновява HTTPS сертификатите автоматично. Портовете на web и API контейнерите са достъпни само локално; публичният трафик влиза през Caddy. Не стартирай production с примерните JWT ключ или пароли.

Ако PostgreSQL volume вече е създаден, промяната на `POSTGRES_PASSWORD` в `.env` сама по себе си не променя паролата в базата. Преди да смениш API връзката, изпълни веднъж `ALTER ROLE fireradar WITH PASSWORD 'НОВА_ПАРОЛА';` през `psql` с текущия администраторски достъп. Използвай URL-безопасна парола или URL-encode-вай паролата в `DATABASE_URL`.

За локално или production подаване на сигнали настрой Turnstile в `.env` в основната директория:

```env
VITE_TURNSTILE_SITE_KEY=...
TURNSTILE_SECRET_KEY=...
```

Site key се включва при build на web контейнера. След промяна изпълни `docker compose up --build web api`. Без двата ключа изпращането на сигнали е изключено, а проверката от API отказва заявките.

Защитените API операции са ограничени от самия API, не само от скрития интерфейс. Reverse proxy адресът за rate limiting е фиксиран към Caddy IP в Docker мрежата.

## Създаване на екипни акаунти

Seed-ът не създава потребители или известни пароли. След като базата е готова, задайте отделни адреси и силни пароли (минимум 14 знака) в средата на shell-а, след което изпълнете provision скрипта през API контейнера:

```powershell
$env:ADMIN_EMAIL = "admin@example.org"
$env:ADMIN_PASSWORD = Read-Host "Admin password"
$env:DISPATCHER_EMAIL = "dispatcher@example.org"
$env:DISPATCHER_PASSWORD = Read-Host "Dispatcher password"
docker compose exec -e ADMIN_EMAIL -e ADMIN_PASSWORD -e DISPATCHER_EMAIL -e DISPATCHER_PASSWORD api npm run provision:users
```

Скриптът създава или актуализира двата екипни акаунта и премахва стария `citizen@fireradar.bg` seed акаунт, като запазва свързаните сигнали. Не съхранявайте паролите в Git или в shell history.

API стартира идемпотентните миграции преди да приема заявки. Те мигрират съществуващите sensor API keys към SHA-256 хешове и изтриват старите ключове в открит вид. Нов ключ се връща само при създаването му.

Предишният Compose API Dockerfile е копирал `api/` без Docker ignore файл. Ако стар image е бил построен или качен, `api/.env` може да е попаднал в него; смени всички тайни от този файл и премахни стария image от registry-то. Текущият root `.dockerignore` изключва вложените `.env` файлове от новите API builds. Git история не може да бъде сканирана от тази работна папка, защото тя няма `.git` директория.

## Разработка

```bash
# API
cd api && npm run dev

# Web
cd web && npm run dev
```

## Технологии

- **API**: Fastify + TypeScript + PostgreSQL/PostGIS
- **Web**: React + Vite + MapLibre GL
- **ML**: Python + LightGBM + ONNX
- **Инфраструктура**: Docker Compose
