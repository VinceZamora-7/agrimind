const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { WebSocket } = require("ws");
const { createWebSocketHub } = require("../src/realtime/webSocketHub");

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
    socket.once("error", reject);
  });
}

test("authenticated WebSocket receives snapshot and broadcasts", async (context) => {
  const hub = createWebSocketHub({ apiToken: "local-secret", pairing: { enforceAuth: true } }, { authorize: () => null });
  hub.setSnapshotProvider(() => ({ detection_enabled: true }));
  const server = http.createServer((_req, res) => res.end("ok"));
  hub.attach(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => { hub.close(); server.close(); });
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws?token=local-secret`);
  const connected = await nextMessage(socket);
  assert.equal(connected.type, "connected");
  assert.equal(connected.status.detection_enabled, true);
  const broadcast = nextMessage(socket);
  hub.broadcast("motion_detected", { gpio_line: 6 });
  assert.deepEqual(await broadcast, {
    type: "motion_detected",
    timestamp: (await broadcast).timestamp,
    gpio_line: 6,
  });
  socket.close();
});

test("WebSocket rejects an invalid API token", async (context) => {
  const hub = createWebSocketHub({ apiToken: "local-secret", pairing: { enforceAuth: true } }, { authorize: () => null });
  const server = http.createServer();
  hub.attach(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => { hub.close(); server.close(); });
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws?token=wrong`);
  const status = await new Promise((resolve) => {
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode));
  });
  assert.equal(status, 401);
});
