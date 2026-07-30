const { spawn } = require("child_process");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(`${command} exited ${code}: ${result.stderr.trim()}`), result));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
module.exports = { run, sleep };
