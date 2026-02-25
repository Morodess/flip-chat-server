const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 3000);
const wss = new WebSocket.Server({ port: PORT });

const clients = new Map();

wss.on("connection", (ws) => {
  let username = null;

  ws.on("message", (message) => {
    let data;
    try { data = JSON.parse(message); } catch { return; }

    if (data.type === "auth") {
      username = String(data.user || "");
      if (username) clients.set(username, ws);
      return;
    }

    if (data.type === "message") {
      const out = JSON.stringify({
        type: "message",
        from: data.from,
        text: data.text,
        chat: data.chat
      });

      for (const client of clients.values()) {
        if (client.readyState === WebSocket.OPEN) client.send(out);
      }
    }
  });

  ws.on("close", () => {
    if (username) clients.delete(username);
  });
});

console.log("WebSocket server running on port", PORT);
