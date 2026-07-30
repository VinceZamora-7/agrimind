# HTTP API

Base URL during laptop development: `http://192.168.18.254:5000`

Future Orange Pi base URL: `http://192.168.18.5:5000`

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Detection, PIR, camera, latest event, and recent activity |
| `GET` | `/api/events` | Recent event records |
| `GET` | `/api/images` | Recent capture metadata |
| `POST` | `/api/manual-trigger` | Start a mock/manual detection event |
| `POST` | `/api/detection/on` | Enable detection |
| `POST` | `/api/detection/off` | Disable detection |
| `POST` | `/api/events/:event_id/analyze` | Analyze one saved event, subject to all Gemini gates |
| `GET` | `/captures/:filename` | Read a generated capture image |

All API responses are JSON. Capture responses use their image content type. The backend does not serve a web UI.

`GET` endpoints never invoke Gemini or Semaphore. If `AGRIMIND_API_TOKEN` is configured, all `POST` endpoints require either `X-API-Key` or `Authorization: Bearer` with that token.
