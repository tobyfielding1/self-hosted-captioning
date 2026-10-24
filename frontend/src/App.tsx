import { useEffect, useState } from "react";
import { isCongregation, shouldOpenShare } from "./backend";
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
    document.title = listen ? "Live captions" : "Captions";
    if (!listen) document.documentElement.classList.remove("dark");
  }, [listen]);

  if (listen) return <ListenView key={location.search} />;

  return (
    <div className="min-h-full bg-gray-100 text-gray-900 print:bg-white">
      <ChurchView key={location.hash} shareOpen={shouldOpenShare()} />
    </div>
  );
}
