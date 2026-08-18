const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WebSocket } = require("ws");

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "agrimind-cloud-test-"));
process.env.AGRIMIND_DEVICE_ID = "agrimind-test-001";
process.env.AGRIMIND_DEVICE_TOKEN = "test-device-token-123";
process.env.AGRIMIND_MOBILE_TOKEN = "test-mobile-token-456";
process.env.CLOUD_STORAGE_DIR = storageDir;

const { createServer, rainForecastToday, relayControlState } = require("../server");

test("automatic relay state enforces rain lock and otherwise delegates to ESP32", () => {
  const reading = { pump_on: true, soil_moisture_percent: 42, relay_command: { control_mode: "automatic" } };
  const rainy = { daily: [{ rain_probability_percent: 70, rain_sum_mm: 2 }] };
  const dry = { daily: [{ rain_probability_percent: 20, rain_sum_mm: 0 }] };
  assert.equal(rainForecastToday(rainy), true);
  assert.deepEqual(relayControlState(reading, rainy), {
    control_mode: "automatic", automation: "rain_lock", action: "OFF", relay: 0, reason: "Rain forecast today",
  });
  assert.deepEqual(relayControlState(reading, dry), {
    control_mode: "automatic", automation: "vps_soil_threshold", action: "ON", relay: 1, threshold: 50,
    reason: "Soil moisture below threshold",
  });
});

test("cloud relay accepts a device event and serves only the latest event", async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const deviceHeaders = {
    "Content-Type": "application/json",
    "X-Device-ID": "agrimind-test-001",
    Authorization: "Bearer test-device-token-123",
  };
  const mobileHeaders = { Authorization: "Bearer test-mobile-token-456" };

  for (const eventId of ["event_first", "event_latest"]) {
    const response = await fetch(`${baseUrl}/api/device/events/latest`, {
      method: "POST",
      headers: deviceHeaders,
      body: JSON.stringify({
        device_id: "agrimind-test-001",
        event: { event_id: eventId, timestamp: new Date().toISOString(), status: "analyzed", ai_result: { label: "animal", confidence: 91 } },
        image: { filename: `${eventId}.jpg`, content_type: "image/jpeg", data_base64: Buffer.from(eventId).toString("base64") },
      }),
    });
    assert.equal(response.status, 200);
  }

  const statusResponse = await fetch(`${baseUrl}/api/devices/agrimind-test-001/status`, { headers: mobileHeaders });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.mode, "cloud_relay");
  assert.equal(status.latest_event.event_id, "event_latest");
  assert.equal(status.recent_events.length, 1);

  const imageResponse = await fetch(`${baseUrl}/api/devices/agrimind-test-001/latest-image`, { headers: mobileHeaders });
  assert.equal(imageResponse.status, 200);
  assert.equal(Buffer.from(await imageResponse.arrayBuffer()).toString(), "event_latest");
  assert.deepEqual(fs.readdirSync(storageDir).sort(), ["agrimind-test-001.jpg", "agrimind-test-001.json"]);
});

