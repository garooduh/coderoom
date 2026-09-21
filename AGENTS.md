# AGENTS.md

## Project overview

CodeRoom — небольшое TypeScript-приложение для совместного редактирования файлов `.py` и `.txt` в комнате и запуска Python-кода в одноразовом Docker-контейнере. React-клиент использует Monaco и Yjs; Node.js backend обслуживает REST, JSON WebSocket, бинарный Yjs WebSocket и напрямую вызывает Docker Engine API.

Состояние комнат, пользователей, файлов, Yjs-документов и последних запусков хранится только в памяти backend. Базы данных, постоянного файлового хранилища, аутентификации и авторизации в проекте нет.

## Repository map

- `frontend/src/main.tsx` — entry point SPA и маршруты `/` и `/room/:roomId`.
- `frontend/src/pages/HomePage.tsx` — создание комнаты через REST.
- `frontend/src/pages/RoomPage.tsx` — основная UI- и клиентская orchestration-логика комнаты: REST-загрузка, оба WebSocket-соединения, Monaco/Yjs binding, файлы и запуск кода.
- `frontend/src/config.ts` — вычисление базовых REST и WebSocket URL.
- `frontend/src/theme.tsx`, `frontend/src/styles.css` — theme context и глобальное оформление.
- `frontend/src/types.ts` — клиентские room/run/WebSocket-типы.
- `backend/src/index.ts` — entry point, Express middleware и REST handlers.
- `backend/src/rooms.ts` — in-memory room/file state, Yjs documents, валидация имён и 24-часовой TTL пустых комнат.
- `backend/src/realtime.ts` — `/ws`, `/yjs/:roomId`, broadcasts и orchestration запуска.
- `backend/src/runner.ts` — прямой HTTP-доступ к Docker socket, tar-архив файлов, lifecycle sandbox-контейнера и лимиты.
- `backend/src/types.ts` — серверные модели и client-message union.
- `runner/Dockerfile` — образ Python 3.12 для одноразовых запусков.
- `docker-compose.yml`, `docker-compose.prod.yml` — development и production Compose-конфигурации.
- `frontend/nginx.conf`, `nginx.code-room.conf` — внутренний SPA proxy и внешний TLS reverse proxy для `code-room.ru`.
- `scripts/update.sh`, `start-prod.sh`, `DEPLOY.md` — существующие production-процедуры.
- `.github/workflows/` — публикация GHCR-образов и SSH deployment.

## How to investigate a task

1. Определи затронутую подсистему: UI, room state, JSON events, Yjs sync, runner или deployment.
2. Найди её фактическую точку входа из карты выше.
3. Прочитай окружающий код, а не только целевой метод или компонент.
4. Проследи imports, callers, сообщения и зависимости до другой стороны frontend/backend и инфраструктурных proxy.
5. Найди похожую существующую реализацию и следуй её структуре, именованию и обработке ошибок.
6. Определи минимальную область изменений и связанные типы/конфигурацию/документацию.
7. Только после этого меняй код и выполняй сначала узкие, затем общие проверки.

## Existing patterns

- Проект состоит из отдельных npm-пакетов в корне, `backend/` и `frontend/`; общего workspace package или shared types package нет.
- TypeScript работает в `strict` mode. Backend — ESM/NodeNext и использует суффикс `.js` в локальных imports; frontend — ESM с extensionless imports.
- React-компоненты названы PascalCase, функции и значения — camelCase. UI сейчас организован по страницам, а не по feature-модулям.
- REST handlers объявлены непосредственно в `backend/src/index.ts`; отдельного слоя controller/repository нет. Не вводи такой слой для одиночного изменения без архитектурной необходимости.
- Room/file операции сосредоточены в `rooms.ts`; WebSocket routing и broadcasts — в `realtime.ts`; Docker execution — в `runner.ts`.
- Metadata комнаты передаются JSON-событиями `/ws`, а содержимое редактора и awareness — отдельным бинарным Yjs-протоколом `/yjs/:roomId`.
- Frontend хранит server state и UI state в hooks `RoomPage`; единственный React context — тема. Настройки пользователя сохраняются в `localStorage`/`sessionStorage`.
- Выделенного frontend API client нет: `fetch` находится в страницах, WebSocket отправка — в `RoomPage.send`.
- Runtime schema library отсутствует. Валидация имён файлов выполняется в `rooms.ts`; имя участника проверяется в `realtime.ts`; runner повторно проверяет имена перед созданием tar.
- REST-ошибки возвращаются как `{ message }`; JSON WebSocket-ошибки — событием `error`; runner превращает сбои выполнения в `RunResult` со статусом `error`.
- Структурированного logger нет. Не добавляй случайные `console.log`; текущий единственный operational log сообщает адрес при старте сервера.
- Клиентские и серверные transport types дублируются в двух `types.ts`; при изменении контракта проверяй обе копии.

