import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import { audioSupported, guessMode, listInputs, startCapture, type Capture, type InputMode } from "../audio/capture";
import { clampSendAfter, SEND_AFTER } from "../audio/gate";
import { checkDeskAccess, getBackend, getStatus, getToken, listenerLink, protocolNotice, siteRoot, speakLink, type DeskAccess, type ProtocolNotice, type Status } from "../backend";
import { englishName } from "../lib/languages";
import { useWakeLock, wakeLockSupported } from "../lib/wakeLock";
import { createDeskGate } from "../audio/speech-model";
import type { SpeechGate } from "../audio/speech";
import { SpeakerConnection, type ConnState, type Preview, type ServerMessage, type Stats } from "../speaker";
import { Banner, Button, Card, copyText, Details, RepoLink } from "../ui";

const SONIOX_USAGE = "https://console.soniox.com/org/projects/usage/cost";
const SONIOX_BILLING = "https://console.soniox.com/org/billing/reports";

const REPO = "https://github.com/tobyfielding1/self-hosted-captioning";
const shellUrl = (tutorial: string) =>
  `https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=${encodeURIComponent(REPO)}&cloudshell_tutorial=${tutorial}&show=terminal`;
const INSTALL_URL = shellUrl("deploy.md");
const ANOTHER_URL = shellUrl("another.md");
const ROTATE_URL = shellUrl("rotate.md");
const NEWKEY_URL = shellUrl("newkey.md");
const DELETE_URL = shellUrl("delete.md");
const SONIOX_PROJECT = "https://console.soniox.com/org/projects/settings";
const SONIOX_KEYS = "https://console.soniox.com/org/projects/api/keys";
// Venue images freeze their Node major version; below this they need a re-install.
const MIN_NODE_MAJOR = 24;
const TIP_DISMISSED = "captioning.fasterTipDismissed";

/** The venue team's page: an intro, or the sound desk when the address is a sound desk link. */
export default function VenueView({ shareOpen }: { shareOpen: boolean }) {
  const backend = getBackend();
  const token = getToken();
  const [access, setAccess] = useState<DeskAccess | "checking">("checking");
  const allowed = !!backend && !!token && (access === "ok" || access === "legacy");

  useEffect(() => {
    if (!backend || !token) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      void checkDeskAccess(backend, token).then((result) => {
        if (cancelled) return;
        setAccess(result);
        if (result === "down") timer = setTimeout(run, 3000);
      });
    };
    setAccess("checking");
    run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [backend, token]);

  return (
    <main className="max-w-2xl mx-auto p-4 space-y-4">
      {backend && token && !allowed ? (
        <DeskGate access={access === "bad" || access === "down" ? access : "checking"} />
      ) : allowed ? (
        <Desk backend={backend!} token={token!} shareOpen={shareOpen} />
      ) : (
        <Intro />
      )}
    </main>
  );
}

function DeskGate({ access }: { access: "checking" | "down" | "bad" }) {
  if (access === "bad") {
    return (
      <Banner tone="warn">
        <p className="font-semibold">This sound desk link isn't valid.</p>
        <p>Ask whoever set up captions for the current link.</p>
      </Banner>
    );
  }
  return (
    <p className="text-lg">
      {access === "down"
        ? "The captioning server isn't answering yet, so this link can't be checked. Trying again."
        : "Checking this sound desk link..."}
    </p>
  );
}

// ----------------------------------------------------------------------------- sound desk

const METER_MAX = 0.1;
const METER_HEARD = 0.01;
const STORE = {
  input: "captioning.input",
  mode: (id: string) => `captioning.mode.${id || "default"}`,
  sendAfter: "captioning.sendAfter",
};

const durationLabel = (ms: number) => {
  const seconds = ms / 1000;
  const shown = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
  return `${shown} ${seconds === 1 ? "second" : "seconds"}`;
};

type MicState = "idle" | "asking" | "on" | "denied" | "interrupted" | "failed";

const plural = (n: number) => (n === 1 ? "1 person" : `${n} people`);

function describeListeners(listeners: Record<string, number>): string {
  const entries = Object.entries(listeners).filter(([, n]) => n > 0);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (!total) return "nobody following yet";
  const parts = entries.sort((a, b) => b[1] - a[1]).map(([code, n]) => `${englishName(code)} ${n}`);
  return `${plural(total)} following (${parts.join(", ")})`;
}

