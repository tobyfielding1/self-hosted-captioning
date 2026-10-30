# Self-hosted captioning

Live captions and translation for one venue at a time. The venue's own Google Cloud account runs a small server. This website is the sound desk and the audience page. Soniox turns speech into text. Google Translate covers languages Soniox does not.

Share https://tobyfielding1.github.io/self-hosted-captioning/ with a venue. That page explains it and starts the install.

## Should you use it

Use it when a room needs live captions on phones, in the languages people actually read, without subscribing to a captioning service.

You need:

- A Google account that can create a Cloud project. Google hosts the server. Normal use stays in the free tier, but Google still asks for a card and emails the venue if the project passes £5 a month.
- A Soniox account. That is the part that costs money. The venue chooses how much credit to add. Credit is used only while someone is being captioned: quiet audio is not sent, and a language runs only while someone is reading it.

This is not a service you host for other people. You never get access to a venue's Google project or Soniox key. Each venue installs its own server. Running the install again is safe.

It is a poor fit if you need a human captioner, a recording of the event, or one account that serves many unrelated venues.

## What people do

- **Sound desk.** Open the sound desk link, check the level bar moves when someone speaks, press Start. Press Stop at the end.
- **Audience.** Scan the QR code, pick a language, read. Spoken captions, when the venue turned them on, start off and follow the phone's light or dark setting.

## How it works

```
Sound desk browser --(16 kHz PCM, silence removed)--> Venue Cloud Run
                                                         |
                         one Soniox transcript, shared by the Original page and every Google language
                         one Soniox translation stream per Soniox language someone is reading
                         Google Translate once per pause, for languages Soniox does not translate
Audience phones <-------- caption text, and optional spoken audio
```

The venue's Cloud Run container is a small launcher (`backend/boot.mjs`). On every cold start it downloads the latest backend from the `backend-latest` GitHub release, checks the SHA-256, and falls back to the copy in the image if that fails. Languages and the Soniox region are discovered at runtime.

## Development

```bash
# backend (needs SONIOX_API_KEY; SPEAKER_TOKEN defaults to "dev" locally)
cd backend && npm install && SONIOX_API_KEY=... npm run dev

# frontend
cd frontend && npm install && npm run dev
# open http://localhost:5173/#backend=http://localhost:8080&token=dev
```

Tests: `cd backend && npm test`.

Every push to `main` that passes typecheck, tests and build deploys the website and publishes `server.mjs` to `backend-latest`. Rollback is the **release** workflow with `ref` set to an older commit.

Contributors, including coding agents, should read [AGENTS.md](AGENTS.md) before changing behaviour. It records the decisions that are easy to get wrong.
