# FireRadar — технически справочник на проекта

Документът описва състоянието на проекта във файловата папка към 7 ноември 2026 г.: архитектурата, потока на данните, ролята на файловете, наличните функции, ограниченията и безопасния ред за следваща работа. Той е описание на кода и конфигурацията, а не потвърждение, че production сървърът или DNS вече са настроени.

## 1. Какво представлява приложението

FireRadar е уеб приложение за наблюдение и демонстрация на пожарен риск в България. То комбинира:

- географски слой на България и CORINE Land Cover;
- исторически засичания от NASA FIRMS/VIIRS;
- метеорологични данни от Open-Meteo;
- FWI изчисление с памет между дните и отделен LightGBM модел, експортиран в ONNX;
- карта за публичен посетител;
- отделен интерфейс за диспечер и администратор;
- симулационни данни за кули, сигнали и дронове;
- PostgreSQL/PostGIS база, Fastify API и Docker Compose конфигурация.

Това е система за демонстрация и подпомагане на наблюдението. Рискът от ML модела е **относителен и некалибриран**, не е потвърдена абсолютна вероятност за пожар. Кулите, техните сигнали и дроновете в началните данни са демо/симулационни.

## 2. Системна схема

```text
Посетител
  ├─ fireradar-bg.org ─────────┐
  └─ admin.fireradar-bg.org ───┤
                               v
                       Caddy reverse proxy
                       TLS / HTTPS, портове 80/443
                         ├─ /api/* -> Fastify API
                         ├─ /docs* -> Swagger
                         └─ останалите пътища -> Nginx / React SPA
                                                   |
                                                   v
                                            PostgreSQL + PostGIS

Fastify API
  ├─ FIRMS CSV -> fires
  ├─ геоданни -> cells
  ├─ Open-Meteo -> FWI + ONNX -> risk_forecasts
  └─ сигнали / кули / дронове / потребители / audit log

ML pipeline (ръчно стартиране)
  data/*.csv + data/*.geojson -> ml/train.py
                              -> ml/fire_risk.onnx
                              -> ml/model_meta.json
                              -> results.md
```

### Технологични граници

- **Web:** React, TypeScript, Vite, React Router, TanStack Query, MapLibre GL.
- **API:** Fastify, TypeScript, PostgreSQL клиента `postgres`, Zod за част от входните проверки, JWT за екипни сесии, bcrypt за пароли, ONNX Runtime за inference.
- **База:** PostgreSQL 16 с PostGIS 3.4.
- **ML/data:** Python, pandas, NumPy, LightGBM, scikit-learn, ONNX conversion, requests, Shapely.
- **Proxy:** Caddy в production профила; Nginx вътре в web контейнера за SPA и локално препращане към API.
- **Оркестрация:** Docker Compose.

## 3. Пътища, hostnames и deployment състояние

Планираните production адреси са:

- публична карта: `https://fireradar-bg.org`;
- екипен вход: `https://admin.fireradar-bg.org`;
- незадължителен alias: `https://www.fireradar-bg.org`.

Съответната конфигурация е подготвена във [Caddyfile](./Caddyfile) и [docker-compose.yml](./docker-compose.yml). Caddy е в Compose профил `production`; обикновеното `docker compose up` не стартира този профил. В конфигурацията са зададени Caddy маршрути, Docker мрежи, HTTPS портове и място за постоянните сертификати.

**Домейнът умишлено не е свързван и production услугите не са стартирани.** DNS записите, firewall-ът, HTTPS сертификатите и работата на услугата от интернет зависят от сървъра и DNS настройките, които трябва да се направят отделно.

Важно за локалното стартиране: текущият Compose файл изисква `JWT_SECRET` и `POSTGRES_PASSWORD` от основния `.env`. Локален root `.env` вече е създаден и се игнорира от Git/Docker; стойностите му умишлено не са записани тук. Паролата на локалната PostgreSQL роля е синхронизирана с локалната Compose конфигурация. При други вече създадени PostgreSQL volumes смяната на `POSTGRES_PASSWORD` в `.env` не сменя автоматично паролата в самата база.

Към последната локална проверка API, web и DB контейнерите работят; `/api/risk/cells` и `/api/risk/fires/recent` връщат `200`, а `/api/auth/me` без токен връща очаквания `401`. Това е локална проверка, не production deployment.

## 4. Публичен потребител и екипен достъп

### Публична страна

- На основния hostname посетителят вижда картата и формата за сигнал без акаунт.
- При сигнал API проверява границата на България през PostGIS и изисква Cloudflare Turnstile.
- Rate limit-ът на endpoint-а за сигнал е 5 заявки на час на IP, когато адресът на клиента се отчита коректно през доверения proxy.
- Гражданският профил е спрян за login; текущият seed не създава потребителски акаунти. Provisioning-ът премахва legacy `citizen@fireradar.bg` акаунта от вече създадена база, като запазва свързаните сигнали.
- Ако Turnstile ключовете не са конфигурирани, формата показва предупреждение и API отказва подаването с `503` (fail closed).

### Екипна страна

- `admin.<hostname>` е отделният екипен интерфейс.
- Диспечерът има оперативен екран: граждански сигнали, сигнали от кули и дронове.
- Само `admin` има управление на потребители, статистика, audit log и управление/симулация на сензори.
- API повторно проверява правата по JWT роля; скриването на страница във frontend не е единствената защита.
- JWT access token в момента се съхранява в `localStorage` за всеки отделен origin и се подновява през `/auth/refresh`. Това е работещият текущ модел, но не е целевият httpOnly refresh cookie вариант от security плана.

## 5. Поток на данните

### Подготовка на геоданните

