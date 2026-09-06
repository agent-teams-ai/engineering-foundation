import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docsInitPlan, docsInitApply } from "../../dist/index.js";

// Includes transaction/barrier/completed evidence as well as authored bytes.
export async function snapshot(root, relative = "") {
  const result = [];
  for (const name of (await readdir(join(root, relative))).toSorted()) {
    const path = relative ? `${relative}/${name}` : name;
    const state = await lstat(join(root, path));
    result.push({ path, mode: state.mode, ino: state.ino, ...(state.isFile() ? { bytes: (await readFile(join(root, path))).toString("base64") } : {}) });
    if (state.isDirectory()) {result.push(...await snapshot(root, path));}
  }
  return result;
}

export async function portableRepository(run, { bootstrap = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "portable-dx-"));
  try {
    const init = { consumerRoot: root, projectId: "example/widgets", ownerId: "documentation/team" };
    if (bootstrap) {
      const preview = await docsInitPlan(init);
      const applied = await docsInitApply({ ...init, expectedPlanDigest: preview.planDigest });
      assert.equal(applied.writeState, "applied");
    }
    return await run(root, init);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
