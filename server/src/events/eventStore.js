const fs = require("fs");
const path = require("path");
const { listByModified, readJson, writeJsonAtomic } = require("../utils/files");

function createEventStore(config) {
  const latestPath = path.join(config.logsDir, "latest_event.json");
  return {
    save(event) {
      writeJsonAtomic(path.join(config.logsDir, `${event.event_id}.json`), event);
      writeJsonAtomic(latestPath, event);
      return event;
    },
    latest() {
      const latest = readJson(latestPath);
      return latest || this.list(1)[0] || null;
    },
    get(eventId) {
      if (!/^event_[A-Za-z0-9_-]+$/.test(eventId)) return null;
      return readJson(path.join(config.logsDir, `${eventId}.json`));
    },
    list(limit = 30) {
      return listByModified(config.logsDir, [".json"], 500)
        .filter((file) => file.filename.startsWith("event_"))
        .slice(0, limit).map((file) => readJson(file.path)).filter(Boolean);
    },
    images(limit = 50) {
      return listByModified(config.capturesDir, [".jpg", ".jpeg", ".png", ".svg"], limit)
        .filter((file) => file.size > 0)
        .map((file) => ({ filename: file.filename, url: `/captures/${file.filename}`, size: file.size, modified: file.modified }));
    },
    usagePath: path.join(config.logsDir, "ai_usage.json"),
    alertUsagePath: path.join(config.logsDir, "alert_usage.json"),
    existsImage(filename) { return fs.existsSync(path.join(config.capturesDir, path.basename(filename))); },
  };
}
module.exports = { createEventStore };
