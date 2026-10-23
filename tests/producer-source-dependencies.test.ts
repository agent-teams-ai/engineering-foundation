import assert from "node:assert/strict";
import { mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectProducerSourceDependencies } from "../tools/producer-source-dependencies.ts";

for (const variant of ["valid", "missing", "mismatch", "escape", "foreign"] as const) {
  test(`shadowed producer projection: ${variant}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "producer-source-TEST-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const put = async (path: string, value: unknown): Promise<void> => {
      await mkdir(join(root, path), { recursive: true });
      await writeFile(join(root, path, "package.json"), JSON.stringify(value));
    };
    await put("", { name: "owner", version: "1.0.0", devDependencies: { "stack-toolchain": "0.1.0" } });
    await put("packages/stack-toolchain", { name: "stack-toolchain", version: "0.1.0", dependencies: { parser: "catalog:" } });
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\ncatalog:\n  parser: 1.0.0\n");
    const registry = "node_modules/.bun/stack/node_modules/stack-toolchain";
    await put(registry, { name: "stack-toolchain", version: "0.1.0" });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(join(root, registry), join(root, "node_modules/stack-toolchain"), "junction");
    const consumerBefore = await readlink(join(root, "node_modules/stack-toolchain"));
    if (variant !== "missing") {
      await put(`${registry}/node_modules/parser`, { name: "parser", version: variant === "mismatch" ? "2.0.0" : "1.0.0" });
    }
    if (variant === "escape") {
      await rm(join(root, registry, "node_modules/parser"), { recursive: true });
      await symlink(tmpdir(), join(root, registry, "node_modules/parser"), "junction");
    }
    if (variant === "foreign") {
      await put("packages/stack-toolchain/node_modules/parser", { name: "parser", version: "1.0.0" });
    }
    if (variant === "valid") {
      await projectProducerSourceDependencies(root);
      await projectProducerSourceDependencies(root);
      assert.equal(
        await realpath(join(root, "packages/stack-toolchain/node_modules/parser")),
        await realpath(join(root, registry, "node_modules/parser")),
      );
    } else {
      await assert.rejects(projectProducerSourceDependencies(root), /unavailable|mismatch|escapes/u);
    }
    assert.equal(await readlink(join(root, "node_modules/stack-toolchain")), consumerBefore);
  });
}
