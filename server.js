const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 3000);
const wss = new WebSocket.Server({ port: PORT });

const clientsByUser = new Map(); // userId -> { ws, userData }

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
      return send(ws, { type: "error", message: "Неверный JSON" });
    }

    const type = data.type;

    // register
    if (type === "register") {
      const uid = String(data.userId || "").trim();
      const userData = data.userData || {};

      if (!uid) return send(ws, { type: "error", message: "userId пустой" });

      userId = uid;

      // если был старый коннект того же юзера — закрываем
      const old = clientsByUser.get(uid);
      if (old && old.ws !== ws) {
        try { old.ws.close(); } catch {}
      }

      clientsByUser.set(uid, { ws, userData });

      // отправляем список онлайн новому
      const users = [];
      for (const [ouid, oc] of clientsByUser.entries()) {
        if (ouid === uid) continue;
        users.push({ userId: ouid, userData: oc.userData || {} });
      }
      send(ws, { type: "online_users", users });

      // уведомляем остальных
      broadcast({ type: "user_online", userId: uid, userData }, uid);
      return;
    }

    if (!userId) {
      return send(ws, { type: "error", message: "Сначала register" });
    }

    // private_message
    if (type === "private_message") {
      const to = String(data.to || "").trim();
      if (!to) return send(ws, { type: "error", message: "Нет поля to" });

      const payload = {
        type: "private_message",
        from: userId,
        to,
        text: data.text || "",
        messageId: data.messageId || null,
        timestamp: data.timestamp || new Date().toISOString(),
      };

      const target = clientsByUser.get(to);
      if (target && target.ws.readyState === WebSocket.OPEN) {
        send(target.ws, payload);
      } else {
        send(ws, { type: "error", message: `Пользователь ${to} оффлайн` });
      }
      return;
    }

    // typing
    if (type === "typing") {
      const to = String(data.to || "").trim();
      if (!to) return;

      const payload = {
        type: "typing",
        from: userId,
        to,
        isTyping: !!data.isTyping,
        chatId: data.chatId || null,
      };

      const target = clientsByUser.get(to);
      if (target && target.ws.readyState === WebSocket.OPEN) {
        send(target.ws, payload);
      }
      return;
    }

    send(ws, { type: "error", message: `Неизвестный type: ${type}` });
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

console.log("WebSocket server running on port", PORT);
