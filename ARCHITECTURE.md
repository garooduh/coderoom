# CodeRoom architecture

Этот документ описывает текущую, фактически реализованную архитектуру репозитория. Он не является целевой схемой развития проекта.

## System overview

CodeRoom состоит из browser SPA, одного stateful backend-процесса и Docker Engine, который создаёт одноразовые Python-контейнеры.

```text
Browser
  ├─ HTTP /api/* ───────────────────────┐
  ├─ JSON WebSocket /ws ────────────────┤
  └─ Yjs binary WebSocket /yjs/:roomId ─┤
                                         ↓
                              Node.js / Express backend
                                ├─ room metadata Maps
                                ├─ Y.Doc Maps
                                └─ Docker Engine API over socket
                                                ↓
                                  disposable Python container
```

В production browser сначала обращается к внешнему Nginx из `nginx.code-room.conf`, работающему в отдельном LXC. Он завершает TLS и отправляет весь трафик на frontend Nginx в CodeRoom LXC (`192.168.1.101:8080`); frontend обслуживает SPA и проксирует `/api`, `/ws`, `/yjs` и `/health` в backend по Compose-сети.

Backend является единственным источником room metadata и Yjs state. Состояние не переживает его перезапуск и не разделяется между replicas.

## Components

### Frontend SPA

Расположение: `frontend/`.

Ответственность:

- создание и открытие комнат;
- ввод display name и представление участников;
- Monaco UI и выбор активного файла;
- импорт `.py`/`.txt` файлов перетаскиванием в sidebar;
- Yjs document sync и awareness;
- отправка room commands и отображение результатов запуска;
- локальные UI-настройки.

Ключевые точки входа — `src/main.tsx`, `src/pages/HomePage.tsx` и `src/pages/RoomPage.tsx`. Основные зависимости: React, React Router, Monaco, Yjs, `y-websocket` и `y-monaco`.

### Backend HTTP and realtime server

Расположение: `backend/`.

`src/index.ts` создаёт Express app и `node:http` server, условно подключает CORS, объявляет REST endpoints, вызывает `attachRealtime(server)` и начинает слушать `PORT`.

`src/realtime.ts` создаёт два `WebSocketServer` в режиме `noServer` и маршрутизирует HTTP upgrades:

- точный путь `/ws` — JSON room protocol;
- префикс `/yjs/` — бинарный Yjs sync/awareness protocol;
- прочие upgrade requests закрываются.

### Room state and collaboration

Расположение: `backend/src/rooms.ts`, `backend/src/realtime.ts`.

`rooms.ts` владеет двумя process-local maps:

- `rooms: Map<string, Room>` — room metadata, файлы, пользователи, connections и последний запуск;
- `docs: Map<string, Y.Doc>` — CRDT-текст каждого файла по ключу `file:<fileId>`.

Новая комната получает восьмисимвольный `nanoid`, файл `main.py` с отдельным десятисимвольным id и исходным `print("Hello, world!")`. Пустая комната ставится на удаление через 24 часа. Присоединение отменяет timer; после ухода всех пользователей и закрытия clients timer создаётся снова. Удаление комнаты закрывает connections, уничтожает `Y.Doc`, awareness state и активный запуск.

`realtime.ts` дополнительно хранит `yRooms` с `Awareness` и наборами connections, а также `activeRuns` с одним `AbortController` на комнату.

### Python runner

Расположение: `backend/src/runner.ts`, `runner/Dockerfile`.

Backend не вызывает Docker CLI и не записывает source-файлы на host. Он вручную создаёт tar archive в памяти и использует HTTP API Docker daemon через Unix socket или Windows named pipe:

1. создаёт контейнер из `RUNNER_IMAGE`;
2. задаёт команду `python /app/<entryFile>`;
3. отключает сеть, ограничивает память 128 MiB и CPU до 0.5;
4. загружает все файлы комнаты tar-архивом в `/app`;
5. подключается к multiplexed stdout/stderr, запускает и ожидает контейнер;
6. убивает выполнение при abort, timeout или превышении output limit;
7. принудительно удаляет контейнер в `finally`.

Runner возвращает `RunResult`, а не выбрасывает большинство execution/infrastructure ошибок наружу. По умолчанию timeout равен 15 секундам, общий output limit — 64 KiB.

## Frontend architecture

### Entry point and routing

