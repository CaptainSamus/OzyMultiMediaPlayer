# Ozy Boards — mood board website (v2) design

Date: 2026-09-12. Status: draft for Mark's review. No code yet.

## Goal

Share a board made in the desktop app as a web page: YouTube and Twitch
items arranged the way they were on the board, viewable by anyone with
the link, editable by the owner. Hosted on Vercel. Accounts are needed to
publish and edit, not to view.

## What a shared board is

A board on the web is a JSON document, a subset of the desktop `.mvp`:
- `layout`: `gallery` or `board`, board pan/zoom, gallery scale.
- `tiles[]`: `{ id, type, url, title, aspect, board: {x,y,w,h}, galleryH,
  bookmarks: [{ t, label, color }], color, webMode, loop }` for
  `type: youtube | twitch` (video, short, clip, stream).
- `groups[]`: `{ name, color, members, sync, loop, range }` (settings
  only; the web viewer applies them best-effort through the YouTube
  iframe API).
- Nothing local is ever uploaded (Mark's rule): no video files, no
  image tiles, no thumbnails. Local video, image and sequence tiles
  appear as placeholder cards ("local file · name.mov") so the layout
  keeps its shape; only YouTube and Twitch links are stored.
- `meta`: title, description, visibility (`public | unlisted | private`),
  created/updated, owner.

The desktop app gains **Publish board…** (Task, later): exports this
JSON and writes it to the user's account with their Firebase token.
Phase 1 works without that: export a `.ozyboard.json` file and upload it
on the site.

## Stack (Vercel hosting, Firebase for accounts and data)

- **Next.js 15 (App Router, TypeScript) + Tailwind** on Vercel. Git
  integration: every branch gets a preview URL, `main` deploys prod.
- **Firebase Authentication** for accounts: Google sign-in and
  email/password (with email verification and password reset). Viewing
  needs no account. The desktop app signs in through the same Firebase
  project (system browser flow) so "Publish board…" can write directly.
- **Cloud Firestore** holds everything per user:
  `users/{uid}` (profile, plan), `users/{uid}/boards/{boardId}` (title,
  description, visibility, the board JSON, created/updated), plus a
  top-level `slugs/{slug} → {uid, boardId}` index for public URLs.
  Security rules: owners read/write their boards; `public` and
  `unlisted` boards are readable by anyone; `private` only by the owner.
  Board JSON is validated with Zod in the API route before write.
- **Firebase Admin SDK** in Next.js route handlers verifies ID tokens
  and performs writes; the viewer page reads public/unlisted boards
  server-side for SEO and OG images.
- **No file storage at all**: no Blob, no Firebase Storage. Only
  YouTube/Twitch URLs and layout data live in Firestore.
- No server-side video: everything plays in the viewer's browser from
  YouTube/Twitch embeds. Twitch embeds need `parent=<site host>`, which
  a real domain satisfies.
- Separate repo (`OzyBoards`), not the desktop repo: the desktop stays a
  no-build Electron app; the site has its own build.

## Pages

- `/` — landing + sign-in; a few public boards as examples.
- `/b/[slug]` — the viewer. Server-rendered shell (title, description,
  OG image built from the first tile's thumbnail), client board: pan/zoom
  canvas or gallery, tiles with YouTube/Twitch embeds (lazy: an embed
  loads when its tile scrolls into view or is clicked; thumbnails first),
  bookmark markers under each tile (click = seek via iframe API), group
  colours, a "Play all" and per-group Sync (best-effort). Read-only.
  `unlisted` boards render for anyone with the link and carry
  `noindex`; `private` require the owner.
- `/me` — dashboard (signed in with Google or email): my boards,
  create, rename, visibility, delete, copy link, upload `.ozyboard.json`.
- `/b/[slug]/edit` — the owner's editor (phase 3): move/resize tiles on
  the board, add a YouTube/Twitch URL, remove, rename, group settings,
  bookmark colours. Same layout code as the viewer.
- `/api/boards` (POST create/replace, Firebase ID token required),
  `/api/boards/[slug]` (GET json; PATCH meta; DELETE).

## Phases

1. **Viewer + upload.** Firebase project, Firestore rules, Zod schema,
   `/b/[slug]`, `/me` with file upload, Google + email sign-in, unlisted
   links. Desktop: "Export board for web…" writes `.ozyboard.json` (web
   tiles, groups, bookmarks; placeholders for local). ~1 week.
2. **Publish from the app.** Desktop signs in with Firebase (system
   browser, token handed back to the app), "Publish board…" writes the
   board to the user's account, updates in place on re-publish.
3. **Web editor.** Owner edits in the browser; boards created from
   scratch on the site (no desktop needed to make a YouTube mood board).
4. **Later:** comments, collaborators, embed a board in another site,
   playlist import on the web via YouTube Data API (server-side key).

## Rules carried over from the desktop

- Only YouTube/Twitch domains, Firebase, and the site itself load; no
  trackers, no ads of ours.
- The site never receives local files, images, or thumbnails. Sharing is
  opt-in per board.
- Board JSON is versioned (`format: "ozy-board", version: 1`), and the
  viewer accepts older versions.

## Open questions for Mark

1. Domain name for the site.
2. Public boards discoverable on the landing page, or link-only always?
3. Is a web editor (phase 3) wanted before or after "publish from app" (phase 2)?
4. Firebase project: create a new one for Ozy, or reuse an existing one of yours?
