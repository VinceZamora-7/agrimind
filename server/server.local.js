const { createConfig } = require("./src/config/env");
const { createMockCamera } = require("./src/hardware/camera");
const { createMockPir } = require("./src/hardware/pir");
const { createApp } = require("./src/app");

const config = createConfig(__dirname, "local_mock_mode");
config.camera.device = "mock_camera";
const app = createApp({
  config,
  camera: createMockCamera(config),
  pir: createMockPir(),
  startDetector: false,
});

app.listen();
module.exports = app;
