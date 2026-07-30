const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createPairingService } = require("../src/pairing/pairingService");

test("pairing issues unique hashed credentials and supports administrator revocation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agrimind-pairing-test-"));
  const pairing = createPairingService({ pairing: {
    enabled: true,
    enforceAuth: true,
    deviceId: "agrimind-test-001",
    deviceName: "Test Agrimind",
    localUrls: ["http://agrimind.test:5000"],
    storePath: path.join(directory, "pairing.json"),
  } });
  const adminCredentials = pairing.claim({ installation_id: "installation_admin_001", client_name: "Admin phone" });
  assert.throws(
    () => pairing.claim({ installation_id: "installation_member_002", client_name: "Farm tablet" }),
    /Pairing is closed/,
  );
  const admin = pairing.authorize(adminCredentials.access_token);
  pairing.openWindow(admin, 300);
  const memberCredentials = pairing.claim({ installation_id: "installation_member_002", client_name: "Farm tablet" });
  assert.equal(adminCredentials.role, "admin");
  assert.equal(memberCredentials.role, "admin");
  assert.equal(memberCredentials.identity_fingerprint, adminCredentials.identity_fingerprint);
  assert.equal(pairing.info().pairable, false);
  assert.equal(pairing.authorize(adminCredentials.access_token).client_name, "Admin phone");
  assert.equal(pairing.authorize("wrong-token"), null);
  assert.equal(pairing.list().some((client) => Object.hasOwn(client, "token_hash")), false);
  assert.equal(pairing.revoke(memberCredentials.client_id, admin), true);
  assert.equal(pairing.authorize(memberCredentials.access_token), null);
  const stored = fs.readFileSync(path.join(directory, "pairing.json"), "utf8");
  assert.equal(stored.includes(adminCredentials.access_token), false);
});

test("paired phone can register an Expo push token without exposing it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agrimind-push-pairing-"));
  const pairing = createPairingService({ pairing: {
    enabled: true,
    enforceAuth: true,
    deviceId: "agrimind-test-push",
    deviceName: "Push Test Agrimind",
    storePath: path.join(directory, "pairing.json"),
  } });
  const credentials = pairing.claim({ client_name: "Farm Phone", installation_id: "installation_push_123" });
  const registered = pairing.registerPushToken(credentials.client_id, {
    expo_push_token: "ExponentPushToken[test_token_123]",
    platform: "android",
  });
  assert.equal(registered.push_notifications_enabled, true);
  assert.equal(pairing.pushRecipients()[0].token, "ExponentPushToken[test_token_123]");
  assert.equal(pairing.list()[0].push_notifications_enabled, true);
  assert.equal("expo_push_token" in pairing.list()[0], false);
});
