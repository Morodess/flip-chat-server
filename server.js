'use strict';

const http = require('http');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const PORT = Number(process.env.PORT || 8080);

// Railway: добавь переменную MYSQL_URL (Reference на MySQL -> MYSQL_URL)
// ADMIN_USERS=morodess,anotheradmin
const MYSQL_URL = process.env.MYSQL_URL || process.env.MYSQL_PUBLIC_URL || '';
const ADMIN_USERS = (process.env.ADMIN_USERS || 'morodess')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function parseMysqlUrl(urlStr) {
  if (!urlStr) return null;
  const u = new URL(urlStr);
  // mysql://user:pass@host:port/db
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '') || undefined,
    ssl: undefined
  };
}

let pool;

async function initDb() {
  const cfg = parseMysqlUrl(MYSQL_URL);
  if (!cfg) throw new Error('MYSQL_URL is empty. Set MYSQL_URL in Railway variables.');
  pool = mysql.createPool({
    ...cfg,
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 5,
    idleTimeout: 60000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  });
  // quick ping
  const c = await pool.getConnection();
  await c.ping();
  c.release();
  console.log('[db] connected');
}

async function q(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

function dmKey(a, b) {
  const x = String(a), y = String(b);
  return (x < y) ? `${x}:${y}` : `${y}:${x}`;
}

function isAdminUsername(username) {
  return ADMIN_USERS.includes(String(username || '').toLowerCase());
}

async function upsertPresence(userId, isOnline) {
  await q(
    `INSERT INTO presence (user_id, is_online, last_seen)
     VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE is_online=VALUES(is_online), last_seen=NOW()`,
    [userId, isOnline ? 1 : 0]
  );
}

async function getOnlineMap() {
  const rows = await q(
    `SELECT p.user_id, p.is_online, p.last_seen, u.username, u.prefix, u.avatar_url
     FROM presence p
     JOIN users u ON u.id = p.user_id`
  );
  return rows.map(r => ({
    userId: r.user_id,
    username: r.username,
    prefix: r.prefix,
    avatarUrl: r.avatar_url,
    isOnline: !!r.is_online,
    lastSeen: r.last_seen
  }));
}

async function getUserByUsername(username) {
  const rows = await q(`SELECT * FROM users WHERE username=? LIMIT 1`, [username]);
  return rows[0] || null;
}

async function getUserById(id) {
  const rows = await q(`SELECT * FROM users WHERE id=? LIMIT 1`, [id]);
  return rows[0] || null;
}

async function getActiveBan(userId) {
  const rows = await q(
    `SELECT * FROM bans
     WHERE user_id=?
       AND (banned_until IS NULL OR banned_until > NOW())
     ORDER BY id DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function getActiveMute(userId) {
  const rows = await q(
    `SELECT * FROM mutes
     WHERE user_id=?
       AND (muted_until IS NULL OR muted_until > NOW())
     ORDER BY id DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function createSession(userId, hours = 24 * 30) { // 30 дней
  const token = uuidv4();
  await q(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
    [token, userId, hours]
  );
  return token;
}

async function getSession(token) {
  const rows = await q(
    `SELECT * FROM sessions
     WHERE token=? AND expires_at > NOW()
     LIMIT 1`,
    [token]
  );
  return rows[0] || null;
}

async function deleteSession(token) {
  await q(`DELETE FROM sessions WHERE token=?`, [token]);
}

async function ensureDefaultChannels(ownerId) {
  // создадим 2 дефолта если нет
  const exists = await q(`SELECT id FROM channels WHERE name='Тех поддержка' LIMIT 1`);
  if (!exists.length) {
    const r = await q(`INSERT INTO channels (name, owner_id, is_private) VALUES ('Тех поддержка', ?, 0)`, [ownerId]);
    const id = r.insertId;
    await q(`INSERT IGNORE INTO channel_members (channel_id, user_id, role) VALUES (?, ?, 'owner')`, [id, ownerId]);
  }
  const exists2 = await q(`SELECT id FROM channels WHERE name='Избранное' LIMIT 1`);
  if (!exists2.length) {
    const r = await q(`INSERT INTO channels (name, owner_id, is_private) VALUES ('Избранное', ?, 1)`, [ownerId]);
    const id = r.insertId;
    await q(`INSERT IGNORE INTO channel_members (channel_id, user_id, role) VALUES (?, ?, 'owner')`, [id, ownerId]);
  }
}

function safeSend(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

const clientsByUserId = new Map(); // userId -> Set(ws)

function addClient(userId, ws) {
  if (!clientsByUserId.has(userId)) clientsByUserId.set(userId, new Set());
  clientsByUserId.get(userId).add(ws);
}
function removeClient(userId, ws) {
  const set = clientsByUserId.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) clientsByUserId.delete(userId);
}
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const set of clientsByUserId.values()) {
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
}

async function broadcastPresence() {
  const list = await getOnlineMap();
  broadcast({ type: 'presence', list });
}

async function sendDirectory(ws, currentUserId) {
  // users list
  const users = await q(`SELECT id, username, prefix, avatar_url, can_show_email FROM users ORDER BY username ASC`);
  const channels = await q(
    `SELECT c.id, c.name, c.owner_id, c.is_private
     FROM channels c
     JOIN channel_members m ON m.channel_id=c.id
     WHERE m.user_id=?
     ORDER BY c.id ASC`,
    [currentUserId]
  );
  safeSend(ws, { type: 'directory', users, channels });
}

async function getHistoryDM(userId, otherUserId, limit = 100) {
  const key = dmKey(userId, otherUserId);
  const rows = await q(
    `SELECT m.id, m.kind, m.body, m.attachment_url, m.created_at,
            u.username as sender_username, u.prefix as sender_prefix, u.avatar_url as sender_avatar, u.id as sender_id
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.dm_key=?
     ORDER BY m.id DESC
     LIMIT ?`,
    [key, Number(limit)]
  );
  return rows.reverse();
}

async function getHistoryChannel(channelId, limit = 100) {
  const rows = await q(
    `SELECT m.id, m.kind, m.body, m.attachment_url, m.created_at,
            u.username as sender_username, u.prefix as sender_prefix, u.avatar_url as sender_avatar, u.id as sender_id
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.channel_id=?
     ORDER BY m.id DESC
     LIMIT ?`,
    [Number(channelId), Number(limit)]
  );
  return rows.reverse();
}

async function handleAdminAction(current, data, ws) {
  if (!current?.isAdmin) {
    safeSend(ws, { type: 'error', message: 'Not admin' });
    return;
  }

  const targetUsername = String(data.target || '').trim().replace(/^@/, '');
  const target = await getUserByUsername(targetUsername);
  if (!target) {
    safeSend(ws, { type: 'error', message: 'User not found' });
    return;
  }

  if (data.type === 'admin_set_prefix') {
    const prefix = (data.prefix ?? '').toString().trim();
    await q(`UPDATE users SET prefix=? WHERE id=?`, [prefix || null, target.id]);
    safeSend(ws, { type: 'ok', message: 'prefix updated' });
    broadcast({ type: 'user_updated', userId: target.id, prefix: prefix || null });
    return;
  }

  if (data.type === 'admin_mute') {
    const minutes = Number(data.minutes || 0);
    const reason = String(data.reason || 'muted').trim();
    const until = minutes > 0 ? `DATE_ADD(NOW(), INTERVAL ${Math.floor(minutes)} MINUTE)` : null;
    if (until) {
      await q(`INSERT INTO mutes (user_id, reason, muted_until) VALUES (?, ?, ${until})`, [target.id, reason]);
    } else {
      await q(`INSERT INTO mutes (user_id, reason, muted_until) VALUES (?, ?, NULL)`, [target.id, reason]);
    }
    safeSend(ws, { type: 'ok', message: 'muted' });
    const set = clientsByUserId.get(target.id);
    if (set) {
      for (const c of set) safeSend(c, { type: 'muted', reason, minutes });
    }
    return;
  }

  if (data.type === 'admin_unmute') {
    await q(`DELETE FROM mutes WHERE user_id=?`, [target.id]);
    safeSend(ws, { type: 'ok', message: 'unmuted' });
    const set = clientsByUserId.get(target.id);
    if (set) {
      for (const c of set) safeSend(c, { type: 'unmuted' });
    }
    return;
  }

  if (data.type === 'admin_ban') {
    const minutes = Number(data.minutes || 0);
    const reason = String(data.reason || 'banned').trim();
    const until = minutes > 0 ? `DATE_ADD(NOW(), INTERVAL ${Math.floor(minutes)} MINUTE)` : null;
    if (until) {
      await q(`INSERT INTO bans (user_id, reason, banned_until) VALUES (?, ?, ${until})`, [target.id, reason]);
    } else {
      await q(`INSERT INTO bans (user_id, reason, banned_until) VALUES (?, ?, NULL)`, [target.id, reason]);
    }

    safeSend(ws, { type: 'ok', message: 'banned' });

    const set = clientsByUserId.get(target.id);
    if (set) {
      for (const c of set) {
        safeSend(c, { type: 'banned', reason, minutes });
        try { c.close(4003, 'banned'); } catch {}
      }
    }
    return;
  }

  if (data.type === 'admin_unban') {
    await q(`DELETE FROM bans WHERE user_id=?`, [target.id]);
    safeSend(ws, { type: 'ok', message: 'unbanned' });
    return;
  }

  safeSend(ws, { type: 'error', message: 'Unknown admin action' });
}

async function main() {
  await initDb();

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('FlipChat V3 WS server is running.\n');
  });

  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    ws._current = null;

    safeSend(ws, { type: 'hello', v: 3 });

    ws.on('message', async (buf) => {
      let data;
      try {
        data = JSON.parse(buf.toString('utf8'));
      } catch {
        safeSend(ws, { type: 'error', message: 'Bad JSON' });
        return;
      }

      try {
        // ---------- AUTH ----------
        if (data.type === 'register') {
          const username = String(data.username || '').trim().replace(/^@/, '');
          const email = (data.email ? String(data.email).trim() : null);
          const pass = String(data.password || '');

          if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
            safeSend(ws, { type: 'error', message: 'Username: 3-32, a-z A-Z 0-9 _' });
            return;
          }
          if (pass.length < 4) {
            safeSend(ws, { type: 'error', message: 'Password too short' });
            return;
          }

          const exists = await getUserByUsername(username);
          if (exists) {
            safeSend(ws, { type: 'error', message: 'Username already taken' });
            return;
          }

          const hash = await bcrypt.hash(pass, 10);
          const r = await q(
            `INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)`,
            [username, email, hash]
          );
          const userId = r.insertId;

          // дефолтные каналы для первого пользователя
          await ensureDefaultChannels(userId);

          const token = await createSession(userId);
          const user = await getUserById(userId);

          ws._current = { userId, username: user.username, token, isAdmin: isAdminUsername(user.username) };
          addClient(userId, ws);
          await upsertPresence(userId, true);
          await broadcastPresence();

          safeSend(ws, {
            type: 'auth_ok',
            token,
            user: {
              id: user.id,
              username: user.username,
              email: user.email,
              can_show_email: !!user.can_show_email,
              prefix: user.prefix,
              avatar_url: user.avatar_url,
              isAdmin: ws._current.isAdmin
            }
          });

          await sendDirectory(ws, userId);
          return;
        }

        if (data.type === 'login') {
          const username = String(data.username || '').trim().replace(/^@/, '');
          const pass = String(data.password || '');

          const user = await getUserByUsername(username);
          if (!user) {
            safeSend(ws, { type: 'error', message: 'Bad login' });
            return;
          }

          const ban = await getActiveBan(user.id);
          if (ban) {
            safeSend(ws, {
              type: 'banned',
              reason: ban.reason,
              until: ban.banned_until
            });
            try { ws.close(4003, 'banned'); } catch {}
            return;
          }

          const ok = await bcrypt.compare(pass, user.password_hash);
          if (!ok) {
            safeSend(ws, { type: 'error', message: 'Bad login' });
            return;
          }

          const token = await createSession(user.id);
          ws._current = { userId: user.id, username: user.username, token, isAdmin: isAdminUsername(user.username) };
          addClient(user.id, ws);

          await upsertPresence(user.id, true);
          await broadcastPresence();

          safeSend(ws, {
            type: 'auth_ok',
            token,
            user: {
              id: user.id,
              username: user.username,
              email: user.email,
              can_show_email: !!user.can_show_email,
              prefix: user.prefix,
              avatar_url: user.avatar_url,
              isAdmin: ws._current.isAdmin
            }
          });

          await sendDirectory(ws, user.id);
          return;
        }

        if (data.type === 'resume') {
          const token = String(data.token || '');
          const sess = await getSession(token);
          if (!sess) {
            safeSend(ws, { type: 'auth_required' });
            return;
          }

          const user = await getUserById(sess.user_id);
          if (!user) {
            await deleteSession(token);
            safeSend(ws, { type: 'auth_required' });
            return;
          }

          const ban = await getActiveBan(user.id);
          if (ban) {
            safeSend(ws, { type: 'banned', reason: ban.reason, until: ban.banned_until });
            try { ws.close(4003, 'banned'); } catch {}
            return;
          }

          ws._current = { userId: user.id, username: user.username, token, isAdmin: isAdminUsername(user.username) };
          addClient(user.id, ws);

          await upsertPresence(user.id, true);
          await broadcastPresence();

          safeSend(ws, {
            type: 'auth_ok',
            token,
            user: {
              id: user.id,
              username: user.username,
              email: user.email,
              can_show_email: !!user.can_show_email,
              prefix: user.prefix,
              avatar_url: user.avatar_url,
              isAdmin: ws._current.isAdmin
            }
          });

          await sendDirectory(ws, user.id);
          return;
        }

        if (data.type === 'logout') {
          if (ws._current?.token) await deleteSession(ws._current.token);
          safeSend(ws, { type: 'logged_out' });
          try { ws.close(1000, 'logout'); } catch {}
          return;
        }

        // всё ниже требует auth
        if (!ws._current) {
          safeSend(ws, { type: 'auth_required' });
          return;
        }

        // ---------- DIRECTORY / PRESENCE ----------
        if (data.type === 'get_directory') {
          await sendDirectory(ws, ws._current.userId);
          return;
        }
        if (data.type === 'get_presence') {
          const list = await getOnlineMap();
          safeSend(ws, { type: 'presence', list });
          return;
        }

        // ---------- PROFILE SETTINGS ----------
        if (data.type === 'set_profile') {
          const canShow = data.can_show_email ? 1 : 0;
          const avatarUrl = data.avatar_url ? String(data.avatar_url).trim() : null;
          const email = data.email ? String(data.email).trim() : null;
          await q(
            `UPDATE users SET can_show_email=?, avatar_url=COALESCE(?, avatar_url), email=COALESCE(?, email) WHERE id=?`,
            [canShow, avatarUrl, email, ws._current.userId]
          );
          safeSend(ws, { type: 'ok', message: 'profile updated' });
          broadcast({ type: 'user_updated', userId: ws._current.userId, avatarUrl, can_show_email: !!canShow });
          return;
        }

        if (data.type === 'get_profile') {
          const username = String(data.username || '').trim().replace(/^@/, '');
          const u = await getUserByUsername(username);
          if (!u) {
            safeSend(ws, { type: 'error', message: 'User not found' });
            return;
          }
          safeSend(ws, {
            type: 'profile',
            user: {
              id: u.id,
              username: u.username,
              prefix: u.prefix,
              avatar_url: u.avatar_url,
              email: u.can_show_email ? u.email : null,
              can_show_email: !!u.can_show_email
            }
          });
          return;
        }

        // ---------- CHANNELS ----------
        if (data.type === 'create_channel') {
          const name = String(data.name || '').trim();
          if (name.length < 2 || name.length > 64) {
            safeSend(ws, { type: 'error', message: 'Bad channel name' });
            return;
          }
          const isPrivate = data.is_private ? 1 : 0;

          try {
            const r = await q(
              `INSERT INTO channels (name, owner_id, is_private) VALUES (?, ?, ?)`,
              [name, ws._current.userId, isPrivate]
            );
            const channelId = r.insertId;
            await q(
              `INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, 'owner')`,
              [channelId, ws._current.userId]
            );
            safeSend(ws, { type: 'channel_created', channel: { id: channelId, name, owner_id: ws._current.userId, is_private: !!isPrivate } });
            await sendDirectory(ws, ws._current.userId);
          } catch {
            safeSend(ws, { type: 'error', message: 'Channel name already exists' });
          }
          return;
        }

        if (data.type === 'join_channel') {
          const channelId = Number(data.channel_id);
          await q(`INSERT IGNORE INTO channel_members (channel_id, user_id, role) VALUES (?, ?, 'member')`, [channelId, ws._current.userId]);
          safeSend(ws, { type: 'ok', message: 'joined' });
          await sendDirectory(ws, ws._current.userId);
          return;
        }

        // ---------- HISTORY ----------
        if (data.type === 'get_history_dm') {
          const other = String(data.with || '').trim().replace(/^@/, '');
          const u = await getUserByUsername(other);
          if (!u) {
            safeSend(ws, { type: 'error', message: 'User not found' });
            return;
          }
          const hist = await getHistoryDM(ws._current.userId, u.id, data.limit || 100);
          safeSend(ws, { type: 'history_dm', with: u.username, items: hist });
          return;
        }

        if (data.type === 'get_history_channel') {
          const channelId = Number(data.channel_id);
          const hist = await getHistoryChannel(channelId, data.limit || 100);
          safeSend(ws, { type: 'history_channel', channel_id: channelId, items: hist });
          return;
        }

        // ---------- SEND MESSAGE ----------
        if (data.type === 'send_dm') {
          const other = String(data.to || '').trim().replace(/^@/, '');
          const text = String(data.text || '');
          const u = await getUserByUsername(other);
          if (!u) {
            safeSend(ws, { type: 'error', message: 'User not found' });
            return;
          }

          const ban = await getActiveBan(ws._current.userId);
          if (ban) {
            safeSend(ws, { type: 'banned', reason: ban.reason, until: ban.banned_until });
            try { ws.close(4003, 'banned'); } catch {}
            return;
          }

          const mute = await getActiveMute(ws._current.userId);
          if (mute) {
            safeSend(ws, { type: 'muted', reason: mute.reason, until: mute.muted_until });
            return;
          }

          const key = dmKey(ws._current.userId, u.id);
          const r = await q(
            `INSERT INTO messages (sender_id, dm_key, kind, body) VALUES (?, ?, 'text', ?)`,
            [ws._current.userId, key, text]
          );
          const msgId = r.insertId;
          const sender = await getUserById(ws._current.userId);

          const payload = {
            type: 'dm_message',
            id: msgId,
            dm_key: key,
            from: sender.username,
            to: u.username,
            sender_id: sender.id,
            sender_prefix: sender.prefix,
            sender_avatar: sender.avatar_url,
            text,
            created_at: new Date().toISOString()
          };

          // sender
          const senderSet = clientsByUserId.get(sender.id);
          if (senderSet) for (const c of senderSet) safeSend(c, payload);

          // receiver
          const recvSet = clientsByUserId.get(u.id);
          if (recvSet) for (const c of recvSet) safeSend(c, payload);

          return;
        }

        if (data.type === 'send_channel') {
          const channelId = Number(data.channel_id);
          const text = String(data.text || '');

          const mute = await getActiveMute(ws._current.userId);
          if (mute) {
            safeSend(ws, { type: 'muted', reason: mute.reason, until: mute.muted_until });
            return;
          }

          // member check
          const mem = await q(
            `SELECT 1 FROM channel_members WHERE channel_id=? AND user_id=? LIMIT 1`,
            [channelId, ws._current.userId]
          );
          if (!mem.length) {
            safeSend(ws, { type: 'error', message: 'Not in channel' });
            return;
          }

          const r = await q(
            `INSERT INTO messages (sender_id, channel_id, kind, body) VALUES (?, ?, 'text', ?)`,
            [ws._current.userId, channelId, text]
          );
          const msgId = r.insertId;
          const sender = await getUserById(ws._current.userId);

          const payload = {
            type: 'channel_message',
            id: msgId,
            channel_id: channelId,
            from: sender.username,
            sender_id: sender.id,
            sender_prefix: sender.prefix,
            sender_avatar: sender.avatar_url,
            text,
            created_at: new Date().toISOString()
          };

          // broadcast всем подключенным (проще)
          broadcast(payload);
          return;
        }

        // ---------- ADMIN ----------
        if (data.type.startsWith('admin_')) {
          await handleAdminAction(ws._current, data, ws);
          return;
        }

        safeSend(ws, { type: 'error', message: 'Unknown command' });

      } catch (e) {
        console.error('[ws] handler error:', e);
        safeSend(ws, { type: 'error', message: 'Server error' });
      }
    });

    ws.on('close', async () => {
      if (ws._current?.userId) {
        const userId = ws._current.userId;
        removeClient(userId, ws);

        // если у юзера больше нет подключений — оффлайн
        const still = clientsByUserId.get(userId);
        if (!still || still.size === 0) {
          try {
            await upsertPresence(userId, false);
            await broadcastPresence();
          } catch {}
        }
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`FlipChat V3 server listening on ${PORT}`);
  });
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