1. `download_geodata.py` сваля административната граница и CLC 2018 GeoJSON.
2. `generateCells.ts` зарежда границата и CLC, генерира клетки и ги записва в PostGIS.
3. Клетките се филтрират/изрязват спрямо истинската геометрия на България, така че да не се показват извън границата.
4. CLC класификацията се пази в `veg_type` за ML входа.

### FIRMS засичания

1. `download_firms_full.py` е помощен скрипт за сваляне на VIIRS засичанията.
2. CSV се съхранява в `data/firms_bulgaria_2018_2025.csv`.
3. При стартиране API изпълнява `importFires.ts`, който пакетно импортира историческия CSV с уникален `source_id`.
4. При стартиране и на всеки час `importRecentFires.ts` изтегля последните два дни от NASA FIRMS VIIRS NRT за Suomi-NPP, NOAA-20 и NOAA-21. Изисква `FIRMS_MAP_KEY`, има 20-секунден timeout и до три опита за всеки продукт, пропуска невалидни/нискоуверени редове, филтрира по границата на България и дедупликира по стабилен `source_id`. Наличието на ключ не гарантира точки: endpoint-ът връща само реалните засичания за района и периода.
5. `GET /risk/fires/:date` връща историческите засичания, `GET /risk/fires/top-date` избира най-активната replay дата, а `GET /risk/fires/recent` връща последните 48 часа за живата карта.
6. Живият слой се обновява на всеки пет минути и е надписан „Спътникови засичания, не потвърдени пожари“. FIRMS отказът се логва, но не спира API.
7. FIRMS е satellite hotspot detection; засичането само по себе си не е потвърден горски пожар.

### Прогноза и риск

1. `updateForecasts.ts` зарежда клетките и Open-Meteo прогнозата (60 дни история + 3 прогнозни дни).
2. За всяка представителна метео точка изчислява FWI последователно, за да се запазва дневното състояние FFMC/DMC/DC.
3. Клетките свързват към най-близката представителна метео точка.
4. `predictRisk()` подготвя признаците, изпълнява ONNX inference при наличен модел и връща `risk_score`, `risk_level`, explanation и source.
5. `risk_forecasts` пази forecast time, FWI, class, числов score, source (`model`/`fwi`) и обяснение.
6. Job-ът upsert-ва три дни прогнози и се изпълнява при стартиране, после веднъж на час.
7. Публичната карта пита `GET /risk/cells` приблизително всяка минута и `/risk/fires/recent` на всеки пет минути. Replay използва архивно време и кешира отговор за 30 минути в паметта на API процеса.

## 6. API endpoint-ите

В `api/src/index.ts` route модулите се монтират със следните prefix-и. Fastify слуша на порт 3000 вътре в контейнера; Compose публикува localhost порт 3001. Production Caddy препраща `/api/...` към същите API пътища, като премахва `/api` префикса.

| Prefix | Endpoint-и | Роля / цел |
|---|---|---|
| `/auth` | `POST /login`, `POST /refresh`, `GET /me` | Екипен вход, подновяване и проверка на JWT. Login отказва citizen и неактивни акаунти. |
| `/risk` | `GET /cells`, `GET /cells/:id` | Последен риск за клетките / история на клетка. |
| `/risk` | `GET /fires/top-date`, `GET /fires/:date`, `GET /fires/recent` | FIRMS replay дата, засичания за избран ден и high/nominal VIIRS засичания от последните 48 часа. |
| `/risk` | `GET /replay/:date` | Историческо време, FWI/ML inference и риск за всички клетки. Дата е ограничена от 2024-01-01 нататък и трябва да е минала. |
| `/risk` | `POST /simulate` | Учебен клетъчен автомат за разпространение на огън според risk class и вятър. |
| `/alerts` | `POST /` | Публично, анонимно подаване; валидира полета, географска граница и Turnstile, с rate limit; автоматично изпраща най-близкия свободен разузнавателен дрон. |
| `/alerts` | `GET /`, `PATCH /:id` | Диспечер/admin вижда и обработва граждански сигнали; действията се записват в audit log. |
| `/towers` | `GET /`, `GET /alerts` | Кули/зони и сигнали от кули за оперативната карта. |
| `/towers` | `POST /:id/alert`, `PATCH /alerts/:id` | Диспечер/admin създава/обновява сигнал от кула. |
| `/drones` | `GET /`, `POST /dispatch/recon`, `POST /dispatch/citizen-alert`, `POST /dispatch/tanker`, `POST /dispatch/citizen-alert/tanker`, `PATCH /:id/status` | Оперативен достъп; изпращане заключва свободен дрон транзакционно; tanker към граждански сигнал изисква потвърждение от диспечера. |
| `/sensors` | `POST /tower-alert` | Приемане на сензорен сигнал чрез `X-API-Key`. |
| `/sensors` | `POST /simulate/:tower_id` | Симулиране на сигнал от кула за диспечер/admin. |
| `/sensors` | `GET /keys`, `POST /keys` | Списък и създаване на sensor ключове; admin-only. Ключът се връща при създаване. |
| `/admin` | `GET /users`, `PATCH /users/:id/role`, `PATCH /users/:id/status` | Admin-only управление на потребители и активност. |
| `/admin` | `GET /audit`, `GET /stats` | Admin-only audit log и системни броячи. |
| корен | `GET /health`, `/docs` | Health probe и Swagger UI. |

Публични са risk data endpoints и анонимното подаване на сигнали. `/towers`, `/towers/alerts`, `/drones`, `/admin` и екипните `/sensors` endpoints изискват активен staff JWT с подходяща роля; `POST /sensors/tower-alert` използва отделен sensor key.

## 7. База данни

