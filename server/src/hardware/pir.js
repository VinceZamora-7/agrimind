const { run, sleep } = require("../utils/process");

function createRealPir(config) {
  return {
    async read() {
      let lastError;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const result = await run("gpioget", ["--chip", config.pir.chip, "--numeric", String(config.pir.line)]);
          return Number(result.stdout.toString("utf8").trim());
        } catch (error) {
          lastError = error;
          if (!String(error.message).toLowerCase().includes("busy")) break;
          await sleep(100 * (attempt + 1));
        }
      }
      throw lastError;
    },
  };
}

function createMockPir() {
  let state = 0;
  return { read: async () => state, set: (value) => { state = value; } };
}
module.exports = { createRealPir, createMockPir };
