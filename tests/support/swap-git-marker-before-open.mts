// Test-only syscall boundary: perform one actual atomic marker replacement
// after the caller observes metadata, before it can open/read the marker.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const marker = process.env["TEST_GIT_MARKER_TO_SWAP"];
const source = process.env["TEST_GIT_MARKER_SOURCE"];
if (marker === undefined || source === undefined) {
  throw new Error("The finite Git marker race requires its owned fixture inputs.");
}
interface MetadataOperations {
  stat: (...args: unknown[]) => Promise<unknown>;
  lstat: (...args: unknown[]) => Promise<unknown>;
}
const operations = fs as unknown as MetadataOperations;
let replaced = false;
for (const method of ["stat", "lstat"] as const) {
  const original = operations[method].bind(fs);
  operations[method] = async (...args: unknown[]) => {
    const metadata = await original(...args);
    if (!replaced && String(args[0]) === marker) {
      replaced = true;
      await fs.rename(marker, `${marker}.retained-before-race`);
      await fs.writeFile(marker, source);
    }
    return metadata;
  };
}
syncBuiltinESMExports();