Основната схема е в [api/src/db/schema.sql](./api/src/db/schema.sql), а началните демо записи са в [api/src/db/seed.sql](./api/src/db/seed.sql).

| Таблица | Роля |
|---|---|
| `users` | Екипни профили, bcrypt парола, роля и `active`. Seed не добавя потребители; екипните акаунти се създават от environment credentials чрез provisioning script. |
| `cells` | Геометрия на клетка, център/координати и тип земно покритие. |
| `weather_obs` | Предвидена таблица за метео наблюдения; основният текущ forecast job използва Open-Meteo и записва прогнозата в `risk_forecasts`. |
| `fires` | FIRMS координати, дата, яркост, увереност, геометрия и уникален import source id. |
| `risk_forecasts` | Време на прогноза, FWI, категория, числов score/source и обяснение. |
| `alerts` | Граждански сигнали със статуси pending/confirmed/dismissed/extinguished; при анонимния поток `user_id` е `NULL`; пази връзки към изпратените разузнавателен и водоноска дронове. |
| `watch_towers` | Демо кули и покривни геометрии. |
| `tower_alerts` | Сигнали от кули, статус, увереност и връзки към изпратените дронове. |
| `drones` | Тип, база, текущо местоположение, статус, мисия, сигнал/граждански сигнал и капацитет. |
| `audit_log` | Екипни и административни действия. |
| `sensor_api_keys` | SHA-256 хешове на ключове, свързани с кула, активност и описателни данни. Само отговорът при създаване съдържа оригинала. |

PostGIS геометрии са в SRID 4326; spatial индекси се използват за геометрии на клетки, огньове, кули и сигнали.

### Schema change-ове и migration бележки

- `schema.sql` се монтира като Docker init script и PostgreSQL изпълнява init файловете само при първо създаване на data volume.
- `migrate2.sql` е исторически ръчен файл за active/audit/key таблици; новите стартирания използват идемпотентната миграция от `api/src/db/migrate.ts`.
- Кодът съдържа и някои идемпотентни `ADD COLUMN IF NOT EXISTS` операции при job стартиране.
- `api/src/db/migrate.ts` пуска номерираните миграции за sensor key hashing, връзките между граждански сигнали и дронове и статуса за угасен сигнал в транзакция преди API listen. За всички бъдещи schema промени са нужни номерирани миграции и процедури за backup/restore; `schema.sql` не се изпълнява повторно върху съществуващ volume.

## 8. Frontend: какво показва всеки екран

- Публичната карта е началният път на основния hostname. Има live, replay и simulation режими; рискът се оцветява по клас. При достатъчно приближение се показва ONNX model score като процент. Popup-ът уточнява, че score-ът не е абсолютна вероятност; при FWI fallback процент не се показва.
- Replay показва историческо време, rainfall за клетката, FIRMS засичания и loading/error състояния. Бутонът demo избира най-активната FIRMS дата.
- Форма за сигнал е достъпна без вход. Тя позволява да се избере координата на карта, да се добави описание и да се мине Turnstile.
- Екипната страна се зарежда на `admin.*`. Login веде admin към `/admin`, dispatcher към `/operations`.
- Диспечерът използва Operations екрана за граждански/кули сигнали, маршрутни полигони и дронове. При нов граждански сигнал автоматично се изпраща най-близкият свободен разузнавач; след потвърждение от диспечера може да изпрати и свободна водоноска или да отбележи сигнала като угасен. Ако няма свободен дрон, сигналът остава в панела и може да бъде изпратен ръчно след това.
- Админът има потребители, журнал, статистика и сензорен симулатор/ключове.
- Админ hostname без екипен JWT не показва навигация; невалидна публична/citizen сесия се изчиства от екипния hostname.
- Данните се обновяват с TanStack Query периодично; „реално време“ в интерфейса тук означава polling интервали, не WebSocket/live push.

## 9. ML модел и интерпретация

`ml/train.py`:

1. Зарежда FIRMS до края на 2024 и Open-Meteo Archive за мрежата от клетки.
2. Генерира същите 0.1° клетки като API картата и им присвоява най-близкия CORINE vegetation клас.
3. Присвоява метеорологичните редове към най-близката точка и пресмята FWI серии с FFMC/DMC/DC памет.
4. Свързва FIRMS пожарни дни към клетката и календарната дата.
5. Създава lag признаци за FWI, температура и валежи.
6. Разделя train/test по време: обучение преди 2024, тест 2024.
7. Съпоставя отрицателните train примери по месец с положителните.
8. Сравнява четири версии на признаците: weather; weather+FWI; плюс lag/land cover; плюс календар.
9. Избира operational model по AUC критерий, извежда AUC/precision/recall и prevalence-коригирана оценка.
10. Експортира ONNX и `model_meta.json` с реда на признаците и percentile праговете.

Текущият operational ONNX има 20 признака; `model_meta.json` е източникът на реда на признаците и праговете. Класовете „умерен/висок/екстремен“ са percentile-базирани. Моделът вече е преобучен върху 0.1° клетка-дни и мрежата му съвпада с 1358-те клетки на API картата. Тестовата извадка е по време (2024), с естествена честота на пожарните клетка-дни около 0.362%; score-ът остава относителен риск, а не калибрирана абсолютна вероятност.

Точни текущи метрики и методологични ограничения са описани в [results.md](./results.md).

## 10. Файл по файл

### Основна папка

