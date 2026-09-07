import { createHash } from "node:crypto";
import { compareBinaryStrings } from "../../packages/engineering-foundation/dist/binary-string-comparator.js";

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestWorkflows(workflows) {
  const hash = createHash("sha256");
  hash.update("repository-security-workflows-v1\0");
  for (const [path, source] of Object.entries(workflows).toSorted(([left], [right]) =>
    compareBinaryStrings(left, right),
  )) {
    const bytes = Buffer.from(source, "utf8");
    hash.update(path);
    hash.update("\0");
    hash.update(String(bytes.byteLength));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
