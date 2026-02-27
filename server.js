const http = require("http");
const WebSocket = require("ws");
const mysql = require("mysql2/promise");

const PORT = Number(process.env.PORT || 3000);

let db;

// Подключение к MySQL Railway
async function initDB() {
  db = await mysql.createConnection({
    host: process.env.MYSQLHOST,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    port: process.env.MYSQLPORT
  });

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      userId VARCHAR(64) PRIMARY KEY,
      display VARCHAR(255),
      lastSeen DATETIME
    )
  `);

  console.log("MySQL connected");
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200);
    return res.end("ok");
  }
  res.writeHead(200);
  res.end("flip-chat-server ok");
});

const wss = new WebSocket.Server({ server });

const online = new Map();

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

async function getDirectory() {
  const [rows] = await db.execute("SELECT * FROM users");
  return rows.map(r => ({
    userId: r.userId,
    userData: { display: r.display },
    online: online.has(r.userId)
  }));
}

wss.on("connection", (ws) => {
  let userId = null;

  ws.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.type === "register") {
      userId = data.userId;
      const display = data.userData?.display || userId;

      online.set(userId, { ws });

      await db.execute(
        "INSERT INTO users (userId, display, lastSeen) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE display=?, lastSeen=NOW()",
        [userId, display, display]
      );

      const users = await getDirectory();
      safeSend(ws, { type: "user_directory", users });

      for (const [uid, c] of online.entries()) {
        if (uid !== userId) {
          safeSend(c.ws, {
            type: "user_online",
            userId,
            userData: { display }
          });
        }
      }
      return;
    }

    if (data.type === "get_directory") {
      const users = await getDirectory();
      safeSend(ws, { type: "user_directory", users });
      return;
    }

    if (!userId) return;

    if (data.type === "private_message") {
      const target = online.get(data.to);
      if (target) {
        safeSend(target.ws, {
          type: "private_message",
          from: userId,
          to: data.to,
          text: data.text,
          timestamp: new Date().toISOString()
        });
      }
    }
  });

  ws.on("close", async () => {
    if (!userId) return;
    online.delete(userId);

    await db.execute(
      "UPDATE users SET lastSeen=NOW() WHERE userId=?",
      [userId]
    );

    for (const [uid, c] of online.entries()) {
      safeSend(c.ws, {
        type: "user_offline",
        userId
      });
    }
  });
});

initDB().then(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log("Server running on port", PORT);
  });
});
