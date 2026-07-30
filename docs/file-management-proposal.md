# Agrimind Project File-Management Proposal

## Purpose

Organize Agrimind as one project with three clear boundaries:

1. `agrimind-mobile/` contains only the Expo/React Native client.
2. `server/` contains the API and orchestration logic and remains the source of truth.
3. `hardware/` contains device-facing scripts and wiring notes for the Orange Pi.

Generated captures and event records belong in `storage/`. They are runtime data, not source code.

## Current-state review

The current root contains:

- A functioning Expo 57 app under `agrimind-mobile/`, including the proposed `src/` modules.
- A local Node.js mock server at root-level `server.local.js`.
- A legacy browser UI under `public/` that conflicts with the API-only architecture.
- Empty root-level `captures/` and `logs/` directories instead of the proposed `storage/` hierarchy.
- No root Git repository or root `.gitignore`; Git currently begins inside `agrimind-mobile/`.
- Local/generated directories inside the mobile project (`node_modules/` and `.expo/`). They are ignored by the mobile `.gitignore`, but account for most of the working-directory size.

The current server still creates and serves `public/`, serves `/` as `index.html`, and writes captures/logs at the project root. Its manual trigger is also named `manual_web_trigger`. Those behaviors should be changed during the migration.

## Proposed structure

```text
Agrimind/
├── .gitignore
├── .env.example
├── README.md
├── agrimind-mobile/
│   ├── App.js
│   ├── app.json
│   ├── babel.config.js
│   ├── global.css
│   ├── index.js
│   ├── metro.config.js
│   ├── package.json
│   ├── package-lock.json
│   ├── tailwind.config.js
│   ├── assets/
│   └── src/
│       ├── api/
│       │   └── agrimindApi.js
│       ├── components/
│       ├── config/
│       │   └── api.js
│       ├── screens/
│       └── theme/
├── server/
│   ├── package.json
│   ├── package-lock.json
│   ├── server.local.js
│   ├── server.orange-pi.js
│   └── src/
│       ├── api/
│       │   ├── router.js
│       │   └── responses.js
│       ├── events/
│       │   ├── eventService.js
│       │   └── eventStore.js
│       ├── hardware/
│       │   ├── camera.js
│       │   └── pir.js
│       ├── ai/
│       │   └── geminiClassifier.js
│       ├── alerts/
│       │   └── semaphoreSms.js
│       ├── config/
│       │   └── env.js
│       └── utils/
│           ├── files.js
│           └── ids.js
├── hardware/
│   ├── python/
│   │   ├── agrimind_pir_capture.py
│   │   ├── agrimind_motion_capture.py
│   │   └── agrimind_capture_only.py
│   └── wiring/
│       └── orange-pi-pir-notes.md
├── storage/
│   ├── captures/
│   │   └── .gitkeep
│   └── logs/
│       └── .gitkeep
├── docs/
│   ├── architecture.md
│   ├── api.md
│   ├── setup.md
│   └── file-management-proposal.md
├── resources/
│   ├── images/
│   ├── diagrams/
│   └── references/
└── scripts/
    ├── start-local-server.sh
    └── start-mobile.sh
```

The `scripts/` directory is an optional addition to the supplied structure. It provides memorable development entry points without mixing launch scripts into application source.

## Directory ownership rules

| Directory | Owns | Must not own |
| --- | --- | --- |
| `agrimind-mobile/` | Screens, components, API client, presentation config | Secrets, sensor/camera access, event persistence |
| `server/` | HTTP API, event workflow, classification and alert orchestration | Mobile UI, static web pages, committed runtime output |
| `hardware/` | Standalone diagnostics, capture helpers, wiring documentation | API routes, UI, credentials |
| `storage/` | Images and JSON generated while the system runs | Source files or permanent documentation |
| `docs/` | Maintained project and API documentation | Runtime logs or copied dependencies |
| `resources/` | Reference material used by the team | Generated captures or application assets |

## File naming and placement

- Use lower camel case for JavaScript modules: `eventService.js`.
- Use kebab case for Markdown documents and shell scripts: `orange-pi-pir-notes.md`.
- Keep UI images used by Expo in `agrimind-mobile/assets/`; keep design/reference images in `resources/images/`.
- Name persisted events `event_<timestamp>_<milliseconds>.json` and capture files `<event_id>_frame_<index>.<ext>`.
- Keep `latest_event.json` only as a replaceable runtime index; event files remain the historical records.
- Keep one responsibility per module. Entry points should assemble modules rather than contain all API, storage, and device logic.

## Configuration and secrets

