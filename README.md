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

Required for Shorts uploads and playback (Cloudinary):

- `CLOUDINARY_CLOUD_NAME` — cloud name from your Cloudinary dashboard
- `CLOUDINARY_UPLOAD_PRESET` — unsigned upload preset name (for this setup: `vibe_shorts`)

Configure the unsigned preset to accept only MP4, WebM and MOV videos, set a maximum file size of 25 MB, and use the `vibe/shorts` asset folder. Never expose an API secret in browser code. The application uploads directly to Cloudinary and stores the secure video URL in PostgreSQL.

Required for live streaming (LiveKit):

- `LIVEKIT_URL` — LiveKit server URL beginning with `wss://`
- `LIVEKIT_API_KEY` — LiveKit API key
- `LIVEKIT_API_SECRET` — LiveKit API secret

The LiveKit secret stays on the server. The browser receives short-lived room tokens with publishing permission only for the stream owner.

## Cloudinary setup for Shorts

1. Create an unsigned upload preset named `vibe_shorts`.
2. Restrict allowed formats to `mp4`, `webm` and `mov`; set the maximum file size to 25 MB.
3. Set the asset folder to `vibe/shorts`.
4. Add `CLOUDINARY_CLOUD_NAME` and `CLOUDINARY_UPLOAD_PRESET` to the Render web service Environment page, then save.

Unsigned uploads are public media. Do not upload private or sensitive recordings. Review your Cloudinary usage limits before inviting users to upload videos.

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


## Cloudinary video storage for Shorts
Set `CLOUDINARY_CLOUD_NAME` and `CLOUDINARY_UPLOAD_PRESET` in your hosting environment. Create an unsigned upload preset named `vibe_shorts` in Cloudinary, restrict allowed formats to mp4/webm/mov, set a maximum file size of 25 MB, and set the asset folder to `vibe/shorts`. Do not expose an API secret in browser code. The application uploads videos directly to Cloudinary and stores their URLs in PostgreSQL.
