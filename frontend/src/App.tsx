import { useEffect, useState } from "react";
import { currentView, isSoundDesk, SETTINGS_CHANGED, type View } from "./backend";
import ListenView from "./views/ListenView";
import SetupView from "./views/SetupView";
import SpeakView from "./views/SpeakView";

export default function App() {
  const [view, setView] = useState<View>(currentView);
  const [soundDesk, setSoundDesk] = useState(isSoundDesk);

  useEffect(() => {
    const onHash = () => setView(currentView());
    const onSettings = () => setSoundDesk(isSoundDesk());
    window.addEventListener("hashchange", onHash);
    window.addEventListener(SETTINGS_CHANGED, onSettings);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener(SETTINGS_CHANGED, onSettings);
    };
  }, []);

  useEffect(() => {
    document.title = view === "listen" ? "Live captions" : view === "speak" ? "Captions: sound desk" : "Captions: setup";
    if (view !== "listen") document.documentElement.classList.remove("dark");
  }, [view]);

  if (view === "listen") return <ListenView />;

  return (
    <div className="min-h-full bg-gray-100 text-gray-900 print:bg-white">
      {soundDesk && (
        <nav className="bg-white border-b border-gray-200 print:hidden">
          <div className="max-w-2xl mx-auto px-4 flex gap-1">
            <Tab to="speak" view={view}>
              Sound desk
            </Tab>
            <Tab to="setup" view={view}>
              Setup
            </Tab>
          </div>
        </nav>
      )}
      {view === "speak" ? <SpeakView /> : <SetupView />}
    </div>
  );
}

function Tab({ to, view, children }: { to: View; view: View; children: React.ReactNode }) {
  const active = to === view;
  return (
    <a
      href={`#${to}`}
      className={`px-4 py-3 font-semibold border-b-4 ${active ? "border-blue-700 text-blue-900" : "border-transparent text-gray-600 hover:text-gray-900"}`}
      aria-current={active ? "page" : undefined}
    >
      {children}
    </a>
  );
}
