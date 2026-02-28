// FlipChat Server v2 (WebSocket + HTTP uploads + MySQL persistence)
// Works on Railway. Exposes HTTP on PORT and upgrades to WS on same port.

const http = require("http");
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { WebSocketServer } = require("ws");
const mysql = require("mysql2/promise");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "8080", 10);

// Railway MySQL vars (via Variable Reference)
const DB_HOST = process.env.MYSQLHOST || process.env.MYSQL_HOST || "127.0.0.1";
const DB_USER = process.env.MYSQLUSER || process.env.MYSQL_USER || "root";
const DB_PASS = process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || "";
const DB_NAME = process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || "flipchat";
const DB_PORT = parseInt(process.env.MYSQLPORT || process.env.MYSQL_PORT || "3306", 10);

// Admins (comma-separated usernames, without @)
const ADMIN_USERS = new Set(
  (process.env.ADMIN_USERS || "morodess")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

// If set, server will reject non-https origins (optional)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function nowMs() { return Date.now(); }
function sha256(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function newToken() { return crypto.randomBytes(32).toString("hex"); }
function normUser(u) { return String(u || "").trim().replace(/^@+/, "").toLowerCase(); }

let pool;

async function initDB() {
  pool = await mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    port: DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: "utf8mb4",
  });

  // Create tables if not exist
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  for (const stmt of schema.split(/;\s*$/m)) {
    const s = stmt.trim();
    if (!s) continue;
    await pool.query(s);
  }
}

