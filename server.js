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
const { AccessToken } = require('livekit-server-sdk');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const mediaStorageReady = Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_UPLOAD_PRESET);
const liveKitReady = Boolean(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);

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
    CREATE TABLE IF NOT EXISTS follows (follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, followed_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (follower_id, followed_id), CHECK (follower_id <> followed_id));
    CREATE INDEX IF NOT EXISTS follows_followed_idx ON follows(followed_id);
    CREATE TABLE IF NOT EXISTS shorts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, video_url TEXT NOT NULL, storage_key TEXT NOT NULL, caption VARCHAR(500) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS shorts_created_idx ON shorts(created_at DESC);
    CREATE INDEX IF NOT EXISTS shorts_user_idx ON shorts(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS short_likes (short_id TEXT NOT NULL REFERENCES shorts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(short_id,user_id));
    CREATE TABLE IF NOT EXISTS short_favorites (short_id TEXT NOT NULL REFERENCES shorts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(short_id,user_id));
    CREATE TABLE IF NOT EXISTS short_reposts (short_id TEXT NOT NULL REFERENCES shorts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(short_id,user_id));
    CREATE TABLE IF NOT EXISTS short_comments (id TEXT PRIMARY KEY, short_id TEXT NOT NULL REFERENCES shorts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, text VARCHAR(500) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS short_comments_idx ON short_comments(short_id,created_at);
    CREATE TABLE IF NOT EXISTS live_streams (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, room_name TEXT NOT NULL UNIQUE, title VARCHAR(100) NOT NULL, status VARCHAR(12) NOT NULL DEFAULT 'live' CHECK(status IN ('live','ended')), started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ended_at TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS live_streams_status_idx ON live_streams(status,started_at DESC);
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


// Social profiles and short-video feed. Media bytes are stored in Cloudflare R2;
// PostgreSQL stores metadata and social interactions.
app.get('/api/shorts', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT s.id,s.video_url,s.caption,s.created_at,u.id AS user_id,u.username,
      (SELECT COUNT(*)::int FROM short_likes l WHERE l.short_id=s.id) AS likes,
      (SELECT COUNT(*)::int FROM short_comments c WHERE c.short_id=s.id) AS comments,
      (SELECT COUNT(*)::int FROM short_reposts r WHERE r.short_id=s.id) AS reposts,
      EXISTS(SELECT 1 FROM short_likes l WHERE l.short_id=s.id AND l.user_id=$1) AS liked,
      EXISTS(SELECT 1 FROM short_favorites f WHERE f.short_id=s.id AND f.user_id=$1) AS favorited,
      EXISTS(SELECT 1 FROM short_reposts r WHERE r.short_id=s.id AND r.user_id=$1) AS reposted,
      EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.followed_id=u.id) AS is_following,
      (u.id=$1) AS is_me
      FROM shorts s JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT 100`, [req.session.userId]);
    res.json({ shorts: result.rows });
  } catch (error) { next(error); }
});
app.post('/api/shorts/upload-url', requireAuth, async (req, res) => {
  if (!mediaStorageReady) return apiError(res, 503, 'Video storage is not configured yet. Add CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET in Render.');
  const type = String(req.body.contentType || '');
  const size = Number(req.body.size || 0);
  const allowed = ['video/mp4','video/webm','video/quicktime'];
  if (!allowed.includes(type)) return apiError(res, 400, 'Upload an MP4, WebM or MOV video.');
  if (!Number.isFinite(size) || size < 1 || size > 25 * 1024 * 1024) return apiError(res, 400, 'Video must be smaller than 25 MB.');
  res.json({ cloudName: CLOUDINARY_CLOUD_NAME, uploadPreset: CLOUDINARY_UPLOAD_PRESET, resourceType: 'video' });
});
app.post('/api/shorts', requireAuth, async (req, res, next) => {
  try {
    const videoUrl = String(req.body.videoUrl || '');
    const publicId = String(req.body.publicId || '');
    const caption = String(req.body.caption || '').trim();
    let parsed;
    try { parsed = new URL(videoUrl); } catch { return apiError(res, 400, 'Invalid video URL. Please upload your video again.'); }
    if (!mediaStorageReady || parsed.protocol !== 'https:' || parsed.hostname !== 'res.cloudinary.com' || !parsed.pathname.startsWith(`/${CLOUDINARY_CLOUD_NAME}/video/upload/`) || !publicId.startsWith('vibe/shorts/')) return apiError(res, 400, 'Invalid Cloudinary video upload. Please upload your video again.');
    if (caption.length > 500) return apiError(res, 400, 'Caption must be 500 characters or fewer.');
    const id = makeId();
    const result = await pool.query('INSERT INTO shorts(id,user_id,video_url,storage_key,caption) VALUES($1,$2,$3,$4,$5) RETURNING id,video_url,caption,created_at', [id, req.session.userId, videoUrl, publicId, caption]);
    res.status(201).json({ short: result.rows[0] });
  } catch (error) { next(error); }
});
app.get('/api/shorts/:id/comments', requireAuth, async (req, res, next) => {
  try { const r=await pool.query(`SELECT c.id,c.text,c.created_at,u.username FROM short_comments c JOIN users u ON u.id=c.user_id WHERE c.short_id=$1 ORDER BY c.created_at ASC LIMIT 100`,[req.params.id]); res.json({comments:r.rows}); }
  catch(error){next(error)}
});
app.post('/api/shorts/:id/comments', requireAuth, async (req,res,next)=>{
  try { const text=String(req.body.text||'').trim(); if(!text||text.length>500)return apiError(res,400,'Comment must be 1–500 characters.'); const id=makeId(); const r=await pool.query('INSERT INTO short_comments(id,short_id,user_id,text) SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM shorts WHERE id=$2) RETURNING id,text,created_at',[id,req.params.id,req.session.userId,text]); if(!r.rowCount)return apiError(res,404,'Short not found.'); const u=await findUser(req.session.userId); res.status(201).json({comment:{...r.rows[0],username:u.username}}); }
  catch(error){next(error)}
});
for (const [route, table] of [['like','short_likes'],['favorite','short_favorites'],['repost','short_reposts']]) {
  app.post(`/api/shorts/:id/${route}`, requireAuth, async (req,res,next)=>{
    try { const exists=await pool.query('SELECT 1 FROM shorts WHERE id=$1',[req.params.id]); if(!exists.rowCount)return apiError(res,404,'Short not found.');
      const removed=await pool.query(`DELETE FROM ${table} WHERE short_id=$1 AND user_id=$2 RETURNING short_id`,[req.params.id,req.session.userId]);
      const active=removed.rowCount===0; if(active)await pool.query(`INSERT INTO ${table}(short_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[req.params.id,req.session.userId]);
      res.json({active});
    } catch(error){next(error)}
  });
}
app.post('/api/users/:id/follow', requireAuth, async (req,res,next)=>{
  try { if(req.params.id===req.session.userId)return apiError(res,400,'You cannot follow yourself.'); const target=await findUser(req.params.id); if(!target)return apiError(res,404,'User not found.'); const removed=await pool.query('DELETE FROM follows WHERE follower_id=$1 AND followed_id=$2 RETURNING follower_id',[req.session.userId,req.params.id]); const following=removed.rowCount===0; if(following)await pool.query('INSERT INTO follows(follower_id,followed_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.session.userId,req.params.id]); res.json({following}); }
  catch(error){next(error)}
});
app.get('/api/profile/:username', requireAuth, async (req,res,next)=>{
  try { const u=await pool.query('SELECT id,username,created_at FROM users WHERE username=$1',[cleanUsername(req.params.username)]); if(!u.rowCount)return apiError(res,404,'Profile not found.'); const user=u.rows[0], viewer=req.session.userId;
    const [counts, followState, posts, favorites, reposts, followers, followingList]=await Promise.all([
      pool.query(`SELECT (SELECT COUNT(*)::int FROM follows WHERE followed_id=$1) followers,(SELECT COUNT(*)::int FROM follows WHERE follower_id=$1) following,(SELECT COUNT(*)::int FROM shorts WHERE user_id=$1) posts,(SELECT COUNT(*)::int FROM short_favorites f JOIN shorts s ON s.id=f.short_id WHERE f.user_id=$1) favorites,(SELECT COUNT(*)::int FROM short_reposts WHERE user_id=$1) reposts`,[user.id]),
      pool.query('SELECT EXISTS(SELECT 1 FROM follows WHERE follower_id=$1 AND followed_id=$2) following',[viewer,user.id]),
      pool.query(`SELECT s.id,s.video_url,s.caption,s.created_at,u.id user_id,u.username,(SELECT COUNT(*)::int FROM short_likes WHERE short_id=s.id) likes,(SELECT COUNT(*)::int FROM short_comments WHERE short_id=s.id) comments,(SELECT COUNT(*)::int FROM short_reposts WHERE short_id=s.id) reposts,EXISTS(SELECT 1 FROM short_likes WHERE short_id=s.id AND user_id=$2) liked,EXISTS(SELECT 1 FROM short_favorites WHERE short_id=s.id AND user_id=$2) favorited,EXISTS(SELECT 1 FROM short_reposts WHERE short_id=s.id AND user_id=$2) reposted FROM shorts s JOIN users u ON u.id=s.user_id WHERE s.user_id=$1 ORDER BY s.created_at DESC LIMIT 100`,[user.id,viewer]),
      pool.query(`SELECT s.id,s.video_url,s.caption,s.created_at,u.id user_id,u.username,(SELECT COUNT(*)::int FROM short_likes WHERE short_id=s.id) likes,(SELECT COUNT(*)::int FROM short_comments WHERE short_id=s.id) comments,(SELECT COUNT(*)::int FROM short_reposts WHERE short_id=s.id) reposts,EXISTS(SELECT 1 FROM short_likes WHERE short_id=s.id AND user_id=$2) liked,EXISTS(SELECT 1 FROM short_favorites WHERE short_id=s.id AND user_id=$2) favorited,EXISTS(SELECT 1 FROM short_reposts WHERE short_id=s.id AND user_id=$2) reposted FROM short_favorites f JOIN shorts s ON s.id=f.short_id JOIN users u ON u.id=s.user_id WHERE f.user_id=$1 ORDER BY f.created_at DESC LIMIT 100`,[user.id,viewer]),
      pool.query(`SELECT s.id,s.video_url,s.caption,s.created_at,u.id user_id,u.username,(SELECT COUNT(*)::int FROM short_likes WHERE short_id=s.id) likes,(SELECT COUNT(*)::int FROM short_comments WHERE short_id=s.id) comments,(SELECT COUNT(*)::int FROM short_reposts WHERE short_id=s.id) reposts,EXISTS(SELECT 1 FROM short_likes WHERE short_id=s.id AND user_id=$2) liked,EXISTS(SELECT 1 FROM short_favorites WHERE short_id=s.id AND user_id=$2) favorited,EXISTS(SELECT 1 FROM short_reposts WHERE short_id=s.id AND user_id=$2) reposted FROM short_reposts r JOIN shorts s ON s.id=r.short_id JOIN users u ON u.id=s.user_id WHERE r.user_id=$1 ORDER BY r.created_at DESC LIMIT 100`,[user.id,viewer]),
      pool.query(`SELECT u.id,u.username,EXISTS(SELECT 1 FROM follows f2 WHERE f2.follower_id=$2 AND f2.followed_id=u.id) following FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.followed_id=$1 ORDER BY f.created_at DESC LIMIT 200`,[user.id,viewer]),
      pool.query(`SELECT u.id,u.username,EXISTS(SELECT 1 FROM follows f2 WHERE f2.follower_id=$2 AND f2.followed_id=u.id) following FROM follows f JOIN users u ON u.id=f.followed_id WHERE f.follower_id=$1 ORDER BY f.created_at DESC LIMIT 200`,[user.id,viewer])
    ]);
    res.json({profile:{id:user.id,username:user.username,createdAt:user.created_at,isMe:user.id===viewer,isFollowing:followState.rows[0].following,...counts.rows[0]},posts:posts.rows,favorites:favorites.rows,reposts:reposts.rows,followers:followers.rows,followingList:followingList.rows});
  }catch(error){next(error)}
});
app.get('/api/live', requireAuth, async (_req,res,next)=>{try{const r=await pool.query(`SELECT l.id,l.title,l.started_at,u.id user_id,u.username FROM live_streams l JOIN users u ON u.id=l.user_id WHERE l.status='live' ORDER BY l.started_at DESC LIMIT 50`);res.json({streams:r.rows,enabled:liveKitReady})}catch(e){next(e)}});
app.post('/api/live/start', requireAuth, async (req,res,next)=>{try{if(!liveKitReady)return apiError(res,503,'Livestreaming is not configured yet. Add the LiveKit environment variables first.');const title=String(req.body.title||'').trim().slice(0,100);if(title.length<3)return apiError(res,400,'Stream title must be at least 3 characters.');const id=makeId(),roomName='vibe-live-'+id;const r=await pool.query(`INSERT INTO live_streams(id,user_id,room_name,title) VALUES($1,$2,$3,$4) RETURNING id,title`,[id,req.session.userId,roomName,title]);res.status(201).json({stream:r.rows[0]});}catch(e){next(e)}});
app.post('/api/live/:id/token', requireAuth, async (req,res,next)=>{try{if(!liveKitReady)return apiError(res,503,'Livestreaming is not configured yet.');const r=await pool.query(`SELECT l.*,u.username FROM live_streams l JOIN users u ON u.id=l.user_id WHERE l.id=$1 AND l.status='live'`,[req.params.id]);const stream=r.rows[0];if(!stream)return apiError(res,404,'This livestream has ended.');const isHost=stream.user_id===req.session.userId;const at=new AccessToken(LIVEKIT_API_KEY,LIVEKIT_API_SECRET,{identity:req.session.userId, name: (await findUser(req.session.userId)).username, ttl:'2h'});at.addGrant({roomJoin:true,room:stream.room_name,canPublish:isHost,canSubscribe:true,canPublishData:true});const token=await at.toJwt();res.json({token,url:LIVEKIT_URL,isHost,title:stream.title,username:stream.username});}catch(e){next(e)}});
app.post('/api/live/:id/end', requireAuth, async (req,res,next)=>{try{const r=await pool.query(`UPDATE live_streams SET status='ended',ended_at=NOW() WHERE id=$1 AND user_id=$2 AND status='live' RETURNING id`,[req.params.id,req.session.userId]);if(!r.rowCount)return apiError(res,404,'Live stream not found or you are not its host.');res.json({ok:true});}catch(e){next(e)}});

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
