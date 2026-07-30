const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "agrimind-cloud-test-"));
process.env.AGRIMIND_DEVICE_ID = "agrimind-test-001";
process.env.AGRIMIND_DEVICE_TOKEN = "test-device-token-123";
process.env.AGRIMIND_MOBILE_TOKEN = "test-mobile-token-456";
process.env.CLOUD_STORAGE_DIR = storageDir;

const { createServer } = require("../server");

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
