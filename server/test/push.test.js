const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createExpoPush, notificationBody } = require("../src/alerts/expoPush");

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agrimind-push-test-"));
  const pairing = { pushRecipients: () => [{ client_id: "client_test", token: "ExponentPushToken[test_token]", platform: "android" }] };
  const config = { semaphore: { categoryCooldownMs: { SECURITY_HUMAN: 300_000 }, minIntervalMs: 60_000 } };
  return createExpoPush({ config, pairing, historyPath: path.join(directory, "push.json") });
}

test("push excludes heat-index and rain forecast categories", async () => {
  const push = setup();
  assert.equal((await push.send("HEAT_INDEX_HIGH", "Heat")).skip_reason, "push_category_excluded");
  assert.equal((await push.send("RAIN_FORECAST_HIGH", "Rain")).skip_reason, "push_category_excluded");
});

test("push submits enabled security alerts and enforces its own cooldown", async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ data: [{ status: "ok", id: "ticket-1" }] }) };
  };
  const push = setup();
  const first = await push.send("SECURITY_HUMAN", "AGRIMIND SECURITY ALERT\nHuman detected.", { event_id: "event_1" });
  assert.equal(first.sent, true);
  assert.equal(request[0].channelId, "security-alerts");
  assert.equal(request[0].data.event_id, "event_1");
  const second = await push.send("SECURITY_HUMAN", "AGRIMIND SECURITY ALERT\nHuman detected.");
  assert.equal(second.skip_reason, "push_cooldown");
});

test("notification body removes the repeated SMS heading", () => {
  assert.equal(notificationBody("AGRIMIND PLANT ALERT\nTomato needs attention."), "Tomato needs attention.");
});
