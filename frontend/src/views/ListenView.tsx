import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getBackend, getLanguages, getStatus, ORIGINAL, protocolSupported, siteRoot, wsUrl, type Languages } from "../backend";
import { label, orderLanguages } from "../lib/languages";
import { HomeLink, RepoLink } from "../ui";
import { useWakeLock } from "../lib/wakeLock";

type Phase = "checking" | "waiting" | "live" | "reconnecting" | "ended" | "gave-up" | "outdated" | "unsupported";

const STORE = { lang: "captioning.lang", size: "captioning.size", dark: "captioning.dark", original: "captioning.withOriginal" };

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
/** How often a visible waiting page asks whether the sound desk is live. */
const POLL_MS = 2_000;
const GIVE_UP_MS = 2 * 60 * 60_000;
const MAX_LINES = 500;

interface CaptionState {
  lines: string[];
  current: string;
  partial: string;
}

interface PairLine {
  original: string;
  translation: string;
}

interface BilingualState {
  lines: PairLine[];
  original: string;
  translation: string;
  originalPartial: string;
  translationPartial: string;
}

const EMPTY_BILINGUAL: BilingualState = { lines: [], original: "", translation: "", originalPartial: "", translationPartial: "" };

const provisional = "text-gray-400 dark:text-gray-300";

function PairBlock({
  original = "",
  originalPartial = "",
  translation = "",
  translationPartial = "",
}: {
  original?: string;
  originalPartial?: string;
  translation?: string;
  translationPartial?: string;
}) {
  if (!original && !originalPartial && !translation && !translationPartial) return null;
  return (
    <div>
      {(original || originalPartial) && (
        <p className="italic">
          {original}
          {original && originalPartial && " "}
          {originalPartial && <span className={provisional}>{originalPartial}</span>}
        </p>
      )}
      {(translation || translationPartial) && (
        <p className="font-bold">
          {translation}
          {translation && translationPartial && " "}
          {translationPartial && <span className={provisional}>{translationPartial}</span>}
        </p>
      )}
    </div>
  );
}

function readBilingual(msg: { lines?: PairLine[]; original?: string; translation?: string; originalPartial?: string; translationPartial?: string; partial?: string }): BilingualState {
  return {
    lines: msg.lines ?? [],
    original: msg.original ?? "",
    translation: msg.translation ?? "",
    originalPartial: msg.originalPartial ?? msg.partial ?? "",
    translationPartial: msg.translationPartial ?? "",
  };
}

