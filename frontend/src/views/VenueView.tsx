import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import { audioSupported, guessMode, listInputs, startCapture, type Capture, type InputMode } from "../audio/capture";
import { clampSendAfter, SEND_AFTER } from "../audio/gate";
import { checkDeskAccess, getBackend, getLanguages, getPrices, getSpend, getStatus, getToken, listenerLink, parseProtocol, protocolNotice, setupNotice, siteRoot, speakLink, strongestNotice, type DeskAccess, type GooglePrices, type Languages, type Spend, type ProtocolNotice, type Status } from "../backend";
import { englishName } from "../lib/languages";
import { useWakeLock, wakeLockSupported } from "../lib/wakeLock";
import { createDeskGate } from "../audio/speech-model";
import type { SpeechGate } from "../audio/speech";
import { SpeakerConnection, type ConnState, type Preview, type ServerMessage, type Stats } from "../speaker";
import { applyDarkClass, readDarkPreference, writeDarkPreference } from "../lib/dark";
import { Banner, Button, Card, copyText, Details, InfoLink, RepoLink, ThemeButton } from "../ui";

const SONIOX_USAGE = "https://console.soniox.com/org/projects/usage/cost";
const SONIOX_BILLING = "https://console.soniox.com/org/billing/reports";

const REPO = "https://github.com/tobyfielding1/self-hosted-captioning";
/** /dev/ site opens Cloud Shell on tag backend-dev; live site on backend-latest. */
const SITE_CHANNEL = import.meta.env.BASE_URL.includes("/dev/") ? "dev" : "prod";
const RELEASE_TAG = SITE_CHANNEL === "dev" ? "backend-dev" : "backend-latest";
const shellUrl = (tutorial: string) =>
  `https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=${encodeURIComponent(REPO)}&cloudshell_git_branch=${encodeURIComponent(RELEASE_TAG)}&cloudshell_tutorial=${encodeURIComponent(tutorial)}&show=terminal`;
const INSTALL_URL = shellUrl("deploy.md");
const ROTATE_URL = shellUrl("rotate.md");
const NEWKEY_URL = shellUrl("newkey.md");
const DELETE_URL = shellUrl("delete.md");
// Public on purpose: the demo venue. The home page also reads its live language list.
const DEMO_HOST = "captioning-idhlw6p5ka-ew.a.run.app";
const DEMO_DESK_URL = `#backend=${DEMO_HOST}&token=07400c4702ba8651da12b3225f88a031`;
const LANGUAGE_DOCS = {
  soniox: "https://soniox.com/docs/stt/concepts/supported-languages",
  google: "https://docs.cloud.google.com/translate/docs/languages#nmt",
  chirp: "https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd#language_availability",
};
const PRICING = {
  soniox: "https://soniox.com/pricing?mode=translation&providers=soniox%2Copenai&delivery=realtime",
  google: "https://cloud.google.com/products/translate/pricing#basic-pricing",
  chirp: "https://cloud.google.com/text-to-speech/pricing",
};
const SONIOX_PROJECT = "https://console.soniox.com/org/projects/settings";
const SONIOX_KEYS = "https://console.soniox.com/org/projects/api/keys";
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
  endpointDelayMs: "captioning.endpointDelayMs",
  endpointSensitivity: "captioning.endpointSensitivity",
  endpointLatency: "captioning.endpointLatency",
  /** Missing means the install default. An empty string means no context. */
  context: "captioning.context",
  /** Missing means the install default. */
  sessionMinutes: "captioning.sessionMinutes",
};
/** The server replaces the Soniox stream (capped at 300 minutes), so a session may run up to a day. */
const MAX_SESSION_MIN = 24 * 60;
const clampSessionMinutes = (n: number) => Math.min(MAX_SESSION_MIN, Math.max(1, Math.round(n)));

/** The only copy of these defaults. Changing them ships with the page. */
const ENDPOINT_DEFAULTS = { delayMs: 1500, sensitivity: 0.3, latency: 2 };
const SONIOX_ENDPOINT_DOCS = "https://soniox.com/docs/stt/rt/endpoint-detection";
const SONIOX_CONTEXT_DOCS = "https://soniox.com/docs/stt/concepts/context";
/** Soniox rejects a context over about 10,000 characters. */
const MAX_CONTEXT = 10_000;

/** Servers from 4.3.0 accept context from the sound desk. */
function acceptsContext(protocolVersion: unknown): boolean {
  const v = parseProtocol(protocolVersion);
  return !!v && (v.major > 4 || (v.major === 4 && v.minor >= 3));
}

function SonioxInfo({ href, text }: { href: string; text: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={text}
      title={text}
      className="inline-flex text-blue-600 hover:text-blue-800 dark:text-blue-200 dark:hover:text-blue-100"
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden="true">
        <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM7.25 4.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0zM7 7h1.5v4.5H7V7z" />
      </svg>
    </a>
  );
}

const readStored = (key: string) => {
  const saved = localStorage.getItem(key);
  if (saved === null || saved === "") return null;
  const n = Number(saved);
  return Number.isFinite(n) ? n : null;
};

