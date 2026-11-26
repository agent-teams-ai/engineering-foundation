import { Cause, Effect, Exit, ManagedRuntime } from "effect";
import { sessionId } from "../sdk/index.ts";
import { BrowserRoots, prepareBrowser } from "./session.ts";

function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (value === null) throw new Error("Missing " + id);
  return value;
}

const session = sessionId(new URL(location.href).searchParams.get("session"));
const status = element("status");
const error = element("error");
let starting = false;
let active: {
  readonly stop: () => Promise<void>;
  readonly advance: () => Promise<void>;
} | undefined;

function failed(cause: unknown): void {
  error.textContent = String(cause);
  status.textContent = "error";
}

async function start(): Promise<void> {
  if (active !== undefined || starting) return;
  starting = true;
  status.textContent = "starting";
  error.textContent = "";
  try {
    const graph = await prepareBrowser();
    const runtime = ManagedRuntime.make(graph.layer(BrowserRoots));
    const controller = new AbortController();
    let closing: Promise<void> | undefined;
    const done = runtime.runPromiseExit(Effect.gen(function* () {
      const roots = yield* BrowserRoots;
      yield* roots.view.watch(session, (value) => {
        element("revision").textContent = String(value.revision);
        element("completed").textContent = String(value.completed);
        status.textContent = "live";
      });
    }), { signal: controller.signal });
    const owner = {
      stop: () => {
        closing ??= (async () => {
          controller.abort();
          await done;
          await runtime.dispose();
          if (active === owner) active = undefined;
          status.textContent = "stopped";
        })();
        return closing;
      },
      advance: async () => {
        await runtime.runPromise(Effect.flatMap(BrowserRoots, (roots) => roots.view.advance(session)));
      },
    };
    active = owner;
    void done.then(async (exit) => {
      if (controller.signal.aborted) return;
      await runtime.dispose();
      if (active === owner) active = undefined;
      if (Exit.isFailure(exit)) failed(Cause.pretty(exit.cause));
      else failed("Progress stream ended unexpectedly");
    }).catch(failed);
  } finally {
    starting = false;
  }
}

element("start").addEventListener("click", () => { void start().catch(failed); });
element("stop").addEventListener("click", () => { void active?.stop().catch(failed); });
element("advance").addEventListener("click", () => { void active?.advance().catch(failed); });
void start().catch(failed);
