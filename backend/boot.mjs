// Launcher. Built into each church's image once and never rebuilt, so keep this file tiny and
// never change its contract: the bundle exports start() (resolves when listening) and stop().
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RELEASE =
  process.env.UPDATE_URL || "https://github.com/tobyfielding1/self-hosted-captioning/releases/download/backend-latest";
const BUNDLED = fileURLToPath(new URL("./server.mjs", import.meta.url));

const log = (severity, message, extra = {}) => console.log(JSON.stringify({ severity, message, ...extra }));

async function download() {
  const signal = AbortSignal.timeout(2000);
  const get = async (name) => {
    const res = await fetch(`${RELEASE}/${name}`, { signal });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const [code, sum] = await Promise.all([get("server.mjs"), get("server.mjs.sha256")]);
  const expected = sum.toString().trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(code).digest("hex");
  if (expected !== actual) throw new Error("checksum mismatch");
  const file = join(tmpdir(), `server-${actual.slice(0, 16)}.mjs`);
  await writeFile(file, code);
  return file;
}

async function run(file) {
  const mod = await import(pathToFileURL(file).href);
  let timer;
  try {
    await Promise.race([
      mod.start(),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("did not start within 5 s")), 5000))),
    ]);
  } catch (e) {
    await Promise.resolve(mod.stop?.()).catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

try {
  if (process.env.AUTO_UPDATE === "false") throw new Error("AUTO_UPDATE=false");
  await run(await download());
  log("INFO", "running latest release");
} catch (e) {
  log("WARNING", "using bundled copy", { reason: String(e) });
  try {
    await run(BUNDLED);
  } catch (e2) {
    log("ERROR", "bundled copy failed to start", { reason: String(e2) });
    process.exit(1);
  }
}
