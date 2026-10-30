import { useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { getBackend, getLanguages, getStatus, ORIGINAL, protocolNotice, setupNotice, siteRoot, wsUrl, type Languages } from "../backend";
import { applyDarkClass, readDarkPreference, writeDarkPreference } from "../lib/dark";
import { label, orderLanguages } from "../lib/languages";
import { iconBtn, InfoLink, RepoLink, ThemeButton } from "../ui";
import { useWakeLock } from "../lib/wakeLock";

type Phase = "checking" | "waiting" | "live" | "reconnecting" | "ended" | "gave-up" | "outdated" | "unsupported";

const STORE = {
  lang: "captioning.lang",
  size: "captioning.size",
  original: "captioning.withOriginal",
};

/** An audience link names its language only with `?backend=…&lang=fr`. Without `lang`, the picker is shown. */
function langFromUrl(): string | null {
  return new URLSearchParams(location.search).get("lang");
}

function rememberLang(code: string) {
  localStorage.setItem(STORE.lang, code);
  const url = new URL(location.href);
  if (!url.searchParams.get("backend")) return;
  url.searchParams.set("lang", code);
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}
const SIZES = [20, 24, 28, 34, 40, 48, 56];
/** A silent clip, played on the tap so iPhones allow sound later. */
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
/** How often a visible waiting page asks whether the sound desk is live. */
const POLL_MS = 2_000;
const GIVE_UP_MS = 2 * 60 * 60_000;
const MAX_LINES = 500;

interface CaptionState {
  lines: string[];
  current: string;
  partial: string;
}

const EMPTY_CAPTION: CaptionState = { lines: [], current: "", partial: "" };

function readCaption(msg: { lines?: string[]; current?: string; partial?: string }): CaptionState {
  return { lines: msg.lines ?? [], current: msg.current ?? "", partial: msg.partial ?? "" };
}

export default function ListenView() {
  const backend = getBackend();
  const [lang, setLang] = useState<string | null>(() => langFromUrl());
  const [choosing, setChoosing] = useState(() => !langFromUrl());
  const [languages, setLanguages] = useState<Languages | null>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [caption, setCaption] = useState<CaptionState>(EMPTY_CAPTION);
  const [withOriginal, setWithOriginal] = useState(() => localStorage.getItem(STORE.original) === "1");
  const [paired, setPaired] = useState(false);
  const [original, setOriginal] = useState<CaptionState>(EMPTY_CAPTION);
  const [paused, setPaused] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [size, setSize] = useState(() => Number(localStorage.getItem(STORE.size) ?? 3));
  const [dark, setDark] = useState(readDarkPreference);
  const [venueSpoken, setVenueSpoken] = useState(false);
  // Each visit starts silent. A saved toggle would speak before the listener taps.
  const [audio, setAudio] = useState(false);
  const sound = useRef<{ el: HTMLAudioElement; clips: string[]; playing: boolean } | null>(null);
  const [follow, setFollow] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [venue, setVenue] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const originalScroller = useRef<HTMLDivElement>(null);

  useWakeLock(phase === "live");

  useEffect(() => {
    applyDarkClass(dark);
  }, [dark]);

  const setDarkMode = (next: boolean) => {
    writeDarkPreference(next);
    setDark(next);
  };

  useEffect(() => localStorage.setItem(STORE.size, String(size)), [size]);
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setAudio(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);
  useEffect(() => localStorage.setItem(STORE.original, withOriginal ? "1" : "0"), [withOriginal]);

  useEffect(() => {
    if (venue) document.title = venue;
  }, [venue]);

  // The language list comes from the server, retrying while it wakes up.
  useEffect(() => {
    if (!backend) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const [l, s] = await Promise.all([getLanguages(), getStatus()]);
      if (cancelled) return;
      if (s?.venue) setVenue(s.venue);
      if (l && l.targets.length) setLanguages(l);
      else timer = setTimeout(load, 5000);
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [backend]);

  const hear = audio && !!lang && lang !== ORIGINAL && !!languages?.targets.some((t) => t.code === lang && t.audio);

  // Connection loop: while this tab is visible, check often and connect once the desk is live.
  useEffect(() => {
    if (!backend || !lang || choosing) return;
    let stopped = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry = 0;
    let waitingSince = Date.now();
    let ended = false;

    const later = (fn: () => void, ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };

    const poll = () => {
      if (stopped) return;
      if (Date.now() - waitingSince > GIVE_UP_MS) {
        setPhase("gave-up");
        return;
      }
      if (document.visibilityState === "visible") later(check, POLL_MS);
    };

    const check = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const status = await getStatus();
      if (stopped || document.visibilityState !== "visible") return;
      if (status?.venue) setVenue(status.venue);
      setVenueSpoken(!!status?.spoken);
      if (
        status &&
        (protocolNotice(status.protocol, status.protocolVersion) === "major" || setupNotice(status.setupVersion) === "major")
      )
        return setPhase("outdated");
      if (status?.live) return connect();
      setPhase("waiting");
      poll();
    };

    const stopSound = () => {
      const deck = sound.current;
      if (!deck) return;
      deck.clips = [];
      deck.playing = false;
      deck.el.pause();
    };

    const play = (b64: string) => {
      const deck = sound.current ?? { el: new Audio(), clips: [], playing: false };
      sound.current = deck;
      deck.clips.push(b64);
      const drain = () => {
        if (deck.playing) return;
        const next = deck.clips.shift();
        if (!next) return;
        deck.playing = true;
        const bytes = Uint8Array.from(atob(next), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
        deck.el.onended = () => {
          URL.revokeObjectURL(url);
          deck.playing = false;
          drain();
        };
        deck.el.onerror = () => {
          URL.revokeObjectURL(url);
          deck.playing = false;
          drain();
        };
        deck.el.src = url;
        void deck.el.play().catch(() => {
          deck.playing = false;
        });
      };
      drain();
    };

    const connect = () => {
      if (stopped || ws || document.visibilityState !== "visible") return;
      const params: Record<string, string> = { lang };
      if (withOriginal && lang !== ORIGINAL) params.original = "1";
      if (hear) params.audio = "1";
      const socket = new WebSocket(wsUrl("/ws/listen", params));
      ws = socket;
      socket.onopen = () => {
        retry = 0;
        ended = false;
        setPhase("live");
        setNotice(null);
      };
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data as string);
        switch (msg.type) {
          case "hello":
            setPaused(msg.paused);
            setPaired(!!msg.bilingual);
            if (!msg.bilingual) setOriginal(EMPTY_CAPTION);
            break;
          case "history":
            setCaption(readCaption(msg));
            if (msg.original) {
              setPaired(true);
              setOriginal(readCaption(msg.original));
            }
            break;
          case "original":
            setOriginal(readCaption(msg));
            setNotice(null);
            break;
          case "line":
            setCaption((c) => ({ ...c, lines: [...c.lines, msg.text].slice(-MAX_LINES), current: "" }));
            setNotice(null);
            break;
          case "caption":
            setCaption((c) => ({ ...c, current: msg.current, partial: msg.partial }));
            setNotice(null);
            break;
          case "paused":
            setPaused(msg.paused);
            if (msg.paused) stopSound();
            break;
          case "error":
            setNotice(msg.message);
            break;
          case "ended":
            ended = true;
            stopSound();
            break;
          case "audio":
            if (typeof msg.audio === "string") play(msg.audio);
            break;
        }
      };
      socket.onclose = (e) => {
        if (ws === socket) ws = null;
        if (stopped) return;
        if (ended) {
          setPhase("ended");
          setPaused(false);
          return;
        }
        if (e.code === 4400) return setPhase("unsupported");
        if (e.code === 4404) {
          waitingSince = Date.now();
          setPhase("waiting");
          return poll();
        }
        setPhase("reconnecting");
        later(check, Math.min(1000 * 2 ** retry++, 15_000));
      };
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible" || ws || ended) return;
      void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    setPhase("checking");
    setPaired(false);
    setOriginal(EMPTY_CAPTION);
    setCaption(EMPTY_CAPTION);
    void check();

    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      stopSound();
      ws?.close();
    };
  }, [backend, lang, choosing, attempt, withOriginal, hear]);

  // Keep the newest line in view unless the reader has scrolled back.
  useLayoutEffect(() => {
    for (const el of [originalScroller.current, scroller.current]) {
      if (el && follow) el.scrollTop = el.scrollHeight;
    }
  }, [caption, original, follow, size]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  const choose = (code: string) => {
    rememberLang(code);
    setCaption(EMPTY_CAPTION);
    setOriginal(EMPTY_CAPTION);
    setPaired(false);
    setAudio(false);
    setLang(code);
    setChoosing(false);
  };

  if (!backend)
    return (
      <Shell dark={dark}>
        <div className="max-w-xl mx-auto p-6 space-y-6">
          <h1 className="text-3xl font-bold">Live captions</h1>
          <p className="text-2xl">To follow live captions, scan the QR code at your venue with your phone camera.</p>
          <a href={siteRoot()} className="inline-block text-base text-gray-500 underline">
            Setting up captions for your venue?
          </a>
        </div>
      </Shell>
    );

  if (choosing)
    return (
      <LanguageChooser
        languages={languages}
        current={lang ?? localStorage.getItem(STORE.lang)}
        venue={venue}
        onChoose={choose}
        dark={dark}
        onDark={() => setDarkMode(!dark)}
      />
    );

  const showBoth = paired && lang !== ORIGINAL;
  const blank = (c: CaptionState) => !c.lines.length && !c.current && !c.partial;
  const empty = showBoth ? blank(caption) && blank(original) : blank(caption);
  let message: string | null = null;
  if (phase === "checking") message = "Connecting...";
  else if (phase === "waiting") message = "Waiting for captions to start. This page will connect by itself.";
  else if (phase === "ended") message = "Captions have stopped.";
  else if (phase === "gave-up") message = "Captions haven't started yet.";
  else if (phase === "outdated")
    message = "These captions need an update before they can run. Please ask the venue to run the install again, from the Google account that set the venue up.";
  else if (phase === "unsupported") message = "This language isn't available. Please choose another.";
  else if (paused) message = "Captions paused";
  else if (phase === "live" && empty) message = "Live. Captions will appear when someone speaks.";

  const backToLanguages = () => setChoosing(true);
  const canHear = venueSpoken && lang !== ORIGINAL && !!languages?.targets.some((t) => t.code === lang && t.audio);

  return (
    <Shell dark={dark}>
      <header className="border-b border-purple/30 dark:border-white/15">
        <div className="flex items-center gap-2 px-3 pt-2">
          <button
            type="button"
            onClick={backToLanguages}
            aria-label="Languages"
            title="Languages"
            className={iconBtn}
          >
            <BackGlyph />
          </button>
          <button
            type="button"
            onClick={backToLanguages}
            className="min-w-0 flex-1 truncate text-left text-lg font-semibold text-midnight hover:underline dark:text-white"
          >
            {venue ?? "Live captions"}
          </button>
          <IconButton label="Smaller text" onClick={() => setSize((s) => Math.max(0, s - 1))}>
            A-
          </IconButton>
          <IconButton label="Bigger text" onClick={() => setSize((s) => Math.min(SIZES.length - 1, s + 1))}>
            A+
          </IconButton>
          <IconButton label={dark ? "Light mode" : "Dark mode"} onClick={() => setDarkMode(!dark)}>
            {dark ? "☀" : "☾"}
          </IconButton>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <p className="min-w-0 flex-1 truncate px-2 text-lg font-semibold text-midnight dark:text-white">
            {label(lang!, languages?.targets.find((t) => t.code === lang)?.name)}
          </p>
          {phase === "reconnecting" && <span className="text-sm text-amber-700 dark:text-amber-400">Reconnecting...</span>}
          {canHear && (
            <button
              type="button"
              aria-pressed={audio}
              aria-label={audio ? "Turn sound off" : "Turn sound on"}
              title={audio ? "Sound on" : "Sound off"}
              onClick={() => {
                const next = !audio;
                setAudio(next);
                if (!next) return;
                const el = sound.current?.el ?? new Audio();
                sound.current = sound.current ?? { el, clips: [], playing: false };
                el.src = SILENT_WAV;
                void el.play().catch(() => {});
              }}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border ${
                audio
                  ? "border-purple bg-purple text-white"
                  : "border-purple/30 hover:bg-veil dark:border-white/20 dark:hover:bg-white/10"
              }`}
            >
              <SpeakerIcon on={audio} />
            </button>
          )}
          {lang !== ORIGINAL && (
            <button
              type="button"
              aria-pressed={withOriginal}
              title="Show the original as well"
              onClick={() => setWithOriginal((v) => !v)}
              className={`h-11 w-[calc(5.5rem+0.5rem)] shrink-0 rounded-lg border text-base font-semibold ${
                withOriginal
                  ? "border-purple bg-purple text-white"
                  : "border-purple/30 hover:bg-veil dark:border-white/20 dark:hover:bg-white/10"
              }`}
            >
              Original
            </button>
          )}
        </div>
      </header>

      {showBoth ? (
        <div className="font-caption flex min-h-0 flex-1 flex-col" style={{ fontSize: SIZES[size], lineHeight: 1.35 }}>
          <div ref={originalScroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto border-b border-purple/30 px-5 py-4 dark:border-white/15">
            <Transcript caption={original} />
          </div>
          <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <Transcript caption={caption} />
            <StatusNote notice={notice} message={message} empty={empty} phase={phase} onRetry={() => setAttempt((a) => a + 1)} />
          </div>
        </div>
      ) : (
        <div ref={scroller} onScroll={onScroll} className="font-caption flex-1 overflow-y-auto px-5 py-4" style={{ fontSize: SIZES[size], lineHeight: 1.35 }}>
          <Transcript caption={caption} />
          <StatusNote notice={notice} message={message} empty={empty} phase={phase} onRetry={() => setAttempt((a) => a + 1)} />
        </div>
      )}

      {!follow && (
        <button
          onClick={() => setFollow(true)}
          className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-purple text-white px-5 py-2 text-lg shadow-lg"
        >
          Jump to live
        </button>
      )}
    </Shell>
  );
}

function Transcript({ caption }: { caption: CaptionState }) {
  if (!caption.lines.length && !caption.current && !caption.partial) return null;
  return (
    <div aria-live="polite" aria-relevant="additions">
      {caption.lines.map((line, i) => (
        <p key={i} className="mt-3">
          {line}
        </p>
      ))}
      {(caption.current || caption.partial) && (
        <p className="mt-3">
          {caption.current}
          {caption.current && caption.partial && !caption.current.endsWith(" ") && " "}
          {caption.partial && <span className="text-gray-400 dark:text-gray-300">{caption.partial}</span>}
        </p>
      )}
    </div>
  );
}

function StatusNote({
  notice,
  message,
  empty,
  phase,
  onRetry,
}: {
  notice: string | null;
  message: string | null;
  empty: boolean;
  phase: Phase;
  onRetry: () => void;
}) {
  return (
    <>
      {notice && <p className="mt-4 text-base text-amber-700 dark:text-amber-400">{notice}</p>}
      {message && (
        <p className={`mt-6 ${empty ? "" : "text-base"} ${phase === "outdated" ? "text-red-700 dark:text-red-300" : "text-gray-500"}`}>{message}</p>
      )}
      {(phase === "ended" || phase === "gave-up") && (
        <button onClick={onRetry} className="mt-4 text-base underline text-blue-600 hover:text-blue-800 dark:text-blue-300">
          Check again
        </button>
      )}
    </>
  );
}

function Shell({ dark, children }: { dark: boolean; children: React.ReactNode }) {
  return <div className={`h-full flex flex-col ${dark ? "bg-midnight text-white" : "bg-white text-charcoal"}`}>{children}</div>;
}

function BackGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-6 w-6" fill="currentColor" aria-hidden="true">
      <path d="M10.8 2.2 4.5 8l6.3 5.8-.9 1L2.5 8l7.4-6.8z" />
    </svg>
  );
}

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
      <path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4z" />
      {on && <path fill="currentColor" d="M16.2 7.1a5 5 0 0 1 0 9.8v-1.8a3 3 0 0 0 0-6.2z" />}
    </svg>
  );
}

function IconButton({ label: text, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={text}
      title={text}
      className="min-w-11 h-11 rounded-lg border border-purple/30 text-lg font-semibold hover:bg-veil dark:border-white/40 dark:hover:bg-white/10"
    >
      {children}
    </button>
  );
}

const VIA_HINT = {
  soniox: "Soniox: live, word by word, with faster and more natural translation. Also cheaper for your venue.",
  google: "Google Translate: after each pause, for languages Soniox doesn't offer.",
};

function ViaTag({ via }: { via: "soniox" | "google" }) {
  return (
    <span
      title={VIA_HINT[via]}
      className="inline-block align-middle rounded-full border border-gray-300 dark:border-white/40 px-2 py-0.5 text-xs font-medium text-gray-500 dark:text-white/80 whitespace-nowrap"
    >
      {via === "soniox" ? "Soniox" : "Google"}
    </span>
  );
}

function LanguageChooser({
  languages,
  current,
  venue,
  onChoose,
  dark,
  onDark,
}: {
  languages: Languages | null;
  current: string | null;
  venue: string | null;
  onChoose: (code: string) => void;
  dark: boolean;
  onDark: () => void;
}) {
  const [filter, setFilter] = useState("");
  const names = useMemo(
    () => new Map((languages?.targets ?? []).filter((t) => t.name).map((t) => [t.code, t.name!])),
    [languages],
  );
  const codes = useMemo(
    () => orderLanguages((languages?.targets ?? []).map((t) => t.code).filter((c) => c !== ORIGINAL), names),
    [languages, names],
  );
  const via = useMemo(() => new Map((languages?.targets ?? []).map((t) => [t.code, t.via])), [languages]);
  const q = filter.trim().toLocaleLowerCase();
  const matches = (code: string) => label(code, names.get(code)).toLocaleLowerCase().includes(q) || code.startsWith(q);
  const shown = q ? codes.filter(matches) : codes;
  const showOriginal = !q || "original transcript of the words as spoken".includes(q);

  return (
    <Shell dark={dark}>
      <div className="max-w-xl w-full mx-auto flex flex-col h-full p-4 gap-3">
        <div className="flex items-center gap-1">
          {venue ? (
            <p className="min-w-0 flex-1 truncate text-lg font-semibold text-gray-600 dark:text-white/80">{venue}</p>
          ) : (
            <span className="flex-1" />
          )}
          <InfoLink />
          <ThemeButton dark={dark} onClick={onDark} />
          <RepoLink />
        </div>
        <h1 className="text-3xl font-bold text-midnight dark:text-white">Choose your language</h1>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search"
          aria-label="Search languages"
          className="w-full rounded-xl border-2 border-purple/30 dark:border-white/40 bg-transparent px-4 py-3 text-lg placeholder:text-gray-400 dark:placeholder:text-white/50"
        />
        {showOriginal && (
          <button
            onClick={() => onChoose(ORIGINAL)}
            className={`w-full text-left px-4 py-4 rounded-xl border-2 bg-leaf/40 hover:bg-leaf/55 dark:bg-white/10 dark:hover:bg-white/15 ${
              current === ORIGINAL ? "border-purple dark:border-leaf" : "border-purple/30 dark:border-white/40"
            }`}
          >
            <span className="block text-xl">Original</span>
            <span className="block text-base text-gray-600 dark:text-white/70">Transcript of the words as spoken</span>
          </button>
        )}
        {!languages && <p className="text-gray-500 dark:text-white/70">Loading languages...</p>}
        {languages && !q && (
          <p className="text-sm text-gray-500 dark:text-white/70">
            <ViaTag via="soniox" /> appears word by word, with faster, more natural translation, and costs your venue
            less. <ViaTag via="google" /> appears after each pause. If your language has both, choose Soniox.
          </p>
        )}
        {shown.length > 0 && <p className="text-sm font-semibold text-gray-500 dark:text-white/80">Languages</p>}
        <ul className="flex-1 overflow-y-auto space-y-2">
          {shown.map((code) => (
            <li key={code}>
              <button
                onClick={() => onChoose(code)}
                className={`w-full flex items-center gap-3 text-left text-xl px-4 py-4 rounded-xl border-2 ${
                  code === current ? "border-purple dark:border-leaf" : "border-purple/30 dark:border-white/40"
                } hover:bg-veil dark:hover:bg-white/10`}
              >
                <span className="flex-1">{label(code, names.get(code))}</span>
                {via.has(code) && <ViaTag via={via.get(code)!} />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Shell>
  );
}
