const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv(path.join(__dirname, ".env"));
const config = {
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT) || 8080,
  deviceId: process.env.AGRIMIND_DEVICE_ID || "",
  deviceToken: process.env.AGRIMIND_DEVICE_TOKEN || "",
  mobileToken: process.env.AGRIMIND_MOBILE_TOKEN || "",
  storageDir: path.resolve(__dirname, process.env.CLOUD_STORAGE_DIR || "storage"),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES) || 2 * 1024 * 1024,
};

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function bearer(req) {
  const value = req.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-ID",
  });
  res.end(`${JSON.stringify(data, null, 2)}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > config.maxUploadBytes) {
        reject(Object.assign(new Error("Upload is too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function atomicWrite(filePath, data) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, filePath);
}

function validDeviceId(value) {
  return /^[A-Za-z0-9_-]{3,64}$/.test(value || "");
}

function eventPath(deviceId) { return path.join(config.storageDir, `${deviceId}.json`); }
function imagePath(deviceId) { return path.join(config.storageDir, `${deviceId}.jpg`); }

function publicStatus(record) {
  if (!record) return null;
  const event = {
    ...record.event,
    best_image: {
      filename: record.image.filename,
      url: `/api/devices/${encodeURIComponent(record.device_id)}/latest-image`,
      available: true,
    },
  };
  return {
    app: "Agrimind Cloud Relay",
    mode: "cloud_relay",
    server_time: new Date().toISOString(),
    connection: "cloud",
    device_id: record.device_id,
    last_synced_at: record.received_at,
    detection_enabled: null,
    is_capturing: false,
    latest_event: event,
    recent_events: [event],
    recent_images: [{ filename: record.image.filename, url: event.best_image.url }],
  };
}

function readRecord(deviceId) {
  try { return JSON.parse(fs.readFileSync(eventPath(deviceId), "utf8")); }
  catch { return null; }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });

  if (req.method === "POST" && url.pathname === "/api/device/events/latest") {
    const deviceId = req.headers["x-device-id"];
    if (!safeEqual(deviceId, config.deviceId) || !safeEqual(bearer(req), config.deviceToken)) {
      return json(res, 401, { ok: false, error: "Invalid device credentials" });
    }
    const body = await readBody(req);
    if (!validDeviceId(body.device_id) || body.device_id !== deviceId || !body.event?.event_id || !body.image?.data_base64) {
      return json(res, 400, { ok: false, error: "Invalid event payload" });
    }
    const image = Buffer.from(body.image.data_base64, "base64");
    if (!image.length || image.length > config.maxUploadBytes) return json(res, 400, { ok: false, error: "Invalid image" });
    const record = {
      device_id: body.device_id,
      received_at: new Date().toISOString(),
      event: body.event,
      image: { filename: path.basename(body.image.filename || "capture.jpg"), content_type: "image/jpeg", bytes: image.length },
    };
    atomicWrite(imagePath(deviceId), image);
    atomicWrite(eventPath(deviceId), `${JSON.stringify(record, null, 2)}\n`);
    return json(res, 200, { ok: true, event_id: record.event.event_id, received_at: record.received_at });
  }

  const statusMatch = url.pathname.match(/^\/api\/devices\/([A-Za-z0-9_-]+)\/status$/);
  const eventsMatch = url.pathname.match(/^\/api\/devices\/([A-Za-z0-9_-]+)\/events$/);
  const imageMatch = url.pathname.match(/^\/api\/devices\/([A-Za-z0-9_-]+)\/latest-image$/);
  if (statusMatch || eventsMatch || imageMatch) {
    if (!safeEqual(bearer(req), config.mobileToken)) return json(res, 401, { ok: false, error: "Unauthorized" });
    const deviceId = (statusMatch || eventsMatch || imageMatch)[1];
    const record = readRecord(deviceId);
    if (!record) return json(res, 404, { ok: false, error: "Device has not synchronized an event" });
    if (statusMatch) return json(res, 200, publicStatus(record));
    if (eventsMatch) return json(res, 200, publicStatus(record).recent_events);
    const filePath = imagePath(deviceId);
    if (!fs.existsSync(filePath)) return json(res, 404, { ok: false, error: "Image not found" });
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    return fs.createReadStream(filePath).pipe(res);
  }
  return json(res, 404, { ok: false, error: "Route not found" });
}

function createServer() {
  fs.mkdirSync(config.storageDir, { recursive: true });
  if (!config.deviceId || !config.deviceToken || !config.mobileToken) {
    throw new Error("AGRIMIND_DEVICE_ID, AGRIMIND_DEVICE_TOKEN, and AGRIMIND_MOBILE_TOKEN are required");
  }
  return http.createServer((req, res) => route(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { ok: false, error: error.status ? error.message : "Internal server error" });
  }));
}

if (require.main === module) {
  createServer().listen(config.port, config.host, () => console.log(`Agrimind Cloud Relay listening on ${config.host}:${config.port}`));
}

module.exports = { createServer, config, publicStatus, safeEqual };