| Файл/папка | Предназначение |
|---|---|
| [README.md](./README.md) | Стартиране, домейн план, env променливи, deployment указания и създаване на защитени екипни акаунти. |
| [DONEWORK.md](./DONEWORK.md) | Статус на по-ранния план от шест блока и отметнати/оставащи задачи. |
| [PROJECT_GUIDE.md](./PROJECT_GUIDE.md) | Настоящият архитектурен и файл-по-файл справочник. |
| [Caddyfile](./Caddyfile) | Production hostnames, reverse proxy към API/docs/web и TLS автоматизация от Caddy. Не е активиран без production Compose профил и DNS. |
| [docker-compose.yml](./docker-compose.yml) | Контейнери, env wiring, loopback-публикуване на dev портове, мрежи, volumes, DB healthcheck, Caddy production profile. Изисква root `.env` за JWT/database secrets. |
| [.dockerignore](./.dockerignore) | Изключва secrets, dependencies, build output и runtime geodata от root API image context-а. |
| [api/.dockerignore](./api/.dockerignore) | Защитава самостоятелния API Dockerfile при build с `api/` като context. |
| [web/.dockerignore](./web/.dockerignore) | Изключва secrets, dependencies, build output и logs от web image context-а. |
| [.gitignore](./.gitignore) | Изключва dependencies, build output, `.env`, CSV/GeoTIFF. |
| [requirements.txt](./requirements.txt) | Python библиотеки за geodata/download/ML pipeline. |
| [download_firms_full.py](./download_firms_full.py) | Изтегля VIIRS FIRMS засичания за България на части и записва CSV; API ключ се подава като CLI аргумент. |
| [download_geodata.py](./download_geodata.py) | Изтегля GADM граница и CORINE 2018 полигони. |
| [phase0_check.py](./phase0_check.py) | Проверява достъпност на FIRMS/Open-Meteo източниците преди голямото сваляне. |
| [migrate2.sql](./migrate2.sql) | Исторически/ръчен SQL migration файл за active, audit и sensor keys; не замества migration framework. |
| [results.md](./results.md) | Резултати, baseline, feature ablations, precision caveats и ограничения на ML модела. |
| `.env` | Локални тайни/конфигурация; не записвай стойностите в документация или Git. Root ignore pattern `.env` важен за такъв файл във вложени папки. |
| `docs/` | Папката в текущата инвентаризация е празна. |
| `.github/workflows/ci.yml` | GitHub Actions workflow; детайлите са описани по-долу. |
| `data/` | Входни геоданни, FIRMS и метео кешове; не са изходен код. |
| `api/` | Fastify API, SQL схема, jobs и услуги. |
| `web/` | React SPA, nginx static server и Vite development configuration. |
| `ml/` | Training script, ONNX бинарник и metadata. |

### API файлы

