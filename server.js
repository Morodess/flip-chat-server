const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("WebSocket server is running");
});

const wss = new WebSocket.Server({ server });

const clientsByUser = new Map();

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(obj, skipUserId = null) {
  const msg = JSON.stringify(obj);
  for (const [uid, c] of clientsByUser.entries()) {
    if (skipUserId && uid === skipUserId) continue;
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  }
}

wss.on("connection", (ws) => {
  let userId = null;

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: "error", message: "Invalid JSON" });
    }

    if (data.type === "register") {
      userId = data.userId;
      clientsByUser.set(userId, { ws, userData: data.userData || {} });

      broadcast({ type: "user_online", userId }, userId);
      return;
    }

    if (!userId) return;

    if (data.type === "private_message") {
      const target = clientsByUser.get(data.to);
      if (target) {
        send(target.ws, {
          type: "private_message",
          from: userId,
          text: data.text,
          timestamp: new Date().toISOString()
        });
      }
    }
  });

  ws.on("close", () => {
    if (userId) {
      clientsByUser.delete(userId);
      broadcast({ type: "user_offline", userId }, userId);
    }
  });
});

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
