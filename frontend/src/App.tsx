import { useEffect, useState } from "react";
import { getBackend, getToken, isAudience, shouldOpenShare } from "./backend";
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

  const listen = href.length > 0 && isAudience();

  useEffect(() => {
    const desk = !listen && !!getBackend() && !!getToken();
    document.title = listen ? "Live captions" : desk ? "Captions" : "Live captions";
    if (!listen) document.documentElement.classList.remove("dark");
  }, [listen, href]);

  if (listen) return <ListenView key={location.search} />;

  return (
    <div className="min-h-full bg-veil text-charcoal">
      <VenueView key={`${location.pathname}${location.hash}`} shareOpen={shouldOpenShare()} />
    </div>
  );
}
