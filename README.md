# CodeRoom

CodeRoom — веб-приложение для совместного редактирования `.py` и `.txt` файлов в комнатах и запуска Python-кода в одноразовых Docker-контейнерах. Клиенты синхронизируют текст и курсоры через Yjs, а состав комнаты, файловые операции и результаты выполнения — через отдельный JSON WebSocket.

## Features

- Создание комнаты по короткому идентификатору и приглашение участников ссылкой.
- Совместное редактирование в Monaco Editor с Yjs CRDT, удалёнными выделениями и awareness-данными пользователей.
- Создание, импорт перетаскиванием, переименование, удаление и общий выбор файлов `.py` и `.txt`.
- Запуск выбранного Python-файла вместе с остальными файлами комнаты.
- Общие для комнаты статусы, `stdout`, `stderr` и exit code; ручная остановка выполнения.
- Ограничения sandbox: без сети, 128 MiB RAM, 0.5 CPU, настраиваемые timeout и лимит вывода.
- Светлая/тёмная тема, сохранение имени, размера шрифта и состояния sidebar в browser storage.
- Автоматическое удаление пустой комнаты через 24 часа.

Все комнаты и документы хранятся только в памяти backend. Перезапуск процесса удаляет их; учётных записей и разграничения доступа нет.

## Tech stack

### Frontend

- React 18 и React Router 6;
- TypeScript 5 и Vite 5;
- Monaco Editor;
- Yjs, `y-websocket` и `y-monaco`.

Monaco и его editor worker собираются вместе с frontend из зафиксированной в lock-файле версии. React-редактор и Yjs binding используют один экземпляр Monaco, без отдельной загрузки редактора с CDN.

### Backend

- Node.js, TypeScript и Express 4;
- `ws` для JSON и Yjs WebSocket endpoints;
- Yjs, `y-protocols` и `lib0`;
- прямой HTTP-доступ к Docker Engine API через Docker socket.

### Data

Базы данных, ORM и migrations нет. Room metadata хранится в `Map`, содержимое файлов — в in-memory `Y.Doc`.

### Infrastructure

- npm и отдельные lock-файлы корня, frontend и backend;
- Docker/Compose;
- production frontend на Nginx;
- внешний Nginx reverse proxy с TLS для `code-room.ru`;
- GitHub Actions для сборки GHCR-образов и SSH deployment.

## Project structure

```text
.
├── backend/
│   ├── src/
│   │   ├── index.ts       # Express entry point и REST API
│   │   ├── rooms.ts       # in-memory комнаты, файлы, Yjs docs и TTL
│   │   ├── realtime.ts    # JSON WebSocket, Yjs WebSocket и broadcasts
│   │   ├── runner.ts      # Docker Engine API и lifecycle sandbox
│   │   └── types.ts       # серверные модели и client events
│   └── Dockerfile*        # development/production образы backend
├── frontend/
│   ├── src/
│   │   ├── pages/         # HomePage и RoomPage
│   │   ├── main.tsx       # React entry point и routing
│   │   ├── config.ts      # REST/WS URL
│   │   ├── theme.tsx      # theme context
│   │   └── types.ts       # клиентские модели и server events
│   ├── nginx.conf         # production SPA и внутренний proxy
│   └── Dockerfile*        # development/production образы frontend
├── runner/Dockerfile      # Python 3.12 runner image
├── docker-compose.yml     # локальный Docker development stack
├── docker-compose.prod.yml
├── nginx.code-room.conf   # внешний TLS reverse proxy
├── scripts/update.sh      # server update procedure
├── DEPLOY.md              # production runbook
└── .github/workflows/     # image build и SSH deploy
```

## Requirements

Для запуска напрямую на хосте нужны:

- Node.js и npm. Версия Node.js для host development в `package.json` не закреплена; Dockerfiles используют `node:24-slim`.
- Запущенный Docker Engine и доступ backend к Docker socket.
- Образ `collab-python-runner`, если backend запускается с настройками по умолчанию.

Для Compose-варианта нужны Docker и Docker Compose plugin. Runner основан на `python:3.12-slim`.

## Installation

Установите зависимости всех трёх npm-пакетов из корня:

```bash
npm ci
npm ci --prefix backend
npm ci --prefix frontend
```

Существующий helper `npm run install:all` выполняет `npm install` только в `backend/` и `frontend/`; root dependency `concurrently` всё равно должна быть установлена отдельно.

Для прямого запуска backend соберите его runner image:

```bash
docker build -t collab-python-runner ./runner
```

## Configuration

### Backend environment

