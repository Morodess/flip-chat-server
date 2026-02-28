# FlipChat Server v2

## Railway vars (connect MySQL to service)
Add Variable References to your `flip-chat-server` service:

- MYSQLHOST
- MYSQLPORT
- MYSQLUSER
- MYSQLPASSWORD
- MYSQLDATABASE

Also set:
- ADMIN_USERS=morodess   (comma-separated usernames without @)

## Port
Railway provides `PORT` automatically. Server listens on it and supports WS upgrade on same port.

## Endpoints
- GET /health
- POST /upload/avatar (multipart form-data field: file)
- POST /upload/voice (multipart form-data field: file)
- /uploads/* (static)

## WebSocket URL
Use your Railway public domain:
`wss://flip-chat-server-production.up.railway.app`

## Database wipe (без программ)
В админ-панели клиента есть кнопка **Clear DB** (или отправь WS admin action `clear_db`).
Это удалит сообщения/каналы/санкции, пользователей НЕ трогает.
