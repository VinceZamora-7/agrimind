const assert = require("node:assert/strict");
const test = require("node:test");
const { legacySlaveTelemetry } = require("../src/api/router");

test("legacy GET telemetry maps compact values to the Agrimind slave reading", () => {
  const url = new URL("http://localhost/api/slave-telemetry?slaveid=1&soilmoisture=20&relay=1");
  assert.deepEqual(legacySlaveTelemetry(url), {
    slaveId: "slave-1",
    reading: {
      soil_moisture_percent: 20,
      pump_on: true,
      sensor_on: true,
    },
  });
});

test("legacy GET telemetry rejects malformed identifiers and sensor values", () => {
  assert.throws(
    () => legacySlaveTelemetry(new URL("http://localhost/api/slave-telemetry?slaveid-1234&&soilmoisture=20&&relay=1")),
    /Use slaveid=/,
  );
  assert.throws(
    () => legacySlaveTelemetry(new URL("http://localhost/api/slave-telemetry?slaveid=2&soilmoisture=120&relay=0")),
    /between 0 and 100/,
  );
});
