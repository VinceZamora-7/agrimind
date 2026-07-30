const path = require("path");
const { createConfig } = require("../src/config/env");
const { createPairingService } = require("../src/pairing/pairingService");

const serverDir = path.join(__dirname, "..");
const config = createConfig(serverDir, "orange_pi_hardware_mode");
const pairing = createPairingService(config);
const info = pairing.info();
console.log(`Agrimind pairing initialized for ${info.device_id}; paired devices: ${info.paired_devices}`);
