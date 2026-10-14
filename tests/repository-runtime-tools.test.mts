import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertOwnedProfileRoot } from "../tools/profile-root.mts";
import { inspectInstalledDependencies } from "../tools/dependencies-installed-check.mts";
import { checkEngineeringQualityStandard } from "../scripts/check-engineering-quality-standard.mts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("profile roots reject root, siblings, nesting and symlink escapes", async () => {
  const profiles = resolve(repositoryRoot, ".worker-tmp/profiles");
  await mkdir(profiles, { recursive: true });
  const accepted = join(profiles, `runtime-root-${process.pid}`);
  const sibling = resolve(repositoryRoot, ".worker-tmp/profiles-other");
  const nested = join(accepted, "nested");
  const linked = join(profiles, `runtime-link-${process.pid}`);
  try {
    await mkdir(accepted);
    await mkdir(nested, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await symlink(sibling, linked);
    assert.equal(await assertOwnedProfileRoot(accepted), accepted);
    await assert.rejects(assertOwnedProfileRoot(repositoryRoot), /one dedicated child/u);
    await assert.rejects(assertOwnedProfileRoot(sibling), /one dedicated child/u);
    await assert.rejects(assertOwnedProfileRoot(nested), /one dedicated child/u);
    await assert.rejects(assertOwnedProfileRoot(linked), /symbolic link/u);
  } finally {
    await rm(linked, { force: true });
    await rm(nested, { recursive: true, force: true });
    await rm(accepted, { recursive: true, force: true });
    await rm(sibling, { recursive: true, force: true });
  }
});

async function writeManifest(path: string, manifest: unknown): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("installed guard validates optional peer ranges and follows peer-only engine context", async () => {
  const root = await mkdtemp(join(profilesTemporaryParent(), "installed-guard-"));
  try {
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n", "utf8");
    await writeManifest(root, {
      name: "fixture-root",
      version: "1.0.0",
      dependencies: { host: "1.0.0", "optional-host": "1.0.0" }
    });
    await writeManifest(join(root, "node_modules/host"), {
      name: "host",
      version: "1.0.0",
      peerDependencies: { peer: "^2.0.0" }
    });
    await writeManifest(join(root, "node_modules/host/node_modules/peer"), {
      name: "peer",
      version: "2.0.0",
      engines: { node: ">=99.0.0" }
    });
    await writeManifest(join(root, "node_modules/optional-host"), {
      name: "optional-host",
      version: "1.0.0",
      peerDependencies: { absent: "not-a-range" },
      peerDependenciesMeta: { absent: { optional: true } }
    });
    await assert.rejects(
      inspectInstalledDependencies(root),
      /Malformed SemVer range.*absent/u
    );
    await writeManifest(join(root, "node_modules/optional-host"), {
      name: "optional-host",
      version: "1.0.0",
      peerDependencies: { absent: "^1.0.0" },
      peerDependenciesMeta: { absent: { optional: true } }
    });
    await assert.rejects(
      inspectInstalledDependencies(root),
      /Installed engine mismatch.*peer@2\.0\.0/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standards pin gate rejects consumer classification drift", async () => {
  const root = await mkdtemp(join(profilesTemporaryParent(), "standards-pin-"));
  try {
    await mkdir(join(root, "standards"), { recursive: true });
    for (const file of [
      "engineering-quality-standard.md",
      "engineering-quality-standard.provenance.json",
      "standards-pin-review.json"
    ]) {
      await writeFile(
        join(root, "standards", file),
        await readFile(join(repositoryRoot, "standards", file), "utf8")
      );
    }
    await checkEngineeringQualityStandard(root);
    const reviewPath = join(root, "standards/standards-pin-review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf8")) as {
      readonly classification: Record<string, string>;
    };
    review.classification["consumerModuleStandard"] = "adopted";
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
    await assert.rejects(
      checkEngineeringQualityStandard(root),
      /classification drifted/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function profilesTemporaryParent(): string {
  return resolve(repositoryRoot, ".worker-tmp/profiles");
}
