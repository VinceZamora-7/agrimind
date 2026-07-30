const { WebSocket, WebSocketServer } = require("ws");

function createWebSocketHub(config, pairing) {
  const server = new WebSocketServer({ noServer: true });
  let snapshotProvider = () => null;

  function message(type, data = {}) {
    return JSON.stringify({ type, timestamp: new Date().toISOString(), ...data });
  }

  function broadcast(type, data = {}) {
    const payload = message(type, data);
    for (const client of server.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  function attach(httpServer) {
    httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== "/ws") return socket.destroy();
      const token = url.searchParams.get("token") || "";
      const legacyAuthorized = Boolean(config.apiToken && token === config.apiToken);
      const pairedClient = pairing.authorize(token);
      if (config.pairing.enforceAuth && !legacyAuthorized && !pairedClient) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      server.handleUpgrade(req, socket, head, (client) => server.emit("connection", client, req));
    });
    server.on("connection", (client) => {
      client.send(message("connected", { status: snapshotProvider() }));
    });
  }

  function close() {
    for (const client of server.clients) client.close(1001, "Server shutting down");
    server.close();
  }

  return {
    attach,
    broadcast,
    close,
    connectedClients: () => server.clients.size,
    setSnapshotProvider(provider) { snapshotProvider = provider; },
  };
}

module.exports = { createWebSocketHub };
