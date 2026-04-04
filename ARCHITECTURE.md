# Talk Bridge MVP — Архитектура

> Первая рабочая версия с двухсторонним переводом: `v0.1.0-first-working` (2026-04-03)

## Общая схема

```
Телефон А (client)              Сервер (Render)                    OpenAI Realtime API

  микрофон 48kHz                                                   ┌─────────────────┐
  │                                                                │ gpt-4o-mini      │
  ▼                                                                │ -realtime-preview│
  AudioWorklet                                                     │                  │
  (48kHz→24kHz PCM16)                                              │  STT → перевод   │
  │                                                                │  → TTS (voice)   │
  ▼                              ┌──────────┐                      └────────┬─────────┘
  WS binary ──────────────────►  │ server.ts│                               │
  (PCM16 24kHz, 20ms chunks)     │          │    WS JSON                    │
                                 │feedAudio()──► input_audio_buffer.append ─┘
                                 │          │    (base64 PCM16)
                                 │          │                      ┌─────────────────┐
                                 │          │◄── response.audio.delta ◄──────────────┘
                                 │          │    (base64 PCM16)
                                 │ decode   │
                                 │ base64   │
                                 │          │
  WS binary ◄─────────────────  │sendBinary│   То же самое для
  (PCM16 24kHz)                  │ToRole()  │   Телефона Б (receiver):
  │                              │          │   свой relay к OpenAI,
  ▼                              └──────────┘   свой WS, свой промпт
  Resample 24kHz→48kHz
  │
  ▼
  AudioBufferSourceNode
  │
  ▼
  динамик                      Телефон Б (receiver) — зеркальная схема
```

**Ключевой принцип:** На каждого участника создаётся ОТДЕЛЬНЫЙ relay (WebSocket к OpenAI). Relay участника А переводит речь А и отправляет перевод на устройство Б, и наоборот.

## Карта задержек (end-to-end)

**Сценарий:** Человек А закончил фразу → Человек Б услышал первое слово перевода.

| # | Этап | Где | Задержка | % от общей |
|---|------|-----|----------|------------|
| 1 | Mic capture + AudioWorklet resample (48→24kHz) | Браузер А | **20–40 мс** | ~1–2% |
| 2 | WebSocket binary: браузер → сервер | Сеть | **50–200 мс** | ~3–8% |
| 3 | feedAudio: base64 encode + WS JSON send к OpenAI | Сервер | **1–5 мс** | <1% |
| 4 | **OpenAI VAD: ожидание конца речи** | OpenAI | **800 мс** | **~30–40%** |
| 5 | **OpenAI: распознавание + перевод + синтез речи** | OpenAI | **500–1500 мс** | **~30–50%** |
| 6 | response.audio.delta: base64 decode + WS binary к браузеру | Сервер + сеть | **50–200 мс** | ~3–8% |
| 7 | Resample 24→48kHz + AudioBufferSourceNode schedule + playback | Браузер Б | **20–50 мс** | ~1–2% |

**Итого: ~1500–3000 мс** от конца фразы до первого слова перевода.

### Главные источники задержки

1. **VAD silence detection (800ms)** — OpenAI ждёт 800мс тишины перед тем как считать что фраза закончена. Параметр `silence_duration_ms` в `session.update`. Можно снизить до 500мс, но повышается риск ложных обрывов.

2. **OpenAI model processing (~500–1500ms)** — STT + перевод + TTS. Зависит от длины фразы и загрузки API. Streaming: первый audio delta приходит до окончания генерации.

3. **Сеть (~100–400ms round-trip)** — браузер→Render→OpenAI→Render→браузер. Render в US, добавляет ~50–100мс к каждому hop для пользователей из Европы/Азии.

## Промпт (system instructions)

Файл: `src/server/openai.ts` → `buildTranslationInstructions()`

