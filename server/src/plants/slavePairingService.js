const crypto = require("crypto");
const fs = require("fs");

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ""));
  const right = Buffer.from(String(rightValue || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function createSlavePairingService(config) {
  const filePath = config.slaves.pairingStorePath;
  let data;
  try { data = JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { data = { version: 1, sessions: [], devices: [] }; }
  if (!Array.isArray(data.sessions)) data.sessions = [];
  if (!Array.isArray(data.devices)) data.devices = [];

  function save() {
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  }
  function prune() {
    data.sessions = data.sessions.filter((session) => new Date(session.expires_at).getTime() > Date.now());
  }
  function validateSlaveId(slaveId) {
    if (!/^slave-[1-9][0-9]*$/.test(slaveId || "")) throw Object.assign(new Error("Invalid slave ID"), { status: 400 });
  }

  function openWindow(slaveId, displayName) {
    validateSlaveId(slaveId);
    prune();
    const claimToken = crypto.randomBytes(32).toString("base64url");
    const session = {
      slave_id: slaveId,
      display_name: String(displayName || slaveId).trim().slice(0, 40) || slaveId,
      claim_hash: hash(claimToken),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + config.slaves.pairingWindowMs).toISOString(),
    };
    data.sessions = data.sessions.filter((item) => item.slave_id !== slaveId);
    data.sessions.push(session);
    save();
    return { slave_id: slaveId, display_name: session.display_name, claim_token: claimToken, expires_at: session.expires_at };
  }

  function claim(input) {
    const slaveId = String(input?.slave_id || "");
    validateSlaveId(slaveId);
    const chipId = String(input?.chip_id || "").trim();
    if (!/^[A-Za-z0-9:_-]{4,64}$/.test(chipId)) throw Object.assign(new Error("Invalid ESP8266 chip ID"), { status: 400 });
    prune();
    const sessionIndex = data.sessions.findIndex((item) => item.slave_id === slaveId && safeEqual(item.claim_hash, hash(input?.claim_token)));
    if (sessionIndex < 0) throw Object.assign(new Error("Slave pairing code is invalid or expired"), { status: 403 });
    const session = data.sessions[sessionIndex];
    data.sessions.splice(sessionIndex, 1);
    const apiToken = crypto.randomBytes(32).toString("base64url");
    const device = {
      slave_id: slaveId,
      display_name: session.display_name,
      chip_id: chipId,
      token_hash: hash(apiToken),
      firmware_version: String(input?.firmware_version || "").trim().slice(0, 40) || null,
      paired_at: new Date().toISOString(),
      last_seen_at: null,
    };
    data.devices = data.devices.filter((item) => item.slave_id !== slaveId && item.chip_id !== chipId);
    data.devices.push(device);
    save();
    return { slave_id: slaveId, display_name: device.display_name, api_token: apiToken, telemetry_path: `/api/slaves/${slaveId}/telemetry` };
  }

  function authorize(slaveId, token) {
    if (!token) return null;
    const tokenDigest = hash(token);
    const device = data.devices.find((item) => item.slave_id === slaveId && safeEqual(item.token_hash, tokenDigest));
    if (!device) return null;
    if (!device.last_seen_at || Date.now() - new Date(device.last_seen_at).getTime() > 60_000) {
      device.last_seen_at = new Date().toISOString();
      save();
    }
    return device;
  }

  function list() {
    prune();
    return data.devices.map(({ token_hash: _tokenHash, ...device }) => device);
  }

  return { authorize, claim, list, openWindow };
}

module.exports = { createSlavePairingService, hash };
