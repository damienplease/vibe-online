'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.warn('WARNING: Set SESSION_SECRET to a random value of at least 32 characters in .env before public deployment.');
}
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'db.json');
const db = loadDb();
function loadDb() {
  try { return JSON.parse(fs.readFileSync(dbPath, 'utf8')); }
  catch { return { users: [], conversations: [], messages: [] }; }
}
function saveDb() {
  const temp = dbPath + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(db, null, 2));
  fs.renameSync(temp, dbPath);
}
const sessionMiddleware = session({
  name: 'vibe.sid',
  secret: SESSION_SECRET || crypto.randomBytes(48).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 }
});
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const cleanUsername = v => String(v || '').trim().toLowerCase();
const validUsername = v => /^[a-z0-9_]{3,20}$/.test(v);
const publicUser = u => ({ id: u.id, username: u.username, createdAt: u.createdAt });
const findUser = id => db.users.find(u => u.id === id);
const findConversation = id => db.conversations.find(c => c.id === id);
const isMember = (c, userId) => !!c && c.members.includes(userId);
const makeId = () => crypto.randomUUID();
const time = () => new Date().toISOString();
function apiError(res, status, error) { return res.status(status).json({ error }); }
function requireAuth(req, res, next) {
  if (!req.session.userId || !findUser(req.session.userId)) return apiError(res, 401, 'Please sign in first.');
  next();
}
function conversationSummary(c, userId) {
  const last = db.messages.filter(m => m.conversationId === c.id).slice(-1)[0];
  return {
    id: c.id, name: c.name, type: c.type,
    members: c.members.map(findUser).filter(Boolean).map(publicUser),
    lastMessage: last ? { text: last.text, senderId: last.senderId, createdAt: last.createdAt } : null,
    updatedAt: c.updatedAt
  };
}
app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'VIBE', time: time() }));
app.get('/api/me', (req, res) => {
  const u = req.session.userId && findUser(req.session.userId);
  res.json({ user: u ? publicUser(u) : null });
});
app.post('/api/register', async (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!validUsername(username)) return apiError(res, 400, 'Username must be 3–20 characters: letters, numbers, underscores.');
  if (password.length < 10 || password.length > 128) return apiError(res, 400, 'Password must be 10–128 characters.');
  if (db.users.some(u => u.username === username)) return apiError(res, 409, 'That username is already taken.');
  const user = { id: makeId(), username, passwordHash: await bcrypt.hash(password, 12), createdAt: time() };
  db.users.push(user); saveDb();
  req.session.userId = user.id;
  req.session.save(err => err ? apiError(res, 500, 'Could not create session.') : res.status(201).json({ user: publicUser(user) }));
});
app.post('/api/login', async (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  const user = db.users.find(u => u.username === username);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return apiError(res, 401, 'Incorrect username or password.');
  req.session.userId = user.id;
  req.session.save(err => err ? apiError(res, 500, 'Could not create session.') : res.json({ user: publicUser(user) }));
});
app.post('/api/logout', (req, res) => req.session.destroy(() => {
  res.clearCookie('vibe.sid', { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true });
}));
app.get('/api/users', requireAuth, (req, res) => {
  const q = cleanUsername(req.query.q);
  const users = db.users.filter(u => u.id !== req.session.userId && (!q || u.username.includes(q)))
    .slice(0, 30).map(u => ({ ...publicUser(u), online: onlineUsers.has(u.id) }));
  res.json({ users });
});
app.get('/api/conversations', requireAuth, (req, res) => {
  const list = db.conversations.filter(c => isMember(c, req.session.userId))
    .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(c => conversationSummary(c, req.session.userId));
  res.json({ conversations: list });
});
app.post('/api/conversations/direct', requireAuth, (req, res) => {
  const username = cleanUsername(req.body.username);
  const other = db.users.find(u => u.username === username);
  if (!other || other.id === req.session.userId) return apiError(res, 404, 'Find another registered username first.');
  let c = db.conversations.find(c => c.type === 'direct' && c.members.length === 2 &&
    c.members.includes(req.session.userId) && c.members.includes(other.id));
  if (!c) {
    c = { id: makeId(), type: 'direct', name: '', members: [req.session.userId, other.id], createdAt: time(), updatedAt: time() };
    db.conversations.push(c); saveDb();
  }
  res.json({ conversation: conversationSummary(c, req.session.userId) });
});
app.post('/api/conversations/group', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const usernames = Array.isArray(req.body.usernames) ? req.body.usernames.map(cleanUsername) : [];
  if (name.length < 2) return apiError(res, 400, 'Group name must be at least 2 characters.');
  const found = usernames.map(n => db.users.find(u => u.username === n)).filter(Boolean);
  const members = [...new Set([req.session.userId, ...found.map(u => u.id)])];
  if (members.length < 3) return apiError(res, 400, 'Add at least two other registered users to create a group.');
  if (members.length > 50) return apiError(res, 400, 'Groups are limited to 50 members.');
  const c = { id: makeId(), type: 'group', name, members, createdAt: time(), updatedAt: time() };
  db.conversations.push(c); saveDb();
  res.status(201).json({ conversation: conversationSummary(c, req.session.userId) });
});
app.get('/api/conversations/:id/messages', requireAuth, (req, res) => {
  const c = findConversation(req.params.id);
  if (!isMember(c, req.session.userId)) return apiError(res, 404, 'Conversation not found.');
  const messages = db.messages.filter(m => m.conversationId === c.id).slice(-200).map(m => ({
    id: m.id, conversationId: m.conversationId, senderId: m.senderId,
    sender: findUser(m.senderId)?.username || 'unknown', text: m.text, createdAt: m.createdAt
  }));
  res.json({ messages });
});

