import { createServer, type ServerResponse } from "node:http";
import { Effect, Exit, ManagedRuntime, Stream } from "effect";
import { maxFrameBytes, sessionId, type Frame, type SessionId } from "../sdk/index.ts";
import { prepareSessions, SessionRoots } from "./sessions.ts";
import { writeFrame } from "./write-frame.ts";
export { writeFrame } from "./write-frame.ts";
export type { FrameSink } from "./write-frame.ts";

export type WireFault = "malformed" | "wrong-session" | "oversized" | "truncated";
export interface HostObservation {
  readonly kind: "application-acquired" | "application-released" | "subscription-acquired" | "subscription-released" | "request-settled" | "admission-stopped" | "listener-closed" | "listening";
  readonly session?: SessionId;
  readonly failed?: boolean;
}
export interface HostOptions {
  readonly bundle: string;
  readonly observe: (event: HostObservation) => void;
  readonly failStartup?: boolean;
  readonly wireFault?: WireFault;
  readonly beforeReady?: (session: SessionId, signal: AbortSignal) => Promise<void>;
}

function wire(frame: Frame, fault: WireFault | undefined): string {
  if (frame.kind === "ready" || fault === undefined) return JSON.stringify(frame) + "\n";
  if (fault === "malformed") return JSON.stringify({ ...frame, revision: "invalid" }) + "\n";
  if (fault === "wrong-session") return JSON.stringify({ ...frame, sessionId: frame.sessionId === "left" ? "right" : "left" }) + "\n";
  if (fault === "oversized") return "x".repeat(maxFrameBytes + 1) + "\n";
  return JSON.stringify(frame);
}

export async function startFixtureHost(options: HostOptions) {
  const graph = await prepareSessions((kind) => options.observe({ kind }), options.failStartup ?? false);
  const runtime = ManagedRuntime.make(graph.layer(SessionRoots));
  try {
    await runtime.runPromise(SessionRoots);
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  let accepting = true;
  const requests = new Map<AbortController, Promise<void>>();
  const server = createServer((request, response) => {
    if (!accepting) { response.writeHead(503).end(); return; }
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (request.method === "GET" && url.pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end('<!doctype html><html lang="en"><title>Progress qualification</title><p id="status">idle</p><output id="revision">-1</output><output id="completed">-1</output><button id="start">Start</button><button id="stop">Stop</button><button id="advance">Advance</button><pre id="error"></pre><script type="module" src="/client.js"></script></html>');
      return;
    }
    if (request.method === "GET" && url.pathname === "/client.js") {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(options.bundle);
      return;
    }
    const route = /^\/api\/sessions\/(left|right)\/(events|advance)$/u.exec(url.pathname);
    if (route === null || !((route[2] === "events" && request.method === "GET") || (route[2] === "advance" && request.method === "POST"))) {
      response.writeHead(404).end(); return;
    }
    const id = sessionId(route[1] ?? null);
    const controller = new AbortController();
    const closed = () => { if (!response.writableFinished) controller.abort(); };
    response.once("close", closed);
    response.once("error", closed);
    const program = route[2] === "advance"
      ? Effect.gen(function* () {
          const roots = yield* SessionRoots;
          const value = yield* roots.api[id].advance;
          response.setHeader("content-type", "application/json");
          yield* writeFrame(response, JSON.stringify(value));
          response.end();
        })
      : streamRequest(id, response, options);
    const settled = runtime.runPromiseExit(program, { signal: controller.signal }).then((exit) => {
      if (Exit.isFailure(exit) && !response.destroyed) response.destroy();
      response.removeListener("close", closed);
      response.removeListener("error", closed);
      requests.delete(controller);
      options.observe({ kind: "request-settled", session: id, failed: Exit.isFailure(exit) });
    });
    requests.set(controller, settled);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once("error", failed);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", failed); resolve(); });
    });
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected loopback listener");
  options.observe({ kind: "listening" });
  let closing: Promise<void> | undefined;
  return {
    origin: "http://127.0.0.1:" + address.port,
    close(): Promise<void> {
      closing ??= (async () => {
        accepting = false;
        options.observe({ kind: "admission-stopped" });
        const listenerClosed = new Promise<void>((resolve, reject) => {
          server.close((error) => { if (error) reject(error); else resolve(); });
        });
        for (const controller of requests.keys()) controller.abort();
        await Promise.all(requests.values());
        await runtime.dispose();
        server.closeAllConnections();
        await listenerClosed;
        options.observe({ kind: "listener-closed" });
      })();
      return closing;
    },
  };
}

function streamRequest(id: SessionId, response: ServerResponse, options: HostOptions) {
  let acquired = false;
  return Effect.scoped(Effect.gen(function* () {
    const roots = yield* SessionRoots;
    const states = yield* roots.api[id].subscribe;
    acquired = true;
    options.observe({ kind: "subscription-acquired", session: id });
    const beforeReady = options.beforeReady;
    if (beforeReady !== undefined) {
      yield* Effect.tryPromise({ try: (signal) => beforeReady(id, signal), catch: (error) => error });
    }
    response.setHeader("content-type", "application/x-ndjson");
    response.setHeader("cache-control", "no-store");
    yield* writeFrame(response, wire({ kind: "ready", sessionId: id }, undefined));
    const fault = id === "left" ? options.wireFault : undefined;
    yield* Stream.runForEach(fault === undefined ? states : states.pipe(Stream.take(1)), (state) =>
      writeFrame(response, wire({ ...state, kind: "progress" }, fault)),
    );
    response.end();
  })).pipe(Effect.ensuring(Effect.sync(() => {
    if (acquired) options.observe({ kind: "subscription-released", session: id });
  })));
}
