import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { checkDeskAccess, getBackend, getStatus, getToken, listenerLink, protocolSupported, siteRoot, speakLink, type DeskAccess, type Status } from "../backend";
import { Banner, Button, Card, copyText, Details } from "../ui";
import SpeakView from "./SpeakView";

const SONIOX_USAGE = "https://console.soniox.com/org/projects/usage/cost";
const SONIOX_BILLING = "https://console.soniox.com/org/billing/reports";

const REPO = "https://github.com/tobyfielding1/self-hosted-captioning";
const shellUrl = (tutorial: string) =>
  `https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=${encodeURIComponent(REPO)}&cloudshell_tutorial=${tutorial}&show=terminal`;
const INSTALL_URL = shellUrl("deploy.md");
const ANOTHER_URL = shellUrl("another.md");
const ROTATE_URL = shellUrl("rotate.md");
const NEWKEY_URL = shellUrl("newkey.md");
const DELETE_URL = shellUrl("delete.md");
const SONIOX_PROJECT = "https://console.soniox.com/org/projects/settings";
const SONIOX_KEYS = "https://console.soniox.com/org/projects/api/keys";
// Venue images freeze their Node major version; below this they need a re-install.
const MIN_NODE_MAJOR = 24;
const TIP_DISMISSED = "captioning.fasterTipDismissed";

/** The venue team's page: an intro, or the sound desk when the address is a sound desk link. */
export default function VenueView({ shareOpen }: { shareOpen: boolean }) {
  const backend = getBackend();
  const token = getToken();
  const [status, setStatus] = useState<Status | null | undefined>(undefined);
  const [access, setAccess] = useState<DeskAccess | "checking">("checking");
  const allowed = !!backend && !!token && (access === "ok" || access === "legacy");

  useEffect(() => {
    if (!backend || !token) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      void checkDeskAccess(backend, token).then((result) => {
        if (cancelled) return;
        setAccess(result);
        if (result === "down") timer = setTimeout(run, 3000);
      });
    };
    setAccess("checking");
    run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [backend, token]);

  useEffect(() => {
    if (!backend || !allowed) return;
    void getStatus(backend).then(setStatus);
  }, [backend, allowed]);

  useEffect(() => {
    if (allowed && status?.venue) document.title = status.venue;
  }, [allowed, status?.venue]);

  return (
    <main className="max-w-2xl mx-auto p-4 space-y-4">
      {backend && token && !allowed ? (
        <DeskGate access={access === "bad" || access === "down" ? access : "checking"} />
      ) : allowed ? (
        <>
          {status?.venue && <h1 className="text-3xl font-bold text-midnight">{status.venue}</h1>}
          <Notices status={status} />
          <SpeakView
            settings={<Delete status={status} />}
            extras={(panels) => (
              <>
                <Finished backend={backend!} token={token!} open={shareOpen} status={status} />
                <div className="space-y-4">{panels}</div>
              </>
            )}
          />
        </>
      ) : (
        <Intro />
      )}
    </main>
  );
}

function DeskGate({ access }: { access: "checking" | "down" | "bad" }) {
  if (access === "bad") {
    return (
      <Banner tone="warn">
        <p className="font-semibold">This sound desk link isn't valid.</p>
        <p>Ask whoever set up captions for the current link.</p>
      </Banner>
    );
  }
  return (
    <p className="text-lg">
      {access === "down"
        ? "The captioning server isn't answering yet, so this link can't be checked. Trying again."
        : "Checking this sound desk link..."}
    </p>
  );
}

// ----------------------------------------------------------------------------- intro