function Desk({ backend, token, shareOpen }: { backend: string; token: string; shareOpen: boolean }) {
  const supported = audioSupported();

  const [status, setStatus] = useState<Status | null | undefined>(undefined);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem(STORE.input) ?? "");
  const [mode, setMode] = useState<InputMode | null>(null);
  const [mic, setMic] = useState<MicState>("idle");
  const [level, setLevel] = useState(0);
  const [speech, setSpeech] = useState<"loading" | "ready" | "failed">("loading");
  const [sendAfter, setSendAfter] = useState(() => {
    const saved = localStorage.getItem(STORE.sendAfter);
    return saved === null ? SEND_AFTER.default : clampSendAfter(Number(saved));
  });
  const [conn, setConn] = useState<ConnState>("off");
  const [stats, setStats] = useState<Stats | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [errors, setErrors] = useState<{ at: string; message: string }[]>([]);
  const [shownError, setShownError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hello, setHello] = useState<Record<string, unknown> | null>(null);
  const [copied, setCopied] = useState(false);

  const captureRef = useRef<Capture | null>(null);
  const gateRef = useRef<SpeechGate | null>(null);
  const audioChain = useRef(Promise.resolve());
  const levelRef = useRef(0);
  const lastHeardRef = useRef(0);
  const connRef = useRef<SpeakerConnection | null>(null);

  const live = conn !== "off";
  const wakeLock = useWakeLock(live);

  useEffect(() => {
    let gone = false;
    const created = createDeskGate(clampSendAfter(sendAfter));
    gateRef.current = created.gate;
    created.ready.then(
      () => {
        if (!gone) setSpeech("ready");
      },
      () => {
        if (!gone) setSpeech("failed");
      },
    );
    return () => {
      gone = true;
      gateRef.current = null;
    };
    // The model is loaded once. Later changes to the hangover update the gate directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Watch whether another sound desk is connected, while this tab is visible and not yet live.
  useEffect(() => {
    if (live) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      void getStatus().then((s) => {
        if (cancelled || document.visibilityState !== "visible") return;
        setStatus((prev) => s ?? prev ?? null);
        timer = setTimeout(run, 3000);
      });
    };
    const onVisible = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [live]);

  useEffect(() => {
    if (status?.venue) document.title = status.venue;
  }, [status?.venue]);

  if (!connRef.current) {
    connRef.current = new SpeakerConnection(
      setConn,
      (msg: ServerMessage) => {
        if (msg.type === "hello") setHello(msg);
        else if (msg.type === "stats") setStats(msg);
        else if (msg.type === "preview") setPreview(msg);
        else if (msg.type === "error") {
          setErrors((e) => [...e.slice(-19), { at: new Date().toISOString(), message: msg.message }]);
          setShownError(msg.message);
        } else if (msg.type === "stopped") {
          setNotice(
            msg.reason === "idle"
              ? "Stopped because it was quiet for an hour. Press Start to begin again."
              : msg.reason === "takeover"
                ? "Taken over by another device. Press Start to take it back."
                : null,
          );
        }
      },
      () => setNotice("This sound desk link isn't valid any more. Ask your admin for the new link."),
    );
  }

  const onFrame = useCallback((pcm: ArrayBuffer, rms: number) => {
    levelRef.current = rms;
    if (rms >= METER_HEARD) lastHeardRef.current = performance.now();
    const samples = new Uint8Array(pcm);
    audioChain.current = audioChain.current.then(async () => {
      const gate = gateRef.current;
      if (!gate) return;
      const decision = await gate.push(samples);
      const connection = connRef.current;
      if (!connection || connection.state !== "live") return;
      for (const frame of decision.forward) connection.sendAudio(frame.slice().buffer);
    }).catch(() => setSpeech("failed"));
  }, []);

  // Level meter at ~10 fps.
  useEffect(() => {
    const t = setInterval(() => setLevel(levelRef.current), 100);
    return () => clearInterval(t);
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await listInputs());
    } catch {
      /* not available */
    }
  }, []);

  const openMic = useCallback(
    async (id: string, forcedMode?: InputMode) => {
      captureRef.current?.stop();
      captureRef.current = null;
      setMic("asking");
      try {
        const savedMode = localStorage.getItem(STORE.mode(id)) as InputMode | null;
        const initial = forcedMode ?? savedMode ?? "mic";
        const first = await startCapture(id || undefined, initial, onFrame);
        let capture = first;
        const wanted = forcedMode ?? savedMode ?? guessMode(first.label);
        if (wanted !== initial) {
          // The real label is only known after permission; reopen with the right processing.
          first.stop();
          capture = await startCapture(id || undefined, wanted, onFrame);
        }
        captureRef.current = capture;
        setMode(wanted);
        setMic("on");
        void refreshDevices();
      } catch (e) {
        const name = (e as DOMException).name;
        setMic(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "failed");
      }
    },
    [onFrame, refreshDevices],
  );

  // Open the microphone straight away if permission was already given.
  useEffect(() => {
    if (!supported) return;
    void navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((p) => {
        if (p.state === "granted") void openMic(deviceId);
      })
      .catch(() => {});
    return () => captureRef.current?.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mobile browsers stop the microphone when the screen locks or the app is switched.
  useEffect(() => {
    const t = setInterval(() => {
      const c = captureRef.current;
      if (c && !c.running()) setMic((m) => (m === "on" ? "interrupted" : m));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const resumeMic = async () => {
    const c = captureRef.current;
    if (c) {
      await c.resume().catch(() => {});
      if (c.running()) {
        setMic("on");
        return;
      }
    }
    await openMic(deviceId, mode ?? undefined);
  };

  const pickDevice = (id: string) => {
    setDeviceId(id);
    localStorage.setItem(STORE.input, id);
    void openMic(id);
  };

  const pickMode = (m: InputMode) => {
    localStorage.setItem(STORE.mode(deviceId), m);
    void openMic(deviceId, m);
  };

  const start = (test = false) => {
    setNotice(null);
    setShownError(null);
    const gate = gateRef.current;
    if (gate) {
      gate.hangoverMs = clampSendAfter(sendAfter);
      if (!live) gate.reset();
    }
    connRef.current!.start(test);
  };

  const stop = () => {
    connRef.current!.stop();
    setStats(null);
    setPreview(null);
  };

  const copyDiagnostics = async () => {
    const c = captureRef.current;
    const report = {
      at: new Date().toISOString(),
      backend,
      status: await getStatus(),
      server: hello,
      stats,
      connection: conn,
      errors,
      audio: { input: c?.label, sampleRate: c?.sampleRate, mode, mic },
      browser: navigator.userAgent,
      wakeLock: wakeLockSupported(),
    };
    setCopied(await copyText(JSON.stringify(report, null, 2)));
    setTimeout(() => setCopied(false), 3000);
  };

  const heading = status?.venue ? <h1 className="text-3xl font-bold text-midnight">{status.venue}</h1> : null;

  if (!supported) {
    return (
      <>
        {heading}
        <Notices status={status} />
        <Banner tone="error">
          This browser can't capture audio. Please update it or use Chrome, Edge, Firefox or Safari.
        </Banner>
      </>
    );
  }

  const heard = performance.now() - lastHeardRef.current < 600;
  const meterPct = Math.min(100, Math.sqrt(level / METER_MAX) * 100);
  const listenersText = stats ? describeListeners(stats.listeners) : "";

  let headline = "Not live";
  if (conn === "connecting") headline = "Connecting...";
  else if (conn === "reconnecting") headline = "Reconnecting...";
  else if (conn === "live") headline = `Live: ${listenersText || "connecting"}`;

  return (
    <div className="space-y-4">
      {heading}
      <Notices status={status} />
      {notice && <Banner tone="warn">{notice}</Banner>}
      {shownError && (
        <Banner tone="error" onClose={() => setShownError(null)}>
          {shownError}
        </Banner>
      )}

      <section className="bg-white rounded-2xl border border-purple/30 p-5 space-y-4">
        {mic === "idle" && (
          <div className="space-y-3">
            <p className="text-lg">First, let this page hear the sound desk.</p>
            <Button big onClick={() => openMic(deviceId)}>
              Turn on the microphone
            </Button>
            <p>Your browser will ask for permission. Click Allow.</p>
          </div>
        )}
        {mic === "asking" && <p className="text-lg">Waiting for permission... click Allow if your browser asks.</p>}
        {mic === "denied" && (
          <Banner tone="error">
            The browser is blocking the microphone. Click the lock or microphone icon next to the address bar, allow
            the microphone, then reload this page.
          </Banner>
        )}
        {mic === "failed" && (
          <Banner tone="error">
            Couldn't open that input. Check the cable, or pick another input below.{" "}
            <Button variant="ghost" onClick={() => openMic("")}>
              Try the default input
            </Button>
          </Banner>
        )}
        {mic === "interrupted" && (
          <Button big className="w-full" onClick={resumeMic}>
            Paused by your device. Tap to resume
          </Button>
        )}
        {(mic === "on" || mic === "interrupted" || mic === "failed") && (
          <>
            {devices.length > 1 && (
              <label className="block">
                <span className="font-semibold">Sound comes from</span>
                <select
                  className="mt-1 block w-full rounded-xl border-2 border-purple/30 px-3 py-2.5 text-lg bg-white"
                  value={deviceId}
                  onChange={(e) => pickDevice(e.target.value)}
                >
                  {devices.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Input ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div>
              <div className="relative h-8 rounded-full bg-gray-200 overflow-hidden" aria-hidden>
                <div
                  className={`h-full transition-[width] duration-100 ${heard ? "bg-green-600" : "bg-gray-400"}`}
                  style={{ width: `${meterPct}%` }}
                />
              </div>
              <p className="mt-2 text-lg font-semibold" aria-live="polite">
                {heard ? "We can hear you" : "Quiet: speak and check the bar moves"}
              </p>
            </div>
          </>
        )}
      </section>

      <section className="bg-white rounded-2xl border border-purple/30 p-5 space-y-4">
        <p className="text-3xl font-bold" aria-live="polite">
          {headline}
        </p>
        {live && conn === "live" && stats?.testing && <p className="text-purple">Test captions running for a minute.</p>}

        {!live && status?.streaming && (
          <Banner tone="warn">
            Another sound desk is already live. Starting here takes over, and their page stops.
          </Banner>
        )}

        {speech === "loading" && <p>Preparing speech detection...</p>}
        {speech === "failed" && <Banner tone="error">Speech detection didn't load. Reload the page.</Banner>}

        <div className="flex flex-wrap gap-3">
          {!live ? (
            <>
              <Button big disabled={mic !== "on" || speech !== "ready"} onClick={() => start()}>
                Start
              </Button>
              <Button big variant="secondary" disabled={mic !== "on" || speech !== "ready"} onClick={() => start(true)}>
                Test captions
              </Button>
            </>
          ) : (
            <>
              <Button big variant="danger" onClick={stop}>
                Stop
              </Button>
              <Button variant="secondary" onClick={() => start(true)}>
                Test captions
              </Button>
            </>
          )}
        </div>

        {live && (
          <p>
            Keep this tab open.{" "}
            {wakeLockSupported() ? (wakeLock ? "The screen will stay on." : "") : "Turn off sleep on this device."}{" "}
            <a className="underline text-blue-600 hover:text-blue-800" href={listenerLink()} target="_blank" rel="noreferrer">
              Open the audience view
            </a>
          </p>
        )}

        {preview && (preview.lines.length > 0 || preview.current || preview.partial) && (
          <div className="rounded-xl bg-gray-50 border border-gray-200 p-3 text-lg leading-snug">
            <p className="text-sm font-semibold text-gray-500 mb-1">What people are reading</p>
            {preview.lines.map((l, i) => (
              <p key={i}>{l}</p>
            ))}
            <p>
              {preview.current} <span className="text-gray-400">{preview.partial}</span>
            </p>
          </div>
        )}
      </section>

      <Finished backend={backend} token={token} open={shareOpen} status={status} />

      <Details summary="Settings">
        <fieldset className="space-y-1">
          <legend className="font-semibold">Input type</legend>
          {(["desk", "mic"] as const).map((m) => (
            <label key={m} className="flex items-center gap-2">
              <input type="radio" name="mode" checked={mode === m} onChange={() => pickMode(m)} />
              {m === "desk" ? "Desk feed (clean audio, no processing)" : "Device microphone (reduce noise, even out volume)"}
            </label>
          ))}
        </fieldset>
        <div className="space-y-3">
          <div>
            <label className="font-semibold" htmlFor="send-after">
              Keep sending after speech stops: {durationLabel(sendAfter)}
            </label>
            <input
              id="send-after"
              type="range"
              className="w-full"
              min={SEND_AFTER.min}
              max={SEND_AFTER.max}
              step={100}
              value={sendAfter}
              onChange={(e) => {
                const ms = clampSendAfter(Number(e.target.value));
                setSendAfter(ms);
                localStorage.setItem(STORE.sendAfter, String(ms));
                if (gateRef.current) gateRef.current.hangoverMs = ms;
              }}
            />
          </div>
          <p className="text-sm text-gray-600">
            Audio keeps going for a moment after speech stops, so the last words are still sent. That applies straight away.
          </p>
        </div>
        <p className="text-sm text-gray-600 break-all">
          Server: {backend}
          {status && ` (version ${status.version})`}
        </p>
        <Delete status={status} />
      </Details>

      <Details summary="Help">
        <dl className="space-y-3">
          <div>
            <dt className="font-semibold">The bar isn't moving</dt>
            <dd>
              Check the cable from the desk and that the right input is chosen above.{" "}
              <Button variant="ghost" onClick={() => openMic(deviceId)}>
                Reconnect the input
              </Button>
            </dd>
          </div>
          <div>
            <dt className="font-semibold">It says "out of credit"</dt>
            <dd>
              Top up under{" "}
              <a className="underline text-blue-600 hover:text-blue-800" href="https://console.soniox.com/org/billing/reports" target="_blank" rel="noreferrer">
                Billing
              </a>
              . Turn on "Enable autopay" under{" "}
              <a className="underline text-blue-600 hover:text-blue-800" href="https://console.soniox.com/org/billing/payment-setup" target="_blank" rel="noreferrer">
                Payment setup
              </a>{" "}
              so this doesn't happen again.
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Nobody can connect</dt>
            <dd>Press Start. Phones can only join while this page is live.</dd>
          </div>
          <div>
            <dt className="font-semibold">Still stuck</dt>
            <dd>
              <Button variant="secondary" onClick={copyDiagnostics}>
                {copied ? "Copied" : "Copy diagnostics"}
              </Button>{" "}
              and send them to your helper.
            </dd>
          </div>
        </dl>
      </Details>
    </div>
  );
}

// ----------------------------------------------------------------------------- intro

function Intro() {
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-bold text-midnight">Live captions</h1>
        <RepoLink />
      </div>
      <p className="text-lg">
        Self-hosted captioning allows a venue to host a translation server on Google Cloud so the audience can read what is being spoken on their mobile devices in their own language. Self-hosting makes it extremely low cost for the venue.
      </p>
      <Card title="Audience">
        <p>If you are in the audience, ask the venue for the audience link or QR code to read along.</p>
      </Card>
      <Card title="Venue team">
        <p>
          Open your sound desk link, check the level bar moves when someone speaks, and press Start. Everyone else
          scans a QR code with their phone camera, picks a language, and reads.
        </p>
        <p>
          The words appear as they are spoken, in the language each person picked.
        </p>
        <p>Press Stop at the end. Devices can follow only while the sound desk is live.</p>
      </Card>
      <Card title="Set up once">
        <p>
          It takes about 15 minutes on your Google account. Each venue gets its own server, a private sound desk link, and a QR
          code that stays the same. The terminal lists any venues already on this account.
        </p>
        <p>
          Google Cloud hosts the server. Normal use stays in the free tier, but Google still asks for a card,
          and the install emails you if this venue passes £5 a month. Transcripts and translations come from Soniox and Google Translate. Soniox is the part that costs money. You choose how
          much credit to add, and it is only used while someone is being captioned: quiet audio isn't sent, and a
          language runs only while someone is reading it. That costs less than a captioning service you subscribe to.
          See{" "}
          <a className="underline text-blue-600 hover:text-blue-800" href="https://soniox.com/pricing" target="_blank" rel="noreferrer">
            Soniox pricing
          </a>
          .
        </p>
        <a
          href={INSTALL_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-block bg-purple hover:bg-midnight text-white text-lg font-semibold px-8 py-5 rounded-2xl"
        >
          Set up live captions
        </a>
        <p className="text-gray-600">
          If you end up in a blank terminal, click Set up live captions again.
        </p>
        <p className="text-gray-600">
          Already set up? Open your sound desk link. Lost it, or updating? Open the setup again and sign in with the Google account that set this venue up, or with another account that can manage that same Google Cloud project. An account without that access will not see the venue.
        </p>
      </Card>
    </>
  );
}

// -------------------------------------------------------------------------- finished

function Finished({
  backend,
  token,
  open,
  status,
}: {
  backend: string;
  token: string;
  open: boolean;
  status: Status | null | undefined;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const listen = listenerLink(backend);
  const speak = speakLink(backend, token);

  useEffect(() => {
    if (canvas.current) void QRCode.toCanvas(canvas.current, listen, { width: 280, margin: 2, errorCorrectionLevel: "M" });
  }, [listen]);

  const copy = async (what: string, text: string) => {
    if (await copyText(text)) {
      setCopied(what);
      setTimeout(() => setCopied(null), 2500);
    }
  };

  const downloadQr = async () => {
    const url = await QRCode.toDataURL(listen, { width: 1200, margin: 4, errorCorrectionLevel: "M" });
    const a = document.createElement("a");
    a.href = url;
    a.download = "captions-qr-code.png";
    a.click();
  };

  const emailBody = [
    "Here's the sound desk link. Opening it is the sound desk page.",
    "",
    "Bookmark it as \"Captions\":",
    speak,
    "",
    "Each time: open the bookmark, check the bar moves when someone speaks, press Start. Press Stop at the end.",
    "",
    "Please keep this link private.",
  ].join("\n");
  const mailto = `mailto:?subject=${encodeURIComponent("Captions: sound desk link")}&body=${encodeURIComponent(emailBody)}`;

  return (
    <>
      <div className="space-y-4">
      <Details summary="Share" open={open}>
        <h3 className="font-semibold text-midnight">Sound desk link</h3>
        <p>This page is the sound desk link. Bookmark it as "Captions" and keep it private.</p>
        <p className="text-sm break-all text-gray-600">{speak}</p>
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => copy("speak", speak)}>{copied === "speak" ? "Copied" : "Copy link"}</Button>
          <a href={mailto} className="bg-white border-2 border-purple/30 rounded-xl px-4 py-2.5 font-semibold hover:bg-veil">
            Email to sound desk team
          </a>
        </div>

        <h3 className="font-semibold text-midnight pt-3">QR code for the audience</h3>
        <p>People scan this with their phone camera to follow along. It never changes, even after updates.</p>
        <canvas ref={canvas} className="rounded-lg border border-gray-200" />
        <div className="flex flex-wrap gap-3">
          <Button onClick={downloadQr}>Download QR code (PNG)</Button>
          <Button variant="secondary" onClick={() => copy("listen", listen)}>
            {copied === "listen" ? "Copied" : "Copy audience link"}
          </Button>
        </div>
        <a className="inline-block underline text-blue-600 hover:text-blue-800" href={listen} target="_blank" rel="noreferrer">
          Open the audience view
        </a>
        <h3 className="font-semibold text-midnight pt-3">Other venues</h3>
        <p>Share the homepage with someone setting up captions somewhere else. The project itself is on GitHub.</p>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => copy("home", siteRoot())}>
            {copied === "home" ? "Copied" : "Share with other venues"}
          </Button>
          <a
            href={REPO}
            target="_blank"
            rel="noreferrer"
            className="inline-block bg-white border-2 border-purple/30 rounded-xl px-4 py-2.5 font-semibold hover:bg-veil"
          >
            See the project on GitHub
          </a>
        </div>
      </Details>

      <Spending status={status} />
      </div>
    </>
  );
}

function Notices({ status }: { status: Status | null | undefined }) {
  const [tipDismissed, setTipDismissed] = useState(() => localStorage.getItem(TIP_DISMISSED) === "1");
  const nodeMajor = status ? Number(status.node.split(".")[0]) : null;
  const nodeOld = nodeMajor !== null && nodeMajor < MIN_NODE_MAJOR;
  const update: ProtocolNotice | null = !status ? null : nodeOld ? "major" : protocolNotice(status.protocol, status.protocolVersion);
  const down = status === null;
  const error = !!status?.error;
  const faster = !!status?.sonioxFasterRegion && !tipDismissed;
  if (!down && !error && !update && !faster) return null;
  return (
    <div className="space-y-3">
      {down && (
        <Banner tone="warn">The captioning server isn't answering yet. If you've only just installed it, wait a minute and reload.</Banner>
      )}
      {error && <Banner tone="error">{status.error}</Banner>}
      {update === "major" && (
        <UpdateBanner tone="error">This server is too old for this version of captions, so they may not work.</UpdateBanner>
      )}
      {update === "patch" && <UpdateBanner tone="warn">A security fix is ready for this server.</UpdateBanner>}
      {update === "minor" && (
        <UpdateBanner tone="blue">A new feature is ready. Captions keep working as they are.</UpdateBanner>
      )}
      {status?.sonioxFasterRegion && !tipDismissed && (
        <Banner
          tone="info"
          onClose={() => {
            localStorage.setItem(TIP_DISMISSED, "1");
            setTipDismissed(true);
          }}
        >
          <p className="font-semibold text-midnight">Captions can be faster (optional)</p>
          <p>
            Your venue is closer to Soniox's {status.sonioxFasterRegion.toUpperCase()} region. At console.soniox.com,
            request access to that region, create a project in it, and make an API key there. Then{" "}
            <a className="underline text-blue-600 hover:text-blue-800" href={NEWKEY_URL} target="_blank" rel="noreferrer">
              rotate the Soniox key
            </a>{" "}
            and paste that key when asked.
          </p>
        </Banner>
      )}
    </div>
  );
}

function UpdateBanner({ tone, children }: { tone: "error" | "warn" | "blue"; children: string }) {
  return (
    <Banner tone={tone}>
      {children}{" "}
      <a className="underline text-blue-600 hover:text-blue-800" href={INSTALL_URL} target="_blank" rel="noreferrer">
        Run the install again
      </a>
      . Sign in with the Google account that set this venue up, or with another account that can manage that same Google Cloud project. Your links and QR code stay the same.
    </Banner>
  );
}

function ExtLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="underline text-blue-600 hover:text-blue-800" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function googleBillingCloseUrl(account: string | null | undefined) {
  return account
    ? `https://console.cloud.google.com/billing/${encodeURIComponent(account)}/manage`
    : "https://console.cloud.google.com/billing";
}

function googleProjectUrl(project: string) {
  return `https://console.cloud.google.com/home/dashboard?project=${encodeURIComponent(project)}`;
}

function googleBillingReportsUrl(account: string) {
  return `https://console.cloud.google.com/billing/${encodeURIComponent(account)}/reports`;
}

function googleServerUrl(project: string, region: string) {
  return `https://console.cloud.google.com/run/detail/${encodeURIComponent(region)}/captioning?project=${encodeURIComponent(project)}`;
}

function Spending({ status }: { status: Status | null | undefined }) {
  const project = status?.project;
  const account = status?.billingAccount;
  return (
    <Details summary="Spending">
      <p>
        Captions are billed in two places. Soniox charges for turning speech into captions and translations. Google Cloud
        charges for hosting the server, which normal use keeps inside the free tier, and for Google Translate on the
        languages that use it. Sign in with your account on each site.
      </p>
      <div>
        <p className="font-semibold">Soniox</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <ExtLink href={SONIOX_USAGE}>Usage and cost</ExtLink> — what captions have cost, split by model.
          </li>
          <li>
            <ExtLink href={SONIOX_BILLING}>Credit and charges</ExtLink> — remaining balance, top-ups and autopay.
          </li>
        </ul>
      </div>
      <div>
        <p className="font-semibold">Google Cloud</p>
        {project ? (
          <ul className="list-disc pl-5 space-y-1">
            <li>
              {account ? (
                <ExtLink href={googleBillingReportsUrl(account)}>Spending on this billing account</ExtLink>
              ) : (
                <ExtLink href={`https://console.cloud.google.com/billing/linkedaccount?project=${encodeURIComponent(project)}`}>
                  Spending for this project
                </ExtLink>
              )}{" "}
              — Reports, grouped by Service. Cloud Run is the server; Cloud Translation is the extra languages. Figures
              usually appear the next day.
            </li>
            <li>
              <ExtLink href={googleProjectUrl(project)}>Open the project</ExtLink>
              {status?.region ? (
                <>
                  {" "}
                  · <ExtLink href={googleServerUrl(project, status.region)}>the captioning server</ExtLink>
                </>
              ) : null}
            </li>
          </ul>
        ) : (
          <p>
            {status === undefined
              ? "Checking which Google Cloud project this server is in."
              : "The Google Cloud links appear once the captioning server reports its project."}
          </p>
        )}
      </div>
    </Details>
  );
}

function startNewDeskLink() {
  const shell = window.open(ROTATE_URL, "_blank");
  if (!shell) return;
  shell.opener = null;
  window.close();
  location.replace(siteRoot());
}

function Delete({ status }: { status: Status | null | undefined }) {
  const project = status?.project;
  return (
    <div className="space-y-3 pt-2">
      <h3 className="font-semibold text-midnight">Update the server</h3>
      <p>
        {status?.node ? <>This server is on Node {status.node}. </> : null}
        Smaller fixes are applied for you. Use this only to move to a new Node version. Select this venue when the
        terminal asks. The sound desk link and QR code stay the same.
      </p>
      <a
        href={INSTALL_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-block bg-white border-2 border-purple/30 rounded-xl px-4 py-2.5 font-semibold hover:bg-veil"
      >
        Update the server
      </a>
      <h3 className="font-semibold text-midnight pt-3">Rotate the sound desk link</h3>
      <p>If the sound desk link was shared with someone who shouldn't have it, issue a new one. The old link stops working. The QR code stays the same. This page closes so the old link is not left open here.</p>
      <Button variant="secondary" onClick={startNewDeskLink}>
        Rotate sound desk link
      </Button>
      <h3 className="font-semibold text-midnight pt-3">Rotate the Soniox key</h3>
      <p>
        If the Soniox key got out, or Soniox has stopped accepting it, put a new one on the server. The sound desk link
        and QR code stay the same. When it finishes, <ExtLink href={SONIOX_KEYS}>delete the old key</ExtLink>.
      </p>
      <Button variant="secondary" onClick={() => window.open(NEWKEY_URL, "_blank", "noopener")}>
        Rotate Soniox key
      </Button>
      <h3 className="font-semibold text-midnight pt-3">Set up another venue</h3>
      <p>
        Opens the install in Google Cloud, for a second session at the same time. This venue's link and QR code stay the
        same. The same billing account and Soniox account are fine. A new Soniox key is recommended. The terminal lists
        your venues. The last line sets up another.
      </p>
      <a
        href={ANOTHER_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-block bg-white border-2 border-purple/30 rounded-xl px-4 py-2.5 font-semibold hover:bg-veil"
      >
        Set up another venue
      </a>
      <h3 className="font-semibold text-midnight pt-3">Delete</h3>
      <p>
        Delete removes the captioning server and the Google Cloud project the install created
        {project ? ` (${project})` : ""}. Google keeps a deleted project for 30 days if you change your mind.
      </p>
      <a
        href={DELETE_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-block bg-red-700 hover:bg-red-800 text-white font-semibold px-4 py-2.5 rounded-xl"
      >
        Delete from Google Cloud
      </a>
      <p>These stay, because the install did not create them:</p>
      <ul className="list-disc pl-5 space-y-1">
        <li>
          The Soniox project and its API key. <ExtLink href={SONIOX_PROJECT}>Delete the Soniox project</ExtLink>. The
          account and any remaining credit stay.
        </li>
        <li>
          Your Google billing account and card.{" "}
          <ExtLink href={googleBillingCloseUrl(status?.billingAccount)}>Close the Google billing account</ExtLink>
          {status?.billingAccount ? " (Account management → Close billing account)." : " (pick the captions account, then Account management → Close billing account)."}{" "}
          Only close it if you created it for captions and nothing else uses it.
        </li>
      </ul>
    </div>
  );
}