async function q(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function getUserByUsername(username) {
  const rows = await q("SELECT * FROM users WHERE username = ?", [username]);
  return rows[0] || null;
}

async function getUserByToken(token) {
  const rows = await q("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at > NOW()", [token]);
  return rows[0] || null;
}

async function createSession(userId) {
  const token = newToken();
  // 30 days session
  await q("INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))", [userId, token]);
  return token;
}

async function deleteSessions(userId) {
  await q("DELETE FROM sessions WHERE user_id=?", [userId]);
}

async function isMuted(userId) {
  const rows = await q(
    "SELECT * FROM sanctions WHERE user_id=? AND type='mute' AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY id DESC LIMIT 1",
    [userId]
  );
  return rows[0] || null;
}

async function activeBan(userId) {
  const rows = await q(
    "SELECT * FROM sanctions WHERE user_id=? AND type='ban' AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY id DESC LIMIT 1",
    [userId]
  );
  return rows[0] || null;
}

async function listDirectory() {
  const users = await q(
    "SELECT id, username, display_name, email, email_public, avatar_url, prefix, created_at FROM users ORDER BY created_at ASC"
  );
  const channels = await q(
    "SELECT id, name, owner_user_id, created_at FROM channels ORDER BY created_at ASC"
  );
  return { users, channels };
}

function safeUserPublic(u, online=false) {
  return {
    id: u.id,
    username: u.username,
    display: u.display_name || u.username,
    email: u.email_public ? (u.email || null) : null,
    emailPublic: !!u.email_public,
    avatarUrl: u.avatar_url || null,
    prefix: u.prefix || "",
    online: !!online,
    createdAt: u.created_at,
  };
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function broadcast(clients, obj, exceptWs = null) {
  const msg = JSON.stringify(obj);
  for (const c of clients) {
    if (c === exceptWs) continue;
    if (c.readyState === 1) {
      try { c.send(msg); } catch {}
    }
  }
}

function wsCloseWithBan(ws, reason, untilIso) {
  send(ws, { type: "ban", reason: reason || "ban", until: untilIso || null });
  try { ws.close(4003, "banned"); } catch {}
}

async function main() {
  await initDB();
  console.log("DB OK");

  const app = express();
  app.use(cors({ origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true, credentials: true }));
  app.use(express.json({ limit: "2mb" }));

  // uploads
  const uploadDir = path.join(__dirname, "uploads");
  fs.mkdirSync(uploadDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_, __, cb) => cb(null, uploadDir),
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname || "").slice(0, 10) || "";
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
    }
  });

  const upload = multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  });

  app.use("/uploads", express.static(uploadDir, { maxAge: "7d" }));

  app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

  // Upload endpoints (avatar, voice)
  app.post("/upload/avatar", upload.single("file"), async (req, res) => {
    res.json({ ok: true, url: `/uploads/${req.file.filename}` });
  });

  app.post("/upload/voice", upload.single("file"), async (req, res) => {
    res.json({ ok: true, url: `/uploads/${req.file.filename}` });
  });

  const server = http.createServer(app);

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set(); // ws objects

  server.on("upgrade", (req, socket, head) => {
    // Optional origin check
    if (ALLOWED_ORIGINS.length) {
      const origin = req.headers.origin || "";
      if (!ALLOWED_ORIGINS.includes(origin)) {
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  // Online map: userId -> ws
  const onlineByUserId = new Map();

  async function pushDirectory(ws) {
    const dir = await listDirectory();
    // mark online
    const onlineIds = new Set(onlineByUserId.keys());
    const users = dir.users.map(u => safeUserPublic(u, onlineIds.has(u.id)));
    send(ws, { type: "directory", users, channels: dir.channels });
  }

  async function sendHistory(ws, peerUsername, limit=100) {
    const me = ws.user;
    if (!me) return;
    const peer = await getUserByUsername(normUser(peerUsername));
    if (!peer) {
      send(ws, { type: "history", with: normUser(peerUsername), messages: [] });
      return;
    }
    const rows = await q(
      `SELECT m.id, m.sender_user_id, su.username AS sender, m.receiver_user_id, ru.username AS receiver,
              m.channel_id, m.type, m.content, m.file_url, m.created_at
       FROM messages m
       LEFT JOIN users su ON su.id=m.sender_user_id
       LEFT JOIN users ru ON ru.id=m.receiver_user_id
       WHERE (m.sender_user_id=? AND m.receiver_user_id=?)
          OR (m.sender_user_id=? AND m.receiver_user_id=?)
       ORDER BY m.id DESC
       LIMIT ?`,
      [me.id, peer.id, peer.id, me.id, limit]
    );
    const msgs = rows.reverse().map(r => ({
      id: r.id,
      from: r.sender,
      to: r.receiver,
      type: r.type,
      text: r.content,
      fileUrl: r.file_url,
      at: r.created_at,
    }));
    send(ws, { type: "history", with: peer.username, messages: msgs });
  }

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.user = null;      // user row
    ws.username = null;  // string
    ws.isAdmin = false;

    send(ws, { type: "hello", serverTime: Date.now() });

    ws.on("message", async (buf) => {
      let data;
      try { data = JSON.parse(buf.toString("utf8")); } catch { return; }

      try {
        // --- AUTH ---
        if (data.type === "resume") {
          const token = String(data.token || "");
          const u = await getUserByToken(token);
          if (!u) {
            send(ws, { type: "auth", ok: false, error: "bad_token" });
            return;
          }
          // check ban
          const ban = await activeBan(u.id);
          if (ban) {
            wsCloseWithBan(ws, ban.reason, ban.expires_at ? ban.expires_at.toISOString?.() : ban.expires_at);
            return;
          }

          ws.user = u;
          ws.username = u.username;
          ws.isAdmin = ADMIN_USERS.has(u.username);

          onlineByUserId.set(u.id, ws);
          send(ws, { type: "auth", ok: true, username: u.username, token, user: safeUserPublic(u, true), admin: ws.isAdmin });
          broadcast(clients, { type: "presence", user: u.username, online: true }, ws);
          await pushDirectory(ws);
          return;
        }

        if (data.type === "register") {
          const username = normUser(data.username);
          const password = String(data.password || "");
          const email = String(data.email || "").trim() || null;
          const emailPublic = !!data.emailPublic;

          if (!username || username.length < 3) {
            send(ws, { type: "auth", ok: false, error: "bad_username" });
            return;
          }
          if (!password || password.length < 4) {
            send(ws, { type: "auth", ok: false, error: "bad_password" });
            return;
          }
          const exists = await getUserByUsername(username);
          if (exists) {
            send(ws, { type: "auth", ok: false, error: "user_exists" });
            return;
          }

          const passHash = sha256(password);
          const [result] = await pool.execute(
            "INSERT INTO users (username, display_name, pass_hash, email, email_public) VALUES (?, ?, ?, ?, ?)",
            [username, username, passHash, email, emailPublic ? 1 : 0]
          );

          const userId = result.insertId;
          const u = await q("SELECT * FROM users WHERE id=?", [userId]).then(r => r[0]);
          const ban = await activeBan(u.id);
          if (ban) {
            wsCloseWithBan(ws, ban.reason, ban.expires_at);
            return;
          }

          const token = await createSession(userId);
          ws.user = u;
          ws.username = u.username;
          ws.isAdmin = ADMIN_USERS.has(u.username);
          onlineByUserId.set(u.id, ws);

          send(ws, { type: "auth", ok: true, username: u.username, token, user: safeUserPublic(u, true), admin: ws.isAdmin });
          broadcast(clients, { type: "presence", user: u.username, online: true }, ws);
          await pushDirectory(ws);
          return;
        }

        if (data.type === "login") {
          const username = normUser(data.username);
          const password = String(data.password || "");
          const u = await getUserByUsername(username);
          if (!u || u.pass_hash !== sha256(password)) {
            send(ws, { type: "auth", ok: false, error: "bad_credentials" });
            return;
          }

          const ban = await activeBan(u.id);
          if (ban) {
            wsCloseWithBan(ws, ban.reason, ban.expires_at);
            return;
          }

          // create new session
          const token = await createSession(u.id);

          ws.user = u;
          ws.username = u.username;
          ws.isAdmin = ADMIN_USERS.has(u.username);
          onlineByUserId.set(u.id, ws);

          send(ws, { type: "auth", ok: true, username: u.username, token, user: safeUserPublic(u, true), admin: ws.isAdmin });
          broadcast(clients, { type: "presence", user: u.username, online: true }, ws);
          await pushDirectory(ws);
          return;
        }

        // must be authed beyond this point
        if (!ws.user) {
          send(ws, { type: "error", error: "not_authed" });
          return;
        }

        // --- DIRECTORY / HISTORY ---
        if (data.type === "get_directory") {
          await pushDirectory(ws);
          return;
        }
        if (data.type === "get_history") {
          await sendHistory(ws, data.with, Math.max(1, Math.min(500, parseInt(data.limit || 150, 10))));
          return;
        }

        // --- PROFILE ---
        if (data.type === "get_profile") {
          const target = await getUserByUsername(normUser(data.username));
          if (!target) { send(ws, { type: "profile", ok: false }); return; }
          const online = onlineByUserId.has(target.id);
          send(ws, { type: "profile", ok: true, user: safeUserPublic(target, online) });
          return;
        }

        // --- SETTINGS ---
        if (data.type === "set_email_public") {
          const val = !!data.value;
          await q("UPDATE users SET email_public=? WHERE id=?", [val ? 1 : 0, ws.user.id]);
          ws.user.email_public = val ? 1 : 0;
          send(ws, { type: "ok", op: "set_email_public", value: val });
          await pushDirectory(ws);
          return;
        }

        if (data.type === "set_avatar") {
          const url = String(data.url || "").trim();
          await q("UPDATE users SET avatar_url=? WHERE id=?", [url || null, ws.user.id]);
          ws.user.avatar_url = url || null;
          send(ws, { type: "ok", op: "set_avatar", url: ws.user.avatar_url });
          await pushDirectory(ws);
          return;
        }

        // --- CHANNELS ---
        if (data.type === "create_channel") {
          const name = String(data.name || "").trim();
          if (!name || name.length < 2) { send(ws, { type: "error", error: "bad_channel_name" }); return; }
          await q("INSERT INTO channels (name, owner_user_id) VALUES (?, ?)", [name, ws.user.id]);
          await pushDirectory(ws);
          return;
        }

        // --- MESSAGES ---
        if (data.type === "message") {
          const muted = await isMuted(ws.user.id);
          if (muted) {
            send(ws, { type: "muted", reason: muted.reason || "muted", until: muted.expires_at });
            return;
          }

          const to = normUser(data.to);
          const text = String(data.text || "").slice(0, 5000);
          const msgType = String(data.msgType || "text"); // text | voice
          const fileUrl = data.fileUrl ? String(data.fileUrl) : null;

          const peer = await getUserByUsername(to);
          if (!peer) { send(ws, { type: "error", error: "user_not_found" }); return; }

          const [res] = await pool.execute(
            "INSERT INTO messages (sender_user_id, receiver_user_id, type, content, file_url) VALUES (?, ?, ?, ?, ?)",
            [ws.user.id, peer.id, msgType, text, fileUrl]
          );

          const payload = {
            type: "message",
            id: res.insertId,
            from: ws.user.username,
            to: peer.username,
            msgType,
            text,
            fileUrl,
            at: new Date().toISOString(),
          };

          // send to both (if online)
          send(ws, payload);
          const peerWs = onlineByUserId.get(peer.id);
          if (peerWs && peerWs.readyState === 1) send(peerWs, payload);
          return;
        }

        // --- ADMIN ---
        if (data.type === "admin" && ws.isAdmin) {
          const action = String(data.action || "");
          const targetUser = normUser(data.username);

          if (action === "mute" || action === "ban") {
            const target = await getUserByUsername(targetUser);
            if (!target) { send(ws, { type: "error", error: "user_not_found" }); return; }
            const minutes = data.minutes == null ? null : Math.max(1, Math.min(60*24*365, parseInt(data.minutes, 10)));
            const reason = String(data.reason || "").slice(0, 250) || action;
            const expiresAt = minutes ? new Date(Date.now() + minutes*60*1000) : null;

            await q(
              "INSERT INTO sanctions (user_id, type, reason, expires_at, created_by) VALUES (?, ?, ?, ?, ?)",
              [target.id, action, reason, expiresAt, ws.user.id]
            );

            send(ws, { type: "ok", op: action, username: target.username });

            const targetWs = onlineByUserId.get(target.id);
            if (targetWs) {
              if (action === "mute") {
                send(targetWs, { type: "muted", reason, until: expiresAt });
              } else {
                wsCloseWithBan(targetWs, reason, expiresAt ? expiresAt.toISOString() : null);
              }
            }
            return;
          }

          if (action === "unmute" || action === "unban") {
            const t = await getUserByUsername(targetUser);
            if (!t) { send(ws, { type: "error", error: "user_not_found" }); return; }
            const type = action === "unmute" ? "mute" : "ban";
            await q("UPDATE sanctions SET expires_at=NOW() WHERE user_id=? AND type=? AND (expires_at IS NULL OR expires_at > NOW())", [t.id, type]);
            send(ws, { type: "ok", op: action, username: t.username });
            return;
          }

          if (action === "set_prefix") {
            const t = await getUserByUsername(targetUser);
            if (!t) { send(ws, { type: "error", error: "user_not_found" }); return; }
            const prefix = String(data.prefix || "").slice(0, 24);
            await q("UPDATE users SET prefix=? WHERE id=?", [prefix, t.id]);
            send(ws, { type: "ok", op: "set_prefix", username: t.username, prefix });
            await pushDirectory(ws);
            broadcast(clients, { type: "directory_changed" });
            return;
          }

          if (action === "clear_db") {
            await q("DELETE FROM messages");
            await q("DELETE FROM channels");
            await q("DELETE FROM sanctions");
            // keep users + sessions
            send(ws, { type: "ok", op: "clear_db" });
            broadcast(clients, { type: "directory_changed" });
            return;
          }

          send(ws, { type: "error", error: "unknown_admin_action" });
          return;
        }

      } catch (e) {
        console.error("WS handler error:", e);
        send(ws, { type: "error", error: "server_error" });
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      if (ws.user) {
        onlineByUserId.delete(ws.user.id);
        broadcast(clients, { type: "presence", user: ws.user.username, online: false });
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`HTTP/WS listening on :${PORT}`);
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
