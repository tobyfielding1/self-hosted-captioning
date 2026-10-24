import { useEffect, useState } from "react";
import { currentView, shouldOpenShare, type View } from "./backend";
import ChurchView from "./views/ChurchView";
import ListenView from "./views/ListenView";

export default function App() {
  const [view, setView] = useState<View>(currentView);

  useEffect(() => {
    const onHash = () => setView(currentView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    document.title = view === "listen" ? "Live captions" : "Captions";
    if (view !== "listen") document.documentElement.classList.remove("dark");
  }, [view]);

  if (view === "listen") return <ListenView />;

  return (
    <div className="min-h-full bg-gray-100 text-gray-900 print:bg-white">
      <ChurchView shareOpen={shouldOpenShare()} />
    </div>
  );
}