| Файл | Какво прави |
|---|---|
| [api/src/index.ts](./api/src/index.ts) | Сглобява Fastify: Helmet CSP, глобален rate limit, exact-origin CORS allowlist, trusted proxy конфигурация, 15-минутни JWT, Swagger и route modules. Пуска миграциите преди listen; зарежда модел/FIRMS/клетки/прогнози и обновява прогнозите и FIRMS NRT на час. |
| [api/src/db/client.ts](./api/src/db/client.ts) | Създава един `postgres` клиент от `DATABASE_URL`, pool max 10. |
| [api/src/db/schema.sql](./api/src/db/schema.sql) | PostGIS extension, таблици, foreign keys, checks и spatial/audit индекси. |
| [api/src/db/seed.sql](./api/src/db/seed.sql) | 8 примерни кули, 8 примерни дрона и покривни зони; seed-ът вече не създава тестови потребители. |
| [api/src/db/migrate.ts](./api/src/db/migrate.ts) | Идемпотентни, транзакционни schema migrations, включително миграция на sensor API keys към SHA-256. |
| [api/src/scripts/provisionUsers.ts](./api/src/scripts/provisionUsers.ts) | Създава/обновява admin и dispatcher от environment credentials и изтрива стария citizen seed акаунт, като запазва свързаните сигнали. |
| [api/src/routes/auth.ts](./api/src/routes/auth.ts) | Rate-limited вход, bcrypt compare, 15-минутни access tokens, active-user-aware refresh и current-user endpoints. |
| [api/src/services/authorization.ts](./api/src/services/authorization.ts) | Проверява JWT, актуалния active flag и роля от базата при всяка екипна заявка. |
| [api/src/services/sensorApiKey.ts](./api/src/services/sensorApiKey.ts) | Генерира и SHA-256 хешира ключовете за сензори. |
| [api/src/routes/risk.ts](./api/src/routes/risk.ts) | Cells, FIRMS recent/date/top-date, replay/cache (до 10 дати; 3 заявки/минута), Archive API batching/nearest weather и fire-spread simulation (3 заявки/минута). |
| [api/src/routes/alerts.ts](./api/src/routes/alerts.ts) | Публични сигнали с Zod, Bulgaria boundary validation, Turnstile/IP rate limit; staff list/update и транзакционен audit. |
| [api/src/routes/towers.ts](./api/src/routes/towers.ts) | Кули, покривни зони и tower alert create/list/status endpoints; всички маршрути са само за активен dispatcher/admin, промените се записват транзакционно в audit log. |
| [api/src/routes/drones.ts](./api/src/routes/drones.ts) | Ops-only drone list, транзакционно изпращане на recon/tanker, audit за изпращане и ръчни статус промени, плюс интерполация по таймер. |
| [api/src/routes/sensors.ts](./api/src/routes/sensors.ts) | SHA-256 X-API-Key ingest, демо генератор на сигнал и admin key management; суровият ключ се връща само при създаване. |
| [api/src/routes/admin.ts](./api/src/routes/admin.ts) | Admin-only потребители, роли, active flags, audit и системна статистика. |
| [api/src/jobs/generateCells.ts](./api/src/jobs/generateCells.ts) | Чете boundary/CLC, формира spatial lookup и генерира/попълва PostGIS cells вътре в границата. |
| [api/src/jobs/importFires.ts](./api/src/jobs/importFires.ts) | Исторически CSV парсер и пакетен импорт с уникален `source_id`. |
| [api/src/jobs/importRecentFires.ts](./api/src/jobs/importRecentFires.ts) | Почасов NASA FIRMS VIIRS NRT импорт от Suomi-NPP, NOAA-20 и NOAA-21: API key от environment, timeout/retry, high/nominal confidence, редова валидация, PostGIS филтър по граница и stable `source_id` дедупликация. Временен FIRMS отказ за един продукт се логва, без да блокира импорт от другите или спира API. |
| [api/src/jobs/updateForecasts.ts](./api/src/jobs/updateForecasts.ts) | Тегли прогноза на представителни точки, пресмята FWI/ML за клетките и пакетно upsert-ва forecast редове. |
| [api/src/jobs/recoverDrones.ts](./api/src/jobs/recoverDrones.ts) | При API старт връща незавършените симулационни дрон мисии в `idle` и ги позиционира обратно в базата. |
| [api/src/services/fwi.ts](./api/src/services/fwi.ts) | TypeScript реализация на FWI компонентите, дневна памет, FWI class thresholds и обяснение на български. |
| [api/src/services/model.ts](./api/src/services/model.ts) | Зарежда ONNX + model metadata; feature mapping, score/classification, explanation и FWI fallback. |
| [api/src/services/openMeteo.ts](./api/src/services/openMeteo.ts) | Retry/backoff/timeout за Open-Meteo Archive fetch. |
| [api/src/services/bulgariaBoundary.ts](./api/src/services/bulgariaBoundary.ts) | Зарежда и валидира boundary GeoJSON от local data или `/app/data`. |
| [api/src/services/turnstile.ts](./api/src/services/turnstile.ts) | Server-side Cloudflare Turnstile Siteverify HTTP call; provider failure става грешка, не успешна CAPTCHA. |
| `api/src/services/*.test.ts` | Unit тестове за FWI, ONNX/model score и fallback, Open-Meteo retry поведението и Turnstile success/failure/provider error. |
| [api/Dockerfile](./api/Dockerfile) | API image definition за отделно build изпълнение; приема `api/` като build context, защитен от [api/.dockerignore](./api/.dockerignore). |
| [api/Dockerfile.compose](./api/Dockerfile.compose) | Compose API image; context-ът е коренът, копира API dependency manifests и ONNX assets, после `COPY api/ .`, компилира TypeScript и пуска `dist/index.js`. Root `.dockerignore` не допуска `.env`, `node_modules` или стар `dist` в image. |
| [api/package.json](./api/package.json) | API scripts/dependencies: build, test, dev, Fastify, PostgreSQL, JWT, Zod, bcrypt, ONNX Runtime. |
| `api/package-lock.json` | Точни dependency версии за reproducible `npm ci`. |
| [api/tsconfig.json](./api/tsconfig.json) | API TypeScript compiler options. |
| [api/vitest.config.ts](./api/vitest.config.ts) | Vitest test runner configuration. |
| `api/.env` | Локална API конфигурация, ако се използва; не включвай стойности в този guide или production image. |

### Web файлове

