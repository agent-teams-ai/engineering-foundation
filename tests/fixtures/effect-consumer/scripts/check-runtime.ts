import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version as esbuildVersion } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { Cause, Effect, Exit } from "effect";
import { startFixtureHost, writeFrame, type HostObservation, type WireFault } from "../backend/index.ts";

function observer() {
  const events: HostObservation[] = [];
  const changes = new EventEmitter();
  return {
    events,
    record(event: HostObservation): void {
      assert.ok(events.length < 1024, "Fixture observation bound exceeded");
      events.push(event);
      changes.emit("change");
    },
    count(kind: HostObservation["kind"], session?: "left" | "right"): number {
      return events.filter((event) => event.kind === kind && (session === undefined || event.session === session)).length;
    },
    async until(predicate: () => boolean): Promise<void> {
      const signal = AbortSignal.timeout(10_000);
      while (!predicate()) await once(changes, "change", { signal });
    },
  };
}

async function displayed(page: Page, revision: number): Promise<void> {
  await page.waitForFunction((expected) =>
    document.getElementById("status")?.textContent === "live" &&
    document.getElementById("revision")?.textContent === String(expected) &&
    document.getElementById("completed")?.textContent === String(expected), revision);
}

async function post(origin: string, session: "left" | "right"): Promise<void> {
  const response = await fetch(origin + "/api/sessions/" + session + "/advance", {
    method: "POST", signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 204);
  assert.equal((await response.arrayBuffer()).byteLength, 0);
}

async function bundle(): Promise<string> {
  const installation = await realpath("node_modules");
  for (const resolved of [
    import.meta.resolve("esbuild"),
    import.meta.resolve("playwright-core"),
    import.meta.resolve("effect"),
    import.meta.resolve("@get-modular/core"),
    import.meta.resolve("@get-modular/assembly"),
    import.meta.resolve("@get-modular/effect"),
  ]) {
    const suffix = relative(installation, await realpath(fileURLToPath(resolved)));
    assert.ok(!isAbsolute(suffix) && suffix.split(/[\\/]/u)[0] !== "..", "Tool or runtime escaped consumer installation");
  }
  const playwright: unknown = JSON.parse(await readFile(fileURLToPath(import.meta.resolve("playwright-core/package.json")), "utf8"));
  assert.ok(playwright !== null && typeof playwright === "object" && "version" in playwright);
  assert.equal(playwright.version, "1.65.1");
  assert.equal(esbuildVersion, "0.28.2");
  const built = await build({
    absWorkingDir: process.cwd(), entryPoints: ["frontend/index.ts"], bundle: true,
    platform: "browser", format: "esm", target: "es2024", write: false, metafile: true,
  });
  assert.ok(built.metafile);
  assert.equal(built.outputFiles.length, 1);
  for (const input of Object.keys(built.metafile.inputs)) {
    const path = input.replaceAll("\\", "/");
    assert.ok(!/node_modules\/(?:@agent-teams\/|stack-toolchain\/|esbuild\/|playwright-core\/)/u.test(path), "Development package entered browser");
    if (!path.includes("node_modules/")) {
      assert.ok(path.startsWith("frontend/") || path.startsWith("sdk/"), "Non-browser source entered bundle: " + path);
    }
  }
  for (const output of Object.values(built.metafile.outputs)) {
    assert.ok(output.imports.every((entry) => !entry.external && !entry.path.startsWith("node:")));
  }
  const output = built.outputFiles[0];
  assert.ok(output);
  return output.text;
}

async function happyPath(browser: Browser, javascript: string): Promise<void> {
  const seen = observer();
  const host = await startFixtureHost({ bundle: javascript, observe: seen.record });
  const context = await browser.newContext();
  context.setDefaultTimeout(10_000);
  const pageErrors: string[] = [];
  context.on("page", (page) => page.on("pageerror", (error) => pageErrors.push(error.message)));
  try {
    const left = await context.newPage();
    const right = await context.newPage();
    await Promise.all([left.goto(host.origin + "/?session=left"), right.goto(host.origin + "/?session=right")]);
    await Promise.all([displayed(left, 0), displayed(right, 0)]);
    assert.equal(seen.count("subscription-acquired"), 2);
    await left.click("#advance");
    await displayed(left, 1);
    await displayed(right, 0);
    await right.click("#advance");
    await displayed(right, 1);
    await displayed(left, 1);

    await left.click("#stop");
    await left.waitForFunction(() => document.getElementById("status")?.textContent === "stopped");
    await seen.until(() => seen.count("subscription-released", "left") === 1);
    assert.equal(seen.count("application-released"), 0);
    assert.equal(seen.count("subscription-released", "right"), 0);
    await right.click("#advance");
    await displayed(right, 2);

    await post(host.origin, "left");
    await post(host.origin, "left");
    await left.click("#start");
    await displayed(left, 3);
    await displayed(right, 2);
    await left.close();
    await seen.until(() => seen.count("subscription-released", "left") === 2);
    await right.click("#advance");
    await displayed(right, 3);

    const fresh = await context.newPage();
    await fresh.goto(host.origin + "/?session=left");
    await displayed(fresh, 3);
    const closing = host.close();
    assert.equal(host.close(), closing);
    await closing;
    assert.equal(seen.count("application-acquired"), 1);
    assert.equal(seen.count("application-released"), 1);
    assert.equal(seen.count("subscription-acquired"), seen.count("subscription-released"));
    assert.equal(seen.count("listener-closed"), 1);
    assert.ok(seen.events.some((event) => event.kind === "request-settled" && event.failed));
    await assert.rejects(fetch(host.origin, { signal: AbortSignal.timeout(2000) }));
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
    await host.close();
  }
}

async function acquisitionOrdering(browser: Browser, javascript: string): Promise<void> {
  const seen = observer();
  const release = Promise.withResolvers<void>();
  const host = await startFixtureHost({
    bundle: javascript, observe: seen.record,
    beforeReady: async (session, signal) => {
      if (session !== "left") return;
      signal.throwIfAborted();
      const abort = Promise.withResolvers<never>();
      const cancelled = () => abort.reject(signal.reason);
      signal.addEventListener("abort", cancelled, { once: true });
      try { await Promise.race([release.promise, abort.promise]); }
      finally { signal.removeEventListener("abort", cancelled); }
    },
  });
  const context = await browser.newContext();
  context.setDefaultTimeout(10_000);
  try {
    const left = await context.newPage();
    const right = await context.newPage();
    await Promise.all([left.goto(host.origin + "/?session=left"), right.goto(host.origin + "/?session=right")]);
    await seen.until(() => seen.count("subscription-acquired", "left") === 1);
    await displayed(right, 0);
    await post(host.origin, "left");
    await post(host.origin, "left");
    await right.click("#advance");
    await displayed(right, 1);
    release.resolve();
    await displayed(left, 2);
    await left.click("#advance");
    await displayed(left, 3);
  } finally {
    release.resolve();
    await context.close();
    await host.close();
  }
  assert.equal(seen.count("subscription-acquired"), seen.count("subscription-released"));
  assert.equal(seen.count("application-released"), 1);
}

async function corruptedWire(browser: Browser, javascript: string): Promise<void> {
  const faults: readonly (WireFault | undefined)[] = ["malformed", "wrong-session", "oversized", "truncated", undefined];
  for (const wireFault of faults) {
    const seen = observer();
    const host = await startFixtureHost({ bundle: javascript, observe: seen.record, ...(wireFault === undefined ? {} : { wireFault }) });
    const context = await browser.newContext();
    context.setDefaultTimeout(10_000);
    try {
      const left = await context.newPage();
      const right = await context.newPage();
      await Promise.all([left.goto(host.origin + "/?session=left"), right.goto(host.origin + "/?session=right")]);
      await displayed(right, 0);
      if (wireFault === undefined) {
        await displayed(left, 0);
        await left.click("#advance");
        await displayed(left, 1);
      } else {
        await left.waitForFunction(() => document.getElementById("status")?.textContent === "error");
        assert.match(await left.locator("#error").innerText(), /ProtocolError/u);
        await seen.until(() => seen.count("subscription-released", "left") === 1);
      }
      await right.click("#advance");
      await displayed(right, 1);
    } finally {
      await context.close();
      await host.close();
    }
    assert.equal(seen.count("subscription-acquired"), seen.count("subscription-released"));
    assert.equal(seen.count("application-released"), 1);
  }
}

async function nativeFailureBoundaries(): Promise<void> {
  const seen = observer();
  await assert.rejects(startFixtureHost({ bundle: "", observe: seen.record, failStartup: true }), /Intentional startup rejection/u);
  assert.equal(seen.count("listening"), 0);
  assert.equal(seen.count("application-acquired"), 1);
  assert.equal(seen.count("application-released"), 1);

  const started = Promise.withResolvers<void>();
  class StalledWritable extends EventEmitter {
    readonly destroyed = false;
    write(_value: string): boolean { started.resolve(); return false; }
  }
  const sink = new StalledWritable();
  const controller = new AbortController();
  const completion = Effect.runPromiseExit(writeFrame(sink, "bounded frame"), { signal: controller.signal });
  await started.promise;
  assert.equal(sink.listenerCount("drain"), 1);
  controller.abort();
  const exit = await completion;
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
  for (const event of ["drain", "close", "error"]) assert.equal(sink.listenerCount(event), 0);
}

assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
await nativeFailureBoundaries();
const javascript = await bundle();
const browser = await chromium.launch({ headless: true });
try {
  assert.equal(browser.version(), "159.0.8154.6");
  await happyPath(browser, javascript);
  await acquisitionOrdering(browser, javascript);
  await corruptedWire(browser, javascript);
  process.stdout.write(JSON.stringify({
    outcome: "passed", driver: "playwright-core@1.65.1", browser: browser.version(),
    cases: ["browser-bundle", "two-sessions", "stop-and-settlement", "physical-disconnect",
      "reconnect-latest-state", "acquisition-ordering", "malformed-wire", "wrong-session",
      "oversized-frame", "truncated-frame", "corrected-wire", "startup-rejection",
      "shutdown", "controlled-output-backpressure"],
  }) + "\n");
} finally {
  await browser.close();
}
