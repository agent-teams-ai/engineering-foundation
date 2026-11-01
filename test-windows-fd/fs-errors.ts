// Diagnostic-only preload: preserve exact filesystem calls; report safe errno facts.
import fs from "node:fs";
type Operation = "openSync" | "fstatSync" | "lstatSync" | "readSync" | "closeSync" | "renameSync";
const operations: readonly Operation[] = ["openSync", "fstatSync", "lstatSync", "readSync", "closeSync", "renameSync"];
let emitted = 0;
for (const operation of operations) {
  const original: unknown = fs[operation];
  if (typeof original !== "function") throw Error("DIAGNOSTIC_FS_METHOD");
  Object.defineProperty(fs, operation, {
    configurable: true, enumerable: true, writable: true,
    value: (...args: unknown[]): unknown => {
      try { return Reflect.apply(original, fs, args); }
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