`frontend/src/main.tsx` монтирует приложение в `#root`, оборачивает его в `React.StrictMode`, `ThemeProvider` и `BrowserRouter`.

Перед монтированием `main.tsx` передаёт локальный Monaco в React loader и подключает editor worker через Vite. Редактор и `y-monaco` используют один экземпляр из npm-зависимостей; версия с CDN не загружается.

Маршрутов два:

- `/` → `HomePage`;
- `/room/:roomId` → `RoomPage`.

Fallback route отсутствует. Production `frontend/nginx.conf` возвращает `index.html` для client-side routes.

### Pages and UI organization

`HomePage` содержит local state создания комнаты, выполняет `POST /api/rooms` и переходит на `/room/<id>`.

`RoomPage` — крупный page component, внутри которого сосредоточены:

- initial REST fetch комнаты;
- display-name form;
- React state комнаты, connection readiness, errors и run result;
- lifecycle JSON WebSocket с exponential reconnect delay до 4 секунд;
- lifecycle `Y.Doc`, `WebsocketProvider`, Monaco model и `MonacoBinding`;
- file commands, run/stop commands и keyboard action;
- динамические стили remote selections;
- cursor position per file и UI preferences.

Отдельных `components/`, `features/`, `hooks/`, state store или API client directories в текущем проекте нет. Общие visual styles находятся в одном `styles.css`.

### State management

Server-derived metadata хранится в React state `RoomPage` и заменяется/дополняется входящими JSON events. Текст файлов не копируется в React state после подключения editor: Monaco model связан с `Y.Text` через `MonacoBinding`.

Theme хранится в React context. `localStorage` хранит theme, display name, font size и sidebar state; `sessionStorage` — client id и случайно выбранный цвет пользователя.

Выбранный файл хранится в локальном state `RoomPage`, поэтому каждый browser может независимо переключать файлы. Если открытый файл удалён другим участником, клиент выбирает первый оставшийся файл.

### API access and errors

Выделенного API abstraction нет. `HomePage` и `RoomPage` вызывают `fetch` напрямую; `RoomPage.send` сериализует JSON WebSocket commands. `frontend/src/config.ts` удаляет trailing slash и выбирает same-origin defaults либо `VITE_API_BASE_URL`/`VITE_WS_BASE_URL`.

Ошибки REST, WebSocket и Yjs connection сводятся к строке `error`; страница показывает not-found panel либо dismissible toast. Формы используют локальную ручную проверку непустого display name. Клиент полагается на backend для правил имён файлов.

## Backend architecture

### Application entry point and HTTP layer

`backend/src/index.ts` содержит весь REST layer:

- `GET /health`;
- `POST /api/rooms`;
- `GET /api/rooms/:roomId`;
- `POST /api/rooms/:roomId/run`.

Отдельных routers, controllers, DTO classes или dependency-injection container нет. REST handlers напрямую вызывают `rooms.ts` и `runAndBroadcast`.

### Business and domain logic

`rooms.ts` реализует создание/поиск/удаление комнаты, membership, file-name rules, file mutations, serialization и TTL.

`realtime.ts` интерпретирует `ClientMessage`, вызывает room functions и рассылает `roomState`, `usersUpdated`, `filesUpdated`, `runStarted`, `runFinished` или `error`. Один room одновременно допускает только один активный запуск.

### Persistence

Persistence layer отсутствует. Нет database client, repositories, filesystem storage, cache server, schema или migrations. `RoomFile.content` сериализуется из соответствующего `Y.Text`; исходное поле metadata не является актуальным источником после редактирования.

### Validation and error handling

Runtime schema validation отсутствует: JSON WebSocket payload приводится к `ClientMessage` TypeScript assertion. Реальные проверки распределены по функциям:

- empty user name — `realtime.ts`;
- room/file existence, supported `.py`/`.txt`, duplicate/path-like names и запрет удаления последнего файла — `rooms.ts`;
- Python-only execution, один run на комнату — `realtime.ts`;
- archive-safe name, duplicate archive names и entry existence — `runner.ts`.

REST not-found/run errors получают HTTP 404/400 и `{ message }`. Ошибки room commands отправляются только инициировавшему socket событием `error`. Runner переводит свои ошибки в `RunResult.status = "error"`; cleanup kill/remove работает best effort.

### Logging and configuration