const readEndpoint = () => {
  const delay = readStored(STORE.endpointDelayMs);
  const sensitivity = readStored(STORE.endpointSensitivity);
  const latency = readStored(STORE.endpointLatency);
  return {
    delayMs: delay === null ? ENDPOINT_DEFAULTS.delayMs : Math.min(3000, Math.max(500, Math.round(delay))),
    sensitivity:
      sensitivity === null ? ENDPOINT_DEFAULTS.sensitivity : Math.min(1, Math.max(-1, Math.round(sensitivity * 100) / 100)),
    latency: latency === null ? ENDPOINT_DEFAULTS.latency : Math.min(3, Math.max(0, Math.round(latency))),
  };
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

/** Seconds as "4:05" or "1:04:05", or "5 minutes" / "5 hours" when it divides evenly. */
function clock(s: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (s >= 3600 && s % 3600 === 0) return unit(s / 3600, "hour");
  if (s >= 60 && s % 60 === 0) return unit(s / 60, "minute");
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
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
  const [endpoint, setEndpoint] = useState(readEndpoint);
  const [context, setContext] = useState<string | null>(() => localStorage.getItem(STORE.context));
  const [contextDraft, setContextDraft] = useState<string | null>(null);
  const [sessionMinutes, setSessionMinutes] = useState<number | null>(() => {
    const saved = readStored(STORE.sessionMinutes);
    return saved === null || saved <= 0 ? null : clampSessionMinutes(saved);
  });
  const [sessionDraft, setSessionDraft] = useState<string | null>(null);
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
  const lastSpeechRef = useRef(0);
  const connRef = useRef<SpeakerConnection | null>(null);
  const testShown = useRef(false);
  const testWant = useRef<boolean | null>(null);
  const followingRef = useRef(false);
  const [testOn, setTestOn] = useState(false);
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;
  const contextRef = useRef(context);
  contextRef.current = context;
  const live = conn !== "off";
  const wakeLock = useWakeLock(live);
  // Same pattern as session length: hello when live, else /status with the desk token.
  const contextDefault =
    typeof hello?.contextDefault === "string"
      ? hello.contextDefault
      : typeof status?.contextDefault === "string"
        ? status.contextDefault
        : null;
  const contextText = context ?? contextDefault ?? "";
  // An older server sends no contextDefault. Show the field once we know this build accepts context.
  const contextShown = contextDefault !== null || acceptsContext(status?.protocolVersion) || acceptsContext(hello?.protocolVersion);
  // An older server sends no default and has no session limit.
  const sessionDefault =
    typeof hello?.sessionMinutesDefault === "number" ? hello.sessionMinutesDefault : (status?.sessionMinutesDefault ?? null);
  const sessionShown = sessionMinutes ?? sessionDefault;

  // Context goes first: the server opens no stream until the endpoint settings arrive.
  const pushSettings = useCallback(
    (next: { delayMs: number; sensitivity: number; latency: number }, text: string | null) => {
      connRef.current?.sendControl({ type: "context", text });
      connRef.current?.sendControl({
        type: "endpoint",
        endpointDelayMs: next.delayMs,
        endpointSensitivity: next.sensitivity,
        endpointLatency: next.latency,
      });
    },
    [],
  );

  useEffect(() => {
    if (conn !== "live") return;
    pushSettings(endpoint, context);
  }, [conn, endpoint, context, pushSettings]);

  useEffect(() => {
    if (conn === "live") connRef.current?.sendControl({ type: "sessionLimit", minutes: sessionMinutes });
  }, [conn, sessionMinutes]);

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
      (s) => {
        setConn(s);
        if (s === "live") pushSettings(endpointRef.current, contextRef.current);
      },
      (msg: ServerMessage) => {
        if (msg.type === "hello") setHello(msg);
        else if (msg.type === "stats") {
          setStats(msg);
          followingRef.current = Object.values(msg.listeners).some((n) => n > 0);
          // A click wins until the server agrees. Once it has agreed, a later stats message can turn it off.
          if (testWant.current === null || msg.testing === testWant.current) {
            testWant.current = null;
            testShown.current = msg.testing;
            setTestOn(msg.testing);
          }
          if (!followingRef.current && !testShown.current) setPreview(null);
        }
        else if (msg.type === "preview") {
          if (followingRef.current || testShown.current) setPreview(msg);
        }
        else if (msg.type === "error") {
          setErrors((e) => [...e.slice(-19), { at: new Date().toISOString(), message: msg.message }]);
          setShownError(msg.message);
        } else if (msg.type === "stopped") {
          testWant.current = null;
          testShown.current = false;
          followingRef.current = false;
          setTestOn(false);
          setStats(null);
          setPreview(null);
          setNotice(
            msg.reason === "idle"
              ? "Stopped because it was quiet for an hour. Press Start to begin again."
              : msg.reason === "takeover"
                ? "Taken over by another device. Press Start to take it back."
                : msg.reason === "limit"
                  ? "Stopped at the time limit for one session. Press Start to begin again."
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
      if (decision.speech) lastSpeechRef.current = performance.now();
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
      lastSpeechRef.current = 0;
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

  const start = () => {
    setNotice(null);
    setShownError(null);
    const gate = gateRef.current;
    if (gate) {
      gate.hangoverMs = clampSendAfter(sendAfter);
      if (!live) gate.reset();
    }
    connRef.current!.start();
  };

  const toggleTest = () => {
    const next = !testShown.current;
    testWant.current = next;
    testShown.current = next;
    setTestOn(next);
    if (!next && !followingRef.current) setPreview(null);
    connRef.current?.setTesting(next);
  };

  const stop = () => {
    connRef.current!.stop();
    setStats(null);
    setPreview(null);
    testWant.current = null;
    testShown.current = false;
    followingRef.current = false;
    setTestOn(false);
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

  const [dark, setDark] = useState(readDarkPreference);
  const setDarkMode = (next: boolean) => {
    writeDarkPreference(next);
    applyDarkClass(next);
    setDark(next);
  };
  const headerIcons = (
    <div className="flex items-center gap-1">
      <InfoLink />
      <ThemeButton dark={dark} onClick={() => setDarkMode(!dark)} />
      <RepoLink />
    </div>
  );
  const heading = status?.venue ? (
    <div className="flex items-center justify-between gap-4">
      <h1 className="min-w-0 flex-1 truncate text-3xl font-bold text-midnight dark:text-white">{status.venue}</h1>
      {headerIcons}
    </div>
  ) : (
    <div className="flex justify-end">{headerIcons}</div>
  );

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
  const speaking = speech === "ready" && performance.now() - lastSpeechRef.current < 600;
  const meterLabel =
    speech === "ready"
      ? speaking
        ? "Speech detected"
        : "No speech detected"
      : heard
        ? "We can hear you"
        : "Quiet: speak and check the bar moves";
  const meterMuted = speech === "ready" && !speaking;
  const meterPct = Math.min(100, Math.sqrt(level / METER_MAX) * 100);
  const listenersText = stats ? describeListeners(stats.listeners) : "";
  const following = !!stats && Object.values(stats.listeners).some((n) => n > 0);
  const showReading = live && (following || testOn);

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

      <section className="bg-white rounded-2xl border border-purple/30 dark:bg-white/10 dark:border-white/15 p-5 space-y-4">
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
                  className="mt-1 block w-full rounded-xl border-2 border-purple/30 px-3 py-2.5 text-lg bg-white dark:bg-white/10 dark:border-white/20 dark:text-white"
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
              <div className="relative h-8 rounded-full bg-gray-200 overflow-hidden dark:bg-white/15" aria-hidden>
                <div
                  className={`h-full transition-[width] duration-100 ${heard ? "bg-green-600" : "bg-gray-400"}`}
                  style={{ width: `${meterPct}%` }}
                />
              </div>
              <p className={`mt-2 text-lg font-semibold ${meterMuted ? "text-gray-500 dark:text-white/50" : "text-charcoal dark:text-white"}`} aria-live="polite">
                {meterLabel}
              </p>
            </div>
          </>
        )}
      </section>

      <section className="bg-white rounded-2xl border border-purple/30 dark:bg-white/10 dark:border-white/15 p-5 space-y-4">
        <p className="text-3xl font-bold" aria-live="polite">
          {headline}
        </p>
        {live && stats?.endsInS !== undefined && <p>Stops automatically in {clock(stats.endsInS)}.</p>}
        {!live && sessionShown !== null && (
          <p>Each session stops automatically after {clock(Math.round(sessionShown * 60))}. Press Start again to carry on.</p>
        )}

        {!live && status?.streaming && (
          <Banner tone="warn">
            Another sound desk is already live. Starting here takes over, and their page stops.
          </Banner>
        )}

        {speech === "loading" && <p>Preparing speech detection...</p>}
        {speech === "failed" && <Banner tone="error">Speech detection didn't load. Reload the page.</Banner>}

        <div className="flex flex-wrap gap-3">
          {!live ? (
            <Button big disabled={mic !== "on" || speech !== "ready"} onClick={() => start()}>
              Start
            </Button>
          ) : (
            <>
              <Button big variant="danger" onClick={stop}>
                Stop
              </Button>
              <Button
                big
                variant={testOn ? "primary" : "secondary"}
                aria-pressed={testOn}
                onClick={toggleTest}
                className="!text-base"
              >
                Test captions
              </Button>
            </>
          )}
        </div>

        {live && conn === "live" && testOn && <p className="text-purple dark:text-leaf">Test captions running for a minute.</p>}

        {showReading && (
          <div className="rounded-xl bg-gray-50 border border-gray-200 dark:bg-white/5 dark:border-white/15 p-3 text-lg leading-snug">
            <p className="text-sm font-semibold text-gray-500 dark:text-white/90 mb-1">What people are reading</p>
            {preview?.lines.map((l, i) => (
              <p key={i}>{l}</p>
            ))}
            {preview && (preview.current || preview.partial) && (
              <p>
                {preview.current} <span className="text-gray-400 dark:text-white/90">{preview.partial}</span>
              </p>
            )}
          </div>
        )}

        {live && (
          <p>
            Keep this tab open.{" "}
            {wakeLockSupported() ? (wakeLock ? "The screen will stay on." : "") : "Turn off sleep on this device."}{" "}
            <a className="underline text-blue-600 hover:text-blue-800 dark:text-blue-200 dark:hover:text-blue-100" href={listenerLink()} target="_blank" rel="noreferrer">
              Open the audience view
            </a>
          </p>
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
          <p className="text-sm text-gray-600 dark:text-white/90">
            Audio keeps going for a moment after speech stops, so the last words are still sent. That applies straight away.
          </p>
        </div>
        <div className="space-y-3">
          <p className="font-semibold">Caption pauses (Soniox)</p>
          <p className="text-sm text-gray-600 dark:text-white/90">
            How readily a pause starts a new line. Applies on the next stream while this desk is live. Stored in this
            browser.
          </p>
          <div>
            <div className="flex items-center gap-1.5">
              <label className="font-semibold" htmlFor="endpoint-delay">
                Max delay: {endpoint.delayMs} ms
              </label>
              <SonioxInfo
                href={`${SONIOX_ENDPOINT_DOCS}#max_endpoint_delay_ms`}
                text="Sets the maximum time Soniox can wait before returning an endpoint after speech has ended."
              />
            </div>
            <input
              id="endpoint-delay"
              type="range"
              className="w-full"
              min={500}
              max={3000}
              step={100}
              value={endpoint.delayMs}
              onChange={(e) => {
                const delayMs = Math.min(3000, Math.max(500, Math.round(Number(e.target.value))));
                const next = { ...endpoint, delayMs };
                setEndpoint(next);
                localStorage.setItem(STORE.endpointDelayMs, String(delayMs));
              }}
            />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <label className="font-semibold" htmlFor="endpoint-sensitivity">
                Sensitivity: {endpoint.sensitivity}
              </label>
              <SonioxInfo
                href={`${SONIOX_ENDPOINT_DOCS}#endpoint_sensitivity`}
                text="Controls how likely Soniox is to emit an endpoint."
              />
            </div>
            <input
              id="endpoint-sensitivity"
              type="range"
              className="w-full"
              min={-1}
              max={1}
              step={0.05}
              value={endpoint.sensitivity}
              onChange={(e) => {
                const sensitivity = Math.min(1, Math.max(-1, Math.round(Number(e.target.value) * 100) / 100));
                const next = { ...endpoint, sensitivity };
                setEndpoint(next);
                localStorage.setItem(STORE.endpointSensitivity, String(sensitivity));
              }}
            />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <label className="font-semibold" htmlFor="endpoint-latency">
                Latency level: {endpoint.latency}
              </label>
              <SonioxInfo
                href={`${SONIOX_ENDPOINT_DOCS}#endpoint_latency_adjustment_level`}
                text="Reduces endpoint latency compared to the default endpointing behavior."
              />
            </div>
            <input
              id="endpoint-latency"
              type="range"
              className="w-full"
              min={0}
              max={3}
              step={1}
              value={endpoint.latency}
              onChange={(e) => {
                const latency = Math.min(3, Math.max(0, Math.round(Number(e.target.value))));
                const next = { ...endpoint, latency };
                setEndpoint(next);
                localStorage.setItem(STORE.endpointLatency, String(latency));
              }}
            />
          </div>
          <Button
            variant="ghost"
            onClick={() => {
              setEndpoint(ENDPOINT_DEFAULTS);
              localStorage.removeItem(STORE.endpointDelayMs);
              localStorage.removeItem(STORE.endpointSensitivity);
              localStorage.removeItem(STORE.endpointLatency);
            }}
          >
            Reset pause settings
          </Button>
        </div>
        {contextShown && (
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <label className="font-semibold" htmlFor="context">
                Context (Soniox)
              </label>
              <SonioxInfo
                href={SONIOX_CONTEXT_DOCS}
                text="Tells Soniox what to expect: the kind of event, and the names and special words that come up."
              />
            </div>
            <p className="text-sm text-gray-600 dark:text-white/90">
              The kind of event, and the names of people, places and special words that come up. Applies on the next
              stream while this desk is live. Stored in this browser.
              {context === null && contextDefault !== null
                ? contextDefault
                  ? " Using the text from the install (shown below)."
                  : " No text was set at install; leave empty for none."
                : ""}
            </p>
            <textarea
              id="context"
              className="w-full rounded border border-gray-300 bg-white p-2 dark:border-gray-600 dark:bg-gray-800"
              rows={4}
              maxLength={MAX_CONTEXT}
              value={contextDraft ?? contextText}
              onChange={(e) => setContextDraft(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={contextDraft === null || contextDraft.trim() === contextText}
                onClick={() => {
                  const text = (contextDraft ?? "").trim().slice(0, MAX_CONTEXT);
                  setContext(text);
                  setContextDraft(null);
                  localStorage.setItem(STORE.context, text);
                }}
              >
                Save context
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setContext(null);
                  setContextDraft(null);
                  localStorage.removeItem(STORE.context);
                }}
              >
                Reset to install default
              </Button>
            </div>
          </div>
        )}
        {sessionDefault !== null && (
          <div className="space-y-3">
            <label className="font-semibold" htmlFor="session-minutes">
              Session length (minutes)
            </label>
            <p className="text-sm text-gray-600 dark:text-white/90">
              Captions stop after this long, and you press Start to carry on. From 1 to {MAX_SESSION_MIN}. Applies to the
              session running now. Stored in this browser.
              {sessionMinutes === null ? " Using the length from the install." : ""}
            </p>
            <input
              id="session-minutes"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_SESSION_MIN}
              step={1}
              className="w-32 rounded border border-gray-300 bg-white p-2 dark:border-gray-600 dark:bg-gray-800"
              value={sessionDraft ?? String(sessionShown ?? "")}
              onChange={(e) => setSessionDraft(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={sessionDraft === null || !(Number(sessionDraft) > 0) || Number(sessionDraft) === sessionShown}
                onClick={() => {
                  const minutes = clampSessionMinutes(Number(sessionDraft));
                  setSessionMinutes(minutes);
                  setSessionDraft(null);
                  localStorage.setItem(STORE.sessionMinutes, String(minutes));
                }}
              >
                Save length
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setSessionMinutes(null);
                  setSessionDraft(null);
                  localStorage.removeItem(STORE.sessionMinutes);
                }}
              >
                Reset to install default
              </Button>
            </div>
          </div>
        )}
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
              <a className="underline text-blue-600 hover:text-blue-800 dark:text-blue-200 dark:hover:text-blue-100" href="https://console.soniox.com/org/billing/reports" target="_blank" rel="noreferrer">
                Billing
              </a>
              . Turn on "Enable autopay" under{" "}
              <a className="underline text-blue-600 hover:text-blue-800 dark:text-blue-200 dark:hover:text-blue-100" href="https://console.soniox.com/org/billing/payment-setup" target="_blank" rel="noreferrer">
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
              </Button>
              , then{" "}
              <a
                className="underline text-blue-600 hover:text-blue-800 dark:text-blue-200 dark:hover:text-blue-100"
                href={`${REPO}/issues/new`}
                target="_blank"
                rel="noreferrer"
              >
                open an issue on GitHub
              </a>{" "}
              and paste them in.
            </dd>
          </div>
        </dl>
      </Details>
    </div>
  );
}

// ----------------------------------------------------------------------------- intro

function Intro() {
  const [dark, setDark] = useState(readDarkPreference);
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-bold text-midnight dark:text-white">Live captions</h1>
        <div className="flex items-center gap-1">
          <ThemeButton
            dark={dark}
            onClick={() => {
              const next = !dark;
              writeDarkPreference(next);
              applyDarkClass(next);
              setDark(next);
            }}
          />
          <RepoLink />
        </div>
      </div>
      <p className="text-lg">
        Live captions and translation for one venue at a time. The venue's own Google Cloud account runs a small
        server, and the audience reads on their phones in the language they pick. Hosting it yourselves keeps the cost
        low.
      </p>
      <Card title="Try it">
        <p>
          Open the{" "}
          <a className="underline text-blue-600 hover:text-blue-800 dark:text-blue-200 dark:hover:text-blue-100" href={DEMO_DESK_URL}>
            demo sound desk
          </a>
          , press Start and speak. Open the audience link it shows on your phone to read along.
        </p>
        <p className="text-gray-600 dark:text-white/90">
          Only one person can record at a time: starting takes over from whoever is using it. Demo recordings stop after
          5 minutes; press Start again to continue.
        </p>
      </Card>
      <LanguagesCard />
      <CostCard />
      <Card title="Audience">
        <p>If you are in the audience, ask the venue for the audience link or QR code to read along.</p>
      </Card>
      <Card title="Venue team">
        <p>
          Open your sound desk link, check the level bar moves when someone speaks, and press Start. Everyone else
          scans a QR code with their phone camera, picks a language, and reads as the words appear.
        </p>
        <p>Press Stop at the end. Devices can follow only while the sound desk is live.</p>
      </Card>
      <Card title="Set up once">
        <p>
          It takes about 15 minutes on your Google account. Each venue gets its own server, a private sound desk link,
          and a QR code that stays the same. The terminal lists any venues already on this account.
        </p>
        <p>
          Google Cloud hosts the server. CPU and memory for normal use stay in the free tier; a little egress is
          charged for audio leaving the server. Google still asks for a card, and the install emails you if this venue
          passes £5 a month.
        </p>
        <p>
          Captions and translations come from Soniox, with Google Translate and spoken captions as options the install
          asks about. You choose how much Soniox credit to add. Credit is only used while someone is being captioned:
          quiet audio isn't sent, and a language runs only while someone is reading it. See Cost above for examples.
        </p>
        <a
          href={INSTALL_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-block bg-purple hover:bg-midnight text-white text-lg font-semibold px-8 py-5 rounded-2xl border-2 border-transparent dark:border-white/40"
        >
          Set up live captions
        </a>
        <p className="text-gray-600 dark:text-white/90">
          If you end up in a blank terminal, click Set up live captions again.
        </p>
        <p className="text-gray-600 dark:text-white/90">
          Already set up? Open your sound desk link. Lost it, or updating? Open the setup again and sign in with the
          Google account that set this venue up, or with another account that can manage that same Google Cloud project.
          An account without that access will not see the venue.
        </p>
      </Card>
    </>
  );
}

/** English name, or Google's name for a language the browser can't name. */
function targetName(t: Languages["targets"][number]): string {
  const name = englishName(t.code);
  return name === t.code && t.name ? t.name : name;
}

function LanguageList({ summary, targets }: { summary: string; targets: Languages["targets"] }) {
  if (!targets.length) return null;
  const names = [...new Set(targets.map(targetName))].sort((a, b) => a.localeCompare(b));
  return (
    <details>
      <summary className="cursor-pointer font-semibold">{summary}</summary>
      <p className="pt-2 text-sm text-gray-600 dark:text-white/90">{names.join(", ")}</p>
    </details>
  );
}

/** How long the home page keeps saying Google is warming up before it stops waiting. */
const DEMO_WARMING_MS = 30_000;

function LanguagesCard() {
  // Read only when opened, so a visit to the home page doesn't wake the demo server.
  // While Google is still loading, poll a few times; after DEMO_WARMING_MS stop claiming it's about to appear.
  const [languages, setLanguages] = useState<Languages | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [warmingSince, setWarmingSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const list = await getLanguages(`https://${DEMO_HOST}`);
      if (cancelled) return;
      setLanguages(list);
      if (list?.google === "loading") {
        setWarmingSince((t) => t ?? Date.now());
        setNow(Date.now());
        timer = setTimeout(load, 3000);
        return;
      }
      setWarmingSince(null);
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open]);
  const targets = languages?.targets ?? [];
  const soniox = targets.filter((t) => t.via === "soniox");
  const google = targets.filter((t) => t.via === "google");
  const spoken = targets.filter((t) => t.audio);
  const warming = languages?.google === "loading";
  const waitedOut = warming && warmingSince != null && now - warmingSince >= DEMO_WARMING_MS;
  return (
    <Card title="Languages">
      <p>
        Soniox writes the captions and translates them live, word by word. Google Translate is an option at install: it
        adds the languages Soniox doesn't translate, shown after each pause. Spoken captions are another option: phones
        read the translation aloud with a Google Chirp 3 HD voice.
      </p>
      <p className="text-sm">
        The providers' own lists: <ExtLink href={LANGUAGE_DOCS.soniox}>Soniox</ExtLink>,{" "}
        <ExtLink href={LANGUAGE_DOCS.google}>Google Translate</ExtLink>,{" "}
        <ExtLink href={LANGUAGE_DOCS.chirp}>Chirp 3 HD voices</ExtLink>.
      </p>
      <details
        onToggle={(e) => {
          const next = e.currentTarget.open;
          setOpen(next);
          if (!next) {
            setLanguages(undefined);
            setWarmingSince(null);
          }
        }}
      >
        <summary className="cursor-pointer font-semibold">Today's languages, from the demo server</summary>
        <div className="pt-2 space-y-2">
          {languages === undefined && (
            <p className="text-sm text-gray-600 dark:text-white/90">Asking the demo server. It can take a few seconds to wake up...</p>
          )}
          {languages === null && (
            <p className="text-sm text-gray-600 dark:text-white/90">The demo server didn't answer. The lists above are the providers' own.</p>
          )}
          {warming && !waitedOut && (
            <p className="text-sm text-gray-600 dark:text-white/90">Google's languages are still warming up on the demo server.</p>
          )}
          {waitedOut && (
            <p className="text-sm text-gray-600 dark:text-white/90">
              Google's languages didn't load on the demo this time. Soniox's list is below; the provider link above has
              Google's full set.
            </p>
          )}
          {languages && <LanguageList summary={`Soniox: ${soniox.length} languages`} targets={soniox} />}
          {languages?.google === "ready" && (
            <LanguageList summary={`Google Translate adds ${google.length} more`} targets={google} />
          )}
          {languages && spoken.length > 0 && (
            <LanguageList summary={`Spoken captions: ${spoken.length} languages`} targets={spoken} />
          )}
        </div>
      </details>
    </Card>
  );
}

/**
 * Prices used for the cost examples, worked out on PRICES_AS_OF. Soniox publishes no price list to read, so its
 * figures are always these. The Google ones can be replaced with what the demo server read from Google today.
 * Soniox's translated hour is estimated from its token prices: $0.12 for the transcript plus about $0.06 for the translation.
 * Cloud Run CPU/RAM free tier and internet egress are dated list prices (Tier 1 / own-continent planning figure).
 */
const PRICES_AS_OF = "November 2026";
const DATED_PRICES = {
  sonioxHour: 0.12,
  sonioxTranslatedHour: 0.18,
  translatePerMillion: 20,
  /** A monthly US$10 credit, so Google's price list doesn't show it. */
  translateFreeChars: 500_000,
  speechPerMillion: 30,
  speechFreeChars: 1_000_000,
  /** Cloud Run internet data transfer out, about own-continent Tier 1. */
  egressPerGiB: 0.12,
};
/** About 30 hours of speech is a million characters. */
const CHARS_PER_HOUR = 1_000_000 / 30;
/** 16 kHz 16-bit mono PCM to each Soniox stream. */
const PCM_GIB_PER_HOUR = (16_000 * 2 * 3600) / 1024 ** 3;
/** Chirp's MP3 is 32 kbps; one copy leaves the server per spoken language. */
const SPOKEN_GIB_PER_HOUR = ((32_000 / 8) * 3600) / 1024 ** 3;
/** Request-based Cloud Run free tier (Tier 1), enough for the examples' live hours. */
const CLOUD_RUN_FREE_VCPU_S = 180_000;
const CLOUD_RUN_FREE_GIB_S = 360_000;

const usd = (n: number) => `$${n.toFixed(2)}`;
const millions = (chars: number) => {
  const m = chars / 1_000_000;
  if (m < 1) return chars.toLocaleString("en-US");
  return m === 1 ? "1 million" : `${Number(m.toFixed(2))} million`;
};
const giBs = (n: number) => (n < 10 ? n.toFixed(1) : String(Math.round(n)));

function CostCard() {
  const [live, setLive] = useState<GooglePrices | null | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const p = {
    ...DATED_PRICES,
    ...(live?.translatePerMillion != null ? { translatePerMillion: live.translatePerMillion } : {}),
    ...(live?.speechPerMillion != null ? { speechPerMillion: live.speechPerMillion } : {}),
    ...(live?.speechFreeChars != null ? { speechFreeChars: live.speechFreeChars } : {}),
  };

  const cloudRunFree = (liveHours: number) =>
    liveHours * 3600 <= CLOUD_RUN_FREE_VCPU_S && liveHours * 3600 * 0.5 <= CLOUD_RUN_FREE_GIB_S;

  const smallHours = 6;
  const smallEgressGiB = 1 * smallHours * PCM_GIB_PER_HOUR;
  const smallEgress = smallEgressGiB * p.egressPerGiB;
  const small = smallHours * p.sonioxTranslatedHour + smallEgress;

  // Halfway between the small and large examples: hours, Soniox languages, Google, and spoken.
  const midHours = 18;
  const midSonioxLangs = 3;
  const midGoogleLangs = 1;
  const midSpokenLangs = 1;
  const midChars = midHours * CHARS_PER_HOUR;
  const midSoniox = midSonioxLangs * midHours * p.sonioxTranslatedHour;
  const midTranscript = midHours * p.sonioxHour;
  const midTranslate = (Math.max(0, midGoogleLangs * midChars - p.translateFreeChars) / 1_000_000) * p.translatePerMillion;
  const midSpeech = (Math.max(0, midSpokenLangs * midChars - p.speechFreeChars) / 1_000_000) * p.speechPerMillion;
  const midSonioxStreams = midSonioxLangs + 1; // + Original/Google transcript stream
  const midEgressGiB = midSonioxStreams * midHours * PCM_GIB_PER_HOUR + midSpokenLangs * midHours * SPOKEN_GIB_PER_HOUR;
  const midEgress = midEgressGiB * p.egressPerGiB;
  const mid = midSoniox + midTranscript + midTranslate + midSpeech + midEgress;

  const hours = 30;
  const chars = hours * CHARS_PER_HOUR;
  const sonioxLanguages = 5 * hours * p.sonioxTranslatedHour;
  const transcript = hours * p.sonioxHour;
  const translateChars = 2 * chars;
  const translate = (Math.max(0, translateChars - p.translateFreeChars) / 1_000_000) * p.translatePerMillion;
  const speechChars = 2 * chars;
  const speech = (Math.max(0, speechChars - p.speechFreeChars) / 1_000_000) * p.speechPerMillion;
  // One Soniox stream for Original/Google, plus one per Soniox language. Spoken audio is one stream per language.
  const largeSonioxStreams = 6;
  const largeSpokenStreams = 2;
  const largeEgressGiB = largeSonioxStreams * hours * PCM_GIB_PER_HOUR + largeSpokenStreams * hours * SPOKEN_GIB_PER_HOUR;
  const largeEgress = largeEgressGiB * p.egressPerGiB;
  const large = sonioxLanguages + transcript + translate + speech + largeEgress;

  return (
    <Card title="Cost">
      <p>
        You pay the providers directly, only while the sound desk is live and someone is reading. Each language costs
        the same however many people read it. The figures below are worked examples for three different months of use,
        not a quote for your venue. Cloud Run CPU and memory for these stay inside Google's free allowance; egress is
        charged for audio leaving the server.
      </p>
      <div className="space-y-1">
        <p className="font-semibold">
          Example: 6 hours a month, translated into 1 language by Soniox — about US{usd(small)} a month
        </p>
        <p className="text-sm text-gray-600 dark:text-white/90">
          Soniox: 6 hours at about {usd(p.sonioxTranslatedHour)} an hour = {usd(smallHours * p.sonioxTranslatedHour)}.
          Cloud Run egress: one stream of 16 kHz audio to Soniox, about {giBs(smallEgressGiB)} GiB at{" "}
          {usd(p.egressPerGiB)}/GiB = {usd(smallEgress)}.
        </p>
      </div>
      <div className="space-y-1">
        <p className="font-semibold">
          Example: 18 hours a month, 3 Soniox languages, 1 Google Translate language and spoken captions in 1
          language — about US{usd(mid)} a month
        </p>
        <ul className="list-disc pl-5 text-sm text-gray-600 dark:text-white/90 space-y-1">
          <li>
            Soniox: 3 languages × 18 hours at about {usd(p.sonioxTranslatedHour)} = {usd(midSoniox)}, plus the transcript
            Google translates from, 18 hours at {usd(p.sonioxHour)} = {usd(midTranscript)}.
          </li>
          <li>
            Google Translate: 1 language × {millions(midChars)} characters. The first {millions(p.translateFreeChars)} a
            month are free, then {usd(p.translatePerMillion)} per million = {usd(midTranslate)}.
          </li>
          <li>
            Spoken captions: 1 language × {millions(midChars)} characters. The first {millions(p.speechFreeChars)} a month
            are free, then {usd(p.speechPerMillion)} per million = {usd(midSpeech)}.
          </li>
          <li>
            Cloud Run: 18 hours stays inside the free CPU and memory allowance
            {cloudRunFree(midHours) ? ` (${usd(0)})` : ""}. Egress: about {giBs(midEgressGiB)} GiB at{" "}
            {usd(p.egressPerGiB)}/GiB = {usd(midEgress)}.
          </li>
        </ul>
      </div>
      <div className="space-y-1">
        <p className="font-semibold">
          Example: 30 hours a month, 5 Soniox languages, 2 Google Translate languages and spoken captions in 2
          languages — about US{usd(large)} a month
        </p>
        <ul className="list-disc pl-5 text-sm text-gray-600 dark:text-white/90 space-y-1">
          <li>
            Soniox: 5 languages × 30 hours at about {usd(p.sonioxTranslatedHour)} = {usd(sonioxLanguages)}, plus the
            transcript Google translates from, 30 hours at {usd(p.sonioxHour)} = {usd(transcript)}.
          </li>
          <li>
            Google Translate: 2 languages × 1 million characters. The first {millions(p.translateFreeChars)} a month are
            free, then {usd(p.translatePerMillion)} per million = {usd(translate)}.
          </li>
          <li>
            Spoken captions: 2 languages × 1 million characters. The first {millions(p.speechFreeChars)} a month are free,
            then {usd(p.speechPerMillion)} per million = {usd(speech)}. Two listeners in the same language share one voice.
          </li>
          <li>
            Cloud Run: 30 hours on one 1 vCPU / 512 MiB instance stays inside the free CPU and memory allowance
            {cloudRunFree(hours) ? ` (${usd(0)})` : ""}. Egress is audio to Soniox ({largeSonioxStreams} streams) and
            spoken captions to phones ({largeSpokenStreams} languages at 32 kbps): about {giBs(largeEgressGiB)} GiB at{" "}
            {usd(p.egressPerGiB)}/GiB = {usd(largeEgress)}.
          </li>
        </ul>
      </div>
      <p className="text-sm text-gray-600 dark:text-white/90">
        In US dollars. The examples assume 30 hours of speech is about 1 million characters. Soniox's translated hour
        is estimated from its token prices. Quiet audio isn't sent, so real egress is often lower.{" "}
        {live
          ? `Google Translate and Chirp prices were read from Google today by the demo server; Soniox and Cloud Run egress are from ${PRICES_AS_OF}.`
          : `Prices as of ${PRICES_AS_OF}, and they change.`}{" "}
        Current prices: <ExtLink href={PRICING.soniox}>Soniox</ExtLink>,{" "}
        <ExtLink href={PRICING.google}>Google Translate</ExtLink>, <ExtLink href={PRICING.chirp}>Chirp 3 HD</ExtLink>,{" "}
        <ExtLink href="https://cloud.google.com/run/pricing">Cloud Run</ExtLink>.
      </p>
      {!live && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="ghost"
            disabled={asking}
            onClick={() => {
              setAsking(true);
              void getPrices(`https://${DEMO_HOST}`).then((prices) => {
                setLive(prices);
                setAsking(false);
              });
            }}
          >
            {asking ? "Asking the demo server..." : "Use today's Google prices"}
          </Button>
          {live === null && <span className="text-sm text-gray-600 dark:text-white/90">The demo server hasn't read them yet.</span>}
        </div>
      )}
    </Card>
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
        <h3 className="font-semibold text-midnight dark:text-white">Sound desk link</h3>
        <p>This page is the sound desk link. Bookmark it as "Captions" and keep it private.</p>
        <p className="text-sm break-all text-gray-600 dark:text-white/90">{speak}</p>
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => copy("speak", speak)}>{copied === "speak" ? "Copied" : "Copy link"}</Button>
          <a href={mailto} className="bg-white border-2 border-purple/30 rounded-xl px-4 py-2.5 font-semibold hover:bg-veil dark:bg-white/10 dark:border-white/20 dark:hover:bg-white/15">
            Email to sound desk team
          </a>
        </div>

        <h3 className="font-semibold text-midnight dark:text-white pt-3">QR code for the audience</h3>
        <p>People scan this with their phone camera to follow along. It never changes, even after updates.</p>
        <canvas ref={canvas} className="rounded-lg border border-gray-200 dark:border-white/20" />
        <div className="flex flex-wrap gap-3">
          <Button onClick={downloadQr}>Download QR code (PNG)</Button>
          <Button variant="secondary" onClick={() => copy("listen", listen)}>
            {copied === "listen" ? "Copied" : "Copy audience link"}
          </Button>
        </div>
        <a className="inline-block underline text-blue-600 hover:text-blue-800 dark:text-blue-200 dark:hover:text-blue-100" href={listen} target="_blank" rel="noreferrer">
          Open the audience view
        </a>
        <h3 className="font-semibold text-midnight dark:text-white pt-3">Other venues</h3>
        <p>Share the homepage with someone setting up captions somewhere else. The project itself is on GitHub.</p>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => copy("home", siteRoot())}>
            {copied === "home" ? "Copied" : "Share with other venues"}
          </Button>
          <a
            href={REPO}
            target="_blank"
            rel="noreferrer"
            className="inline-block bg-white border-2 border-purple/30 rounded-xl px-4 py-2.5 font-semibold hover:bg-veil dark:bg-white/10 dark:border-white/20 dark:hover:bg-white/15"
          >
            See the project on GitHub
          </a>
        </div>
      </Details>

      <Spending status={status} backend={backend} token={token} />
      </div>
    </>
  );
}

function Notices({ status }: { status: Status | null | undefined }) {
  const [tipDismissed, setTipDismissed] = useState(() => localStorage.getItem(TIP_DISMISSED) === "1");
  const update: ProtocolNotice | null = !status
    ? null
    : strongestNotice(protocolNotice(status.protocol, status.protocolVersion), setupNotice(status.setupVersion));
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
          <p className="font-semibold text-midnight dark:text-white">Captions can be faster (optional)</p>
          <p>
            Your venue is closer to Soniox's {status.sonioxFasterRegion.toUpperCase()} region. At console.soniox.com,
            request access to that region, create a project in it, and make an API key there. Then{" "}
            <a className="underline text-blue-600 hover:text-blue-800 dark:text-blue-200 dark:hover:text-blue-100" href={NEWKEY_URL} target="_blank" rel="noreferrer">
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
      <a className="underline text-blue-600 hover:text-blue-800 dark:text-blue-200 dark:hover:text-blue-100" href={INSTALL_URL} target="_blank" rel="noreferrer">
        Run the install again
      </a>
      . Sign in with the Google account that set this venue up, or with another account that can manage that same Google Cloud project. Your links and QR code stay the same.
    </Banner>
  );
}

function ExtLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="underline text-blue-600 hover:text-blue-800 dark:text-blue-200 dark:hover:text-blue-100" href={href} target="_blank" rel="noreferrer">
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

/** "2026-11" as "November 2026". */
const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

function Spending({ status, backend, token }: { status: Status | null | undefined; backend: string; token: string }) {
  const project = status?.project;
  const account = status?.billingAccount;
  const [spend, setSpend] = useState<Spend | null | undefined>(undefined);
  const [asked, setAsked] = useState(false);
  // Asked when opened, not on every visit to this page.
  const load = () => {
    if (asked) return;
    setAsked(true);
    void getSpend(backend, token).then(setSpend);
  };
  const soniox = spend?.soniox;
  const google = spend?.google;
  return (
    <Details summary="Spending" onOpen={load}>
      <p>
        Captions are billed in two places. Soniox charges for turning speech into captions and translations. Google Cloud
        charges for hosting (CPU/memory usually free; egress for audio leaving the server) and for Google Translate and
        spoken captions on the languages that use them. Figures are in US dollars.
      </p>
      <div>
        <p className="font-semibold">Soniox</p>
        {spend === undefined && <p className="text-sm text-gray-600 dark:text-white/90">Asking Soniox what this venue has spent...</p>}
        {spend === null && (
          <p className="text-sm text-gray-600 dark:text-white/90">This server can't show spending yet. It will after its next update.</p>
        )}
        {spend?.sonioxError && <p className="text-sm text-gray-600 dark:text-white/90">{spend.sonioxError}</p>}
        {soniox && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt>{monthName(soniox.thisMonth)} so far</dt>
            <dd className="font-semibold">{usd(soniox.thisMonthUsd)}</dd>
            <dt>{monthName(soniox.lastMonth)}</dt>
            <dd className="font-semibold">{usd(soniox.lastMonthUsd)}</dd>
          </dl>
        )}
        <p className="text-sm text-gray-600 dark:text-white/90">
          Soniox's prices as of {PRICES_AS_OF}: about {usd(DATED_PRICES.sonioxHour)} an hour for the transcript and{" "}
          {usd(DATED_PRICES.sonioxTranslatedHour)} for each translated language, while someone is reading it.
        </p>
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
        <p className="text-sm text-gray-600 dark:text-white/90">
          Google doesn't let the server read what has been spent, so open the report below.
          {google?.translatePerMillion != null &&
            ` Google Translate today: the first 500,000 characters a month free, then ${usd(google.translatePerMillion)} per million.`}
          {google?.speechPerMillion != null &&
            ` Spoken captions today: the first ${millions(google.speechFreeChars ?? 0)} characters a month free, then ${usd(google.speechPerMillion)} per million.`}{" "}
          About 30 hours of speech is a million characters.
        </p>
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
      <h3 className="font-semibold text-midnight dark:text-white">Rotate the sound desk link</h3>
      <p>If the sound desk link was shared with someone who shouldn't have it, issue a new one. The old link stops working. The QR code stays the same. This page closes so the old link is not left open here.</p>
      <Button variant="secondary" onClick={startNewDeskLink}>
        Rotate sound desk link
      </Button>
      <h3 className="font-semibold text-midnight dark:text-white pt-3">Rotate the Soniox key</h3>
      <p>
        If the Soniox key got out, or Soniox has stopped accepting it, put a new one on the server. The sound desk link
        and QR code stay the same. When it finishes, <ExtLink href={SONIOX_KEYS}>delete the old key</ExtLink>.
      </p>
      <Button variant="secondary" onClick={() => window.open(NEWKEY_URL, "_blank", "noopener")}>
        Rotate Soniox key
      </Button>
      <h3 className="font-semibold text-midnight dark:text-white pt-3">Re-run setup for this venue or set up another venue</h3>
      <p>
        Opens the install in Google Cloud. The terminal lists your venues. Select this one to run the setup again. The
        sound desk link and QR code stay the same. The last line sets up another venue, which can run at the same time.
        The same billing account and Soniox account are fine. A new Soniox key is recommended for that venue.
      </p>
      <a
        href={INSTALL_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-block bg-white border-2 border-purple/30 rounded-xl px-4 py-2.5 font-semibold hover:bg-veil dark:bg-white/10 dark:border-white/20 dark:hover:bg-white/15"
      >
        Re-run setup for this venue or set up another venue
      </a>
      <h3 className="font-semibold text-midnight dark:text-white pt-3">Delete</h3>
      <p>
        Delete removes the captioning server and the Google Cloud project the install created
        {project ? ` (${project})` : ""}. Google keeps a deleted project for 30 days if you change your mind.
      </p>
      <a
        href={DELETE_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-block bg-red-700 hover:bg-red-800 text-white font-semibold px-4 py-2.5 rounded-xl border-2 border-transparent dark:border-white/40"
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