test("cloud relay rejects invalid mobile credentials", async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/devices/agrimind-test-001/status`);
  assert.equal(response.status, 401);
});


test("cloud relay accepts ESP32 GET telemetry and includes both slaves in mobile status", async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const [slaveId, moisture, relay] of [["1", "20", "0"], ["2", "65", "1"]]) {
    const response = await fetch(
      `${baseUrl}/api/slave-telemetry?slaveid=${slaveId}&soilmoisture=${moisture}&relay=${relay}`,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  }

  const statusResponse = await fetch(`${baseUrl}/api/devices/agrimind-test-001/status`, {
    headers: { Authorization: "Bearer test-mobile-token-456" },
  });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.slaves.length, 2);
  assert.equal(status.slaves.find((item) => item.slave_id === "slave-1").soil_moisture_percent, 20);
  assert.equal(status.slaves.find((item) => item.slave_id === "slave-2").pump_on, true);
});

test("cloud relay rejects malformed public telemetry", async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(
    `${baseUrl}/api/slave-telemetry?slaveid=1&soilmoisture=150&relay=0`,
  );
  assert.equal(response.status, 400);
});


test("cloud WebSocket broadcasts ESP32 telemetry", async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const socketUrl = baseUrl.replace("http", "ws") + "/ws?token=test-mobile-token-456&deviceid=agrimind-test-001";
  const socket = new WebSocket(socketUrl);
  context.after(() => socket.close());
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const telemetryMessage = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket telemetry timeout")), 2000);
    socket.on("message", (payload) => {
      const message = JSON.parse(payload.toString());
      if (message.type === "slave_telemetry") {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
  const response = await fetch(baseUrl + "/api/slave-telemetry?slaveid=1&soilmoisture=44&relay=1");
  assert.equal(response.status, 200);
  const message = await telemetryMessage;
  assert.equal(message.reading.slave_id, "slave-1");
  assert.equal(message.reading.soil_moisture_percent, 44);
  assert.equal(message.reading.pump_on, true);
});


test("cloud relay command is polled and confirmed by ESP32 telemetry", async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const commandResponse = await fetch(
    baseUrl + "/api/devices/agrimind-test-001/slaves/slave-9/relay-command",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer test-mobile-token-456",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ relay: 1 }),
    },
  );
  assert.equal(commandResponse.status, 202);
  assert.equal((await commandResponse.json()).command.status, "pending");

  const pendingResponse = await fetch(baseUrl + "/api/slave-command?slaveid=9");
  const pending = await pendingResponse.json();
  assert.equal(pending.command.relay, 1);
  assert.equal(pending.command.status, "pending");

  const telemetryResponse = await fetch(
    baseUrl + "/api/slave-telemetry?slaveid=9&soilmoisture=51&relay=1",
  );
  assert.equal(telemetryResponse.status, 200);

  const confirmedResponse = await fetch(baseUrl + "/api/slave-command?slaveid=9");
  const confirmed = await confirmedResponse.json();
  assert.equal(confirmed.command.status, "confirmed");
});


test("public GET relay command needs no token", async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const commandResponse = await fetch(baseUrl + "/api/relay-command?slaveid=7&relay=1");
  assert.equal(commandResponse.status, 200);
  const created = await commandResponse.json();
  assert.equal(created.ok, true);
  assert.equal(created["slave-7"].relay, 1);
  const pollResponse = await fetch(baseUrl + "/api/slave-command?slaveid=7");
  const polled = await pollResponse.json();
  assert.equal(polled.command.relay, 1);
});


test("existing telemetry URL returns the pending relay command", async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fetch(baseUrl + "/api/slave-telemetry?slaveid=8&soilmoisture=40&relay=0");
  await fetch(baseUrl + "/api/relay-command?slaveid=8&relay=1");
  const telemetryResponse = await fetch(
    baseUrl + "/api/slave-telemetry?slaveid=8&soilmoisture=41&relay=0",
  );
  const telemetry = await telemetryResponse.json();
  assert.equal(telemetry.command.relay, 1);
  const confirmationResponse = await fetch(
    baseUrl + "/api/slave-telemetry?slaveid=8&soilmoisture=41&relay=1",
  );
  const confirmation = await confirmationResponse.json();
  assert.equal(confirmation.command, null);
  assert.equal(confirmation.reading.relay_command.status, "confirmed");
});


test("simple slave state exposes only relay and soil moisture", async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fetch(baseUrl + "/api/slave-telemetry?slaveid=6&soilmoisture=62&relay=0");
  await fetch(baseUrl + "/api/relay-command?slaveid=6&relay=1");
  const response = await fetch(baseUrl + "/api/slave-state?slaveid=6");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    "slave-6": {
      control_mode: "manual",
      action: "ON",
      relay: 1,
      reason: "Controlled from mobile application",
      soilmoisture: 62,
    },
  });
});

test("cloud relay stores farm environment and weather for remote mobile status", async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(baseUrl + "/api/device/farm-status", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Device-ID": "agrimind-test-001", Authorization: "Bearer test-device-token-123" },
    body: JSON.stringify({
      device_id: "agrimind-test-001",
      local_environment: { status: "online", source: "sht41", temperature_c: 29.6, humidity_percent: 80.4, sampled_at: new Date().toISOString() },
      weather: { status: "ready", provider: "Open-Meteo", condition: "Partly cloudy", rain_probability_12h_percent: 60 },
      pagasa: { status: "ready", provider: "DOST-PAGASA CAP", alert_groups: { rainfall_flood: [] }, products: { farm_weather: { status: "ready" } } },
    }),
  });
  assert.equal(response.status, 200);
  const statusResponse = await fetch(baseUrl + "/api/devices/agrimind-test-001/status", { headers: { Authorization: "Bearer test-mobile-token-456" } });
  const status = await statusResponse.json();
  assert.equal(status.local_environment.source, "sht41");
  assert.equal(status.local_environment.temperature_c, 29.6);
  assert.equal(status.weather.provider, "Open-Meteo");
  assert.equal(status.pagasa.provider, "DOST-PAGASA CAP");
  assert.equal(status.pagasa.products.farm_weather.status, "ready");
});
