'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) throw new Error('DATABASE_URL is required. Add your Render PostgreSQL Internal Database URL.');
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET is required and must contain at least 32 characters.');
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
const isProduction = process.env.NODE_ENV === 'production';

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  next();
});

const sessionMiddleware = session({
  name: 'vibe.sid',
  store: new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

const makeId = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const cleanUsername = value => String(value || '').trim().toLowerCase();
const validUsername = value => /^[a-z0-9_]{3,20}$/.test(value);
const publicUser = user => ({ id: user.id, username: user.username, createdAt: user.created_at });
const apiError = (res, status, error) => res.status(status).json({ error });

async function findUser(id) {
  const result = await pool.query('SELECT id, username, created_at FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
}
async function findConversation(id) {
  const result = await pool.query('SELECT id, name, type, created_at, updated_at FROM conversations WHERE id = $1', [id]);
  return result.rows[0] || null;
}
async function isMember(conversationId, userId) {
  const result = await pool.query('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
  return result.rowCount > 0;
}
async function requireAuth(req, res, next) {
  try {
    if (!req.session.userId || !(await findUser(req.session.userId))) return apiError(res, 401, 'Please sign in first.');
    next();
  } catch (error) { next(error); }
}
async function conversationSummary(conversation, viewerId) {
  const [membersResult, lastResult] = await Promise.all([
    pool.query(`SELECT u.id, u.username, u.created_at FROM users u
      JOIN conversation_members cm ON cm.user_id = u.id
      WHERE cm.conversation_id = $1 ORDER BY u.username`, [conversation.id]),
    pool.query(`SELECT id, sender_id, text, created_at FROM messages
      WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`, [conversation.id])
  ]);
  const last = lastResult.rows[0];
  return {
    id: conversation.id,
    name: conversation.name,
    type: conversation.type,
    members: membersResult.rows.map(publicUser),
    lastMessage: last ? { text: last.text, senderId: last.sender_id, createdAt: last.created_at } : null,
    updatedAt: conversation.updated_at
  };
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username VARCHAR(20) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      type VARCHAR(10) NOT NULL CHECK (type IN ('direct', 'group')),
      name VARCHAR(60) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text VARCHAR(2000) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages(conversation_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS conversation_members_user_idx ON conversation_members(user_id, conversation_id);
  `);
}

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, app: 'VIBE', database: 'connected', time: now() }); }
  catch { res.status(503).json({ ok: false, app: 'VIBE', database: 'unavailable' }); }
});
app.get('/api/me', async (req, res, next) => {
  try { const user = req.session.userId ? await findUser(req.session.userId) : null; res.json({ user: user ? publicUser(user) : null }); }
  catch (error) { next(error); }
});

app.post('/api/register', async (req, res, next) => {
  try {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.password || '');
    if (!validUsername(username)) return apiError(res, 400, 'Username must be 3–20 characters: letters, numbers, underscores.');
    if (password.length < 10 || password.length > 128) return apiError(res, 400, 'Password must be 10–128 characters.');
    const id = makeId();
    const passwordHash = await bcrypt.hash(password, 12);
    let result;
    try {
      result = await pool.query('INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3) RETURNING id, username, created_at', [id, username, passwordHash]);
    } catch (error) {
      if (error.code === '23505') return apiError(res, 409, 'That username is already taken.');
      throw error;
    }
    req.session.userId = result.rows[0].id;
    req.session.save(error => error ? apiError(res, 500, 'Could not create session.') : res.status(201).json({ user: publicUser(result.rows[0]) }));
  } catch (error) { next(error); }
});
app.post('/api/login', async (req, res, next) => {
  try {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.password || '');
    const result = await pool.query('SELECT id, username, password_hash, created_at FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    const valid = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!valid) return apiError(res, 401, 'Incorrect username or password.');
    req.session.regenerate(error => {
      if (error) return apiError(res, 500, 'Could not create session.');
      req.session.userId = user.id;
      req.session.save(saveError => saveError ? apiError(res, 500, 'Could not create session.') : res.json({ user: publicUser(user) }));
    });
  } catch (error) { next(error); }
});
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('vibe.sid', { httpOnly: true, sameSite: 'lax', secure: isProduction });
    res.json({ ok: true });
  });
});
app.get('/api/users', requireAuth, async (req, res, next) => {
  try {
    const q = cleanUsername(req.query.q).slice(0, 20);
    const result = await pool.query(`SELECT id, username, created_at FROM users
      WHERE id <> $1 AND username LIKE $2 ORDER BY username LIMIT 30`, [req.session.userId, `%${q}%`]);
    res.json({ users: result.rows.map(user => ({ ...publicUser(user), online: onlineUsers.has(user.id) })) });
  } catch (error) { next(error); }
});
app.get('/api/conversations', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT c.* FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id = c.id
      WHERE cm.user_id = $1 ORDER BY c.updated_at DESC`, [req.session.userId]);
    const conversations = await Promise.all(result.rows.map(c => conversationSummary(c, req.session.userId)));
    res.json({ conversations });
  } catch (error) { next(error); }
});
app.post('/api/conversations/direct', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const username = cleanUsername(req.body.username);
    const otherResult = await client.query('SELECT id FROM users WHERE username = $1', [username]);
    const other = otherResult.rows[0];
    if (!other || other.id === req.session.userId) return apiError(res, 404, 'Find another registered username first.');
    await client.query('BEGIN');
    let result = await client.query(`SELECT c.* FROM conversations c
      JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = $1
      JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = $2
      WHERE c.type = 'direct' LIMIT 1`, [req.session.userId, other.id]);
    let conversation = result.rows[0];
    if (!conversation) {
      const id = makeId();
      result = await client.query(`INSERT INTO conversations (id, type) VALUES ($1, 'direct') RETURNING *`, [id]);
      conversation = result.rows[0];
      await client.query('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)', [id, req.session.userId, other.id]);
    }
    await client.query('COMMIT');
    res.json({ conversation: await conversationSummary(conversation, req.session.userId) });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});
app.post('/api/conversations/group', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const name = String(req.body.name || '').trim().slice(0, 60);
    const usernames = Array.isArray(req.body.usernames) ? [...new Set(req.body.usernames.slice(0, 49).map(cleanUsername))] : [];
    if (name.length < 2) return apiError(res, 400, 'Group name must be at least 2 characters.');
    const found = usernames.length ? await client.query('SELECT id FROM users WHERE username = ANY($1::text[])', [usernames]) : { rows: [] };
    const members = [...new Set([req.session.userId, ...found.rows.map(u => u.id)])];
    if (members.length < 3) return apiError(res, 400, 'Add at least two other registered users to create a group.');
    if (members.length > 50) return apiError(res, 400, 'Groups are limited to 50 members.');
    await client.query('BEGIN');
    const id = makeId();
    const inserted = await client.query(`INSERT INTO conversations (id, type, name) VALUES ($1, 'group', $2) RETURNING *`, [id, name]);
    for (const memberId of members) await client.query('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)', [id, memberId]);
    await client.query('COMMIT');
    res.status(201).json({ conversation: await conversationSummary(inserted.rows[0], req.session.userId) });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});