| Файл | Какво прави |
|---|---|
| [web/src/main.tsx](./web/src/main.tsx) | React root, React Query client, BrowserRouter и global CSS. |
| [web/src/App.tsx](./web/src/App.tsx) | Избира public/admin UI според hostname, routes и ролеви guards. |
| [web/src/hooks/useAuth.tsx](./web/src/hooks/useAuth.tsx) | Auth provider, token/role/email в `localStorage`, 10-минутен refresh timer, `/auth/me` validation, login/logout. |
| [web/src/hooks/authContext.ts](./web/src/hooks/authContext.ts) | Споделен auth context и `useAuth` hook без съвместно експортиране с компонента. |
| [web/src/hooks/ThemeProvider.tsx](./web/src/hooks/ThemeProvider.tsx) | Избира тема според запазената настройка или системната предпочитана тема, записва избора и задава `data-theme` за стиловете. |
| [web/src/components/ThemeToggle.tsx](./web/src/components/ThemeToggle.tsx) | Достъпен светъл/тъмен превключвател в навигацията и екрана за вход. |
| [web/src/utils/hosts.ts](./web/src/utils/hosts.ts) | Разпознава admin hostname и строи URL към админ входа. |
| [web/src/components/Navbar.tsx](./web/src/components/Navbar.tsx) | Различна навигация за публичен hostname и екипен hostname. |
| [web/src/components/Icon.tsx](./web/src/components/Icon.tsx) | React SVG icon component. |
| [web/src/components/iconPaths.ts](./web/src/components/iconPaths.ts) | Типизиран набор от SVG path данни и имена на икони. |
| [web/src/components/iconDom.ts](./web/src/components/iconDom.ts) | Създава SVG DOM елементи за MapLibre markers. |
| [web/src/lib/maplibre.ts](./web/src/lib/maplibre.ts) | Единна конфигурация на MapLibre: импортира пакетния module worker като Vite asset с хеширано име, задава URL чрез `setWorkerUrl()` и избира Carto basemap според темата. |
| [web/src/components/Turnstile.tsx](./web/src/components/Turnstile.tsx) | Включва Cloudflare challenge widget и съобщава challenge token към формата. |
| [web/src/pages/MapPage.tsx](./web/src/pages/MapPage.tsx) | Публична карта с CARTO basemap според избраната тема, риск-клетки, относителен риск, live polling, FIRMS/replay и simulation controls. При излизане от повторение FIRMS източникът първо се изчиства, а изчакващи callbacks от стария режим се откачат/игнорират; живият слой после се попълва само с последните засичания. Включва празно състояние и час на последната прогноза. |
| [web/src/pages/AlertsPage.tsx](./web/src/pages/AlertsPage.tsx) | Безвходна форма и Turnstile; за dispatcher/admin показва и управлява сигнали. |
| [web/src/pages/LoginPage.tsx](./web/src/pages/LoginPage.tsx) | Екипен email/password login; граждански login не е част от UX. |
| [web/src/pages/OperationsPage.tsx](./web/src/pages/OperationsPage.tsx) | Оперативна карта за кули, сигнали, мисии и дронове; редовно опреснява данните. |
| [web/src/pages/AdminPage.tsx](./web/src/pages/AdminPage.tsx) | Админ табове: users, audit, stats, sensor tools. |
| [web/src/index.css](./web/src/index.css) | Глобална тема, карта, legend, controls, login, alerts и operation styles. |
| `web/src/assets/*` | Статични изображения, използвани от приложението. Неизползваните Vite template assets са премахнати. |
| [web/index.html](./web/index.html) | HTML shell за Vite build. |
| [web/vite.config.ts](./web/vite.config.ts) | React plugin, отделен MapLibre chunk и dev proxy `/api` към localhost API; разрешава локалния `admin.localhost` host. Worker-ът вече се обработва от Vite чрез `?url` в `web/src/lib/maplibre.ts`, а не чрез ръчно копиране от plugin. |
| [web/nginx.conf](./web/nginx.conf) | Production static SPA fallback, `/api` reverse proxy към API, proxy IP headers, CSP/security headers и JavaScript MIME type за `.js`/`.mjs` assets. |
| [web/Dockerfile](./web/Dockerfile) | Multi-stage Vite build и Nginx static runtime; Turnstile public site key се подава build arg. |
| [web/package.json](./web/package.json) | React/Vite dependencies и `build`, `lint`, `dev`, `preview` scripts. |
| `web/package-lock.json` | Точни Web dependency versions. |
| [web/tsconfig.json](./web/tsconfig.json), [web/tsconfig.app.json](./web/tsconfig.app.json), [web/tsconfig.node.json](./web/tsconfig.node.json) | TypeScript project references и compiler config за app/tooling. |
| [web/.oxlintrc.json](./web/.oxlintrc.json) | Oxlint rule/plugin config. |
| [web/.gitignore](./web/.gitignore) | Игнорира локални web-generated/dependency files. |
| [web/public/favicon.svg](./web/public/favicon.svg), [web/public/icons.svg](./web/public/icons.svg) | Статични web икони/спрайт. |

### ML и данни

| Път | Какво съдържа |
|---|---|
| [ml/train.py](./ml/train.py) | Генерира клетка-дни на 0.1° резолюция, присвоява най-близки метео и CORINE класове, изчислява FWI/lags, сравнява feature sets и експортира ONNX, metadata и метрики. |
| [ml/test_train.py](./ml/test_train.py) | Unit тестове за клетъчната мрежа и FIRMS етикетите/lag признаците. |
| [ml/model_meta.json](./ml/model_meta.json) | Ред на 20 признаците, percentile risk thresholds и `risk_semantics: relative`; API го чете при inference. |
| `ml/fire_risk.onnx` | Компилираният бинарен LightGBM модел за API inference. Не е изходен код; преобучаването го заменя. |
| `data/bulgaria_boundary.geojson` | Българска административна граница. |
| `data/clc2018_bgr.geojson` | CORINE полигони за България; около 399 MB, нужен е за land-cover spatial classification. |
| `data/firms_bulgaria_2018_2025.csv` | FIRMS hotspot записи; около 5.2 MB, използва се от importer и ML training. |
| `data/meteo_2018_2024.csv` | Open-Meteo Archive training cache; около 2.1 MB. |
| `data/clc_per_point.json` | Компактен lookup кеш за CLC клас към представителна точка. |
| `data/clc_polygon_centroids.json` | Игнориран кеш за центроидите на CLC полигони, използван при клетъчното обучение. |

Големите GeoJSON/CSV данни мапват read-only в API container под `/app/data`. Файловете `node_modules/`, `dist/` и кешовете са инсталирани или generated output, не са част от приложния source-of-truth и не са описвани по един.

### CI

[.github/workflows/ci.yml](./.github/workflows/ci.yml) при push към `main` и pull request:

1. checkout;
2. Node 22 setup и npm cache за API;
3. `npm ci`, API build и tests;
4. `npm ci` за web, web lint и production build;
5. Docker image builds за API и web.

Workflow-ът включва API build/tests, web lint/build и Docker image builds. PostgreSQL migration integration test-ът е opt-in и workflow-ът още не стартира database service; няма и k6/performance job.

## 11. Тестове и проверки, които са налични

