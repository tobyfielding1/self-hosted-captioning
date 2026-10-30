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

## Spoken captions

Off unless the venue answered yes at install (`SPOKEN=1`). Pace starts at 0.8 and may rise toward 2, by at most 0.05 per clip, only while that language is still playing earlier lines. It returns to 0.8 when the last listener turns sound off or the desk pauses.

## Two version numbers

- `PROTOCOL_VERSION` in `backend/src/server.ts` and `frontend/src/backend.ts` is the running code. A cold start picks it up. Bump minor for an optional server change, patch for a security fix in the code, major when an old server cannot be trusted.
- `SETUP_VERSION` is the install. `setup.sh` records it. A cold start does not. Bump it when the venue must run the install again (a new question, or a new Node major).

A frontend-only fix does not get a protocol bump. Bumping only the page makes every venue look out of date. Keep the two copies of `PROTOCOL_VERSION` the same.

## Frozen on purpose

`backend/boot.mjs` and these environment variables must keep working for servers already installed:

`PORT`, `SONIOX_API_KEY`, `SONIOX_REGION`, `SPEAKER_TOKEN`, `BILLING_ACCOUNT`, `AUTO_UPDATE`, `VENUE_NAME`, `SPOKEN`, `SETUP_VERSION`

`log.info` takes `Record<string, unknown>`. A typed object with no index signature does not count. Spread the fields. CI typechecks; a local test run does not.

## Cloud Shell tutorials

Each tutorial is one Cloud Shell page: one `#` title and one `##` step. A second `##` becomes a Next button. `deploy.md` already covers a new venue and a re-run. Do not add a separate "another venue" tutorial.

`./setup.sh --help` lists the flags. Unknown flags must exit non-zero.

## Checks

`cd backend && npm test` and `npm run typecheck`. Frontend: `cd frontend && npm run typecheck`. The release workflow runs both, then publishes the site and `backend-latest`. A failed typecheck means venues keep the previous server.
