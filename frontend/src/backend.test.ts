import { afterEach, describe, expect, it, vi } from "vitest";
import { getBackend, listenerLink, protocolNotice, setupNotice, speakLink, strongestNotice, wsUrl } from "./backend";

const HOST = "captioning-f7729b.europe-west1.run.app";

afterEach(() => {
  vi.unstubAllGlobals();
});

function at(href: string) {
  const url = new URL(href);
  vi.stubGlobal("location", { href, origin: url.origin, search: url.search, hash: url.hash });
}

describe("protocol version", () => {
  it("treats a whole number as major.0.0 and grades the gap", () => {
    expect(protocolNotice(4)).toBe("minor");
    expect(protocolNotice(4, "4.1.0")).toBeNull();
    expect(protocolNotice(4, "4.0.9")).toBe("minor");
    expect(protocolNotice(4, "4.1.0", "4.1.1")).toBe("patch");
    expect(protocolNotice(3, "3.4.1")).toBe("major");
    expect(protocolNotice(5, "5.0.0")).toBe("major");
    expect(protocolNotice(4, "4.2.0")).toBeNull();
    expect(protocolNotice(4, "nope")).toBe("minor");
    expect(protocolNotice("nope")).toBe("major");
  });
});

describe("setup version", () => {
  it("treats a missing install as 1.0.0 and keeps the stronger notice", () => {
    expect(setupNotice(undefined)).toBe("minor");
    expect(setupNotice("1.0.0")).toBe("minor");
    expect(setupNotice("1.1.0")).toBeNull();
    expect(setupNotice("1.2.0")).toBeNull();
    expect(setupNotice("nope")).toBe("minor");
    expect(setupNotice("1.1.0", "1.1.1")).toBe("patch");
    expect(setupNotice("1.1.0", "2.0.0")).toBe("major");
    expect(strongestNotice(null, "minor", "patch")).toBe("patch");
    expect(strongestNotice("minor", "major")).toBe("major");
    expect(strongestNotice(null, null)).toBeNull();
  });
});

describe("server address in the link", () => {
  it("reads a bare host as https and writes links without the scheme", () => {
    at(`http://localhost:5173/#backend=${HOST}&token=secret`);
    expect(getBackend()).toBe(`https://${HOST}`);
    expect(speakLink()).toBe(`http://localhost:5173/#backend=${HOST}&token=secret`);
    expect(listenerLink()).toBe(`http://localhost:5173/?backend=${HOST}`);
    expect(wsUrl("/ws/listen", { lang: "fr" })).toBe(`wss://${HOST}/ws/listen?lang=fr`);
  });

  it("keeps an existing https address working and still drops the scheme from new links", () => {
    at(`http://localhost:5173/?backend=${encodeURIComponent(`https://${HOST}/`)}`);
    expect(getBackend()).toBe(`https://${HOST}`);
    expect(listenerLink()).toBe(`http://localhost:5173/?backend=${HOST}`);
  });

  it("keeps an http address in full, for local use", () => {
    at("http://localhost:5173/#backend=http://localhost:8080&token=dev");
    expect(getBackend()).toBe("http://localhost:8080");
    expect(speakLink()).toContain("backend=http%3A%2F%2Flocalhost%3A8080");
    expect(wsUrl("/ws/speaker", { token: "dev" })).toBe("ws://localhost:8080/ws/speaker?token=dev");
  });
});