- API `npm test` (`vitest run`) — включва 401/403 за `/towers` и `/drones`, 400 за координати/описание/Turnstile, 409 за непотвърден пожар, login/сигнални лимити, sensor-key hashing, Open-Meteo/FIRMS отказ, FIRMS retry/dedup/невалидни редове/реален CSV layout, студен/влажен и горещ/сух `predictRisk()` и drone recovery.
- [api/src/db/migrate.integration.test.ts](./api/src/db/migrate.integration.test.ts) изпълнява sensor-key миграцията два пъти върху изолирана PostgreSQL схема, когато е зададен `MIGRATION_TEST_DATABASE_URL`; иначе тестът се пропуска.
- `python -m unittest ml.test_train` — тестове за генериране на клетките и клетка-дни.
- API `npm run build` — TypeScript compile.
- Web `npm run build` — `tsc -b` плюс Vite production bundle.
- Web `npm run lint` — Oxlint без предупреждения.
- Web build отделя MapLibre в собствен chunk; той остава около 1.08 MB minified (293 KB gzip) и затова Vite продължава да предупреждава за размер над 500 KB.
- Vite build издава MapLibre worker като asset с хеширано име, което избягва постоянен URL и проблеми със стар кеширан worker.
- `docker compose config --quiet` — проверява YAML/env expansion; изисква `JWT_SECRET` и `POSTGRES_PASSWORD`.
- Оперативните действия за сигнали, tower alerts и ръчни drone status промени пишат в `audit_log` в същата транзакция като промяната; API тестове проверяват tower/drone audit insert.
- Rate limit адресът идва през Caddy, фиксиран с IP `172.30.0.2`; само този proxy е доверен от Fastify (`TRUST_PROXY`), а API портът е вързан към loopback на хоста. Не приемай произволен `X-Forwarded-For` от клиент.
- Popup DOM-ът за сигнални описания е текстов: `MapPage` задава `textContent`, а `OperationsPage` използва `createPopup` с `textContent`. В web source няма `innerHTML`, `setHTML` или `dangerouslySetInnerHTML`.

Самите build/test команди не потвърждават DNS, TLS, CAPTCHA keys, production server reachability или PostgreSQL backup. Локалните контейнери и браузърните заглавки са проверени отделно, но това не доказва production health.

## 12. Известни ограничения и рискове

1. **Production не е активен.** Домейн файл/configuration-ът е заготовка; DNS, сървър, firewall, secret values, Caddy certificate и deployment не са проверени.
2. **Turnstile не е configured by default.** Без валидни site/secret keys публичното подаване е блокирано по дизайн.
3. **Provisioning задължителен преди вход.** Seed-ът вече не създава потребители; старите DB volume-ове пазят съществуващите акаунти, докато `npm run provision:users` не ги обнови.
4. **DB credentials и стар volume.** Compose env password не променя съществуващ PostgreSQL volume; проверявай migration и ролева парола отделно.
5. **Access token в localStorage.** CSP и кратък 15-минутен access token ограничават риска, но httpOnly refresh cookie би била по-силна защита срещу кражба на токени.
6. **CSP компромиси.** Web CSP позволява inline styles за MapLibre/React style атрибути и HTTPS изображения за базовата карта; script е ограничен до self и Turnstile.
7. **Процентът не е вероятност.** Score-ът е относителен, не е калибриран като абсолютна вероятност. Моделът е на map-cell резолюция, но оценката му е върху исторически времеви split.
8. **Метео пространствено приближение.** Replay взема archive от редки representative точки и присвоява най-близка точка на клетките. Не е директна клетъчна наблюдателна мрежа.
9. **Polling, не push.** Live UI опреснява през интервали (например клетките всяка минута); няма WebSocket/SSE.
10. **Дрон таймерите са process-local.** При API restart активните симулационни мисии се зануляват в `idle` и дроновете се връщат в базата; реални мисии трябва да се управляват през устойчив job/worker.
11. **Demo seed.** Кули/дронове са начални симулационни записи; интерфейсът маркира демо данните.
12. **Миграции и тестове.** Идемпотентното migration ядро за sensor key hashing има PostgreSQL integration test, който създава изолирана схема и изпълнява миграцията два пъти. Локално е изпълнена и реална проверка срещу текущата база. Няма още пълна схема с номерирани SQL файлове за бъдещите промени. Пусни integration test с `MIGRATION_TEST_DATABASE_URL`, за да го активираш; без него тестът се пропуска.
13. **Docker build context.** Root `.dockerignore` и `web/.dockerignore` вече изключват тайни, зависимости, build output и големите runtime данни от контекстите.
14. **Compose topology.** Production reverse proxy използва Docker IP `172.30.0.2`, който е единственият подразбиран trusted proxy. При deployment провери subnet конфликт и че Caddy запазва реалния клиентски адрес чрез своя proxy header; не настройвай доверие към всички proxy адреси.
15. **Голям geodata файл.** CORINE GeoJSON е ~399 MB и се монтира read-only в API; сървърът пак трябва да има файла и достатъчно място.
16. **Локален `api/.env`.** Root `.gitignore` и `.dockerignore` го изключват за нови checkout/build-и. Старият Compose Dockerfile е копирал `api/` в image без ignore; ако такъв image е бил качен или споделен, смени всички тайни, които са били в `api/.env`, и изтрий стария image от registry-то. Историята на Git не може да се сканира в тази папка, защото няма `.git` директория.
17. **Относителен риск и FIRMS актуалност.** Моделът вече е на същата 0.1° клетъчна резолюция като картата, но score-ът не е калибрирана вероятност. Архивният CSV завършва през 2025 г.; отделният NRT job обновява засичанията от последните два дни, когато `FIRMS_MAP_KEY` е зададен. Локалният `FIRMS_MAP_KEY` не е конфигуриран при последната проверка, затова реални NRT точки не са потвърдени.
18. **Браузърна проверка и CSP.** На ширина 360 px е проверено, че страницата няма хоризонтален overflow и контролите/легендата остават достъпни в долната лента. CARTO Positron light basemap е визуално проверен в браузър, но не и на физически проектор. При последната локална проверка картата зарежда клетките, worker asset-ът връща `200` с `application/javascript`, а `/map` CSP съдържа `script-src 'self' https://challenges.cloudflare.com` — не `script-src 'none'`. Предишна конзолна бележка за `script-src 'none'` не съвпадаше с текущите HTTP response headers. Ако съобщението се върне, провери всички CSP заглавки в Network и дали browser extension добавя отделна политика. Turnstile smoke test изисква Cloudflare тестови ключове или валидна конфигурация.
19. **Известия към граждани.** Telegram ботът и доставката на известия са спрени по изрично указание и не са част от текущата реализация. Не са добавяни бот, опашка или notification таблици.

