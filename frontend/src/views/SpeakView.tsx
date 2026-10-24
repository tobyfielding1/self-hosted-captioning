import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { audioSupported, guessMode, listInputs, startCapture, type Capture, type InputMode } from "../audio/capture";
import { calibrate, DEFAULT_THRESHOLD, FRAME_MS, Gate, MAX_THRESHOLD, MIN_THRESHOLD } from "../audio/gate";
import { getBackend, getStatus, getToken, listenerLink, protocolSupported, type Status } from "../backend";
import { englishName } from "../lib/languages";
import { useWakeLock, wakeLockSupported } from "../lib/wakeLock";
import { SpeakerConnection, type ConnState, type Preview, type ServerMessage, type Stats } from "../speaker";
import { Banner, Button, copyText, Details } from "../ui";

const LEVEL_HISTORY = 10_000 / FRAME_MS;
const CALIBRATE_FRAMES = 3_000 / FRAME_MS;
const STORE = {
  input: "captioning.input",
  mode: (id: string) => `captioning.mode.${id || "default"}`,
  threshold: "captioning.threshold",
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

export default function SpeakView({
  extras,
  settings,
}: { extras?: (panels: ReactNode) => ReactNode; settings?: ReactNode } = {}) {
  const backend = getBackend();
  const token = getToken();
  const supported = audioSupported();

  const [status, setStatus] = useState<Status | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem(STORE.input) ?? "");
  const [mode, setMode] = useState<InputMode | null>(null);
  const [mic, setMic] = useState<MicState>("idle");
  const [level, setLevel] = useState(0);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [manualThreshold, setManualThreshold] = useState<number | null>(() => {
    const v = localStorage.getItem(STORE.threshold);
    return v ? Number(v) : null;
  });
  const [conn, setConn] = useState<ConnState>("off");
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [errors, setErrors] = useState<{ at: string; message: string }[]>([]);
  const [shownError, setShownError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hello, setHello] = useState<Record<string, unknown> | null>(null);
  const [copied, setCopied] = useState(false);

  const captureRef = useRef<Capture | null>(null);
  const gateRef = useRef(new Gate());
  const levelsRef = useRef<number[]>([]);
  const levelRef = useRef(0);
  const lastHeardRef = useRef(0);
  const calibrateAtRef = useRef<number | null>(null);
  const connRef = useRef<SpeakerConnection | null>(null);
  const pausedRef = useRef(false);

  const live = conn !== "off";
  const wakeLock = useWakeLock(live);

  // Wake the server as soon as the page opens so Start is instant.
  useEffect(() => {
    void getStatus().then(setStatus);
  }, []);

  if (!connRef.current) {
    connRef.current = new SpeakerConnection(
      setConn,
      (msg: ServerMessage) => {
        if (msg.type === "hello") setHello(msg);
        else if (msg.type === "stats") {
          setStats(msg);
          setPaused(msg.paused);
        } else if (msg.type === "preview") setPreview(msg);
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
    const levels = levelsRef.current;
    levels.push(rms);
    if (levels.length > LEVEL_HISTORY) levels.shift();
    const gate = gateRef.current;
    if (calibrateAtRef.current !== null && levels.length >= calibrateAtRef.current) {
      calibrateAtRef.current = null;
      gate.threshold = calibrate(levels.slice(-CALIBRATE_FRAMES));
      setThreshold(gate.threshold);
    }
    if (rms >= gate.threshold) lastHeardRef.current = performance.now();
    const connection = connRef.current!;
    if (connection.state !== "live" || pausedRef.current) return;
    for (const frame of gate.push(pcm, rms)) connection.sendAudio(frame);
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
    if (manualThreshold !== null) gate.threshold = manualThreshold;
    else if (levelsRef.current.length >= CALIBRATE_FRAMES) gate.threshold = calibrate(levelsRef.current.slice(-CALIBRATE_FRAMES));
    else calibrateAtRef.current = levelsRef.current.length + CALIBRATE_FRAMES;
    setThreshold(gate.threshold);
    connRef.current!.start(test);
  };

  const stop = () => {
    connRef.current!.stop();
    setPaused(false);
    pausedRef.current = false;
    setStats(null);
    setPreview(null);
  };

  const togglePause = () => {
    const next = !paused;
    setPaused(next);
    pausedRef.current = next;
    connRef.current!.setPaused(next);
  };

  const setManual = (v: number | null) => {
    setManualThreshold(v);
    if (v === null) localStorage.removeItem(STORE.threshold);
    else {
      localStorage.setItem(STORE.threshold, String(v));
      gateRef.current.threshold = v;
      setThreshold(v);
    }
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
      audio: { input: c?.label, sampleRate: c?.sampleRate, mode, threshold, mic },
      browser: navigator.userAgent,
      wakeLock: wakeLockSupported(),
    };
    setCopied(await copyText(JSON.stringify(report, null, 2)));
    setTimeout(() => setCopied(false), 3000);
  };

  // ------------------------------------------------------------------ render

  if (!supported)
    return (
      <Page>
        <Banner tone="error">
          This browser can't capture audio. Please update it or use Chrome, Edge, Firefox or Safari.
        </Banner>
      </Page>
    );

  if (!backend || !token)
    return (
      <Page>
        <Banner tone="warn">
          <p className="font-semibold">This device isn't set up for the sound desk yet.</p>
          <p>Open the sound desk link in this tab.</p>
        </Banner>
      </Page>
    );

  const heard = performance.now() - lastHeardRef.current < 600;
  const meterPct = Math.min(100, Math.sqrt(level / MAX_THRESHOLD) * 100);
  const thresholdPct = Math.min(100, Math.sqrt(threshold / MAX_THRESHOLD) * 100);
  const listenersText = stats ? describeListeners(stats.listeners) : "";

  let headline = "Not live";
  if (conn === "connecting") headline = "Connecting...";
  else if (conn === "reconnecting") headline = "Reconnecting...";
  else if (conn === "live") headline = paused ? "Paused" : `Live: ${listenersText || "connecting"}`;

  const desk = (
    <Page>
      {status && !protocolSupported(status) && (
        <Banner tone="warn">This server is out of date. Ask your admin to re-run the install.</Banner>
      )}
      {notice && <Banner tone="warn">{notice}</Banner>}
      {shownError && (
        <Banner tone="error" onClose={() => setShownError(null)}>
          {shownError}
        </Banner>
      )}

      {/* Step 1: microphone */}
      <section className="bg-white rounded-2xl border border-gray-200 p-5 space-y-4">
        {mic === "idle" && (
          <div className="space-y-3">
            <p className="text-lg">First, let this page hear the sound desk.</p>
            <Button big onClick={() => openMic(deviceId)}>
              Turn on the microphone
            </Button>
            <p className="text-gray-600">Your browser will ask for permission. Click Allow.</p>
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
                  className="mt-1 block w-full rounded-xl border-2 border-gray-300 px-3 py-2.5 text-lg bg-white"
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
                <div className="absolute top-0 bottom-0 w-0.5 bg-gray-800" style={{ left: `${thresholdPct}%` }} />
              </div>
              <p className="mt-2 text-lg font-semibold" aria-live="polite">
                {heard ? "We can hear you" : "Quiet: speak and check the bar moves"}
              </p>
            </div>
          </>
        )}
      </section>

      {/* Step 2: go live */}
      <section className="bg-white rounded-2xl border border-gray-200 p-5 space-y-4">
        <p className="text-3xl font-bold" aria-live="polite">
          {headline}
        </p>
        {live && conn === "live" && !paused && stats?.testing && <p className="text-blue-800">Test captions running for a minute.</p>}

        <div className="flex flex-wrap gap-3">
          {!live ? (
            <>
              <Button big disabled={mic !== "on"} onClick={() => start()}>
                Start
              </Button>
              <Button big variant="secondary" disabled={mic !== "on"} onClick={() => start(true)}>
                Test captions
              </Button>
            </>
          ) : (
            <>
              <Button big variant="danger" onClick={stop}>
                Stop
              </Button>
              <Button big variant="secondary" onClick={togglePause}>
                {paused ? "Resume captions" : "Pause captions"}
              </Button>
              <Button variant="secondary" onClick={() => start(true)}>
                Test captions
              </Button>
            </>
          )}
        </div>

        {live && (
          <p className="text-gray-700">
            Keep this tab open.{" "}
            {wakeLockSupported() ? (wakeLock ? "The screen will stay on." : "") : "Turn off sleep on this device."}{" "}
            <a className="underline text-blue-800" href={listenerLink()} target="_blank" rel="noreferrer">
              Open the congregation view
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
    </Page>
  );

  const panels = (
    <>
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
        <div>
          <label className="flex items-center gap-2 font-semibold">
            <input type="checkbox" checked={manualThreshold === null} onChange={(e) => setManual(e.target.checked ? null : threshold)} />
            Set the silence level automatically
          </label>
          {manualThreshold !== null && (
            <input
              type="range"
              className="w-full"
              min={Math.log(MIN_THRESHOLD)}
              max={Math.log(MAX_THRESHOLD)}
              step={0.01}
              value={Math.log(manualThreshold)}
              onChange={(e) => setManual(Math.exp(Number(e.target.value)))}
              aria-label="Silence level"
            />
          )}
          <p className="text-sm text-gray-600">Sound below the line on the meter isn't sent.</p>
        </div>
        <p className="text-sm text-gray-600 break-all">
          Server: {backend}
          {status && ` (version ${status.version})`}
        </p>
        {settings}
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
              <a className="underline text-blue-800" href="https://console.soniox.com/org/billing/reports" target="_blank" rel="noreferrer">
                Billing
              </a>
              . Turn on "Enable autopay" under{" "}
              <a className="underline text-blue-800" href="https://console.soniox.com/org/billing/payment-setup" target="_blank" rel="noreferrer">
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
    </>
  );

  return (
    <div className="space-y-4">
      {desk}
      {extras ? extras(panels) : <div className="space-y-4 print:hidden">{panels}</div>}
    </div>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <div className="space-y-4 print:hidden">{children}</div>;
}
