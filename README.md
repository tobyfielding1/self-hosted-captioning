# Self-Hosted Captioning

Live captions and translation for church services. Each church runs its own tiny
backend on its own Google Cloud free tier; the web app is hosted on GitHub Pages.

- **Church setup:** open https://tobyfielding1.github.io/self-hosted-captioning/#setup and follow the two steps.
- **Sound desk:** open the sound desk link, check the bar moves, press Start.
- **Congregation:** scan the QR code, pick a language, read.

## How it works

```
Sound desk browser --(16 kHz PCM, silence removed)--> Church Cloud Run --(one stream per language in use)--> Soniox
                                                             |
Congregation phones <------------(caption text)--------------+--(final sentences, languages Soniox lacks)--> Google Translate
```

- Soniox connections open only while the sound desk is live **and** someone is reading that language.
- The church's Cloud Run container is a small launcher (`backend/boot.mjs`) that downloads the latest
  backend bundle from the `backend-latest` GitHub release on every cold start, verifies its SHA-256,
  and falls back to the copy built into the image if anything goes wrong.
- Languages, models and the Soniox region are discovered at runtime; nothing needs updating by hand.

## Development

```bash
# backend (needs SONIOX_API_KEY; SPEAKER_TOKEN defaults to "dev" locally)
cd backend && npm install && SONIOX_API_KEY=... npm run dev

# frontend
cd frontend && npm install && npm run dev
# open http://localhost:5173/#setup and set the backend to http://localhost:8080
```

Tests: `cd backend && npm test`.

## Releasing

Every push to `main` that passes typecheck, tests and build:

1. deploys the frontend to GitHub Pages;
2. publishes `server.mjs` + `server.mjs.sha256` to the `backend-latest` release.

Rollback: run the **release** workflow manually with `ref` set to an older commit.

## Things that are deliberately frozen

Church images are built once and never rebuilt, so `backend/boot.mjs`, the environment variables
(`PORT`, `SONIOX_API_KEY`, `SONIOX_REGION`, `SPEAKER_TOKEN`, `AUTO_UPDATE`) and the Node major version
(24) must stay compatible. Bumping Node means churches re-run the install.