function Intro() {
  return (
    <>
      <h1 className="text-3xl font-bold text-midnight">Live captions</h1>
      <p className="text-lg">
        People in the room read along on their phones, each in their own language. The sound desk runs it from a laptop.
        Nothing to install.
      </p>
      <Card title="In the room">
        <p>
          Open the sound desk bookmark, check the level bar moves when someone speaks, and press Start. Everyone else
          scans a QR code with their phone camera, picks a language, and reads.
        </p>
        <p>
          The spoken language appears word by word. Translations appear as the words are spoken. Languages Soniox
          doesn't offer come through Google Translate, a sentence at a time. The text can be made larger.
        </p>
        <p>Press Stop at the end. Phones can follow only while the sound desk is live.</p>
      </Card>
      <Card title="Set up once">
        <p className="text-lg">
          About 15 minutes, on your Google account. Each venue gets its own server, a private sound desk link, and a QR
          code that stays the same. The terminal lists any venues already on this account. The last line sets up another.
        </p>
        <p>
          Google Cloud hosts the server. Normal use stays in the free tier, but Google still asks for a card,
          and the install emails you if this venue passes £5 a month. Soniox is the part that costs money. You choose how
          much credit to add, and it is only used while someone is being captioned: quiet audio isn't sent, and a
          language runs only while someone is reading it. That costs less than a captioning service you subscribe to.
          See{" "}
          <a className="underline text-blue-600 hover:text-blue-800" href="https://soniox.com/pricing" target="_blank" rel="noreferrer">
            Soniox pricing
          </a>
          .
        </p>
        <a
          href={INSTALL_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-block bg-purple hover:bg-midnight text-white text-2xl font-semibold px-8 py-5 rounded-2xl"
        >
          Set up live captions
        </a>
        <p className="text-sm text-gray-600">
          If you end up in a blank terminal, click Set up live captions again.
        </p>
        <p className="text-sm text-gray-600">
          Already set up? Open the sound desk bookmark. Lost that link? Click the setup link again and pick that venue to get the link again.
        </p>
      </Card>
    </>
  );
}

// -------------------------------------------------------------------------- finished

function Finished({
  backend,
  token,
  open,
  status,
}: {
  backend: string;
  token: string;
  open: boolean;
  status: Status | null | undefined;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const listen = listenerLink(backend);
  const speak = speakLink(backend, token);

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
    "Here's the sound desk link. Opening it is the sound desk page.",
    "",
    "Bookmark it as \"Captions\":",
    speak,
    "",
    "Each time: open the bookmark, check the bar moves when someone speaks, press Start. Press Stop at the end.",
    "",
    "Please keep this link private.",
  ].join("\n");
  const mailto = `mailto:?subject=${encodeURIComponent("Captions: sound desk link")}&body=${encodeURIComponent(emailBody)}`;

  return (
    <>
      <div className="space-y-4">
      <Details summary="Share" open={open}>
        <h3 className="font-semibold text-midnight">Sound desk link</h3>
        <p>This page is the sound desk link. Bookmark it as "Captions" and keep it private.</p>
        <p className="text-sm break-all text-gray-600">{speak}</p>
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => copy("speak", speak)}>{copied === "speak" ? "Copied" : "Copy link"}</Button>
          <a href={mailto} className="bg-white border-2 border-purple/30 rounded-xl px-4 py-2.5 font-semibold hover:bg-veil">
            Email to sound desk team
          </a>
        </div>

        <h3 className="font-semibold text-midnight pt-3">QR code for the audience</h3>
        <p>People scan this with their phone camera to follow along. It never changes, even after updates.</p>
        <canvas ref={canvas} className="rounded-lg border border-gray-200" />
        <div className="flex flex-wrap gap-3">
          <Button onClick={downloadQr}>Download QR code (PNG)</Button>
          <Button variant="secondary" onClick={() => copy("listen", listen)}>
            {copied === "listen" ? "Copied" : "Copy audience link"}
          </Button>
        </div>
        <a className="inline-block underline text-blue-600 hover:text-blue-800" href={listen} target="_blank" rel="noreferrer">
          Open the audience view
        </a>
      </Details>

      <Spending status={status} />
      </div>
    </>
  );
}