const onlineUsers = new Map(); // userId -> Set(socketId)
const onlineCount = id => onlineUsers.get(id)?.size || 0;
function emitPresence() {
  io.emit('presence:update', [...onlineUsers.keys()].map(id => ({ userId: id, online: true })));
}
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const userId = socket.request.session?.userId;
  if (!userId || !findUser(userId)) return next(new Error('Please sign in to use VIBE chat.'));
  socket.userId = userId;
  next();
});
io.on('connection', socket => {
  const userId = socket.userId;
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socket.id);
  socket.join('user:' + userId);
  db.conversations.filter(c => isMember(c, userId)).forEach(c => socket.join('conversation:' + c.id));
  emitPresence();
  socket.on('conversation:join', conversationId => {
    const c = findConversation(String(conversationId || ''));
    if (isMember(c, userId)) socket.join('conversation:' + c.id);
  });
  socket.on('message:send', payload => {
    const c = findConversation(String(payload?.conversationId || ''));
    const text = String(payload?.text || '').trim();
    if (!isMember(c, userId) || !text || text.length > 2000) return socket.emit('app:error', 'Message must be 1–2000 characters and sent to a conversation you belong to.');
    const msg = { id: makeId(), conversationId: c.id, senderId: userId, text, createdAt: time() };
    db.messages.push(msg); c.updatedAt = msg.createdAt; saveDb();
    io.to('conversation:' + c.id).emit('message:new', { ...msg, sender: findUser(userId).username });
    io.to('conversation:' + c.id).emit('conversation:updated', conversationSummary(c, userId));
  });
  socket.on('call:invite', payload => {
    const c = findConversation(String(payload?.conversationId || ''));
    if (!isMember(c, userId) || c.type !== 'direct') return;
    const targetId = String(payload?.targetUserId || '');
    if (!c.members.includes(targetId) || targetId === userId) return;
    io.to('user:' + targetId).emit('call:invite', {
      conversationId: c.id, fromUserId: userId,
      fromUsername: findUser(userId).username, mode: payload?.mode === 'audio' ? 'audio' : 'video'
    });
  });
  socket.on('call:accept', p => relayCall(socket, p, 'call:accept'));
  socket.on('call:decline', p => relayCall(socket, p, 'call:decline'));
  socket.on('call:offer', p => relayCall(socket, p, 'call:offer'));
  socket.on('call:answer', p => relayCall(socket, p, 'call:answer'));
  socket.on('call:ice', p => relayCall(socket, p, 'call:ice'));
  socket.on('call:end', p => relayCall(socket, p, 'call:end'));
  function relayCall(sock, p, event) {
    const c = findConversation(String(p?.conversationId || ''));
    const targetId = String(p?.targetUserId || '');
    if (!isMember(c, userId) || c?.type !== 'direct' || !c.members.includes(targetId) || targetId === userId) return;
    io.to('user:' + targetId).emit(event, { ...p, targetUserId: undefined, fromUserId: userId });
  }
  socket.on('disconnect', () => {
    const set = onlineUsers.get(userId);
    if (set) { set.delete(socket.id); if (!set.size) onlineUsers.delete(userId); }
    emitPresence();
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`VIBE is running at http://localhost:${PORT}`));
