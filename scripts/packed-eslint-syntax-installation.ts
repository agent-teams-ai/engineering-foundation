import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runNpmCommand } from "./pack-test-support.mjs";
import {
  qualifyInstalledEslintRoot,
  qualifyInstalledEslintSyntax,
  verifyInstalledEslintSyntaxArtifacts,
  type EslintSyntaxArtifactExpectation,
} from "./packed-eslint-syntax-qualification.ts";

type Manager = "npm" | "pnpm";
type RunPnpm = (args: readonly string[], cwd: string) => Promise<unknown>;

export interface PackedEslintInstallationInput {
  readonly artifact: { readonly archiveFileSpecifier: string; readonly packageVersion: string };
  readonly packageManager: string;
  readonly temporaryRoot: string;
  readonly sourcePackageRoot: string;
  readonly runPnpm: RunPnpm;
}

async function install(
  input: PackedEslintInstallationInput,
  root: string,
  manager: Manager,
  frozen: boolean,
): Promise<void> {
  if (manager === "pnpm") {
    await input.runPnpm(
      ["install", "--ignore-scripts", frozen ? "--frozen-lockfile" : "--no-frozen-lockfile"],
      root,
    );
  } else {
    await runNpmCommand(
      [frozen ? "ci" : "install", "--ignore-scripts", "--no-audit", "--fund=false"],
      root,
    );
  }
}

async function qualifyInstallation(
  input: PackedEslintInstallationInput,
  expected: EslintSyntaxArtifactExpectation,
  manager: Manager,
  explicitHost: boolean,
): Promise<void> {
  const root = await mkdtemp(join(input.temporaryRoot, `eslint-${manager}-`));
  try {
    const devDependencies: Record<string, string> = {
      "stack-toolchain": input.artifact.archiveFileSpecifier,
    };
    if (explicitHost) {
      devDependencies["eslint"] = "10.3.0";
    }
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "packed-eslint-consumer",
        private: true,
        type: "module",
        devDependencies,
        ...(manager === "pnpm" ? { packageManager: input.packageManager } : {}),
      }),
    );
    if (manager === "pnpm") {
      // An independent workspace prevents discovery of a containing repository's policy.
      await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - .\n");
    }
    await install(input, root, manager, false);
    const lockPath = join(root, manager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json");
    const lock = await readFile(lockPath);
    assert.ok(lock.length > 0);
    await verifyInstalledEslintSyntaxArtifacts(root, expected);
    await install(input, root, manager, true);
    assert.deepEqual(
      await readFile(lockPath),
      lock,
      "Frozen reinstall must preserve the real lock",
    );
    await verifyInstalledEslintSyntaxArtifacts(root, expected);
    await qualifyInstalledEslintRoot(root);
    if (explicitHost) {
      await qualifyInstalledEslintSyntax(root);
    }
    // The parser has a mandatory peer; no explicit host does not mean no installed host.
    process.stdout.write(
      JSON.stringify({
        event: "packed-eslint-installation",
        manager,
        explicitHost,
        packageVersion: expected.packageVersion,
        frozenReinstall: true,
        lockSha256: createHash("sha256").update(lock).digest("hex"),
      }) + "\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Ordinary manager resolution, without overrides, peer exceptions or source links. */
export async function qualifyPackedEslintInstallations(
  input: PackedEslintInstallationInput,
): Promise<void> {
  const expected: EslintSyntaxArtifactExpectation = {
    packageVersion: input.artifact.packageVersion,
    notices: await readFile(join(input.sourcePackageRoot, "THIRD_PARTY_NOTICES.md"), "utf8"),
    provenance: await readFile(
      join(input.sourcePackageRoot, "eslint-syntax-provenance.json"),
      "utf8",
    ),
  };
  // These minimal consumers cannot borrow dependencies from the larger Foundation fixture.
  for (const manager of ["npm", "pnpm"] as const) {
    for (const explicitHost of [false, true]) {
      await qualifyInstallation(input, expected, manager, explicitHost);
    }
  }
}
