import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { getBackend, getStatus, getToken, listenerLink, protocolSupported, setBackend, setToken, speakLink, type Status } from "../backend";
import { Banner, Button, Card, copyText, Details } from "../ui";
import SpeakView from "./SpeakView";

const SONIOX_USAGE = "https://console.soniox.com/org/projects/usage/cost";
const SONIOX_BILLING = "https://console.soniox.com/org/billing/reports";

const REPO = "https://github.com/tobyfielding1/self-hosted-captioning";
const INSTALL_URL = `https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=${encodeURIComponent(REPO)}&cloudshell_tutorial=deploy.md&show=terminal`;
// Church images freeze their Node major version; below this they need a re-install.
const MIN_NODE_MAJOR = 24;
const TIP_DISMISSED = "captioning.fasterTipDismissed";

/** The church team's page: the setup wizard until this device has a link, then the sound desk plus sharing. */
export default function ChurchView({ shareOpen }: { shareOpen: boolean }) {
  const [backend, setB] = useState(getBackend());
  const [token, setT] = useState(getToken());
  const [justInstalled, setJustInstalled] = useState(false);
  const installed = !!backend && !!token;

  const save = (b: string, t: string) => {
    setBackend(b);
    setToken(t);
    setB(getBackend());
    setT(getToken());
    setJustInstalled(true);
  };

  return (
    <main className="max-w-2xl mx-auto p-4 space-y-4 print:p-0 print:max-w-none">
      {installed ? (
        <>
          <SpeakView />
          <Finished backend={backend!} token={token!} open={shareOpen || justInstalled} />
        </>
      ) : (
        <Wizard onSave={save} />
      )}
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
      <p className="text-lg text-gray-700">Two steps, about 15 minutes, done once.</p>
      <ol className="flex gap-2" aria-label="Progress">
        {[1, 2].map((n) => (
          <li key={n} className={`flex-1 h-2 rounded-full ${n <= step ? "bg-blue-700" : "bg-gray-200"}`} aria-current={n === step} />
        ))}
      </ol>

      {step === 1 && (
        <Card title="Step 1 of 2: Make sure you have Google Cloud billing">
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
          <Button onClick={() => setStep(2)}>Billing is set up</Button>
        </Card>
      )}

      {step === 2 && (
        <Card title='Step 2 of 2: Click "Install on Google Cloud"'>
          <p className="text-lg">
            A Google page opens with instructions on the right. Start the install there. While Google Cloud sets up, it
            walks you through creating a Soniox account (Soniox turns speech into captions and translations) and asks
            you to paste a key. Everything else is automatic.
          </p>
          <p className="text-gray-600">
            See{" "}
            <a className="underline" href="https://soniox.com/pricing" target="_blank" rel="noreferrer">
              Soniox pricing
            </a>{" "}
            for what captions cost per hour.
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
              Or paste the link it printed, or a sound desk link:
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
            {pasteError && <p className="text-red-700">That doesn't look like the right link. Copy the whole line after "Done!".</p>}
            <p className="text-sm text-gray-600">
              Already installed but lost the link? Click Install on Google Cloud again: it prints the same link.
            </p>
          </div>
          <Button variant="secondary" onClick={() => setStep(1)}>
            Back
          </Button>
        </Card>
      )}
    </>
  );
}

// -------------------------------------------------------------------------- finished

function Finished({ backend, token, open }: { backend: string; token: string; open: boolean }) {
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
      <div className="space-y-4 print:hidden">
      <Details summary="Share" open={open}>
        <h3 className="font-semibold">Sound desk link</h3>
        <p>Open this once on the sound desk computer and bookmark it as "Captions". Keep it private.</p>
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => copy("speak", speak)}>{copied === "speak" ? "Copied" : "Copy link"}</Button>
          <a href={mailto} className="bg-white border-2 border-gray-300 rounded-xl px-4 py-2.5 font-semibold hover:bg-gray-50">
            Email to sound desk team
          </a>
        </div>

        <h3 className="font-semibold pt-3">QR code for the congregation</h3>
        <p>People scan this with their phone camera to follow along. It never changes, even after updates.</p>
        <canvas ref={canvas} className="rounded-lg border border-gray-200" />
        <div className="flex flex-wrap gap-3">
          <Button onClick={downloadQr}>Download QR code (PNG)</Button>
          <Button variant="secondary" onClick={() => copy("listen", listen)}>
            {copied === "listen" ? "Copied" : "Copy listener link"}
          </Button>
        </div>
        <a className="inline-block underline text-blue-800" href={listen} target="_blank" rel="noreferrer">
          Open the congregation view
        </a>

        <h3 className="font-semibold pt-3">Sunday checklist</h3>
        <p>A one-page card for the sound desk.</p>
        <Button variant="secondary" onClick={() => window.print()}>
          Print the card
        </Button>
      </Details>

      <Details summary="Set up" open={open || status === null || !!status?.error || !!needsReinstall}>
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
      </Details>

      <Spending status={status} />
      </div>

      <SundayCard />
    </>
  );
}

function ExtLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="underline text-blue-800" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function googleProjectUrl(project: string) {
  return `https://console.cloud.google.com/home/dashboard?project=${encodeURIComponent(project)}`;
}

/** The project's linked billing account. Reports, grouped by service, splits the charges. */
function googleBillingUrl(project: string) {
  return `https://console.cloud.google.com/billing/linkedaccount?project=${encodeURIComponent(project)}`;
}

function googleServerUrl(project: string, region: string) {
  return `https://console.cloud.google.com/run/detail/${encodeURIComponent(region)}/captioning?project=${encodeURIComponent(project)}`;
}

function Spending({ status }: { status: Status | null | undefined }) {
  const project = status?.project;
  return (
    <Details summary="Spending">
      <p>
        Captions are billed in two places. Soniox charges for turning speech into captions and translations. Google Cloud
        charges for hosting the server, which normal use keeps inside the free tier, and for Google Translate on the
        languages that use it. Sign in with the church account on each site.
      </p>
      <div>
        <p className="font-semibold">Soniox</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <ExtLink href={SONIOX_USAGE}>Usage and cost</ExtLink> — what captions have cost, split by model.
          </li>
          <li>
            <ExtLink href={SONIOX_BILLING}>Credit and charges</ExtLink> — remaining balance, top-ups and autopay.
          </li>
        </ul>
      </div>
      <div>
        <p className="font-semibold">Google Cloud</p>
        {project ? (
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <ExtLink href={googleBillingUrl(project)}>Spending for this project</ExtLink> — then open Reports and group
              by Service. Cloud Run is the server; Cloud Translation is the extra languages. Figures usually appear the
              next day. The project is {project}.
            </li>
            <li>
              <ExtLink href={googleProjectUrl(project)}>Open the project</ExtLink>
              {status?.region ? (
                <>
                  {" "}
                  · <ExtLink href={googleServerUrl(project, status.region)}>the captioning server</ExtLink>
                </>
              ) : null}
            </li>
          </ul>
        ) : (
          <p className="text-gray-600">
            {status === undefined
              ? "Checking which Google Cloud project this server is in."
              : "The Google Cloud links appear once the captioning server reports its project."}
          </p>
        )}
      </div>
    </Details>
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