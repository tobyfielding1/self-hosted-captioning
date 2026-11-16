# Working on this repo

Read this before changing captions, billing, install, or the page/server contract. The README is for someone deciding whether to use the product. This file is for someone changing it.

## Layout

- `frontend/` — the website: intro, sound desk (`VenueView`), audience (`ListenView`). GitHub Pages.
- `backend/` — the venue server. `boot.mjs` is the frozen launcher. `src/server.ts` is the process. `src/rooms.ts` owns streams, captions, and spoken audio.
- `setup.sh`, `delete.sh`, `deploy.md`, `rotate.md`, `newkey.md`, `delete.md` — the Cloud Shell install. Venues run these. They are not developer notes.

## One transcript for Original and Google

Original listeners and every Google Translate language share **one** Soniox transcription stream. Do not open a second stream for Google, and do not give Google different pause settings from Original.

A Soniox language (Spanish, and the others Soniox translates itself) still gets its own translation stream, and only while someone is reading that language. Streams close after silence. Three people on Google languages plus two on Original is one Soniox session, not five.

## Pause settings live in the page

Defaults are `ENDPOINT_DEFAULTS` in `frontend/src/views/VenueView.tsx`: 1500 ms max delay, sensitivity 0.3, latency level 2. The server has no copy. It does not open a Soniox stream until the sound desk sends settings.

Changing a default is a frontend change. Do not add server env vars or a second constant for the same numbers. A missing `localStorage` value is not `0`: `Number(null)` is `0`, and the delay slider then snaps to 500. Read the key, and use the default when it is absent.

Soniox's own descriptions are linked beside each slider: https://soniox.com/docs/stt/rt/endpoint-detection

Level 3 with a 1 second cap splits sentences in half. That was tried and rejected.

## Context

One context text goes to every Soniox stream as `context.text`. The install asks for a default (`SONIOX_CONTEXT`). A sound desk can replace it in Settings, stored in that browser under `captioning.context`. A missing key means the install default; an empty string means no context. The desk sends `context` before `endpoint`, so the first stream already has it. A change reopens the streams, like the pause settings.

The text can name people. It goes to the sound desk `hello`, and to `/status` only when the request carries the desk token (so Settings can show the install default before Start, like the session length). A public `/status` must not include it. The log records its length, not the text. Soniox rejects more than about 10,000 characters, so the page, server and install all cut it there.

## Google Translate

Opt-in at install, like spoken captions (`GOOGLE_TRANSLATE=1` or `0`). An install from before the question has no value and was always on, so missing means on; the install writes `0` for no. `/languages` reports `google` as `off` (turned off, or not on Google Cloud), `loading` (retrying with backoff; a missing project or token is a failure, not an empty list) or `ready`. The audience chooser shows the Soniox/Google labels only when both appear.

## Prices

The install and the server read Google's prices from the Cloud Billing catalog (`price.py`, `backend/src/prices.ts`). Translate's free 500,000 characters are a monthly credit, not a price tier, so they are stated, not read. Soniox has no price list to read; the home page's Soniox figures are dated (`PRICES_AS_OF` in `VenueView.tsx`). The home page asks the demo server for languages and prices only when someone opens or presses them, so a visit doesn't wake it.

The sound desk's Spending section reads `/spend`, which needs the desk token. Soniox spend comes from Soniox's usage summary (daily cost totals), not from usage logs. Google has no API for spend without a BigQuery billing export, so Google stays a link to the billing report. Spend is fetched when the section is opened.

## Spoken captions

Off unless the venue answered yes at install (`SPOKEN=1`). Pace starts at 0.8 and may rise toward 2, by at most 0.05 per clip, only while that language is still playing earlier lines. It returns to 0.8 when the last listener turns sound off or the desk pauses.

## Session limit

A session stops after a set number of minutes, and the desk presses Start to carry on. The install asks for the default (`MAX_SESSION_MIN`, 1 to 1440). A sound desk can replace it in Settings, stored in that browser under `captioning.sessionMinutes`; a missing key means the install default. An install without the variable gets 300, Soniox's own stream limit. A reconnect inside the grace period keeps the same clock.

Soniox cuts one stream at 300 minutes. The server replaces each stream at 290 (`streamMaxMs`), letting the old one finish its last words, so a longer session keeps captioning. Do not cap the session at 300.

The home page links to a public demo sound desk; its token is public on purpose. Its length is set on that server like any other venue, not in the page.

## Two version numbers

- `PROTOCOL_VERSION` in `backend/src/server.ts` and `frontend/src/backend.ts` is the running code. A cold start picks it up. Bump minor for an optional server change, patch for a security fix in the code, major when an old server cannot be trusted.
- `SETUP_VERSION` is the install. `setup.sh` records it. A cold start does not. Bump it when the venue must run the install again (a new question, or a new Node major).

A frontend-only fix does not get a protocol bump. Bumping only the page makes every venue look out of date. Keep the two copies of `PROTOCOL_VERSION` the same.

## Frozen on purpose

`backend/boot.mjs` and these environment variables must keep working for servers already installed:

`PORT`, `SONIOX_API_KEY`, `SONIOX_REGION`, `SPEAKER_TOKEN`, `BILLING_ACCOUNT`, `AUTO_UPDATE`, `UPDATE_URL`, `VENUE_NAME`, `SPOKEN`, `SETUP_VERSION`, `SONIOX_CONTEXT`, `MAX_SESSION_MIN`, `GOOGLE_TRANSLATE`

`log.info` takes `Record<string, unknown>`. A typed object with no index signature does not count. Spread the fields. CI typechecks; a local test run does not.

## Cloud Shell tutorials

Each tutorial is one Cloud Shell page: one `#` title and one `##` step. A second `##` becomes a Next button. `deploy.md` already covers a new venue and a re-run. Do not add a separate "another venue" tutorial. The live site and `/dev/` both open the same tutorials; the page picks tag `backend-latest` or `backend-dev`. Cloud Shell cannot set env vars from the URL, so `setup.sh` reads which tag was checked out (reflog) and sets `APP_URL` / `UPDATE_URL` from that. Each channel publish force-moves that git tag to the published commit so Cloud Shell clones current setup scripts, not a stale tag.

`./setup.sh --help` lists the flags. Unknown flags must exit non-zero.

## Checks

`cd backend && npm test` and `npm run typecheck`. Frontend: `cd frontend && npm run typecheck`. The release workflow runs both, then publishes site and server together from one commit: `main` → `backend-dev` and `/dev/`; a `v*` tag or manual prod publish → `backend-latest` and the live site. A failed typecheck means that channel is not updated. The GitHub Pages environment must allow deployments from `main` and from tags matching `v*` (Settings → Environments → github-pages), or a tag release updates the server but not the site. Pages deployments use a fresh empty-commit SHA as `pages_build_version` so tagging the commit that just updated `/dev/` still replaces the live site (`actions/deploy-pages` would reuse `GITHUB_SHA` and keep the first artifact; non-commit build versions 404).
