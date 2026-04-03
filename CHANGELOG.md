# Talk Bridge MVP — Changelog

Все значимые правки проекта. Формат: дата, коммит (сокращённый), что изменено и зачем.

---

## 2026-04-03

### `520155e` — feat: replace P2P browser relay with server-side WebRTC relay

**Суть:** Полная замена архитектуры. Убран P2P-канал между браузерами, сервер теперь сам подключается к OpenAI Realtime через WebRTC (werift) и пересылает переведённое аудио другому браузеру через WS binary.

**Изменённые файлы:**
| Файл | Что изменилось |
|------|----------------|
| `src/server/types.ts` | `peerConnected` → `relayConnected` в `ParticipantState` |
| `src/server/store.ts` | Обновлён `createParticipantState()` |
| `src/server/openai.ts` | Извлечён `buildTranslationInstructions()`, сохранён `createRealtimeClientSecret()` |
| `src/server/relay.ts` | **НОВЫЙ** — ядро серверного relay: werift PC, Opus encode/decode (opusscript), feedAudio, onTranslatedAudio |
| `src/server/server.ts` | Убран P2P-код (broadcastToOther, peer.signal), добавлен binary WS handling, sendBinaryToRole, интеграция relay |
| `public/audio-processor.js` | **НОВЫЙ** — AudioWorklet: MicCaptureProcessor (48kHz→24kHz PCM16), PlaybackProcessor (24kHz→device rate, ring buffer) |
| `public/shared.js` | Убран P2P/OpenAI WebRTC код, добавлен `connectMediaStream()` (mic→WS binary, WS binary→speaker) |
| `public/client.js` | Убрано ~120 строк P2P, переписан `startConversation()` |
| `public/join.js` | Зеркальные изменения client.js |
| `package.json` | Добавлены `werift`, `opusscript` |

**Что удалено:** `PEER_ICE_CONFIG`, `connectOpenAiRealtime()`, muted keepAlive трюк, Perfect Negotiation, STUN серверы Google.

---

### `6d94460` — feat: add diagnostic logging and debug endpoints

**Суть:** Добавлена диагностика на каждом этапе аудио-пайплайна.

**Изменённые файлы:**
| Файл | Что добавлено |
|------|---------------|
| `src/server/relay.ts` | RelayStats (счётчики: feedChunks, opusFramesSent, rtpReceived, decodeErrors и т.д.), периодические логи |
| `src/server/server.ts` | serverAudioStats, `GET /api/debug/relay-stats`, `GET /api/debug/session/:id` |
| `public/shared.js` | Счётчики mic/playback chunks, логи каждые 50 |
| `public/audio-processor.js` | Stats messages каждые 200 фреймов |
| `public/client.js` | Логи mediaHandle, first binary audio |
| `public/join.js` | Аналогичные логи |

---

### `f0775af` — fix: create AudioContext during user gesture to fix iOS silence

**Суть:** AudioContext создавался после нескольких await (fetch), к тому моменту user gesture токен на iOS протухал → AudioContext навсегда suspended → тишина.

**Изменённые файлы:**
| Файл | Что изменилось |
|------|----------------|
| `public/shared.js` | Новая функция `createAudioContextNow()`, `connectMediaStream()` принимает опциональный AudioContext |
| `public/client.js` | Pre-create AudioContext на первый click/touchstart |
| `public/join.js` | Создание AudioContext синхронно в начале `acceptCall()` до await |
| `public/audio-processor.js` | Ring buffer увеличен 200мс → 500мс |

**Статус:** Тишина сохраняется. Серверные счётчики показывают что данные проходят полный путь (wsBinaryIn/Out > 0 для обеих сторон). Проблема может быть в: (а) AudioContext всё ещё suspended, (б) аудио от OpenAI — тишина, (в) Opus encode/decode неверный.

---

### (текущий) — диагностика: сохранение relay stats, уровень громкости, event log

**Суть:** Relay stats уничтожались при завершении звонка. Добавлено: сохранение после destroy, отслеживание max amplitude (чтобы понять тишина ли это), серверный event log.

**Ожидаемый результат:** После следующего звонка relay stats будут доступны с данными об уровне громкости — сразу видно, приходит ли от OpenAI реальное аудио или нули.
