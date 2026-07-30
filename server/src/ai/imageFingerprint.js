const { run } = require("../utils/process");

async function fingerprint(filePath) {
  const result = await run("ffmpeg", ["-v", "error", "-i", filePath, "-vf", "scale=9:8,format=gray", "-f", "rawvideo", "pipe:1"]);
  const pixels = result.stdout;
  if (pixels.length < 72) throw new Error("Unable to fingerprint image");
  let bits = "";
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const offset = row * 9 + column;
      bits += pixels[offset] > pixels[offset + 1] ? "1" : "0";
    }
  }
  return bits;
}

function hammingDistance(left, right) {
  if (!left || !right || left.length !== right.length) return Infinity;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) distance += 1;
  return distance;
}
module.exports = { fingerprint, hammingDistance };
