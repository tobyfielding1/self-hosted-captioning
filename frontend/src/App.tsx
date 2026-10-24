import { useEffect, useState } from "react";
import { getBackend, getToken, isCongregation, isSetupPage, shouldOpenShare } from "./backend";
import ChurchView from "./views/ChurchView";
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

  const listen = href.length > 0 && isCongregation();

  useEffect(() => {
    const desk = !listen && !!getBackend() && !!getToken();
    document.title = listen ? "Live captions" : desk ? "Captions" : isSetupPage() ? "Set up live captions" : "Live captions";
    if (!listen) document.documentElement.classList.remove("dark");
  }, [listen, href]);

  if (listen) return <ListenView key={location.search} />;

  return (
    <div className="min-h-full bg-gray-100 text-gray-900 print:bg-white">
      <ChurchView key={`${location.pathname}${location.hash}`} shareOpen={shouldOpenShare()} />
    </div>
  );
}
