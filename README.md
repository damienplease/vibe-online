# VIBE — Social video, live streaming and messaging

VIBE is a Node.js/Express + PostgreSQL application with real-time messaging, creator profiles, short videos, likes, comments, reposts, favourites, follows and live video rooms.

## What this update adds

- Replaces the old demo Shorts cards with a PostgreSQL-backed Shorts feed.
- Record a Short in the browser (up to 60 seconds) or upload an MP4, WebM or MOV file (maximum 100 MB).
- Like, comment on, repost and favourite Shorts.
- Follow and unfollow creators.
- Profiles show posts, followers, following, favourites and reposts, with lists of followers/following.
- Replaces the old Library navigation item with Profile.
- Adds a Streaming page where a creator can start/end a livestream and other signed-in users can watch.
- Uses LiveKit (WebRTC SFU) for live audio/video and Cloudflare R2 for persistent video-file storage.

## Requirements

- Node.js 20 or later
- PostgreSQL
- A LiveKit Cloud project (for livestreaming)
- A Cloudflare R2 bucket with a public custom domain (for persistent Shorts video files)

## Environment variables

Keep all secrets in Render Environment, never in GitHub.

Required for the app:

- `DATABASE_URL` — Render PostgreSQL **Internal Database URL**
- `SESSION_SECRET` — random private string of at least 32 characters
- `NODE_ENV=production`

Required for Shorts uploads and playback (Cloudflare R2):

- `R2_ACCOUNT_ID` — Cloudflare account ID
- `R2_ACCESS_KEY_ID` — R2 API token access key ID
- `R2_SECRET_ACCESS_KEY` — R2 API token secret
- `R2_BUCKET` — exact R2 bucket name
- `R2_PUBLIC_BASE_URL` — public custom domain for the bucket, e.g. `https://media.yourdomain.com` (no trailing slash)

Required for live streaming (LiveKit):

- `LIVEKIT_URL` — LiveKit server URL beginning with `wss://`
- `LIVEKIT_API_KEY` — LiveKit API key
- `LIVEKIT_API_SECRET` — LiveKit API secret

The LiveKit secret stays on the server. The browser receives short-lived room tokens with publishing permission only for the stream owner.

## Cloudflare R2 setup for Shorts

1. Create an R2 bucket in Cloudflare.
2. Create an R2 API token with object read/write access only to this bucket.
3. Connect a public custom domain to the bucket. Set that URL as `R2_PUBLIC_BASE_URL`.
4. In the bucket's CORS settings, allow your VIBE origin (for example `https://vibe-online.onrender.com`) with method `PUT`, and allow the `Content-Type` request header. Allow `GET` and `HEAD` for playback if the CORS editor asks for read methods too.
5. Add all five R2 variables to the Render web service Environment page, then save.

Do not put R2 keys in the browser or in the GitHub repository. Uploaded clips are public to anyone who has the video URL; do not upload private or sensitive recordings.

## LiveKit setup for Streaming

1. Create a LiveKit project and copy its WebSocket URL, API key and API secret.
2. Add `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` to the Render web service Environment page.
3. Save the environment changes and wait for Render to redeploy.

VIBE creates a room record in PostgreSQL. Live audio/video is transported by LiveKit's SFU, not by the Render web server. Live streams are not recorded or saved as replays by this version.

## Local development

```bash
npm install
cp .env.example .env
npm start
```

Set the variables in `.env` before starting. On Windows, copy `.env.example` to `.env` manually if `cp` is unavailable.

## Deploying to Render

1. Upload/commit the complete project, including the entire `public` folder, to the GitHub branch connected to Render.
2. Confirm `DATABASE_URL` and `SESSION_SECRET` are present in the Render web service Environment page.
3. Add the R2 and LiveKit environment variables to enable video uploads and livestreaming.
4. Wait for the deploy to show **Live**.
5. Test with two separate accounts and browsers/devices.

The database tables are created automatically at startup. Existing VIBE accounts and conversations remain in PostgreSQL. Old local JSON data is not imported.

## Important limitations and launch checks

- R2 and LiveKit are external services and need their own account setup and credentials. The Streaming page and upload controls show setup-required messages until those variables are configured.
- LiveKit handles live delivery; this version does not create livestream replays.
- R2 video files are public through the configured public domain. Add moderation, reporting, deletion workflows, upload scanning and content rules before opening the service broadly.
- Configure R2 CORS exactly for the deployed VIBE origin.
- Test upload, playback, live publish/watch/end, follow/unfollow, comments, likes, favourites and reposts with multiple accounts before launch.
- This is a development update, not a security certification or a guarantee of OWASP compliance. Review privacy, moderation, abuse reporting, retention, rate limits and account recovery before public release.
