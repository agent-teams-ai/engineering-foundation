import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const input: unknown = JSON.parse(
  readFileSync(new URL("./quality-input-drift-preloader.json", import.meta.url), "utf8"),
);
assert.ok(typeof input === "object" && input !== null && !Array.isArray(input));
const values: Record<string, unknown> = Object.fromEntries(Object.entries(input));
function value(key: string): string {
  const entry = values[key];
  assert.ok(typeof entry === "string");
  return entry;
}
const config = value("config");
const expected = value("expected");
const replacement = value("replacement");
const oxlint = value("oxlint");
const log = value("log");
let triggered = false;

function forwardSpawn(
  target: typeof childProcess.spawn,
  receiver: unknown,
  args: unknown[],
): childProcess.ChildProcess {
  const child: unknown = Reflect.apply(target, receiver, args);
  assert.ok(child instanceof childProcess.ChildProcess);
  return child;
}

// Forward every actual spawn argument/result unchanged. The only fault injected
// into the installed consumer is one atomic config replacement before Oxlint.
childProcess.spawn = new Proxy(childProcess.spawn, {
  apply(target, receiver: unknown, args: unknown[]) {
    const argv = args[1];
    if (Array.isArray(argv) && argv[0] === oxlint) {
      if (!triggered) {
        assert.equal(readFileSync(config, "utf8"), expected);
        const next = `${config}.drift-next`;
        writeFileSync(next, replacement);
        renameSync(next, config);
        triggered = true;
        appendFileSync(log, `${JSON.stringify({ event: "mutated" })}\n`);
      }
      const child = forwardSpawn(target, receiver, args);
      child.once("close", (code: number | null, signal: string | null) => {
        appendFileSync(log, `${JSON.stringify({ event: "tool-closed", code, signal })}\n`);
      });
      return child;
    }
    return forwardSpawn(target, receiver, args);
  },
});
syncBuiltinESMExports();
