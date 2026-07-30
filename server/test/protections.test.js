const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createQuotaGate } = require("../src/ai/quotaGate");
const { parseCandidate } = require("../src/ai/geminiClassifier");
const { hammingDistance } = require("../src/ai/imageFingerprint");
const { createCaptureRetention } = require("../src/events/captureRetention");
const { cameraCandidates } = require("../src/hardware/camera");
const { createRearmGate } = require("../src/events/detector");
const { createSemaphoreSms, normalizeNumber } = require("../src/alerts/semaphoreSms");

function config(overrides = {}) {
  return { gemini: { enabled: true, apiKey: "test-key", model: "test-model", minIntervalMs: 0, maxPerHour: 2, maxPerDay: 3, dailyBudgetUsd: 1, estimatedRequestUsd: 0.1, ...overrides } };
}

test("disabled Gemini blocks before any API call", () => {
  const usagePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agrimind-")), "usage.json");
  const gate = createQuotaGate(config({ enabled: false }), usagePath);
  assert.deepEqual(gate.check(), { allowed: false, reason: "gemini_disabled" });
  assert.equal(fs.existsSync(usagePath), false);
});

test("quota gate enforces hourly request cap", () => {
  const usagePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agrimind-")), "usage.json");
  const gate = createQuotaGate(config(), usagePath);
  gate.record({ status: "success", estimated_cost_usd: 0.1 });
  gate.record({ status: "success", estimated_cost_usd: 0.1 });
  const result = gate.check();
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "hourly_quota");
  assert.ok(result.retry_after_seconds > 0);
  assert.ok(result.retry_at);
});

test("minimum interval includes actionable retry details", () => {
  const usagePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agrimind-")), "usage.json");
  const gate = createQuotaGate(config({ minIntervalMs: 15_000 }), usagePath);
  gate.record({ status: "success", estimated_cost_usd: 0.1 });
  const result = gate.check();
  assert.equal(result.reason, "minimum_interval");
  assert.ok(result.retry_after_seconds >= 14 && result.retry_after_seconds <= 15);
  assert.ok(result.retry_at);
});

test("Gemini structured result accepts only supported labels", () => {
  const response = { candidates: [{ content: { parts: [{ text: JSON.stringify({ label: "animal", confidence: 91, reason: "A dog is visible." }) }] } }] };
  assert.equal(parseCandidate(response).label, "animal");
  response.candidates[0].content.parts[0].text = JSON.stringify({ label: "vehicle", confidence: 50, reason: "" });
  assert.throws(() => parseCandidate(response), /invalid label/);
});

test("perceptual hash distance counts changed bits", () => {
  assert.equal(hammingDistance("00001111", "00111100"), 4);
  assert.equal(hammingDistance("0", "00"), Infinity);
});

test("capture retention deletes only images older than two hours", () => {
  const capturesDir = fs.mkdtempSync(path.join(os.tmpdir(), "agrimind-captures-"));
  const oldImage = path.join(capturesDir, "old.jpg");
  const newImage = path.join(capturesDir, "new.jpg");
  const ignoredLog = path.join(capturesDir, "event.json");
  fs.writeFileSync(oldImage, "old");
  fs.writeFileSync(newImage, "new");
  fs.writeFileSync(ignoredLog, "log");
  const now = Date.now();
  fs.utimesSync(oldImage, new Date(now - 2 * 60 * 60 * 1000 - 1), new Date(now - 2 * 60 * 60 * 1000 - 1));
  const state = { retentionLastRun: null, retentionDeletedFiles: 0, retentionReclaimedBytes: 0 };
  const retention = createCaptureRetention({ capturesDir, retention: { captureMs: 2 * 60 * 60 * 1000, cleanupIntervalMs: 600_000 } }, state);
  const result = retention.cleanup(now);
  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(oldImage), false);
  assert.equal(fs.existsSync(newImage), true);
  assert.equal(fs.existsSync(ignoredLog), true);
});

test("camera discovery keeps the configured device first and removes duplicates", () => {
  const configured = "/dev/video0";
  const candidates = cameraCandidates({ camera: { device: configured } });
  assert.equal(candidates[0], configured);
  assert.equal(new Set(candidates).size, candidates.length);
});

test("PIR gate requires a continuous LOW period before re-arming", () => {
  const gate = createRearmGate({ debounceReadings: 2, rearmLowMs: 5_000, initialValue: 0, initialNow: 0 });
  assert.equal(gate.update(1, 100).canTrigger, false);
  assert.equal(gate.update(1, 600).canTrigger, true);
  assert.equal(gate.consume().armed, false);

  assert.equal(gate.update(0, 1_000).rearmed, false);
  assert.equal(gate.update(0, 5_999).rearmed, false);
  gate.update(1, 6_000);
  assert.equal(gate.update(0, 7_000).rearmed, false);
  const rearmed = gate.update(0, 12_000);
  assert.equal(rearmed.rearmed, true);
  assert.equal(rearmed.armed, true);
});

test("Semaphore recipient normalization accepts Philippine mobile formats", () => {
  assert.equal(normalizeNumber("0917 123 4567"), "639171234567");
  assert.equal(normalizeNumber("+63 998 123 4567"), "639981234567");
  assert.throws(() => normalizeNumber("12345"), /Invalid Philippine mobile number/);
});

test("Agrimind project SMS ledger is capped independently from provider balance", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agrimind-sms-"));
  const usagePath = path.join(directory, "usage.json");
  fs.writeFileSync(usagePath, JSON.stringify([{ timestamp: new Date().toISOString(), sent: true, credits_charged: 2 }]));
  const sms = createSemaphoreSms({ semaphore: {
    enabled: true, apiKey: "test", recipients: ["639171234567"], senderName: "",
    settingsPath: path.join(directory, "settings.json"), projectCreditLimit: 50,
    lowBalanceCredits: 20, maxPerDay: 20, minIntervalMs: 0,
    categoryCooldownMs: {}, dailyWeatherEnabled: false, plantAlertEnabled: false,
    heatAlertEnabled: false, rainAlertEnabled: false, typhoonAlertEnabled: false,
  } }, usagePath);
  const projectBalance = sms.balance();
  assert.equal(projectBalance.credit_limit, 50);
  assert.equal(projectBalance.credits_used, 2);
  assert.equal(projectBalance.credit_balance, 48);
  assert.equal(projectBalance.low_balance_threshold, 20);
  assert.equal(projectBalance.low_balance, false);
});

test("Semaphore master rule blocks every SMS category", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agrimind-sms-master-"));
  const usagePath = path.join(directory, "usage.json");
  const sms = createSemaphoreSms({ semaphore: {
    enabled: true, apiKey: "test", recipients: ["639171234567"], senderName: "",
    settingsPath: path.join(directory, "settings.json"), projectCreditLimit: 50,
    lowBalanceCredits: 20, maxPerDay: 20, minIntervalMs: 0, categoryCooldownMs: {},
    dailyWeatherEnabled: false, plantAlertEnabled: false, heatAlertEnabled: false,
    rainAlertEnabled: false, typhoonAlertEnabled: false,
  } }, usagePath);
  sms.updateRules({ sms_alerts_enabled: false });
  assert.equal(sms.status().allowed, false);
  assert.equal(sms.status().reason, "sms_alerts_disabled");
});