function Notices({ status }: { status: Status | null | undefined }) {
  const [tipDismissed, setTipDismissed] = useState(() => localStorage.getItem(TIP_DISMISSED) === "1");
  const nodeMajor = status ? Number(status.node.split(".")[0]) : null;
  const needsReinstall = status && (!protocolSupported(status) || (nodeMajor !== null && nodeMajor < MIN_NODE_MAJOR));
  const down = status === null;
  const error = !!status?.error;
  const faster = !!status?.sonioxFasterRegion && !tipDismissed;
  if (!down && !error && !needsReinstall && !faster) return null;
  return (
    <div className="space-y-3">
      {down && (
        <Banner tone="warn">The captioning server isn't answering yet. If you've only just installed it, wait a minute and reload.</Banner>
      )}
      {error && <Banner tone="error">{status.error}</Banner>}
      {needsReinstall && (
        <Banner tone="warn">
          The captioning server needs a one-time update. Click{" "}
          <a className="underline text-blue-600 hover:text-blue-800" href={INSTALL_URL} target="_blank" rel="noreferrer">
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
          <p className="font-semibold text-midnight">Captions can be faster (optional)</p>
          <p>
            Your venue is closer to Soniox's {status.sonioxFasterRegion.toUpperCase()} region. At console.soniox.com,
            request access to that region, create a project in it, and make an API key there. Then{" "}
            <a className="underline text-blue-600 hover:text-blue-800" href={NEWKEY_URL} target="_blank" rel="noreferrer">
              rotate the Soniox key
            </a>{" "}
            and paste that key when asked.
          </p>
        </Banner>
      )}
    </div>
  );
}

function ExtLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="underline text-blue-600 hover:text-blue-800" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function googleBillingCloseUrl(account: string | null | undefined) {
  return account
    ? `https://console.cloud.google.com/billing/${encodeURIComponent(account)}/manage`
    : "https://console.cloud.google.com/billing";
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
        languages that use it. Sign in with your account on each site.
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
          <p>
            {status === undefined
              ? "Checking which Google Cloud project this server is in."
              : "The Google Cloud links appear once the captioning server reports its project."}
          </p>
        )}
      </div>
    </Details>
  );
}

function startNewDeskLink() {
  const shell = window.open(ROTATE_URL, "_blank");
  if (!shell) return;
  shell.opener = null;
  window.close();
  location.replace(siteRoot());
}

function Delete({ status }: { status: Status | null | undefined }) {
  const project = status?.project;
  return (
    <div className="space-y-3 pt-2">
      <h3 className="font-semibold text-midnight">Rotate the sound desk link</h3>
      <p>If the sound desk link was shared with someone who shouldn't have it, issue a new one. The old link stops working. The QR code stays the same. This page closes so the old link is not left open here.</p>
      <Button variant="secondary" onClick={startNewDeskLink}>
        Rotate sound desk link
      </Button>
      <h3 className="font-semibold text-midnight pt-3">Rotate the Soniox key</h3>
      <p>
        If the Soniox key got out, or Soniox has stopped accepting it, put a new one on the server. The sound desk link
        and QR code stay the same. When it finishes, <ExtLink href={SONIOX_KEYS}>delete the old key</ExtLink>.
      </p>
      <Button variant="secondary" onClick={() => window.open(NEWKEY_URL, "_blank", "noopener")}>
        Rotate Soniox key
      </Button>
      <h3 className="font-semibold text-midnight pt-3">Set up another venue</h3>
      <p>
        Opens the install in Google Cloud, for a second session at the same time. This venue's link and QR code stay the
        same. The same billing account and Soniox account are fine. A new Soniox key is recommended. The terminal lists
        your venues. The last line sets up another.
      </p>
      <a
        href={ANOTHER_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-block bg-white border-2 border-purple/30 rounded-xl px-4 py-2.5 font-semibold hover:bg-veil"
      >
        Set up another venue
      </a>
      <h3 className="font-semibold text-midnight pt-3">Delete</h3>
      <p>
        Delete removes the captioning server and the Google Cloud project the install created
        {project ? ` (${project})` : ""}. Google keeps a deleted project for 30 days if you change your mind.
      </p>
      <a
        href={DELETE_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-block bg-red-700 hover:bg-red-800 text-white font-semibold px-4 py-2.5 rounded-xl"
      >
        Delete from Google Cloud
      </a>
      <p>These stay, because the install did not create them:</p>
      <ul className="list-disc pl-5 space-y-1">
        <li>
          The Soniox project and its API key. <ExtLink href={SONIOX_PROJECT}>Delete the Soniox project</ExtLink>. The
          account and any remaining credit stay.
        </li>
        <li>
          Your Google billing account and card.{" "}
          <ExtLink href={googleBillingCloseUrl(status?.billingAccount)}>Close the Google billing account</ExtLink>
          {status?.billingAccount ? " (Account management → Close billing account)." : " (pick the captions account, then Account management → Close billing account)."}{" "}
          Only close it if you created it for captions and nothing else uses it.
        </li>
      </ul>
    </div>
  );
}