```
You are a simultaneous interpreter. Your sole function is to translate spoken {sourceLang} into {targetLang}.

ABSOLUTE RULES — VIOLATION IS FAILURE:
1. Listen to what the speaker says, then say ONLY the translation in the target language.
2. You are a transparent translator. You have NO personality, NO opinions, NO thoughts.
3. NEVER respond to the content. If speaker says 'Hello, how are you?' — translate it, do NOT reply.
4. NEVER add anything: no 'sure', no 'okay', no commentary, no greetings, no sign-off.
5. NEVER ask questions. NEVER say 'I didn't understand'. If unclear, stay SILENT.
6. Preserve the speaker's tone, emotion, and intent. Just change the language.
7. If the speaker is silent, you are silent. Do not fill silence.

You are invisible. The listener should feel like the speaker is talking directly to them in their language.
```

**Параметры:**
- `sourceLang` / `targetLang` — берутся из `navigator.language` браузера или настроек сессии. При отсутствии: `"auto-detect"`.
- Промпт одинаковый для обоих relay, но с зеркальными языками.

## Конфигурация OpenAI session

```json
{
  "instructions": "... промпт выше ...",
  "voice": "ash",
  "input_audio_format": "pcm16",
  "output_audio_format": "pcm16",
  "input_audio_transcription": { "model": "whisper-1" },
  "turn_detection": {
    "type": "server_vad",
    "silence_duration_ms": 800,
    "prefix_padding_ms": 400,
    "threshold": 0.4
  }
}
```

- **voice** — настраивается в UI: ash, echo, ballad, verse (male), shimmer, coral (female), alloy, sage (neutral)
- **threshold: 0.4** — порог VAD. Снижен с 0.6 для лучшей работы на телефонах.
- **prefix_padding_ms: 400** — захватывает 400мс аудио ДО обнаружения речи (не теряем начало фразы).

## Файлы проекта

### Сервер (TypeScript, Node.js)

| Файл | Назначение |
|------|------------|
| `src/server/server.ts` | Express + WebSocket сервер. HTTP API, WS signal/binary, debug endpoints |
| `src/server/relay.ts` | Ядро: WebSocket соединения к OpenAI. createRelay, feedAudio, destroyRelay |
| `src/server/openai.ts` | Промпт, маппинг моделей |
| `src/server/store.ts` | In-memory хранилище сессий |
| `src/server/types.ts` | TypeScript типы |

### Клиент (Vanilla JS, ES modules)

| Файл | Назначение |
|------|------------|
| `public/index.html` | Страница клиента (создаёт сессию, QR) |
| `public/join.html` | Страница собеседника (принимает звонок) |
| `public/client.js` | Логика клиента: создание сессии, управление звонком |
| `public/join.js` | Логика собеседника: приём звонка, свайп |
| `public/shared.js` | Общее: connectMediaStream (mic+playback), WS, AudioContext |
| `public/audio-processor.js` | AudioWorklet: MicCaptureProcessor (48kHz→24kHz PCM16) |
| `public/diag.html` | Диагностическая страница |

### Аудио формат на всём пути

**PCM16, 24kHz, mono** — от микрофона до динамика:
- Браузер AudioWorklet: 48kHz float32 → resample → 24kHz int16
- WS binary: raw PCM16 bytes
- Сервер → OpenAI: base64-encoded PCM16
- OpenAI → Сервер: base64-encoded PCM16
- Сервер → Браузер: raw PCM16 bytes
- Браузер playback: PCM16 → float32 → resample 24→48kHz → AudioBufferSourceNode

## Debug endpoints

| Endpoint | Что возвращает |
|----------|----------------|
| `GET /health` | Статус сервера |
| `GET /api/debug/relay-stats` | Счётчики всех relay (feed/translate/amplitude) |
| `GET /api/debug/relay-log` | Последние 200 событий relay |
| `GET /api/debug/session/:id` | Полное состояние сессии + relay + WS |

## Модели

| Ключ | Model ID | Описание |
|------|----------|----------|
| `mini` | `gpt-4o-mini-realtime-preview` | Быстрее, дешевле, основная для MVP |
| `full` | `gpt-4o-realtime-preview` | Лучше качество, дороже |
