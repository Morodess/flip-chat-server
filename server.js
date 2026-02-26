const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("FlipChat WS server is running\n");
});

const wss = new WebSocket.Server({ server });

/**
 * username -> { ws, userData }
 */
const clients = new Map();

/**
 * пользователи, которых сервер “видел” хоть раз (пока сервер не перезапустится)
 */
const seenUsers = new Map(); // username -> userData

function safeSend(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {}
}

function broadcast(obj) {
  for (const { ws } of clients.values()) {
    if (ws.readyState === WebSocket.OPEN) safeSend(ws, obj);
  }
}

function makeDirectory() {
  const online = new Set(clients.keys());
  const out = [];
  for (const [userId, userData] of seenUsers.entries()) {
    out.push({
      userId,
      display: userData?.display || userId,
      avatar: userData?.avatar || null,
      online: online.has(userId),
    });
  }
  // на всякий — если кто-то онлайн, но ещё не в seenUsers
  for (const userId of online) {
    if (!seenUsers.has(userId)) {
      out.push({ userId, display: userId, avatar: null, online: true });
    }
  }
  return out;
}

function sendOnlineUsers(ws) {
  const users = [];
  for (const [userId, entry] of clients.entries()) {
    users.push({ userId, ...(entry.userData || {}) });
  }
  safeSend(ws, { type: "online_users", users });
}

function broadcastDirectory() {
  broadcast({ type: "user_directory", users: makeDirectory() });
}

wss.on("connection", (ws) => {
  let username = null;

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Клиент должен прислать hello после логина:
    // {type:"hello", userId:"name", userData:{display, avatar}}
    if (data.type === "hello") {
      username = String(data.userId || "").trim();
      if (!username) return;

      const userData = data.userData || {};
      clients.set(username, { ws, userData });

      // запоминаем в каталоге
      const prev = seenUsers.get(username) || {};
      seenUsers.set(username, { ...prev, ...userData, display: userData.display || prev.display || username });

      // всем: кто онлайн
      broadcast({ type: "user_online", userId: username, userData });
      // этому клиенту: список онлайн
      sendOnlineUsers(ws);
      // всем: каталог (онлайн+виденные)
      broadcastDirectory();
      return;
    }

    // запрос каталога вручную
    if (data.type === "get_directory") {
      safeSend(ws, { type: "user_directory", users: makeDirectory() });
      return;
    }

    // приватные сообщения
    if (data.type === "private_message") {
      const from = String(data.from || "").trim();
      const to = String(data.to || "").trim();
      const text = String(data.text || "");

      if (!from || !to || !text) return;

      const target = clients.get(to);
      if (target && target.ws.readyState === WebSocket.OPEN) {
        safeSend(target.ws, {
          type: "private_message",
          from,
          to,
          text,
          timestamp: data.timestamp || new Date().toISOString(),
          messageId: data.messageId || null,
        });
      } else {
        // если оффлайн — просто скажем отправителю (сообщение не доставлено)
        safeSend(ws, {
          type: "error",
          message: `Пользователь ${to} сейчас оффлайн (сообщение не доставлено).`,
        });
      }
      return;
    }

    // typing
    if (data.type === "typing") {
      const to = String(data.to || "").trim();
      const target = clients.get(to);
      if (target && target.ws.readyState === WebSocket.OPEN) {
        safeSend(target.ws, data);
      }
      return;
    }
  });

  ws.on("close", () => {
    if (username && clients.has(username)) {
      clients.delete(username);
      broadcast({ type: "user_offline", userId: username });
      broadcastDirectory();
    }
  });
});

server.listen(PORT, () => {
  console.log("WebSocket server running on port", PORT);
});
