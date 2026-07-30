const fs = require("fs");
const path = require("path");

function ensureDirectories(config) {
  fs.mkdirSync(config.capturesDir, { recursive: true });
  fs.mkdirSync(config.logsDir, { recursive: true });
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function listByModified(folder, extensions, limit) {
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder)
    .filter((filename) => extensions.includes(path.extname(filename).toLowerCase()))
    .map((filename) => {
      const filePath = path.join(folder, filename);
      const stat = fs.statSync(filePath);
      return { filename, path: filePath, size: stat.size, modifiedMs: stat.mtimeMs, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modifiedMs - a.modifiedMs)
    .slice(0, limit);
}

function publicImage(image) {
  if (!image) return null;
  const { path: ignored, ...safe } = image;
  return safe;
}

module.exports = { ensureDirectories, readJson, writeJsonAtomic, listByModified, publicImage };
