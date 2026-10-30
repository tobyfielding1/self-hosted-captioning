import { useEffect, useState } from "react";
import { getBackend, getToken, isAudience, shouldOpenShare } from "./backend";
import { applyDarkClass, readDarkPreference } from "./lib/dark";
import VenueView from "./views/VenueView";
import ListenView from "./views/ListenView";

export default function App() {
  const [href, setHref] = useState(() => location.href);

  useEffect(() => {
    const onNav = () => setHref(location.href);
    window.addEventListener("hashchange", onNav);
    window.addEventListener("popstate", onNav);
    return () => {
      window.removeEventListener("hashchange", onNav);
      window.removeEventListener("popstate", onNav);
    };
  }, []);

  useEffect(() => {
    const sync = () => applyDarkClass(readDarkPreference());
    sync();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", sync);
    window.addEventListener("storage", sync);
    return () => {
      mq.removeEventListener("change", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const listen = href.length > 0 && isAudience();

  useEffect(() => {
    const desk = !listen && !!getBackend() && !!getToken();
    document.title = listen ? "Live captions" : desk ? "Captions" : "Live captions";
  }, [listen, href]);

  if (listen) return <ListenView key={location.search} />;

  return (
    <div className="min-h-full bg-veil text-charcoal dark:bg-midnight dark:text-white">
      <VenueView key={`${location.pathname}${location.hash}`} shareOpen={shouldOpenShare()} />
    </div>
  );
}
