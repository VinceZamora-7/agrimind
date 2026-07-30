# Agrimind hybrid local/cloud deployment

The Orange Pi remains the hardware controller and owns PIR input, camera capture,
Gemini analysis, Semaphore SMS, two-hour local capture retention, and its local API.
The VPS is a remote monitoring relay that stores only the latest synchronized event
and image. There is no offline upload queue.

## Connection order

1. The mobile app tries each `EXPO_PUBLIC_LOCAL_API_URLS` candidate.
2. If a local `/api/status` request succeeds, the app uses local mode.
3. If all local candidates fail, it tries `EXPO_PUBLIC_CLOUD_API_BASE_URL`.
4. Hardware controls are intentionally local-only in this first cloud version.

In local mode the app also opens `ws://ORANGE_PI:5000/ws` for immediate motion,
capture, completed-event, detection-control, and hardware-error messages. Images and
commands continue over HTTP. The app reconnects automatically and keeps a 15-second
HTTP status check as a fallback. The WebSocket uses the same local API token.

## VPS setup

Install Node.js 20 or newer, copy `cloud-server`, and create its environment file:

```sh
cd cloud-server
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Use different generated values for `AGRIMIND_DEVICE_TOKEN` and
`AGRIMIND_MOBILE_TOKEN`. Start the service with `npm start`, or install it under
systemd. Put the Node service behind an HTTPS reverse proxy and expose only HTTPS.
Do not expose the Orange Pi's port 5000 to the internet.

Example systemd unit:

```ini
[Unit]
Description=Agrimind Cloud Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agrimind
WorkingDirectory=/opt/agrimind/cloud-server
ExecStart=/usr/bin/node /opt/agrimind/cloud-server/server.js
Restart=on-failure
EnvironmentFile=/opt/agrimind/cloud-server/.env

[Install]
WantedBy=multi-user.target
```

Verify the public endpoint:

```sh
curl https://api.example.com/health
```

## Orange Pi setup

Add these values to `/home/orangepi/Agrimind/.env` only after HTTPS is working:

```dotenv
CLOUD_SYNC_ENABLED=true
CLOUD_API_BASE_URL=https://api.example.com
CLOUD_DEVICE_ID=agrimind-farm-001
CLOUD_DEVICE_TOKEN=the-device-token-from-the-vps
CLOUD_SYNC_TIMEOUT_SECONDS=15
```

Restart `agrimind.service`. Each finalized capture makes one upload attempt. If the
VPS or internet is unavailable, the event records a cloud-sync failure locally and
is not queued. The next capture makes a new attempt.

## Mobile setup

Copy the values from `agrimind-mobile/.env.example` into `.env.local`. Set the VPS
URL, the matching device ID, and `EXPO_PUBLIC_CLOUD_MOBILE_TOKEN`, then rebuild or
restart Expo so `EXPO_PUBLIC_` values are embedded.

`EXPO_PUBLIC_` values are readable from a built application. The static mobile token
is suitable only for a private MVP. Replace it with real user authentication and
short-lived access tokens before distributing the app publicly.

## Offline behavior

- Same LAN without internet: local app access, PIR, camera, and storage work.
- Gemini and Semaphore require internet and may fail for that event.
- Different networks with internet: the app reads the most recently synchronized
  event from the VPS.
- No LAN and no internet: the Orange Pi continues local capture, but neither the app
  nor VPS receives updates.