Backend читает переменные из `process.env`; библиотека загрузки `.env` не подключена. Передавайте их через shell, process manager или Compose.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | HTTP/WebSocket port |
| `ALLOWED_ORIGINS` | empty | Список разрешённых CORS origins через запятую; `*` запрещён. При пустом значении CORS middleware не подключается |
| `RUNNER_IMAGE` | `collab-python-runner` | Docker image для каждого запуска |
| `DOCKER_SOCKET` | `/var/run/docker.sock` на Unix, `//./pipe/docker_engine` на Windows | Docker Engine socket |
| `RUN_TIMEOUT_MS` | `15000` | Timeout одного запуска в миллисекундах |
| `RUN_OUTPUT_LIMIT_BYTES` | `65536` | Общий лимит `stdout` + `stderr` в байтах |

### Frontend environment

Шаблон находится в `frontend/.env.example`. Значения необязательны: локальный Vite server проксирует стандартные same-origin пути на backend.

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `/api` | REST API base URL |
| `VITE_WS_BASE_URL` | текущий browser host с `ws://` или `wss://` | Base URL для `/ws` и `/yjs/:roomId` |

`VITE_*` значения встраиваются в frontend bundle и не должны содержать секреты. Не коммитьте реальные credentials или `.env` файлы.

## Development

После установки зависимостей и сборки `collab-python-runner` запустите оба приложения:

```bash
npm run dev
```

- Frontend: `http://localhost:5173`.
- Backend и health endpoint: `http://localhost:4000`, `http://localhost:4000/health`.
- Vite проксирует `/api`, `/ws` и `/yjs` на backend.

Для раздельного запуска доступны:

```bash
npm run dev:backend
npm run dev:frontend
```

Алиасы `dev:server` и `dev:client` запускают те же backend и frontend scripts.

## Docker

Development stack запускается так:

```bash
docker compose up --build
```

`docker-compose.yml` монтирует исходники, запускает оба dev server и публикует порты `4000` и `5173`. Сервис `runner-image` предварительно загружает `dh-mirror.gitverse.ru/library/python:3.12-slim`; это же имя передаётся backend как `RUNNER_IMAGE`. Docker socket хоста смонтирован в backend.

Остановка стека:

```bash
docker compose down
```

## Build

Полная production-сборка TypeScript и frontend assets:

```bash
npm run build
```

Отдельные сборки:

```bash
npm run build --prefix backend
npm run build --prefix frontend
```

Результаты создаются в `backend/dist/` и `frontend/dist/`. Собранный backend запускается командой `npm run start --prefix backend`; production frontend обслуживается Nginx из `frontend/Dockerfile.prod`.

## Tests

Автоматических тестов и `test` script в репозитории сейчас нет.

## Lint / typecheck

Lint-конфигурации и `lint` script нет. Отдельного `typecheck` script тоже нет: проверка TypeScript входит в build обоих пакетов (`tsc` для backend, `tsc && vite build` для frontend).

## Runtime interfaces

- `GET /health` — health response `{ "ok": true }`.
- `POST /api/rooms` — создаёт комнату.
- `GET /api/rooms/:roomId` — возвращает room state.
- `POST /api/rooms/:roomId/run` — запускает файл по `{ "fileId": string }`.
- `/ws` — JSON events для join/leave, file operations и execution.
- `/yjs/:roomId` — бинарные Yjs sync и awareness messages.

Подробные цепочки сообщений и состояния описаны в [ARCHITECTURE.md](ARCHITECTURE.md).

## Deployment

Подтверждённый production-вариант использует `docker-compose.prod.yml`: backend публикуется только на `127.0.0.1:4000`, frontend Nginx — на `127.0.0.1:8080`. Внешний `nginx.code-room.conf` завершает TLS для `code-room.ru`, направляет `/` во frontend, а `/api`, `/ws` и `/yjs` — в backend.

Перед production Compose должен существовать image `collab-python-runner`:

```bash
docker build -t collab-python-runner ./runner
docker compose -f docker-compose.prod.yml config
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=100 backend frontend
```

`scripts/update.sh` автоматизирует pull, временную maintenance-страницу, сборку runner и приложения. `start-prod.sh` только поднимает Compose и предполагает, что runner image уже существует. Полная настройка Nginx, TLS и проверки приведены в [DEPLOY.md](DEPLOY.md).

При push в `main` workflow `deploy.yml` запускает update script на сервере по SSH. Отдельный `build-images.yml` публикует backend/frontend/runner images в GHCR; текущий production Compose эти GHCR images не использует.

> Backend-контейнер получает Docker socket хоста. Это даёт процессу backend высокие полномочия над Docker daemon; рассматривайте это как существенную границу доверия, а не как полноценную защиту хоста от скомпрометированного backend.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — фактические компоненты, данные, протоколы и ограничения.
- [AGENTS.md](AGENTS.md) — компактные правила работы AI/Codex-агентов с репозиторием.
- [DEPLOY.md](DEPLOY.md) — production runbook для Compose и Nginx.
