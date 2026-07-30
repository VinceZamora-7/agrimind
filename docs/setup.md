# Setup

## Requirements

- Node.js 20 or later
- npm
- Expo-compatible Android or iOS device/emulator

## Local API

```sh
cd ~/Agrimind/server
npm start
```

From Flatpak VS Code:

```sh
flatpak-spawn --host bash -lc "cd ~/Agrimind/server && npm start"
```

Verify `http://localhost:5000/api/status` returns JSON.

## Mobile app

Create `agrimind-mobile/.env.local` when the laptop address differs from the default:

```dotenv
EXPO_PUBLIC_API_BASE_URL=http://192.168.18.254:5000
```

Then run:

```sh
cd ~/Agrimind/agrimind-mobile
npm ci
npx expo start -c
```

The phone and API host must be reachable on the same network. Restart Expo after changing the environment file.

## Orange Pi target

The planned server address is `http://192.168.18.5:5000`. On the currently connected REDRAGON camera, `/dev/video0` is the capture interface and `/dev/video1` is its metadata interface. Use the stable `/dev/v4l/by-id/...-video-index0` path from `.env.example` rather than relying on the changeable number. Physical pin 7 maps to `gpiochip0` line 6.

Run the camera-only diagnostic:

```sh
python3 hardware/python/agrimind_capture_only.py
```

After granting the `orangepi` user GPIO access, run the combined PIR/camera diagnostic:

```sh
python3 hardware/python/agrimind_pir_capture.py
```

The production entry point is `server/server.orange-pi.js`. It starts the API and protected PIR detector using the real GPIO and camera adapters.

## Protected analysis modes

- `capture_only` saves images and events without external API calls.
- `manual_analysis` saves automatically and analyzes only through `POST /api/events/:id/analyze`.
- `automatic_analysis` analyzes eligible, non-duplicate events automatically.

Gemini remains blocked unless `GEMINI_ENABLED=true` and `GEMINI_API_KEY` is set. Semaphore remains blocked unless `SEMAPHORE_ENABLED=true`, its key is set, and a recipient is configured. Copy `.env.example` to `.env`, keep `.env` private, and begin in `capture_only`.

The default classification model is the stable `gemini-3.1-flash-lite`. Model identifiers can be retired or restricted by Google, so keep `GEMINI_MODEL` configurable and consult the official Gemini model list when an endpoint returns a model-availability error.

Polling `GET /api/status` is always read-only. It does not capture, classify, send SMS, or consume paid API credit.

Captured images are retained for two hours by default and then permanently deleted. Event JSON, classifications, alert results, and usage records remain. Configure this with `CAPTURE_RETENTION_HOURS` and `CAPTURE_CLEANUP_INTERVAL_MINUTES`.

## Orange Pi service

The server requires Node.js 18.17 or newer. On the current Armbian/Debian installation:

```sh
sudo apt-get update
sudo apt-get install nodejs npm
```

After copying the project to `/home/orangepi/Agrimind`, test it with:

```sh
cd ~/Agrimind/server
npm run start:orange-pi
```

The optional `server/agrimind.service.example` can be installed as `/etc/systemd/system/agrimind.service` after hardware and configuration checks pass.

For the current Orange Pi deployment, run the provided one-time installer:

```sh
cd ~/Agrimind
sudo sh scripts/install-orange-pi-service.sh
```

The installer creates a persistent `gpio` device rule, adds `orangepi` to the required groups, and enables the service. Stop a manually launched server before starting the systemd service.
