# VIBE Online

A real-time web-app starter with account registration, private messages, group chats, online presence, browser-to-browser voice/video call signalling, and local audio playback.

## Requirements
- Node.js 20 or newer
- A modern browser

## Run locally
1. Extract this folder.
2. Open a terminal in `vibe-online`.
3. Install dependencies: `npm install`
4. Copy `.env.example` to `.env`.
   - Windows Command Prompt: `copy .env.example .env`
   - macOS/Linux: `cp .env.example .env`
5. Edit `.env` and set `SESSION_SECRET` to a long random string (32+ characters).
6. Start the server: `npm start`
7. Open http://localhost:3000

Data is stored in `data/db.json` and is created automatically.

## Test between accounts/devices
1. Create an account in one browser.
2. Open a private/incognito window or another browser/device and create another account.
3. From the first account, use Find people to search for the second account's username.
4. Start a chat and send messages. Messages are saved on the server and delivered in real time using Socket.IO.
5. To test calls, both users must be in a direct chat. Allow microphone/camera permissions.

## What works in this starter
- Registration and login with bcrypt password hashing
- Session-cookie authentication
- Persistent JSON database for users, conversations and messages
- Private chats and groups (up to 50 members)
- Real-time messaging and online status via Socket.IO
- One-to-one WebRTC voice/video call signalling
- Audio files selected and played locally in the browser
- Responsive VIBE interface

## Important limitations before public launch
- This is a starter, not a production-audited service.
- The included JSON file database is appropriate only for a small prototype. Use PostgreSQL or another production database for multiple server instances.
- The default session store is Express MemoryStore. Replace it with Redis or a persistent session store before public deployment.
- For deployment, use HTTPS/WSS, set a strong `SESSION_SECRET`, configure a TURN server for calls across restrictive networks, add rate limiting and email verification, CSRF protection for state-changing routes, content moderation/reporting, abuse prevention, backups, and privacy/terms pages.
- The included STUN server is not enough for every network. Calls may fail without a TURN server.
- Calls are one-to-one only; group voice/video calling is not implemented.
- Audio files are never uploaded or shared. No commercial music/video catalogue is included. You must obtain rights for any media you stream publicly.
- There is no password reset or account deletion workflow yet.
- Do not use real or sensitive passwords while testing this starter.

## Hosting
Deploy the Node app to a host that supports long-lived WebSocket connections. Configure the environment variables there and enable HTTPS. Do not publish `.env` or the `data` directory. See the hosting provider's current Node.js deployment guide.

## Health check
Visit `/api/health` while the server is running. It should return JSON with `ok: true`.