## 13. Следващи стъпки — препоръчан ред

### Етап A — Преди утрешното качване

1. Потвърди кой сървър ще се използва, неговата OS/архитектура, публичен IP и наличното място.
2. Направи отделен deployment `.env` на сървъра. Генерирай нова силна `JWT_SECRET` и `POSTGRES_PASSWORD`; никога не използвай стойности от локалния `.env`.
3. Ако пренасяш съществуваща DB volume, направи dump/backup и смени PostgreSQL role password контролирано преди да смениш API connection string-а.
4. Смени JWT, database, Turnstile и други credentials, които са били в локалния `api/.env`, ако е използван предишният API Dockerfile. Задай `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `DISPATCHER_EMAIL`, `DISPATCHER_PASSWORD` и изпълни `npm run provision:users` през API контейнера. Съществуващите екипни акаунти ще бъдат обновени, legacy citizen seed-ът ще бъде изтрит; не създавай публичен граждански login.
5. Създай Turnstile site и secret keys за exact hostnames `fireradar-bg.org`, `www.fireradar-bg.org` и `admin.fireradar-bg.org`; запиши ги като server secrets.
6. Провери root `.dockerignore` и `web/.dockerignore`: runtime data се монтират отделно, а нужните ONNX assets остават в API image-а. Не качвай тайни.

### Етап B — DNS и TLS

1. В DNS добави `A` записи за `fireradar-bg.org`, `www.fireradar-bg.org`, `admin.fireradar-bg.org` към сървъра. Ако хостингът ползва IPv6, провери дали `AAAA` сочи към правилното място.
2. Настрой firewall/security group за TCP 80/443; UDP 443 е незадължителен HTTP/3.
3. Провери, че 80/443 не са заети от друг reverse proxy.
4. Провери DNS propagation отвън; чак след това стартирай Caddy production profile.
5. Потвърди Caddy certificate issuance, redirect HTTP→HTTPS, hostname routing и `/api`, `/docs`, SPA fallback.
6. Не излагай PostgreSQL 5432, API 3000/3001 и Nginx 80 директно към Internet; текущ Compose binding ги ограничава към loopback, а публичният вход е през Caddy.

### Етап C — Smoke tests преди публично обявяване

1. `GET /health` и `/docs` през production hostname.
2. Публичният map да зареди cells; replay/fire endpoints да върнат данни за валидна дата.
3. Админ hostname да покаже login, а не административни данни преди вход.
4. Admin login: users/audit/stats/sensors; dispatcher login: operations/alerts, но `/admin/*` трябва да бъде 403.
5. Публичен сигнал: Turnstile pass, bad token rejection, coordinate-outside-Bulgaria rejection, length validation, rate-limit response.
6. Проверка, че анонимния reporter email/user id не се показва; алертите се виждат само от staff endpoint.
7. Повторно стартиране на контейнерите да не губи PostgreSQL volume, Caddy state/certificates или FIRMS data.
8. Проверка на logs за ключове, лични данни, CAPTCHA token или пълни sensor API keys — те не трябва да се логват.

### Етап D — Оперативна готовност

1. Настрой дневни backups на PostgreSQL и периодично пробвай restore.
2. Добави uptime/health monitoring, alerting за API/db/container restarts, disk space и forecast job failure.
3. Определи retention policy за alerts, raw geodata, logs и audit entries.
4. Вече има PostgreSQL integration test за повторно пускане на миграцията; включи го в CI с отделна DB service и добавяй новите миграции по номериран ред.
5. Access token още е в `localStorage`; планирай httpOnly refresh cookie и завърши threat-model review преди публичния deployment.
6. Направи Git secret scan от действителното репозитори и ротирай всички ключове, които са били committed или попаднали в стар image.
7. Разшири тестовете с k6 натоварване, dependency/security review и браузърни CSP проверки; API/web CI build, lint, tests и Docker builds вече са добавени.
8. Преобучаването на ниво клетка-ден е завършено; следващо е повторно обучение при нови данни и проверка на дрейфа, като навсякъде се запазва надписът „относителен риск“.
9. Направи визуален преглед на светъл екран/проектор, легендата и режимните цветове. За проверка на нови FIRMS данни е нужна валидна `FIRMS_MAP_KEY`; за Turnstile използвай Cloudflare тестови ключове, не production secret.
10. Ако системата ще влияе на реална пожарна реакция, добави оперативни процедури, човешко потвърждение, произход/актуалност на данните и официално предупреждение за 112; не третирай симулацията като реален диспечерски канал.
11. Не добавяй ОгънПазач/Telegram, докато потребителят не възобнови тази задача.

## 14. Команди за работа

Командите от корена на проекта в текущата Windows среда:

```powershell
# Web development
Set-Location .\web
npm.cmd run dev
npm.cmd run build
npm.cmd run lint

# API build/tests
Set-Location ..\api
npm.cmd run build
npm.cmd test

# Compose configuration check (root .env must define required secrets)
Set-Location ..
docker compose config --quiet

# Production start — only after DNS/firewall/secrets are ready
docker compose --profile production up --build -d
```

Не стартирай последната команда преди DNS, secrets, database state, Turnstile и firewall проверките. `docker compose up --build` не е безобиден заместител на production review: контейнерите може да започнат публично да обслужват трафик, ако Caddy profile/host port setup е променен.
