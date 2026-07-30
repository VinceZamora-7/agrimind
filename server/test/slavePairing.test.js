const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createSlavePairingService } = require("../src/plants/slavePairingService");

function service() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agrimind-slave-pairing-"));
  return createSlavePairingService({ slaves: { pairingStorePath: path.join(directory, "slaves.json"), pairingWindowMs: 15 * 60 * 1000 } });
}

test("ESP8266 exchanges one-time claim code for a device-specific token", () => {
  const pairing = service();
  const session = pairing.openWindow("slave-1", "Tomato Zone");
  const claimed = pairing.claim({ slave_id: "slave-1", chip_id: "ESP-A1B2C3", claim_token: session.claim_token, firmware_version: "1.0.0" });
  assert.equal(claimed.slave_id, "slave-1");
  assert.equal(pairing.authorize("slave-1", claimed.api_token).chip_id, "ESP-A1B2C3");
  assert.equal(pairing.authorize("slave-2", claimed.api_token), null);
  assert.throws(() => pairing.claim({ slave_id: "slave-1", chip_id: "ESP-A1B2C3", claim_token: session.claim_token }), /invalid or expired/);
  assert.equal("token_hash" in pairing.list()[0], false);
});

test("ESP8266 rejects an invalid claim code", () => {
  const pairing = service();
  pairing.openWindow("slave-2", "Pepper Zone");
  assert.throws(() => pairing.claim({ slave_id: "slave-2", chip_id: "ESP-D4E5F6", claim_token: "wrong" }), /invalid or expired/);
});
