import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./managed-runtime-fixtures.mjs";
import { hashRuntimeFile } from "../dist/consumer-integration/adapters/node-managed-runtime-identity.js";
import { runManagedProbe } from "../dist/consumer-integration/adapters/node-managed-runtime-process.js";
export async function probeScenario(source: string, signal = new AbortController().signal) {
  const f = await fixture("node24");
  const bin = join(f.packageRoot, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "pnpm.mjs"), source);
  const image = {
    nodePath: f.node,
    rootPath: f.packageRoot,
    node: await hashRuntimeFile(f.node, 256 * 1024 * 1024, true),
    manifest: null,
    entry: null,
    treeDigest: "test-only-negative",
  };
  try {
    return await runManagedProbe({
      // Deliberately incomplete image exercises the negative probe boundary.
      image: image as unknown as Parameters<typeof runManagedProbe>[0]["image"],
      expected: f.expected,
      cwd: f.root,
      kind: "pnpm-version",
      signal,
    });
  } finally {
    await f.cleanup();
  }
}
