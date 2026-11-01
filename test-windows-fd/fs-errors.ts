// Diagnostic-only preload: preserve exact filesystem calls; report safe errno facts.
import fs from "node:fs";
const entry = process.argv[1]?.endsWith("format-files.test.ts") ? "literal"
  : process.argv[1]?.endsWith("command-host-successor-cli.test.mts") ? "witness" : "other";
process.stderr.write(JSON.stringify({ diagnostic: "fd-preload-start", entry, pid: process.pid, platform: process.platform, node: process.version }) + "\n");
type Operation = "openSync" | "fstatSync" | "lstatSync" | "readSync" | "closeSync" | "renameSync";
const operations: readonly Operation[] = ["openSync", "fstatSync", "lstatSync", "readSync", "closeSync", "renameSync"];
let emitted = 0;
let unsafeEmitted = 0;
const unsafeIdentities = new Map<string, string>();
for (const operation of operations) {
  const original: unknown = fs[operation];
  if (typeof original !== "function") throw Error("DIAGNOSTIC_FS_METHOD");
  Object.defineProperty(fs, operation, {
    configurable: true, enumerable: true, writable: true,
    value: (...args: unknown[]): unknown => {
      try {
        const result: unknown = Reflect.apply(original, fs, args);
        if (operation === "fstatSync" && unsafeEmitted < 16 && result !== null && typeof result === "object"
          && "ino" in result && typeof result.ino === "number"
          && "dev" in result && typeof result.dev === "number"
          && (!Number.isSafeInteger(result.ino) || !Number.isSafeInteger(result.dev))) {
          unsafeEmitted++;
          try {
            const exact: unknown = Reflect.apply(original, fs, [args[0], { bigint: true }]);
            if (exact !== null && typeof exact === "object" && "dev" in exact && "ino" in exact) {
              const key = result.dev + ":" + result.ino, exactKey = String(exact.dev) + ":" + String(exact.ino);
              const previous = unsafeIdentities.get(key); unsafeIdentities.set(key, exactKey);
              process.stderr.write(JSON.stringify({ diagnostic: "unsafe-native-fstat-number",
                numberCollisionObserved: previous !== undefined && previous !== exactKey,
                number: { dev: result.dev, ino: result.ino },
                exact: { dev: String(exact.dev), ino: String(exact.ino) },
                numberRoundTripDiffers: BigInt(result.dev) !== exact.dev || BigInt(result.ino) !== exact.ino }) + "\n");
            }
          } catch {
            process.stderr.write(JSON.stringify({ diagnostic: "unsafe-native-fstat-exact-probe-unavailable" }) + "\n");
          }
        }
        return result;
      }
      catch (error) {
        if (emitted++ < 32) {
          const value = error !== null && typeof error === "object" ? error : {};
          const code = "code" in value && typeof value.code === "string" ? value.code : null;
          const syscall = "syscall" in value && typeof value.syscall === "string" ? value.syscall : null;
          process.stderr.write(JSON.stringify({ diagnostic: "native-fs-error", operation, code, syscall }) + "\n");
        }
        throw error;
      }
    },
  });
}
