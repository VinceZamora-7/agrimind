const { execFile } = require("child_process");
const { promisify } = require("util");

const runFile = promisify(execFile);

function crc8(bytes) {
  let crc = 0xff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function decodeMeasurement(bytes) {
  if (!Array.isArray(bytes) || bytes.length !== 6) throw new Error("SHT41 returned an incomplete measurement");
  if (crc8(bytes.slice(0, 2)) !== bytes[2] || crc8(bytes.slice(3, 5)) !== bytes[5]) throw new Error("SHT41 CRC validation failed");
  const rawTemperature = (bytes[0] << 8) | bytes[1];
  const rawHumidity = (bytes[3] << 8) | bytes[4];
  const temperatureC = -45 + (175 * rawTemperature) / 65535;
  const humidityPercent = Math.max(0, Math.min(100, -6 + (125 * rawHumidity) / 65535));
  if (temperatureC < -40 || temperatureC > 85) throw new Error("SHT41 temperature is outside the supported farm range");
  return { temperature_c: temperatureC, humidity_percent: humidityPercent };
}

function createEnvironmentSensor(config, options = {}) {
  const settings = config.environmentSensor;
  const execute = options.execute || ((file, args) => runFile(file, args, { timeout: settings.commandTimeoutMs }));
  const samples = [];
  let timer = null;
  let latest = null;
  let lastError = null;
  let consecutiveFailures = 0;
  let onUpdate = () => {};

  function snapshot() {
    const ageMs = latest ? Date.now() - Date.parse(latest.sampled_at) : Infinity;
    const status = !settings.enabled ? "disabled" : !latest ? (lastError ? "offline" : "waiting") : ageMs > settings.staleMs ? "stale" : "online";
    return {
      enabled: settings.enabled,
      status,
      source: "sht41",
      temperature_c: latest?.temperature_c ?? null,
      humidity_percent: latest?.humidity_percent ?? null,
      sampled_at: latest?.sampled_at ?? null,
      sample_count: samples.length,
      averaging_window: settings.windowSize,
      stale_after_seconds: settings.staleMs / 1000,
      bus: settings.bus,
      address: `0x${settings.address.toString(16)}`,
      consecutive_failures: consecutiveFailures,
      error: status === "online" ? null : lastError,
    };
  }

  async function sample() {
    if (!settings.enabled) return snapshot();
    try {
      await execute(settings.toolPath, ["-y", String(settings.bus), `w1@0x${settings.address.toString(16)}`, "0xfd"]);
      await new Promise((resolve) => setTimeout(resolve, settings.measurementDelayMs));
      const result = await execute(settings.toolPath, ["-y", String(settings.bus), `r6@0x${settings.address.toString(16)}`]);
      const bytes = String(result.stdout || "").match(/0x[0-9a-f]{2}/gi)?.map((value) => Number.parseInt(value, 16)) || [];
      const decoded = decodeMeasurement(bytes);
      samples.push(decoded);
      if (samples.length > settings.windowSize) samples.shift();
      latest = {
        temperature_c: Number((samples.reduce((sum, item) => sum + item.temperature_c, 0) / samples.length).toFixed(1)),
        humidity_percent: Number((samples.reduce((sum, item) => sum + item.humidity_percent, 0) / samples.length).toFixed(1)),
        sampled_at: new Date().toISOString(),
      };
      lastError = null;
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      lastError = error.killed ? "SHT41 read timed out" : error.message;
    }
    const value = snapshot();
    onUpdate(value);
    return value;
  }

  function start(callback) {
    onUpdate = typeof callback === "function" ? callback : () => {};
    if (!settings.enabled || timer) return;
    sample();
    timer = setInterval(sample, settings.sampleMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { sample, snapshot, start, stop };
}

module.exports = { crc8, createEnvironmentSensor, decodeMeasurement };
