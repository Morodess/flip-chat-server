const http = require("http");
const WebSocket = require("ws");
const mysql = require("mysql2/promise");

const ADMIN_USER = "morodess";
const PORT = Number(process.env.PORT || 3000);

let db;

// userId -> { ws, userData }
const online = new Map();

function nowIso() {
  return new Date().toISOString();
}

function safeSend(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

function broadcast(obj, skipUserId = null) {
  const msg = JSON.stringify(obj);
  for (const [uid, c] of online.entries()) {
    if (skipUserId && uid === skipUserId) continue;
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  }
}

async function initDB() {
  const host = process.env.MYSQLHOST;
  const port = Number(process.env.MYSQLPORT || 3306);
  const user = process.env.MYSQLUSER;
  const password = process.env.MYSQLPASSWORD;
  const database = process.env.MYSQLDATABASE;

  const missing = [];
  if (!host) missing.push("MYSQLHOST");
  if (!process.env.MYSQLPORT) missing.push("MYSQLPORT");
  if (!user) missing.push("MYSQLUSER");
  if (password === undefined) missing.push("MYSQLPASSWORD");
  if (!database) missing.push("MYSQLDATABASE");
  if (missing.length) throw new Error("Missing MySQL env vars in flip-chat-server: " + missing.join(", "));

  db = await mysql.createConnection({ host, port, user, password, database });

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      userId VARCHAR(64) PRIMARY KEY,
      display VARCHAR(255) NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      lastSeen DATETIME NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      sender VARCHAR(64) NOT NULL,
      recipient VARCHAR(64) NOT NULL,
      text TEXT NOT NULL,
      ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      delivered TINYINT NOT NULL DEFAULT 0
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_flags (
      userId VARCHAR(64) PRIMARY KEY,
      banned_until DATETIME NULL,
      muted_until DATETIME NULL
    )
  `);

  console.log("MySQL connected");
}

async function ensureUser(userId, display) {
  await db.execute(
    "INSERT INTO users (userId, display, lastSeen) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE display=COALESCE(VALUES(display), display), lastSeen=NOW()",
    [userId, display || userId]
  );
}

async function getFlags(userId) {
  const [rows] = await db.execute("SELECT banned_until, muted_until FROM user_flags WHERE userId=?", [userId]);
  if (!rows.length) return { banned_until: null, muted_until: null };
  return rows[0];
}

function isFutureDate(d) {
  if (!d) return false;
  return new Date(d).getTime() > Date.now();
}

async function getDirectory() {
  const [rows] = await db.execute("SELECT userId, display FROM users ORDER BY userId ASC");
  return rows.map(r => ({
    userId: r.userId,
    userData: { display: r.display || r.userId },
    online: online.has(r.userId),
  }));
}

async function deliverUndelivered(toUserId, ws) {
  const [rows] = await db.execute(
    "SELECT id, sender, recipient, text, ts FROM messages WHERE recipient=? AND delivered=0 ORDER BY id ASC LIMIT 200",
    [toUserId]
  );

  for (const m of rows) {
    safeSend(ws, {
      type: "private_message",
      from: m.sender,
      to: m.recipient,
      text: m.text,
      messageId: String(m.id),
      timestamp: new Date(m.ts).toISOString(),
      offline: true,
    });
  }

  if (rows.length) {
    const lastId = rows[rows.length - 1].id;
    await db.execute("UPDATE messages SET delivered=1 WHERE recipient=? AND delivered=0 AND id<=?", [toUserId, lastId]);
  }
}

async function adminAction(from, ws, data) {
  if (from !== ADMIN_USER) {
    return safeSend(ws, { type: "error", message: "Нет прав" });
  }
  const action = String(data.action || "");
  const target = String(data.target || "").trim().slice(0, 64);
  const minutes = Number(data.minutes || 0);

  if (!target) return safeSend(ws, { type: "error", message: "target пустой" });

  if (action === "ban") {
    const until = minutes > 0 ? new Date(Date.now() + minutes * 60_000) : new Date(Date.now() + 3650 * 24 * 60_000);
    await db.execute(
      "INSERT INTO user_flags (userId, banned_until, muted_until) VALUES (?, ?, NULL) ON DUPLICATE KEY UPDATE banned_until=?",
      [target, until, until]
    );
    safeSend(ws, { type: "admin_ok", action, target, until: until.toISOString() });
    const cur = online.get(target);
    if (cur) { try { cur.ws.close(); } catch {} }
    return;
  }

  if (action === "unban") {
    await db.execute(
      "INSERT INTO user_flags (userId, banned_until, muted_until) VALUES (?, NULL, NULL) ON DUPLICATE KEY UPDATE banned_until=NULL",
      [target]
    );
    return safeSend(ws, { type: "admin_ok", action, target });
  }

  if (action === "mute") {
    const until = minutes > 0 ? new Date(Date.now() + minutes * 60_000) : new Date(Date.now() + 60 * 60_000);
    await db.execute(
      "INSERT INTO user_flags (userId, banned_until, muted_until) VALUES (?, NULL, ?) ON DUPLICATE KEY UPDATE muted_until=?",
      [target, until, until]
    );
    return safeSend(ws, { type: "admin_ok", action, target, until: until.toISOString() });
  }

  if (action === "unmute") {
    await db.execute(
      "INSERT INTO user_flags (userId, banned_until, muted_until) VALUES (?, NULL, NULL) ON DUPLICATE KEY UPDATE muted_until=NULL",
      [target]
    );
    return safeSend(ws, { type: "admin_ok", action, target });
  }

  return safeSend(ws, { type: "error", message: "Неизвестная admin action" });
}

// HTTP healthcheck
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("ok");
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("flip-chat-server ok");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  let userId = null;

  ws.on("message", async (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); }
    catch { return safeSend(ws, { type: "error", message: "Неверный JSON" }); }

    // совместимость: если клиент вдруг шлёт hello
    if (data.type === "hello") {
      data = { type: "register", userId: data.userId, userData: data.userData || {} };
    }

    if (data.type === "register") {
      const uid = String(data.userId || "").trim().slice(0, 64);
      const display = String(data.userData?.display || uid);

      if (!uid) return safeSend(ws, { type: "error", message: "userId пустой" });

      // ban check
      const flags = await getFlags(uid);
      if (isFutureDate(flags.banned_until)) {
        safeSend(ws, { type: "error", message: "Вы забанены" });
        try { ws.close(); } catch {}
        return;
      }

      userId = uid;

      // kick previous session
      const old = online.get(uid);
      if (old && old.ws !== ws) { try { old.ws.close(); } catch {} }

      online.set(uid, { ws, userData: { display } });

      await ensureUser(uid, display);

      // этому клиенту: кто онлайн + каталог
      const dir = await getDirectory();
      safeSend(ws, { type: "user_directory", users: dir });

      const onlineUsers = [];
      for (const [ouid, oc] of online.entries()) {
        if (ouid === uid) continue;
        onlineUsers.push({ userId: ouid, userData: oc.userData || {} });
      }
      safeSend(ws, { type: "online_users", users: onlineUsers });

      // всем остальным: он онлайн
      broadcast({ type: "user_online", userId: uid, userData: { display } }, uid);

      // доставить оффлайн сообщения
      await deliverUndelivered(uid, ws);
      return;
    }

    if (data.type === "get_directory") {
      const dir = await getDirectory();
      return safeSend(ws, { type: "user_directory", users: dir });
    }

    if (!userId) return safeSend(ws, { type: "error", message: "Сначала register" });

    // admin
    if (data.type === "admin_action") {
      return adminAction(userId, ws, data);
    }

    // mute check for sending
    const flags = await getFlags(userId);
    const muted = isFutureDate(flags.muted_until);

    if (data.type === "private_message") {
      if (muted) return safeSend(ws, { type: "error", message: "Вы замучены (mute)" });

      const to = String(data.to || "").trim().slice(0, 64);
      const text = String(data.text || "");
      if (!to) return safeSend(ws, { type: "error", message: "Нет поля to" });
      if (!text) return;

      // сохраняем в БД ВСЕГДА
      const [result] = await db.execute(
        "INSERT INTO messages (sender, recipient, text, delivered) VALUES (?, ?, ?, ?)",
        [userId, to, text, 0]
      );
      const msgId = String(result.insertId);

      // если получатель онлайн — доставляем и помечаем delivered=1
      const target = online.get(to);
      const payload = {
        type: "private_message",
        from: userId,
        to,
        text,
        messageId: msgId,
        timestamp: nowIso(),
      };

      if (target && target.ws.readyState === WebSocket.OPEN) {
        safeSend(target.ws, payload);
        await db.execute("UPDATE messages SET delivered=1 WHERE id=?", [Number(msgId)]);
      } else {
        // сообщим отправителю, что ушло “в оффлайн”
        safeSend(ws, { type: "info", message: `Пользователь ${to} оффлайн, доставим при входе.` });
      }
      return;
    }

    if (data.type === "typing") {
      const to = String(data.to || "").trim().slice(0, 64);
      const target = online.get(to);
      if (target && target.ws.readyState === WebSocket.OPEN) {
        safeSend(target.ws, { type: "typing", from: userId, to, isTyping: !!data.isTyping, chatId: data.chatId || null });
      }
      return;
    }
  });

  ws.on("close", async () => {
    if (!userId) return;

    const cur = online.get(userId);
    if (cur && cur.ws === ws) online.delete(userId);

    try { await db.execute("UPDATE users SET lastSeen=NOW() WHERE userId=?", [userId]); } catch {}

    broadcast({ type: "user_offline", userId }, userId);
  });
});

initDB()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => console.log("Server running on port", PORT));
  })
  .catch((e) => {
    console.error("DB init failed:", e.message);
    process.exit(1);
  });