export default function ListenView() {
  const backend = getBackend();
  const [lang, setLang] = useState<string | null>(() => langFromUrl());
  const [choosing, setChoosing] = useState(() => !langFromUrl());
  const [languages, setLanguages] = useState<Languages | null>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [caption, setCaption] = useState<CaptionState>({ lines: [], current: "", partial: "" });
  const [withOriginal, setWithOriginal] = useState(() => localStorage.getItem(STORE.original) === "1");
  const [paired, setPaired] = useState(false);
  const [bilingual, setBilingual] = useState<BilingualState>(EMPTY_BILINGUAL);
  const [paused, setPaused] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [size, setSize] = useState(() => Number(localStorage.getItem(STORE.size) ?? 3));
  const [dark, setDark] = useState(() => localStorage.getItem(STORE.dark) === "1");
  const [follow, setFollow] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [venue, setVenue] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useWakeLock(phase === "live");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem(STORE.dark, dark ? "1" : "0");
  }, [dark]);

  useEffect(() => localStorage.setItem(STORE.size, String(size)), [size]);
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
      if (status && !protocolSupported(status)) return setPhase("outdated");
      if (status?.live) return connect();
      setPhase("waiting");
      poll();
    };

    const connect = () => {
      if (stopped || ws || document.visibilityState !== "visible") return;
      const params: Record<string, string> = { lang };
      if (withOriginal && lang !== ORIGINAL) params.original = "1";
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
            if (!msg.bilingual) setBilingual(EMPTY_BILINGUAL);
            break;
          case "history":
            if (msg.bilingual) {
              setPaired(true);
              setBilingual(readBilingual(msg));
            } else setCaption({ lines: msg.lines, current: msg.current, partial: msg.partial });
            break;
          case "pair":
            setBilingual((b) => {
              const line = { original: msg.original ?? "", translation: msg.translation ?? "" };
              if (msg.fill) {
                const idx = b.lines.findIndex((l) => l.original === line.original && !l.translation);
                if (idx >= 0) {
                  const lines = b.lines.slice();
                  lines[idx] = line;
                  return { ...b, lines };
                }
              }
              const lines = msg.revise && b.lines.length ? b.lines.slice(0, -1) : b.lines;
              return { ...b, lines: [...lines, line].slice(-MAX_LINES) };
            });
            setNotice(null);
            break;
          case "bilingual":
            setBilingual((b) => ({ ...b, ...readBilingual(msg), lines: b.lines }));
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
            break;
          case "error":
            setNotice(msg.message);
            break;
          case "ended":
            ended = true;
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
    setBilingual(EMPTY_BILINGUAL);
    setCaption({ lines: [], current: "", partial: "" });
    void check();

    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      ws?.close();
    };
  }, [backend, lang, choosing, attempt, withOriginal]);

  // Keep the newest line in view unless the reader has scrolled back.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [caption, bilingual, follow, size]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  const choose = (code: string) => {
    rememberLang(code);
    setCaption({ lines: [], current: "", partial: "" });
    setBilingual(EMPTY_BILINGUAL);
    setPaired(false);
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

  if (choosing) return <LanguageChooser languages={languages} current={lang ?? localStorage.getItem(STORE.lang)} venue={venue} onChoose={choose} dark={dark} />;

  const showPairs = paired && lang !== ORIGINAL;
  const empty = showPairs
    ? !bilingual.lines.length && !bilingual.original && !bilingual.translation && !bilingual.originalPartial && !bilingual.translationPartial
    : !caption.lines.length && !caption.current && !caption.partial;
  let message: string | null = null;
  if (phase === "checking") message = "Connecting...";
  else if (phase === "waiting") message = "Waiting for captions to start. This page will connect by itself.";
  else if (phase === "ended") message = "Captions have stopped.";
  else if (phase === "gave-up") message = "Captions haven't started yet.";
  else if (phase === "outdated") message = "Captions need an update. Please ask the venue to re-run the install.";
  else if (phase === "unsupported") message = "This language isn't available. Please choose another.";
  else if (paused) message = "Captions paused";
  else if (phase === "live" && empty) message = "Live. Captions will appear when someone speaks.";

  const backToLanguages = () => setChoosing(true);

  return (
    <Shell dark={dark}>
      <header className="border-b border-purple/30 dark:border-white/15">
        {venue && (
          <button
            type="button"
            onClick={backToLanguages}
            className="block w-full truncate px-5 pt-3 text-left text-lg font-semibold text-midnight hover:underline"
          >
            {venue}
          </button>
        )}
        <div className="flex items-center gap-2 px-3 py-2">
          <p className="min-w-0 flex-1 truncate px-2 text-lg font-semibold text-midnight">
            {label(lang!, languages?.targets.find((t) => t.code === lang)?.name)}
          </p>
          {phase === "reconnecting" && <span className="text-sm text-amber-700 dark:text-amber-400">Reconnecting...</span>}
          {lang !== ORIGINAL && (
            <button
              type="button"
              aria-pressed={withOriginal}
              title="Show the original above the translation"
              onClick={() => setWithOriginal((v) => !v)}
              className={`h-11 shrink-0 rounded-lg border px-3 text-base font-semibold ${
                withOriginal
                  ? "border-purple bg-purple text-white"
                  : "border-purple/30 hover:bg-veil dark:border-white/20 dark:hover:bg-white/10"
              }`}
            >
              Original
            </button>
          )}
          <button
            type="button"
            onClick={backToLanguages}
            className="h-11 shrink-0 rounded-lg border border-purple/30 px-3 text-lg font-semibold hover:bg-veil dark:border-white/20 dark:hover:bg-white/10"
          >
            Back
          </button>
          <IconButton label="Smaller text" onClick={() => setSize((s) => Math.max(0, s - 1))}>
            A-
          </IconButton>
          <IconButton label="Bigger text" onClick={() => setSize((s) => Math.min(SIZES.length - 1, s + 1))}>
            A+
          </IconButton>
          <IconButton label={dark ? "Light mode" : "Dark mode"} onClick={() => setDark((d) => !d)}>
            {dark ? "☀" : "☾"}
          </IconButton>
        </div>
      </header>

      <div ref={scroller} onScroll={onScroll} className="font-caption flex-1 overflow-y-auto px-5 py-4" style={{ fontSize: SIZES[size], lineHeight: 1.35 }}>
        {showPairs ? (
          <div aria-live="polite" aria-relevant="additions" className="space-y-4">
            {bilingual.lines.map((line, i) => (
              <PairBlock key={i} original={line.original} translation={line.translation} />
            ))}
            <PairBlock
              original={bilingual.original}
              originalPartial={bilingual.originalPartial}
              translation={bilingual.translation}
              translationPartial={bilingual.translationPartial}
            />
          </div>
        ) : (
          <>
            <div aria-live="polite" aria-relevant="additions" className="space-y-3">
              {caption.lines.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
            {(caption.current || caption.partial) && (
              <p className="mt-3">
                {caption.current}
                {caption.current && caption.partial && " "}
                <span className="text-gray-400 dark:text-gray-300">{caption.partial}</span>
              </p>
            )}
          </>
        )}
        {notice && <p className="mt-4 text-base text-amber-700 dark:text-amber-400">{notice}</p>}
        {message && <p className={`mt-6 ${empty ? "" : "text-base"} text-gray-500`}>{message}</p>}
        {(phase === "ended" || phase === "gave-up") && (
          <button onClick={() => setAttempt((a) => a + 1)} className="mt-4 text-base underline text-blue-600 hover:text-blue-800 dark:text-blue-300">
            Check again
          </button>
        )}
      </div>

      {!follow && (
        <button
          onClick={() => setFollow(true)}
          className="fixed bottom-16 left-1/2 -translate-x-1/2 rounded-full bg-purple text-white px-5 py-2 text-lg shadow-lg"
        >
          Jump to live
        </button>
      )}

      <footer className="px-4 py-2 text-xs text-gray-500 border-t border-purple/30 dark:border-white/15">
        Audio is not recorded or stored. Captions are machine-generated.
      </footer>
    </Shell>
  );
}

