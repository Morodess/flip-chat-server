const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("flip-chat-server ok");
});

const wss = new WebSocket.Server({ server });

const clientsByUser = new Map();

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj, skip = null) {
  const msg = JSON.stringify(obj);
  for (const [uid, c] of clientsByUser.entries()) {
    if (skip && uid === skip) continue;
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  }
}

wss.on("connection", (ws) => {
  let userId = null;

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); }
    catch { return send(ws, { type: "error", message: "Invalid JSON" }); }

    if (data.type === "register") {
      const uid = String(data.userId || "").trim();
      if (!uid) return send(ws, { type: "error", message: "userId пустой" });

      userId = uid;
      clientsByUser.set(uid, { ws, userData: data.userData || {} });

      const users = [];
      for (const [ouid, oc] of clientsByUser.entries()) {
        if (ouid === uid) continue;
        users.push({ userId: ouid, userData: oc.userData || {} });
      }
      send(ws, { type: "online_users", users });
      broadcast({ type: "user_online", userId: uid, userData: data.userData || {} }, uid);
      return;
    }

    if (!userId) return;

    if (data.type === "private_message") {
      const to = String(data.to || "").trim();
      const target = clientsByUser.get(to);
      const payload = {
        type: "private_message",
        from: userId,
        to,
        text: data.text || "",
        messageId: data.messageId || null,
        timestamp: new Date().toISOString(),
      };
      if (target && target.ws.readyState === WebSocket.OPEN) send(target.ws, payload);
      else send(ws, { type: "error", message: `Пользователь ${to} оффлайн` });
      return;
    }

    if (data.type === "typing") {
      const to = String(data.to || "").trim();
      const target = clientsByUser.get(to);
      if (target && target.ws.readyState === WebSocket.OPEN) {
        send(target.ws, {
          type: "typing",
          from: userId,
          to,
          isTyping: !!data.isTyping,
          chatId: data.chatId || null
        });
      }
      return;
    }
  });

  ws.on("close", () => {
    if (!userId) return;
    const cur = clientsByUser.get(userId);
    if (cur && cur.ws === ws) {
      clientsByUser.delete(userId);
      broadcast({ type: "user_offline", userId }, userId);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
