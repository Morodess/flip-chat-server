const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 3000);

// HTTP нужен Railway для healthcheck
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("ok");
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("flip-chat-server ok");
});

const wss = new WebSocket.Server({ server });

/**
 * online clients: userId -> { ws, userData }
 */
const online = new Map();

/**
 * directory of seen users (persists while server is running)
 * userId -> userData
 */
const directory = new Map();

function safeSend(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  } catch {}
}

function broadcast(obj, skipUserId = null) {
  const msg = JSON.stringify(obj);
  for (const [uid, c] of online.entries()) {
    if (skipUserId && uid === skipUserId) continue;
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  }
}

function getDirectoryPayload() {
  const arr = [];
  for (const [userId, userData] of directory.entries()) {
    arr.push({
      userId,
      userData,
      online: online.has(userId),
    });
  }
  // на всякий случай добавим всех онлайн, если их вдруг нет в directory
  for (const [userId, c] of online.entries()) {
    if (!directory.has(userId)) {
      arr.push({ userId, userData: c.userData || {}, online: true });
    }
  }
  return arr;
}

function sendOnlineUsers(ws, forUserId) {
  const users = [];
  for (const [userId, c] of online.entries()) {
    if (forUserId && userId === forUserId) continue;
    users.push({ userId, userData: c.userData || {} });
  }
  safeSend(ws, { type: "online_users", users });
}

function broadcastDirectory() {
  broadcast({ type: "user_directory", users: getDirectoryPayload() });
}

wss.on("connection", (ws) => {
  let userId = null;

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return safeSend(ws, { type: "error", message: "Неверный JSON" });
    }

    const type = data.type;

    // Клиент регистрируется
    if (type === "register") {
      const uid = String(data.userId || "").trim().slice(0, 64);
      const userData = data.userData || {};

      if (!uid) return safeSend(ws, { type: "error", message: "userId пустой" });

      userId = uid;

      // Если этот userId уже онлайн — выбиваем старое соединение
      const old = online.get(uid);
      if (old && old.ws !== ws) {
        try { old.ws.close(); } catch {}
      }

      online.set(uid, { ws, userData });

      // сохраняем/обновляем каталог
      const prev = directory.get(uid) || {};
      directory.set(uid, { ...prev, ...userData });

      // отправляем этому клиенту: кто онлайн
      sendOnlineUsers(ws, uid);

      // всем: этот юзер онлайн
      broadcast({ type: "user_online", userId: uid, userData }, uid);

      // всем: обновлённый каталог
      broadcastDirectory();
      return;
    }

    // запрос каталога
    if (type === "get_directory") {
      safeSend(ws, { type: "user_directory", users: getDirectoryPayload() });
      return;
    }

    // все остальные сообщения требуют register
    if (!userId) {
      return safeSend(ws, { type: "error", message: "Сначала register" });
    }

    // приватное сообщение
    if (type === "private_message") {
      const to = String(data.to || "").trim().slice(0, 64);
      if (!to) return safeSend(ws, { type: "error", message: "Нет поля to" });

      const payload = {
        type: "private_message",
        from: userId,
        to,
        text: data.text || "",
        messageId: data.messageId || null,
        timestamp: data.timestamp || new Date().toISOString(),
      };

      const target = online.get(to);
      if (target && target.ws.readyState === WebSocket.OPEN) {
        safeSend(target.ws, payload);
      } else {
        safeSend(ws, { type: "error", message: `Пользователь ${to} оффлайн` });
      }
      return;
    }

    // typing
    if (type === "typing") {
      const to = String(data.to || "").trim().slice(0, 64);
      const target = online.get(to);
      if (target && target.ws.readyState === WebSocket.OPEN) {
        safeSend(target.ws, {
          type: "typing",
          from: userId,
          to,
          isTyping: !!data.isTyping,
          chatId: data.chatId || null,
        });
      }
      return;
    }

    safeSend(ws, { type: "error", message: `Неизвестный type: ${type}` });
  });

  ws.on("close", () => {
    if (!userId) return;

    const cur = online.get(userId);
    if (cur && cur.ws === ws) {
      online.delete(userId);
      broadcast({ type: "user_offline", userId }, userId);
      broadcastDirectory();
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
