# Production deployment

Production работает в same-origin режиме:

- frontend: `https://code-room.ru/`;
- REST API: `https://code-room.ru/api/*`;
- WebSocket: `wss://code-room.ru/ws` и `wss://code-room.ru/yjs/:roomId`.

Frontend не содержит production-домен: по умолчанию API использует `/api`, а
WebSocket URL строится из текущих protocol и host. Nginx сохраняет префикс
`/api`, потому что Express-маршруты объявлены как `/api/rooms`.

## Переменные окружения

Production не требует frontend URL-переменных и не требует CORS. Не задавайте
`ALLOWED_ORIGINS`, если frontend и backend доступны через один origin.

Для отдельного frontend в локальной разработке доступны:

```dotenv
VITE_API_BASE_URL=http://localhost:4000/api
VITE_WS_BASE_URL=ws://localhost:4000
```

Пример находится в `frontend/.env.example`. Backend принимает необязательный
список разрешённых origins через запятую:

```dotenv
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

Wildcard `*` не поддерживается. Остальные production-переменные backend заданы
в `docker-compose.prod.yml`: `PORT`, `RUNNER_IMAGE`, `RUN_TIMEOUT_MS` и
`RUN_OUTPUT_LIMIT_BYTES`.

## Сборка и запуск

На сервере из корня репозитория:

```bash
docker build -t collab-python-runner ./runner
docker compose -f docker-compose.prod.yml config
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=100 backend frontend
```

Backend публикуется только на loopback-порту `4000`. Frontend публикуется на
порту `8080` LXC-контейнера CodeRoom, чтобы отдельный LXC с внешним Nginx мог
обращаться к нему по внутренней сети. Доступ к `8080` должен быть ограничен
локальной сетью или firewall. Docker socket, смонтированный в backend для
запуска пользовательского кода, требует отдельного усиления безопасности на
публичном сервере.

## Nginx и HTTPS

Внешний Nginx работает в отдельном LXC и направляет весь трафик CodeRoom на
frontend (`192.168.1.101:8080`). Внутренний Nginx frontend обслуживает SPA и
проксирует `/api`, `/health`, `/ws` и `/yjs` в backend по Compose-сети.
WebSocket-заголовки и forwarded headers передаются на обоих proxy-уровнях.

При существующих сертификатах Let's Encrypt:

```bash
sudo install -m 0644 nginx.code-room.conf /etc/nginx/sites-available/code-room.conf
sudo ln -sfn /etc/nginx/sites-available/code-room.conf /etc/nginx/sites-enabled/code-room.conf
sudo nginx -t
sudo systemctl reload nginx
```

Если пути сертификатов отличаются, измените только `ssl_certificate` и
`ssl_certificate_key` перед `nginx -t`.

## Проверка и обновление

```bash
curl -fsS https://code-room.ru/health
curl -i -X POST https://code-room.ru/api/rooms
docker compose -f docker-compose.prod.yml logs --tail=100 backend frontend
```

Для последующих обновлений:

```bash
git pull --ff-only origin main
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
sudo nginx -t && sudo systemctl reload nginx
```
