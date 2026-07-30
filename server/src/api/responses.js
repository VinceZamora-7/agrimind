function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key" });
  res.end(`${JSON.stringify(data, null, 2)}\n`);
}
function sendText(res, statusCode, value, contentType = "text/plain") {
  res.writeHead(statusCode, { "Content-Type": contentType, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  res.end(value);
}
module.exports = { sendJson, sendText };
