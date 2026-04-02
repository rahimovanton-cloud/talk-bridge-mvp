# Talk Bridge MVP

MVP сервиса живого разговора с переводом `web-to-web` по QR-инвайту.

## Что уже реализовано

- страница клиента с выбором модели `Mini / Full`
- создание краткоживущей сессии
- генерация invite URL и QR-кода
- страница входящего разговора по `join/:inviteToken`
- in-memory хранение `ConversationSession`
- WebSocket signaling для статусов и peer-событий
- bootstrap ephemeral client secret для `OpenAI Realtime`
- WebRTC-подключение браузера к `OpenAI Realtime`
- browser-to-browser передача переведённого аудио-трека
- экраны активного разговора и завершения

## Стек

- Node.js
- TypeScript
- Express
- ws
- QRCode

## Переменные окружения

Скопируйте `.env.example` в `.env` и заполните:

- `OPENAI_API_KEY` — обязательный ключ OpenAI
- `PUBLIC_BASE_URL` — публичный HTTPS URL сервиса на Render
- `PORT` — локальный порт, по умолчанию `3000`
- `DEFAULT_CLIENT_NAME` — дефолтное имя клиента
- `DEFAULT_CLIENT_PHOTO_URL` — ссылка на фото клиента, по умолчанию `/assets/client-photo.jpg`
- `DEFAULT_LANGUAGE_HINT` — дефолтная языковая подсказка, например `ru`

## Локальный запуск

```bash
npm install
npm run dev
```

Открыть:

- `http://localhost:3000/` — экран клиента
- `http://localhost:3000/join/<inviteToken>` — экран собеседника

## Сборка

```bash
npm run build
```

## Render

Проект подготовлен под `Web Service`.

- Build Command: `npm install && npm run build`
- Start Command: `npm start`
- Environment: `Node`

## Текущее ограничение

Архитектура уже заведена под реальный поток `browser -> OpenAI Realtime -> peer browser`, но без валидного `OPENAI_API_KEY` и публичного `HTTPS` нельзя проверить полный сценарий на Safari/iPhone.
