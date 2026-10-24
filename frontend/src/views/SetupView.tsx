import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { getBackend, getStatus, getToken, listenerLink, protocolSupported, setBackend, setToken, speakLink, type Status } from "../backend";
import { Banner, Button, Card, copyText, Details } from "../ui";

const REPO = "https://github.com/tobyfielding1/self-hosted-captioning";
const INSTALL_URL = `https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=${encodeURIComponent(REPO)}&cloudshell_tutorial=deploy.md&show=terminal`;
// Church images freeze their Node major version; below this they need a re-install.
const MIN_NODE_MAJOR = 24;
const TIP_DISMISSED = "captioning.fasterTipDismissed";

export default function SetupView() {
  const [backend, setB] = useState(getBackend());
  const [token, setT] = useState(getToken());
  const installed = !!backend && !!token;

  const save = (b: string, t: string) => {
    setBackend(b);
    setToken(t);
    setB(getBackend());
    setT(getToken());
  };

  return (
    <main className="max-w-2xl mx-auto p-4 space-y-4 print:p-0 print:max-w-none">
      {installed ? <Finished backend={backend!} token={token!} /> : <Wizard onSave={save} />}
      <div className="print:hidden">
        <Details summary="Advanced: connect to an existing server">
          <ManualEntry backend={backend ?? ""} token={token ?? ""} onSave={save} />
        </Details>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------- wizard

function Wizard({ onSave }: { onSave: (b: string, t: string) => void }) {
  const [step, setStep] = useState(1);
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState(false);

  const usePasted = () => {
    try {
      const hash = new URL(pasted.trim()).hash.replace(/^#/, "").split("&").slice(1).join("&");
      const params = new URLSearchParams(hash);
      const b = params.get("backend");
      const t = params.get("token");
      if (!b || !t) throw new Error();
      onSave(b, t);
    } catch {
      setPasteError(true);
    }
  };

  return (
    <>
      <h1 className="text-3xl font-bold">Set up live captions</h1>
      <p className="text-lg text-gray-700">Three steps, about 15 minutes, done once.</p>
      <ol className="flex gap-2" aria-label="Progress">
        {[1, 2, 3].map((n) => (
          <li key={n} className={`flex-1 h-2 rounded-full ${n <= step ? "bg-blue-700" : "bg-gray-200"}`} aria-current={n === step} />
        ))}
      </ol>

      {step === 1 && (
        <Card title="Step 1 of 3: Get a Soniox key">
          <p className="text-lg">Soniox turns speech into captions and translations.</p>
          <ol className="list-decimal pl-6 space-y-1 text-lg">
            <li>
              Sign up at{" "}
              <a className="underline text-blue-800" href="https://console.soniox.com" target="_blank" rel="noreferrer">
                console.soniox.com
              </a>
              .
            </li>
            <li>Add some credit.</li>
            <li>Click "API keys", then "Create API key", and copy it somewhere safe for step 3.</li>
          </ol>
          <p className="text-gray-600">
            See{" "}
            <a className="underline" href="https://soniox.com/pricing" target="_blank" rel="noreferrer">
              Soniox pricing
            </a>{" "}
            for what captions cost per hour.
          </p>
          <Button onClick={() => setStep(2)}>I have my key</Button>
        </Card>
      )}

      {step === 2 && (
        <Card title="Step 2 of 3: Make sure you have Google Cloud billing">
          <p className="text-lg">
            Sign in with the church Google account and add a card. You won't be charged for normal use: the captioning
            server fits in Google's free tier.
          </p>
          <a
            className="inline-block underline text-blue-800 text-lg"
            href="https://console.cloud.google.com/billing/create"
            target="_blank"
            rel="noreferrer"
          >
            Open Google Cloud billing
          </a>
          <p className="text-gray-600">Already have billing set up? Just carry on.</p>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button onClick={() => setStep(3)}>Billing is set up</Button>
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card title='Step 3 of 3: Click "Install on Google Cloud"'>
          <p className="text-lg">
            A Google page opens with a panel on the right. Follow its one step: click Run, then paste your Soniox key
            when asked. Everything else is automatic and takes about 5 minutes.
          </p>
          <a
            href={INSTALL_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-block bg-blue-700 hover:bg-blue-800 text-white text-2xl font-semibold px-8 py-5 rounded-2xl"
          >
            Install on Google Cloud
          </a>
          <p className="text-lg">
            When it says <strong>Done!</strong>, open the link it prints. It brings you back here with everything filled in.
          </p>
          <div className="pt-2 space-y-2">
            <label className="block font-semibold" htmlFor="finish-link">
              Or paste the link it printed:
            </label>
            <div className="flex gap-2">
              <input
                id="finish-link"
                value={pasted}
                onChange={(e) => {
                  setPasted(e.target.value);
                  setPasteError(false);
                }}
                className="flex-1 rounded-xl border-2 border-gray-300 px-3 py-2"
              />
              <Button onClick={usePasted} disabled={!pasted.trim()}>
                Continue
              </Button>
            </div>
            {pasteError && <p className="text-red-700">That doesn't look like the finish link. Copy the whole line after "Done!".</p>}
          </div>
          <Button variant="secondary" onClick={() => setStep(2)}>
            Back
          </Button>
        </Card>
      )}
    </>
  );
}

// -------------------------------------------------------------------------- finished

function Finished({ backend, token }: { backend: string; token: string }) {
  const [status, setStatus] = useState<Status | null | undefined>(undefined);
  const [copied, setCopied] = useState<string | null>(null);
  const [tipDismissed, setTipDismissed] = useState(() => localStorage.getItem(TIP_DISMISSED) === "1");
  const canvas = useRef<HTMLCanvasElement>(null);
  const listen = listenerLink(backend);
  const speak = speakLink(backend, token);

  useEffect(() => {
    void getStatus(backend).then(setStatus);
  }, [backend]);

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
    "Here's the link for running live captions from the sound desk.",
    "",
    "Open it once on the sound desk computer (it remembers everything after that) and bookmark it as \"Captions\":",
    speak,
    "",
    "Every service: open the bookmark, check the bar moves when someone speaks, press Start. Press Stop at the end.",
    "",
    "Please keep this link private.",
  ].join("\n");
  const mailto = `mailto:?subject=${encodeURIComponent("Captions: sound desk link")}&body=${encodeURIComponent(emailBody)}`;

  const nodeMajor = status ? Number(status.node.split(".")[0]) : null;
  const needsReinstall = status && (!protocolSupported(status) || (nodeMajor !== null && nodeMajor < MIN_NODE_MAJOR));

  return (
    <>
      <div className="print:hidden space-y-4">
        <h1 className="text-3xl font-bold">Live captions are set up</h1>

        {status === undefined && <Banner>Checking the captioning server...</Banner>}
        {status === null && (
          <Banner tone="warn">The captioning server isn't answering yet. If you've only just installed it, wait a minute and reload.</Banner>
        )}
        {status && status.error && <Banner tone="error">{status.error}</Banner>}
        {status && !status.error && <Banner tone="ok">The captioning server is ready.</Banner>}
        {needsReinstall && (
          <Banner tone="warn">
            The captioning server needs a one-time update. Click{" "}
            <a className="underline" href={INSTALL_URL} target="_blank" rel="noreferrer">
              Install on Google Cloud
            </a>{" "}
            again and click Run. Your links and QR code stay the same.
          </Banner>
        )}
        {status?.sonioxFasterRegion && !tipDismissed && (
          <Banner
            tone="info"
            onClose={() => {
              localStorage.setItem(TIP_DISMISSED, "1");
              setTipDismissed(true);
            }}
          >
            <p className="font-semibold">Captions can be faster (optional)</p>
            <p>
              Your church is closer to Soniox's {status.sonioxFasterRegion.toUpperCase()} region. At console.soniox.com,
              request access to that region, create a project in it, and make an API key there. Then click{" "}
              <a className="underline" href={INSTALL_URL} target="_blank" rel="noreferrer">
                Install on Google Cloud
              </a>{" "}
              and run <code>./deploy.sh --new-key</code>.
            </p>
          </Banner>
        )}

        <Card title="Sound desk link">
          <p>Open this once on the sound desk computer and bookmark it as "Captions". Keep it private.</p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => copy("speak", speak)}>{copied === "speak" ? "Copied" : "Copy link"}</Button>
            <a href={mailto} className="bg-white border-2 border-gray-300 rounded-xl px-4 py-2.5 font-semibold hover:bg-gray-50">
              Email to sound desk team
            </a>
            <a href={speak} className="bg-white border-2 border-gray-300 rounded-xl px-4 py-2.5 font-semibold hover:bg-gray-50">
              Use this device
            </a>
          </div>
        </Card>

        <Card title="QR code for the congregation">
          <p>People scan this with their phone camera to follow along. It never changes, even after updates.</p>
          <canvas ref={canvas} className="rounded-lg border border-gray-200" />
          <div className="flex flex-wrap gap-3">
            <Button onClick={downloadQr}>Download QR code (PNG)</Button>
            <Button variant="secondary" onClick={() => copy("listen", listen)}>
              {copied === "listen" ? "Copied" : "Copy listener link"}
            </Button>
          </div>
        </Card>

        <Card title="Sunday checklist">
          <p>A one-page card for the sound desk.</p>
          <Button variant="secondary" onClick={() => window.print()}>
            Print the card
          </Button>
        </Card>
      </div>

      <SundayCard />
    </>
  );
}

function SundayCard() {
  return (
    <div className="hidden print:block text-black">
      <h1 className="text-4xl font-bold mb-6">How to run captions</h1>
      <ol className="list-decimal pl-8 space-y-4 text-2xl">
        <li>Open the "Captions" bookmark.</li>
        <li>Check the bar moves when someone speaks ("We can hear you").</li>
        <li>
          Press the big <strong>Start</strong> button.
        </li>
      </ol>
      <p className="text-2xl mt-6">
        At the end of the service, press <strong>Stop</strong>.
      </p>
      <h2 className="text-2xl font-bold mt-10 mb-3">Good to know</h2>
      <ul className="list-disc pl-8 space-y-2 text-xl">
        <li>Keep the tab open during the service.</li>
        <li>"Pause captions" hides parts of the service you don't want captioned, such as notices.</li>
        <li>"Test captions" shows words on screen for a minute, to check it's working before the service.</li>
        <li>Problems? Press Help on the page. "Still stuck" has a button that copies details for your helper.</li>
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------- manual

function ManualEntry({ backend, token, onSave }: { backend: string; token: string; onSave: (b: string, t: string) => void }) {
  const [b, setB] = useState(backend);
  const [t, setT] = useState(token);
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(b, t);
        setSaved(true);
      }}
    >
      <label className="block">
        <span className="font-semibold">Server address</span>
        <input value={b} onChange={(e) => setB(e.target.value)} placeholder="https://captioning-....run.app" className="mt-1 w-full rounded-xl border-2 border-gray-300 px-3 py-2" />
      </label>
      <label className="block">
        <span className="font-semibold">Sound desk code</span>
        <input value={t} onChange={(e) => setT(e.target.value)} className="mt-1 w-full rounded-xl border-2 border-gray-300 px-3 py-2 font-mono" />
      </label>
      <p className="text-sm text-gray-600">
        Lost the sound desk code? Click Install on Google Cloud and Run again: it prints the same link. To make a new
        one (the old one stops working), run <code>./deploy.sh --rotate-token</code> instead.
      </p>
      <Button type="submit" variant="secondary" disabled={!b.trim() || !t.trim()}>
        {saved ? "Saved" : "Save"}
      </Button>
    </form>
  );
}