app.get('/api/conversations/:id/messages', requireAuth, async (req, res, next) => {
  try {
    if (!(await isMember(req.params.id, req.session.userId))) return apiError(res, 404, 'Conversation not found.');
    const result = await pool.query(`SELECT m.id, m.conversation_id, m.sender_id, m.text, m.created_at, u.username AS sender
      FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = $1 ORDER BY m.created_at DESC LIMIT 200`, [req.params.id]);
    res.json({ messages: result.rows.reverse().map(m => ({ id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, sender: m.sender, text: m.text, createdAt: m.created_at })) });
  } catch (error) { next(error); }
});

const onlineUsers = new Map();
function emitPresence() { io.emit('presence:update', [...onlineUsers.keys()].map(userId => ({ userId, online: true }))); }
io.engine.use(sessionMiddleware);
io.use(async (socket, next) => {
  try {
    const userId = socket.request.session?.userId;
    if (!userId || !(await findUser(userId))) return next(new Error('Please sign in to use VIBE chat.'));
    socket.userId = userId;
    next();
  } catch { next(new Error('Could not verify your VIBE session.')); }
});
io.on('connection', async socket => {
  const userId = socket.userId;
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socket.id);
  socket.join('user:' + userId);
  const memberships = await pool.query('SELECT conversation_id FROM conversation_members WHERE user_id = $1', [userId]);
  memberships.rows.forEach(row => socket.join('conversation:' + row.conversation_id));
  emitPresence();

  socket.on('conversation:join', async conversationId => {
    if (typeof conversationId !== 'string' || conversationId.length > 80) return;
    if (await isMember(conversationId, userId)) socket.join('conversation:' + conversationId);
  });
  socket.on('message:send', async payload => {
    try {
      const conversationId = String(payload?.conversationId || '');
      const text = String(payload?.text || '').trim();
      if (!text || text.length > 2000 || !(await isMember(conversationId, userId))) {
        return socket.emit('app:error', 'Message must be 1–2000 characters and sent to a conversation you belong to.');
      }
      const id = makeId();
      const inserted = await pool.query(`INSERT INTO messages (id, conversation_id, sender_id, text)
        VALUES ($1, $2, $3, $4) RETURNING created_at`, [id, conversationId, userId, text]);
      await pool.query('UPDATE conversations SET updated_at = $1 WHERE id = $2', [inserted.rows[0].created_at, conversationId]);
      const user = await findUser(userId);
      const message = { id, conversationId, senderId: userId, sender: user.username, text, createdAt: inserted.rows[0].created_at };
      io.to('conversation:' + conversationId).emit('message:new', message);
      const conversation = await findConversation(conversationId);
      io.to('conversation:' + conversationId).emit('conversation:updated', await conversationSummary(conversation, userId));
    } catch { socket.emit('app:error', 'Message could not be saved. Please try again.'); }
  });
  socket.on('call:invite', async payload => {
    const c = await findConversation(String(payload?.conversationId || ''));
    const targetId = String(payload?.targetUserId || '');
    if (!c || c.type !== 'direct' || !(await isMember(c.id, userId)) || !(await isMember(c.id, targetId)) || targetId === userId) return;
    const user = await findUser(userId);
    io.to('user:' + targetId).emit('call:invite', { conversationId: c.id, fromUserId: userId, fromUsername: user.username, mode: payload?.mode === 'audio' ? 'audio' : 'video' });
  });
  for (const event of ['call:accept', 'call:decline', 'call:offer', 'call:answer', 'call:ice', 'call:end']) {
    socket.on(event, async payload => {
      try {
        const c = await findConversation(String(payload?.conversationId || ''));
        const targetId = String(payload?.targetUserId || '');
        if (!c || c.type !== 'direct' || !(await isMember(c.id, userId)) || !(await isMember(c.id, targetId)) || targetId === userId) return;
        const { targetUserId, ...safePayload } = payload || {};
        io.to('user:' + targetId).emit(event, { ...safePayload, fromUserId: userId });
      } catch { /* Ignore malformed or failed call relay events. */ }
    });
  }
  socket.on('disconnect', () => {
    const sockets = onlineUsers.get(userId);
    if (sockets) { sockets.delete(socket.id); if (!sockets.size) onlineUsers.delete(userId); }
    emitPresence();
  });
});

app.use((error, _req, res, _next) => {
  console.error('VIBE request failed:', error.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

initializeDatabase().then(() => {
  server.listen(PORT, '0.0.0.0', () => console.log(`VIBE is running on port ${PORT}`));
}).catch(error => {
  console.error('VIBE database initialization failed:', error.message);
  process.exit(1);
});
