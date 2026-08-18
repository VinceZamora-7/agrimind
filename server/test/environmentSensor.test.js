const assert = require("node:assert/strict");
const test = require("node:test");
const { createEnvironmentSensor, decodeMeasurement } = require("../src/hardware/environmentSensor");

test("SHT41 decoder validates CRC and converts temperature and humidity", () => {
  const decoded = decodeMeasurement([0x6d, 0x2f, 0x3c, 0xb0, 0xf1, 0xa3]);
  assert.ok(Math.abs(decoded.temperature_c - 29.6) < 0.1);
  assert.ok(Math.abs(decoded.humidity_percent - 80.4) < 0.1);
  assert.throws(() => decodeMeasurement([0x6d, 0x2f, 0x00, 0xb0, 0xf1, 0xa3]), /CRC/);
});

test("SHT41 service publishes a validated rolling average", async () => {
  const outputs = ["0x6d 0x2f 0x3c 0xb0 0xf1 0xa3", "0x6d 0x2f 0x3c 0xb0 0xf1 0xa3"];
  let reads = 0;
  const service = createEnvironmentSensor({ environmentSensor: {
    enabled: true, bus: 0, address: 0x44, toolPath: "i2ctransfer", sampleMs: 30000,
    staleMs: 180000, windowSize: 5, measurementDelayMs: 0, commandTimeoutMs: 1000,
  } }, { execute: async (_file, args) => args[2].startsWith("r6") ? { stdout: outputs[reads++] } : { stdout: "" } });
  const first = await service.sample();
  assert.equal(first.status, "online");
  assert.equal(first.temperature_c, 29.6);
  assert.equal(first.humidity_percent, 80.4);
  const second = await service.sample();
  assert.equal(second.sample_count, 2);
  assert.ok(Number.isFinite(second.temperature_c));
  assert.ok(Number.isFinite(second.humidity_percent));
});
