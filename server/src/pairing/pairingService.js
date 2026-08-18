const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function atomicWrite(filePath, data) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function createPairingService(config) {
  fs.mkdirSync(path.dirname(config.pairing.storePath), { recursive: true });
  let data;
  try { data = JSON.parse(fs.readFileSync(config.pairing.storePath, "utf8")); }
  catch { data = null; }
  if (!data) {
    data = {
      version: 1,
      device_id: config.pairing.deviceId,
      created_at: new Date().toISOString(),
      clients: [],
    };
  }
  let migrated = false;
  if (!data.device_name) { data.device_name = config.pairing.deviceName; migrated = true; }
  if (data.setup_secret) { delete data.setup_secret; migrated = true; }
  if (!data.identity_private_key || !data.identity_public_key) {
    const keys = crypto.generateKeyPairSync("ed25519");
    data.identity_private_key = keys.privateKey.export({ type: "pkcs8", format: "pem" });
    data.identity_public_key = keys.publicKey.export({ type: "spki", format: "pem" });
    migrated = true;
  }
  if (data.pairing_open_until === undefined) { data.pairing_open_until = null; migrated = true; }
  if (migrated || !fs.existsSync(config.pairing.storePath)) atomicWrite(config.pairing.storePath, data);
  const identityFingerprint = crypto.createHash("sha256").update(data.identity_public_key).digest("hex");
  function safeEqual(leftValue, rightValue) {
    const left = Buffer.from(String(leftValue || ""));
    const right = Buffer.from(String(rightValue || ""));
    return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
  }

  function save() { atomicWrite(config.pairing.storePath, data); }

  function claim({ client_name: clientName, installation_id: installationId }) {
    if (!config.pairing.enabled) throw Object.assign(new Error("Pairing is disabled"), { status: 403 });
    const firstPairing = data.clients.length === 0;
    const windowAuthorized = Boolean(data.pairing_open_until && new Date(data.pairing_open_until).getTime() > Date.now());
    const alwaysAllowed = Boolean(config.pairing.allowAlways);
    if (!firstPairing && !windowAuthorized && !alwaysAllowed) {
      throw Object.assign(new Error("Pairing is closed. Ask an administrator to allow a new device."), { status: 403 });
    }
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(installationId || "")) throw Object.assign(new Error("Invalid installation ID"), { status: 400 });
    const name = String(clientName || "Agrimind Mobile").trim().slice(0, 80) || "Agrimind Mobile";
    const token = crypto.randomBytes(32).toString("base64url");
    const existingIndex = data.clients.findIndex((client) => client.installation_id === installationId);
    const client = {
      client_id: `client_${crypto.randomBytes(8).toString("hex")}`,
      installation_id: installationId,
      client_name: name,
      role: "admin",
      token_hash: tokenHash(token),
      paired_at: new Date().toISOString(),
      last_seen_at: null,
    };
    if (existingIndex >= 0) data.clients.splice(existingIndex, 1, client);
    else data.clients.push(client);
    if (!firstPairing) data.pairing_open_until = null;
    save();
    return { device_id: data.device_id, device_name: data.device_name, identity_fingerprint: identityFingerprint, client_id: client.client_id, role: client.role, access_token: token };
  }

  function authorize(token) {
    if (!token) return null;
    const hash = tokenHash(token);
    const client = data.clients.find((item) => safeEqual(item.token_hash, hash));
    if (!client) return null;
    const now = new Date().toISOString();
    if (!client.last_seen_at || Date.now() - new Date(client.last_seen_at).getTime() > 60_000) {
      client.last_seen_at = now;
      save();
    }
    return client;
  }

  function list() {
    return data.clients.map(({ token_hash: _tokenHash, installation_id: _installationId, expo_push_token: expoPushToken, ...client }) => ({
      ...client,
      push_notifications_enabled: Boolean(expoPushToken),
    }));
  }

  function registerPushToken(clientId, value) {
    const client = data.clients.find((item) => item.client_id === clientId);
    if (!client) throw Object.assign(new Error("Paired device not found"), { status: 404 });
    const token = String(value?.expo_push_token || "").trim();
    if (!/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/.test(token)) {
      throw Object.assign(new Error("Invalid Expo push token"), { status: 400 });
    }
    for (const item of data.clients) {
      if (item.client_id !== clientId && item.expo_push_token === token) delete item.expo_push_token;
    }
    client.expo_push_token = token;
    client.push_platform = ["android", "ios"].includes(value?.platform) ? value.platform : null;
    client.push_registered_at = new Date().toISOString();
    save();
    return { push_notifications_enabled: true, push_registered_at: client.push_registered_at };
  }

  function pushRecipients() {
    return data.clients
      .filter((client) => client.expo_push_token)
      .map((client) => ({ client_id: client.client_id, token: client.expo_push_token, platform: client.push_platform }));
  }

  function revoke(clientId, requester) {
    if (requester?.role !== "admin") throw Object.assign(new Error("Administrator access required"), { status: 403 });
    const before = data.clients.length;
    data.clients = data.clients.filter((client) => client.client_id !== clientId);
    if (data.clients.length === before) return false;
    save();
    return true;
  }

  function openWindow(requester, seconds = 300) {
    if (requester?.role !== "admin") throw Object.assign(new Error("Administrator access required"), { status: 403 });
    const duration = Math.max(30, Math.min(300, Number(seconds) || 300));
    data.pairing_open_until = new Date(Date.now() + duration * 1000).toISOString();
    save();
    return data.pairing_open_until;
  }

  function closeWindow(requester) {
    if (requester?.role !== "admin") throw Object.assign(new Error("Administrator access required"), { status: 403 });
    data.pairing_open_until = null;
    save();
  }

  function info() {
    const alwaysAllowed = Boolean(config.pairing.allowAlways);
    return {
      device_id: data.device_id,
      device_name: data.device_name,
      identity_fingerprint: identityFingerprint,
      pairing_enabled: config.pairing.enabled,
      pairable: alwaysAllowed || data.clients.length === 0 || Boolean(data.pairing_open_until && new Date(data.pairing_open_until).getTime() > Date.now()),
      pairing_open_until: data.pairing_open_until,
      authentication_enforced: config.pairing.enforceAuth,
      paired_devices: data.clients.length,
    };
  }

  return { authorize, claim, closeWindow, info, list, openWindow, pushRecipients, registerPushToken, revoke };
}

module.exports = { createPairingService, tokenHash };
