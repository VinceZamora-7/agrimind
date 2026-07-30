const { createConfig } = require("./src/config/env");
const { createRealCamera } = require("./src/hardware/camera");
const { createRealPir } = require("./src/hardware/pir");
const { createApp } = require("./src/app");

const config = createConfig(__dirname, "orange_pi_hardware_mode");
const app = createApp({
  config,
  camera: createRealCamera(config),
  pir: createRealPir(config),
  startDetector: true,
});

app.listen();
module.exports = app;