Структурированного logging layer нет; server пишет только startup URL через `console.log`. Конфигурация читается при module initialization из environment variables, без config module и без dotenv loader.

## Data flow

### 1. Create and join a room

```text
HomePage button
→ POST /api/rooms
→ index.ts
→ rooms.createRoom()
→ Room + Y.Doc created in memory
→ { roomId }
→ React Router /room/:roomId
→ GET /api/rooms/:roomId
→ user submits display name
→ /ws joinRoom
→ room.clients + room.users
→ roomState to caller + usersUpdated broadcast
```

Yjs provider создаётся после ввода display name параллельно с JSON socket. Эти connections решают разные задачи.

Оба WebSocket endpoint проверяются server ping/pong каждые 15 секунд; соединение без ответа закрывается на следующей проверке. При повторном join с тем же client id новое соединение заменяет старое, а закрытие старого не удаляет нового участника. JSON commands доступны после получения `roomState`; редактирование и запуск доступны после синхронизации Yjs и блокируются при потере его соединения. Initial REST response используется только до входа, чтобы запоздавший ответ не перезаписал актуальный WebSocket state.

### 2. Collaborative edit

```text
Monaco edit
→ MonacoBinding
→ local Y.Text update
→ y-websocket binary sync message
→ /yjs/:roomId handler
→ backend Y.Doc
→ binary update to other Yjs connections
→ remote Y.Text
→ remote MonacoBinding/model
```

Awareness (user metadata, cursor and selection) идёт тем же endpoint, но отдельным message type и не записывается в room metadata.

### 3. Import files

```text
Drop .py/.txt files into sidebar
→ browser File API reads text
→ /ws createFile { name, content }
→ rooms.createFile() validates name and creates metadata + Y.Text
→ Yjs update + filesUpdated broadcast
→ every participant receives the imported file and its content
```

### 4. Run or stop Python

```text
Run button / Ctrl+Enter
→ /ws runCode { fileId, current editor content }
→ realtime.runAndBroadcast()
→ runStarted broadcast
→ current Y.Doc files assembled; active content may be overridden by payload
→ runner.runPythonFile()
→ Docker create + archive upload + attach + start + wait
→ stdout/stderr/exitCode collected
→ disposable container removed
→ runFinished broadcast
→ every participant updates output panel
```

`stopCode` aborts the room's `AbortController`, which causes runner to kill the container and return status `stopped`. REST `POST /api/rooms/:roomId/run` reaches the same orchestration but reads all content from server Yjs state and is not used by the current frontend.

## Domain areas

### Rooms and presence

- Frontend: `HomePage.tsx`, room/presence sections of `RoomPage.tsx`.
- Backend: room lifecycle in `rooms.ts`, join/leave and connection cleanup in `realtime.ts`.
- Models/API: `RoomState`, `User`, REST create/get, `roomState` and `usersUpdated`.

### Files and collaborative editing

- Frontend: file list, Monaco model switching and Yjs binding in `RoomPage.tsx`.
- Backend: file metadata/validation in `rooms.ts`, file events and Yjs protocol in `realtime.ts`.
- Models/API: `RoomFile`, `filesUpdated`, `/yjs/:roomId`.

Supported languages are only `python` and `plaintext`, derived from `.py` and `.txt` extensions.

### Code execution

- Frontend: run/stop controls and output panel in `RoomPage.tsx`.
- Backend: orchestration in `realtime.ts`, Docker integration in `runner.ts`.
- Model/API: `RunResult`, `runCode`, `stopCode`, `runStarted`, `runFinished`, REST run endpoint.

## Database

СУБД не используется. Все основные сущности существуют только в памяти:

- `Room` содержит files, users, clients и last run;
- `Y.Doc` содержит `Y.Text` на каждый file id;
- `YRoom` связывает document с awareness и Yjs connections;
- `activeRuns` связывает room id с cancellation controller.

Следствий два: restart теряет все комнаты, а несколько backend instances без sticky routing/shared state будут расходиться.

## API

REST routes объявлены inline в `backend/src/index.ts`. JSON WebSocket dispatch построен как последовательность проверок `message.type` в `backend/src/realtime.ts`. Типы transport contracts находятся отдельно в `backend/src/types.ts` и `frontend/src/types.ts`; code generation или shared package отсутствуют.