- Commit `.env.example`, never `.env` or production credentials.
- Server-only variables should include `PORT`, `CAMERA_DEVICE`, GPIO settings, `GEMINI_API_KEY`, and Semaphore credentials.
- Do not put Gemini or Semaphore keys in Expo variables because values bundled into a client app are public.
- Replace the hard-coded mobile host with an Expo public variable such as `EXPO_PUBLIC_API_BASE_URL`. This URL is configuration, not a secret.
- Document laptop and Orange Pi example URLs in `docs/setup.md`; do not require source edits when switching environments.

Suggested `.env.example` values:

```dotenv
PORT=5000
CAMERA_DEVICE=/dev/video1
GPIO_CHIP=gpiochip0
GPIO_LINE=6
GEMINI_API_KEY=
SEMAPHORE_API_KEY=
SEMAPHORE_RECIPIENT=
```

Suggested mobile local environment file (ignored):

```dotenv
EXPO_PUBLIC_API_BASE_URL=http://192.168.18.254:5000
```

## Git and generated-file policy

Use one Git repository rooted at `Agrimind/` so backend, mobile, hardware, and documentation changes can be reviewed together. Before converting, preserve or intentionally import the history from the nested `agrimind-mobile/.git`; simply deleting it would discard the mobile repository metadata.

Recommended root `.gitignore` rules:

```gitignore
# Dependencies and build output
**/node_modules/
**/.expo/
**/dist/
**/web-build/

# Runtime data: retain directory placeholders only
storage/captures/*
!storage/captures/.gitkeep
storage/logs/*
!storage/logs/.gitkeep

# Secrets and local configuration
.env
.env.*
!.env.example
agrimind-mobile/.env*

# Logs, editor, and OS files
*.log
.DS_Store
.vscode/
```

Do not commit `node_modules`, `.expo`, real captures, event logs, API keys, SSH keys, or phone numbers. If a sanitized event or capture is needed for tests, place it in an explicit fixture directory such as `server/test/fixtures/`.

## Migration map

| Current path | Proposed path/action |
| --- | --- |
| `server.local.js` | Move to `server/server.local.js` and change `PROJECT_DIR` to `path.join(__dirname, "..")` |
| `captures/` | Replace with `storage/captures/` |
| `logs/` | Replace with `storage/logs/` |
| `public/` | Remove after confirming no needed assets remain; do not recreate |
| `agrimind-mobile/` | Retain, then incorporate safely into the root repository |
| `agrimind-mobile/node_modules/` | Leave locally ignored; recreate with `npm ci` when needed |
| `agrimind-mobile/.expo/` | Leave locally ignored; Expo recreates it |

While moving the local server:

```js
const PROJECT_DIR = path.join(__dirname, "..");
const CAPTURES_DIR = path.join(PROJECT_DIR, "storage", "captures");
const LOGS_DIR = path.join(PROJECT_DIR, "storage", "logs");
```

Remove `PUBLIC_DIR`, HTML/CSS/JS content-type handling, the root-page fallback, and generic public-file serving. Retain a narrowly scoped `/captures/:filename` handler with traversal protection. Rename `manual_web_trigger` to `manual_app_trigger` or simply `manual_trigger`.

## Recommended migration sequence

1. Back up or commit the current mobile changes; the mobile worktree currently contains modified and untracked source files.
2. Decide how to preserve the nested mobile Git history, then establish a single repository at the project root.
3. Add the root `.gitignore` before staging anything, especially dependencies, Expo state, storage data, and secrets.
4. Create the target directories and placeholder files.
5. Move the local server and update storage paths; verify all six API endpoints and `/captures/:filename`.
6. Remove the web routes and `public/` only after confirming the mobile app no longer depends on them.
7. Move any existing runtime data into `storage/`, then verify a manual trigger writes an image and event JSON there.
8. Add server module boundaries incrementally; keep `server.local.js` working after each extraction.
9. Add setup, architecture, and API documentation before deploying `server.orange-pi.js`.
10. Add automated checks for path traversal, disabled detection, concurrent capture, and malformed event files.

## Acceptance criteria

The file-management migration is complete when:

- The project has a single intentional Git boundary at its root.
- No browser UI or `public/` directory exists.
- The backend serves JSON APIs and capture files only.
- Both server entry points use the same shared `server/src/` modules.
- Runtime output is written only beneath `storage/` and is ignored by Git.
- Mobile code reaches hardware, Gemini, alerts, and persisted events only through the Node.js API.
- Switching between laptop and Orange Pi requires configuration changes, not source edits.
- A fresh checkout can be started from commands documented in `README.md` and `docs/setup.md`.
