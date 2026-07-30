# Agrimind discovery and mobile pairing

## User flow

1. Connect the phone and Orange Pi to the same Wi-Fi.
2. Open the Agrimind app and tap **Search Again** if needed.
3. The app probes local Agrimind discovery endpoints and displays each stable device
   identity it finds.
4. Select the Orange Pi and tap **Pair Device**.
5. The first phone receives an administrator token. The app stores it with Expo
   SecureStore and uses it for HTTP and WebSocket connections.
6. On later launches, choose the remembered device. The app verifies its device ID
   and Ed25519 identity fingerprint before reusing the token.

No laptop, terminal, camera, QR code, or phone MAC address is part of pairing.

## Additional phones

After the first phone pairs, the Orange Pi closes pairing. On the administrator
phone, open the dashboard and press **Allow New Device for 5 Minutes**. A second
phone can then discover the Orange Pi and press **Pair Device**. The window closes
after one new claim or five minutes.

Every app installation receives a different random token. The Orange Pi stores only
token hashes and supports individual client revocation. Mobile operating-system MAC
addresses are not used because they may be unavailable or randomized.

## Remembered devices

Each phone may remember multiple Orange Pis. Secure storage contains each device's:

- stable device ID and display name;
- Ed25519 public-key fingerprint;
- unique client ID, role, and access token;
- last-known local URLs.

When an IP address changes, discovery finds the same stable identity and promotes the
new address to the front of the saved URL list. If local discovery fails, a remembered
device can still be selected so cloud fallback can be attempted.

## Discovery implementation

The Expo Go-compatible prototype probes known URLs and the phone's current IPv4 `/24`
LAN in bounded parallel batches. The public `/api/pairing/info` response identifies
Agrimind devices without exposing event data. Future production builds can add
DNS-SD/mDNS advertising without changing stored device identities or pairing tokens.

## Migration and enforcement

Initial Orange Pi deployment keeps `PAIRING_ENFORCE_AUTH=false` until the first phone
is tested. After successful administrator pairing, set it to `true` and restart the
service. Unpaired API and WebSocket clients will then receive `401 Pairing required`.
