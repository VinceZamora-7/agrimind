# Agrimind Detection System

Agrimind is a smart farm security system. A Node.js API coordinates motion detection, image capture, AI classification, event storage, and future SMS alerts. The Expo app is the client UI.

## Project layout

- `agrimind-mobile/` — Expo/React Native client
- `server/` — local and Orange Pi Node.js API entry points
- `hardware/` — device scripts and wiring notes
- `storage/` — generated captures and event JSON (ignored by Git)
- `docs/` — architecture, API, setup, and file-management documentation
- `resources/` — design and reference material
- `scripts/` — local development launch helpers

## Local development

Start the API:

```sh
cd server
npm start
```

Start Expo in a second terminal:

```sh
cd agrimind-mobile
npm start -- --clear
```

The mobile app defaults to `http://192.168.18.254:5000`. Override it in `agrimind-mobile/.env.local`:

```dotenv
EXPO_PUBLIC_API_BASE_URL=http://192.168.18.254:5000
```

See `docs/setup.md` for complete instructions.

The Orange Pi server defaults to `capture_only`: PIR events and images are stored locally, while Gemini and Semaphore remain disabled until explicitly configured. Cost protections include PIR debounce, a 10-second cooldown and 15-second grouping window, perceptual duplicate detection, minimum API intervals, hourly/daily request caps, a daily estimated-cost circuit breaker, and limited retries.
# agrimind