function Shell({ dark, children }: { dark: boolean; children: React.ReactNode }) {
  return <div className={`h-full flex flex-col ${dark ? "bg-midnight text-white" : "bg-white text-charcoal"}`}>{children}</div>;
}

function IconButton({ label: text, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={text}
      title={text}
      className="min-w-11 h-11 rounded-lg border border-purple/30 text-lg font-semibold hover:bg-veil dark:border-white/20 dark:hover:bg-white/10"
    >
      {children}
    </button>
  );
}

const VIA_HINT = {
  soniox: "Soniox: live, word by word, with faster and more natural translation. Also cheaper for your venue.",
  google: "Google Translate: a sentence at a time, just after it's spoken. Used for languages Soniox doesn't offer.",
};

function ViaTag({ via }: { via: "soniox" | "google" }) {
  return (
    <span
      title={VIA_HINT[via]}
      className="inline-block align-middle rounded-full border border-gray-300 dark:border-gray-700 px-2 py-0.5 text-xs font-medium text-gray-500 whitespace-nowrap"
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
}: {
  languages: Languages | null;
  current: string | null;
  venue: string | null;
  onChoose: (code: string) => void;
  dark: boolean;
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
            <p className="min-w-0 flex-1 truncate text-lg font-semibold text-gray-600 dark:text-gray-300">{venue}</p>
          ) : (
            <span className="flex-1" />
          )}
          <HomeLink />
          <RepoLink />
        </div>
        <h1 className="text-3xl font-bold text-midnight">Choose your language</h1>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search"
          aria-label="Search languages"
          className="w-full rounded-xl border-2 border-purple/30 dark:border-white/20 bg-transparent px-4 py-3 text-lg"
        />
        {showOriginal && (
          <button
            onClick={() => onChoose(ORIGINAL)}
            className={`w-full text-left px-4 py-4 rounded-xl border-2 bg-leaf/40 hover:bg-leaf/55 dark:bg-purple/30 dark:hover:bg-purple/40 ${
              current === ORIGINAL ? "border-purple" : "border-purple/30"
            }`}
          >
            <span className="block text-xl">Original</span>
            <span className="block text-base text-gray-600 dark:text-gray-300">Transcript of the words as spoken</span>
          </button>
        )}
        {!languages && <p className="text-gray-500">Loading languages...</p>}
        {languages && !q && (
          <p className="text-sm text-gray-500">
            <ViaTag via="soniox" /> appears word by word, with faster, more natural translation, and costs your venue
            less. <ViaTag via="google" /> appears a sentence at a time. If your language has both, choose Soniox.
          </p>
        )}
        {shown.length > 0 && <p className="text-sm font-semibold text-gray-500">Languages</p>}
        <ul className="flex-1 overflow-y-auto space-y-2">
          {shown.map((code) => (
            <li key={code}>
              <button
                onClick={() => onChoose(code)}
                className={`w-full flex items-center gap-3 text-left text-xl px-4 py-4 rounded-xl border-2 ${
                  code === current ? "border-purple" : "border-purple/30 dark:border-white/15"
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
