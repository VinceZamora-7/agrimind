# Architecture

```text
Expo mobile client
        |
        | HTTP API
        v
Node.js server (source of truth)
   |        |        |        |
   PIR    camera   Gemini    SMS
                    |
              storage/events
```

The mobile app displays state and sends user commands. It never accesses hardware, secrets, captures on disk, Gemini, or Semaphore directly.

The local entry point simulates the PIR and camera. The future Orange Pi entry point will use real device adapters. Shared API, event, AI, alert, and utility modules belong under `server/src/`.

Runtime captures and JSON event records live under `storage/` and are exposed only through API responses and the narrow `/captures/:filename` route.