## Frontend

Frontend находится в `frontend/`. `main.tsx` подключает `ThemeProvider` и React Router. `HomePage` создаёт комнату и переходит на неё. `RoomPage` содержит фактическую бизнес-orchestration клиента: загружает initial state, подключает JSON WebSocket с reconnect/backoff, создаёт `Y.Doc`/`WebsocketProvider`, связывает активный `Y.Text` с Monaco через `MonacoBinding` и отправляет file/run commands.

Небольшую UI-логику держи рядом со страницей. Логику transport URL помещай в `config.ts`, theme-поведение — в `theme.tsx`, shared transport shapes — в `types.ts`. Не создавай несуществующие `features/`, `hooks/` или API-client слои без достаточной причины.

## Backend

Фактические цепочки обработки различаются:

- REST: Express handler в `index.ts` → функции `rooms.ts` либо `runAndBroadcast` → in-memory state/Yjs → JSON response.
- Room events: `/ws` handler в `realtime.ts` → `rooms.ts`/`runner.ts` → broadcast JSON events.
- Editor sync: `/yjs/:roomId` handler в `realtime.ts` → Yjs sync/awareness protocols → in-memory `Y.Doc` → binary broadcasts.
- Execution: `runAndBroadcast` → `runPythonFile` → Docker Engine API через socket → одноразовый Python container → `RunResult` broadcast.

Не представляй код как controller/service/repository архитектуру: этих слоёв здесь нет.

## API changes

При изменении REST или WebSocket API проверь вместе:

- handlers и event routing в `backend/src/index.ts`/`backend/src/realtime.ts`;
- `ClientMessage` в `backend/src/types.ts` и `ServerMessage`/models в `frontend/src/types.ts`;
- producers/consumers в `HomePage.tsx` и `RoomPage.tsx`;
- Vite proxy, оба Nginx-конфига и пути `/api`, `/ws`, `/yjs`, если меняется URL;
- `README.md`, `ARCHITECTURE.md` и `DEPLOY.md`, если меняется публичный контракт или deployment.

## Database

СУБД, ORM, schema и migrations отсутствуют. `Map`-объекты в `rooms.ts` и `realtime.ts` — единственное серверное хранилище. Не создавай миграции и не описывай persistence как существующий. Перезапуск backend теряет комнаты; несколько backend replicas не разделяют состояние.

## Validation

Сначала собирай изменённый пакет, затем весь проект при межпакетных или transport-изменениях:

```bash
npm run build --prefix backend
npm run build --prefix frontend
npm run build
```

Backend build запускает `tsc`; frontend build запускает `tsc && vite build`. Отдельных `typecheck`, `lint` и `test` scripts, test runner и lint-конфигурации сейчас нет. Не выдумывай такие команды и не заявляй о прохождении отсутствующих проверок.

Для runtime-проверки при необходимости используй реальные endpoints и Compose status/logs, описанные в `DEPLOY.md`. Запуск кода требует доступного Docker daemon и нужного runner image.

## Git

- Перед и после работы проверяй `git status` и `git diff`.
- Не меняй несвязанные файлы и не форматируй весь репозиторий ради локальной задачи.
- Сохраняй пользовательские незакоммиченные изменения; не откатывай и не удаляй их.
- Не добавляй `dist/`, `node_modules/`, logs и другие generated artifacts.
- Не выполняй commit, push, reset или checkout пользовательских файлов без явной просьбы.

## Secrets

`.env` игнорируется Git. Публичный пример есть только в `frontend/.env.example`; он не содержит значений production. Backend читает environment напрямую и сам `.env` не загружает. Не коммить токены, SSH keys, Docker credentials, сертификаты или реальные GitHub Actions secrets (`SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY`, `SERVER_PATH`). Для frontend помни, что `VITE_*` попадает в browser bundle и не подходит для секретов.

## Documentation

- Обновляй `README.md`, если меняются установка, команды, конфигурация или видимые возможности.
- Обновляй `ARCHITECTURE.md`, если меняются компоненты, потоки данных, transport boundaries, state/persistence или infrastructure roles.
- Обновляй `DEPLOY.md`, если меняются production Compose, Nginx, CI/CD или server procedure.
- Поддерживай этот файл компактной навигацией для агентов, а не копией полной архитектурной документации.
