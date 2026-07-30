const fs = require("fs");
const path = require("path");
const { run, sleep } = require("../utils/process");

function imageRecord(config, eventId, index, extension = "jpg") {
  const filename = `${eventId}_frame_${index}.${extension}`;
  return { index, filename, path: path.join(config.capturesDir, filename), url: `/captures/${filename}` };
}

function listDirectory(directory) {
  try { return fs.readdirSync(directory).map((name) => path.join(directory, name)); }
  catch { return []; }
}

function cameraCandidates(config) {
  const byId = listDirectory("/dev/v4l/by-id")
    .filter((device) => !device.includes("video-index") || device.includes("video-index0"))
    .sort();
  const video = listDirectory("/dev")
    .filter((device) => /^\/dev\/video[0-9]+$/.test(device))
    .sort((left, right) => Number(left.match(/\d+$/)[0]) - Number(right.match(/\d+$/)[0]));
  return [...new Set([config.camera.device, ...byId, ...video].filter(Boolean))];
}

function createRealCamera(config) {
  let activeDevice = null;
  let lastError = null;
  let lastDiscoveryAt = null;
  let lastSuccessfulCaptureAt = null;
  let discoveryPromise = null;
  let testedCandidates = [];

  async function probe(device) {
    if (!fs.existsSync(device)) return false;
    const probePath = path.join(config.capturesDir, `.camera_probe_${process.pid}_${Date.now()}.jpg`);
    try {
      await run("fswebcam", ["-q", "-d", device, "-r", config.camera.resolution, "--no-banner", probePath]);
      return fs.existsSync(probePath) && fs.statSync(probePath).size >= config.camera.minimumBytes;
    } catch (error) {
      lastError = `${device}: ${error.message}`;
      return false;
    } finally {
      fs.rmSync(probePath, { force: true });
    }
  }

  async function discover(force = false) {
    if (!force && activeDevice && fs.existsSync(activeDevice)) return activeDevice;
    if (discoveryPromise) return discoveryPromise;
    discoveryPromise = (async () => {
      lastDiscoveryAt = new Date().toISOString();
      testedCandidates = [];
      const candidates = config.camera.autoDiscovery ? cameraCandidates(config) : [config.camera.device];
      for (const candidate of candidates) {
        testedCandidates.push(candidate);
        if (await probe(candidate)) {
          activeDevice = candidate;
          lastError = null;
          console.log(`Camera selected: ${candidate}`);
          return candidate;
        }
      }
      activeDevice = null;
      lastError = candidates.length ? "No camera candidate produced a valid image" : "No V4L2 camera device found";
      console.error(`Camera discovery failed: ${lastError}`);
      return null;
    })().finally(() => { discoveryPromise = null; });
    return discoveryPromise;
  }

  async function captureFrame(device, image) {
    await run("fswebcam", ["-q", "-d", device, "-r", config.camera.resolution, "--no-banner", image.path]);
    image.file_size = fs.statSync(image.path).size;
    if (image.file_size < config.camera.minimumBytes) {
      fs.rmSync(image.path, { force: true });
      throw new Error(`Camera produced an invalid ${image.file_size}-byte frame`);
    }
  }

  async function captureBurstOnce(eventId, device) {
    const images = [];
    try {
      for (let index = 1; index <= config.camera.burstCount; index += 1) {
        const image = imageRecord(config, eventId, index);
        images.push(image);
        await captureFrame(device, image);
        if (index < config.camera.burstCount) await sleep(config.camera.burstIntervalMs);
      }
      lastSuccessfulCaptureAt = new Date().toISOString();
      lastError = null;
      return images;
    } catch (error) {
      for (const image of images) fs.rmSync(image.path, { force: true });
      lastError = `${device}: ${error.message}`;
      throw error;
    }
  }

  return {
    initialize: () => discover(true),
    async captureBurst(eventId) {
      let device = await discover();
      if (!device) {
        await sleep(config.camera.discoveryRetryMs);
        device = await discover(true);
      }
      if (!device) throw new Error(lastError || "No working camera found");
      try {
        return await captureBurstOnce(eventId, device);
      } catch (firstError) {
        console.error(`Camera capture failed on ${device}; rediscovering: ${firstError.message}`);
        activeDevice = null;
        const recoveredDevice = await discover(true);
        if (!recoveredDevice) throw firstError;
        return captureBurstOnce(eventId, recoveredDevice);
      }
    },
    status() {
      return {
        configured_device: config.camera.device,
        active_device: activeDevice,
        auto_discovery: config.camera.autoDiscovery,
        resolution: config.camera.resolution,
        burst_count: config.camera.burstCount,
        state: activeDevice ? "ready" : discoveryPromise ? "discovering" : "unavailable",
        last_discovery_at: lastDiscoveryAt,
        last_successful_capture_at: lastSuccessfulCaptureAt,
        last_error: lastError,
        tested_candidates: testedCandidates,
      };
    },
  };
}

function createMockCamera(config) {
  return {
    async captureBurst(eventId) {
      const images = [];
      for (let index = 1; index <= config.camera.burstCount; index += 1) {
        const image = imageRecord(config, eventId, index, "svg");
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#174d2a"/><text x="30" y="70" fill="white" font-size="28">Agrimind mock ${eventId} frame ${index}</text></svg>`;
        fs.writeFileSync(image.path, svg);
        image.file_size = fs.statSync(image.path).size;
        images.push(image);
        await sleep(100);
      }
      return images;
    },
    status: () => ({ configured_device: "mock_camera", active_device: "mock_camera", state: "ready", auto_discovery: false }),
  };
}

function selectBestImage(images) {
  return images.reduce((best, current) => !best || current.file_size > best.file_size ? current : best, null);
}

module.exports = { cameraCandidates, createRealCamera, createMockCamera, selectBestImage };