Frontend вызывает REST через `fetch`, JSON WebSocket через native `WebSocket`, Yjs protocol через `WebsocketProvider`. Vite и Nginx сохраняют внешние пути `/api`, `/ws` и `/yjs` при proxying.

## Authentication and authorization

Аутентификация и авторизация не реализованы. Room id фактически является единственным locator. Display name, client id и цвет задаются клиентом; backend не выдаёт session/token и не проверяет ownership или роли. Любой подключённый клиент, знающий room id, может менять файлы, запускать и останавливать код. Выбор просматриваемого файла остаётся локальным для клиента.

## Configuration

Backend environment:

- `PORT`, `ALLOWED_ORIGINS` — `backend/src/index.ts`;
- `RUNNER_IMAGE`, `DOCKER_SOCKET`, `RUN_TIMEOUT_MS`, `RUN_OUTPUT_LIMIT_BYTES` — `backend/src/runner.ts`.

Frontend build-time environment:

- `VITE_API_BASE_URL`, `VITE_WS_BASE_URL` — `frontend/src/config.ts`;
- документированный шаблон — `frontend/.env.example`.

Vite development proxy направляет `/api`, `/ws` и `/yjs` на `localhost:4000`. Production defaults используют один origin. Backend включает CORS только при непустом `ALLOWED_ORIGINS`; wildcard явно запрещён.

## Infrastructure

### Docker and Compose

Development Compose запускает Vite и backend с bind mounts, публикует `5173`/`4000`, монтирует Docker socket и использует зеркальный `python:3.12-slim` как runner image.

Production Compose multi-stage собирает backend и frontend. Frontend assets обслуживает Nginx. Backend port привязан к loopback, а frontend port `8080` доступен внешнему Nginx через внутреннюю сеть между LXC; firewall должен ограничивать этот порт локальной сетью. Backend по-прежнему получает host Docker socket.

`runner/Dockerfile` определяет локальный image `collab-python-runner`, который явно собирают `scripts/update.sh` и инструкция `DEPLOY.md`.

### CI/CD and deployment

`.github/workflows/build-images.yml` на push в `main` или `deploy/ghcr-images` собирает и публикует три image в GHCR с тегами `latest` и commit SHA.

`.github/workflows/deploy.yml` на push в `main` подключается к серверу с GitHub secrets, выполняет `git checkout -- .`, затем `scripts/update.sh`. Update script делает `git pull`, останавливает dev/prod Compose stacks, показывает временную maintenance-страницу, локально собирает runner и production services, запускает их и выводит Compose status.

## Important architectural conventions

- Room metadata/commands и collaborative text intentionally используют разные WebSocket protocols.
- `rooms.ts` владеет room/file invariants; `realtime.ts` владеет transport routing и broadcasts; `runner.ts` изолирует Docker API детали.
- Backend local imports используют `.js`, хотя source-файлы имеют `.ts`, из-за NodeNext ESM compilation.
- Server serializes file content из Yjs, а не доверяет сохранённому `RoomFile.content`.
- Backend — stateful singleton; last result и active execution общие для всех участников, а выбранный в UI файл хранится локально у клиента.
- API URL должны оставаться согласованными между `config.ts`, Vite proxy, frontend Nginx и внешним Nginx.
- Runner containers одноразовые; cleanup выполняется независимо от результата выполнения.
- Frontend и backend transport types меняются вручную в двух местах.

## Known inconsistencies and limitations

- `docker-compose.prod.yml` создаёт helper service с образом зеркального `python:3.12-slim`, но backend настроен на отдельный tag `collab-python-runner`. `scripts/update.sh` и `DEPLOY.md` этот image собирают; `start-prod.sh` — нет и требует заранее существующий image.
- Workflow публикует GHCR images, но production Compose использует локальный `build`, а SSH deployment также пересобирает локально. Published images не участвуют в текущем deploy path.
- Transport types продублированы, а runtime schema validation отсутствует; TypeScript не защищает backend от malformed network payloads.
- `/yjs/:roomId` создаёт `Y.Doc` через `getRoomDoc` без проверки существования corresponding `Room`. Обычный UI сначала проверяет комнату по REST, но сам WebSocket endpoint этого не требует.
- Удаление файла удаляет metadata, но не удаляет его `Y.Text` из документа явно; данные освобождаются при уничтожении всей комнаты.
- Нет persistence, authentication, automated tests, linting и structured operational logging. Это описание текущего состояния, а не объявление будущей реализации.
