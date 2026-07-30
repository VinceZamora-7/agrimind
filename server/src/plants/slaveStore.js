const fs = require("fs");

function createSlaveStore(config) {
  const filePath = config.slaves.storePath;
  let readings = {};
  try { readings = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { readings = {}; }

  function save() {
    const temporary = `${filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(readings, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  }

  function normalize(id, input) {
    const numeric = (name, minimum, maximum) => {
      if (input[name] === undefined || input[name] === null) return null;
      const value = Number(input[name]);
      if (!Number.isFinite(value) || value < minimum || value > maximum) {
        throw Object.assign(new Error(`Invalid ${name}`), { status: 400 });
      }
      return value;
    };
    return {
      slave_id: id,
      soil_moisture_percent: numeric("soil_moisture_percent", 0, 100),
      temperature_c: numeric("temperature_c", -30, 80),
      humidity_percent: numeric("humidity_percent", 0, 100),
      pump_on: Boolean(input.pump_on),
      sensor_on: input.sensor_on !== false,
      received_at: new Date().toISOString(),
    };
  }

  return {
    list: () => Object.values(readings),
    get: (id) => readings[id] || null,
    update(id, input) {
      if (!/^slave-[1-9][0-9]*$/.test(id)) throw Object.assign(new Error("Invalid slave ID"), { status: 400 });
      readings[id] = { ...normalize(id, input), display_name: readings[id]?.display_name || null };
      save();
      return readings[id];
    },
    updateName(id, displayName) {
      if (!/^slave-[1-9][0-9]*$/.test(id)) throw Object.assign(new Error("Invalid slave ID"), { status: 400 });
      const name = String(displayName || "").trim();
      if (name.length < 1 || name.length > 40) throw Object.assign(new Error("Name must be 1 to 40 characters"), { status: 400 });
      readings[id] = { ...(readings[id] || { slave_id: id, sensor_on: false, received_at: null }), display_name: name };
      save();
      return readings[id];
    },
  };
}

module.exports = { createSlaveStore };
