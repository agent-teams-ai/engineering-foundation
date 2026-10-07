import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// This tests the Linux-only artifact-preparation adapter used by the Actions job.
// It fails on unrelated source mutation, stale distribution inclusion, wrong RC,
// missing public implementation, or accidental reuse of a previous output.
test("first RC is CLI-derived, importable and isolated from authoritative changesets", { skip: process.platform !== "linux", timeout: 120_000 }, async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "ci-input-proof-rc-TEST-"));
  const source = resolve(sandbox, "source");
  const env = { ...process.env, GIT_AUTHOR_NAME: "iliya", GIT_AUTHOR_EMAIL: "iliyazelenkog@gmail.com", GIT_COMMITTER_NAME: "iliya", GIT_COMMITTER_EMAIL: "iliyazelenkog@gmail.com" };
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: source, env, encoding: "utf8" });
  try {
    await mkdir(source);
    for (const path of ["packages/ci-input-proof", ".changeset", "pnpm-workspace.yaml", "LICENSE"]) {
      await cp(resolve(root, path), resolve(source, path), { recursive: true });
    }
    await mkdir(resolve(source, "scripts"));
    await cp(resolve(root, "scripts/prepare-ci-input-proof-rc.mts"), resolve(source, "scripts/prepare-ci-input-proof-rc.mts"));
    await writeFile(resolve(source, "package.json"), JSON.stringify({ name: "ci-input-proof-release-TEST", private: true, packageManager: "pnpm@11.20.0" }));
    await writeFile(resolve(source, ".gitignore"), "node_modules\npackages/*/dist/\npackages/*/*.tsbuildinfo\n");
    await symlink(resolve(root, "node_modules"), resolve(source, "node_modules"));
    await symlink("packages", resolve(source, "tracked-directory-link"));
    // An ignored stale dist file must never get packed, even with a clean Git checkout.
    await mkdir(resolve(source, "packages/ci-input-proof/dist"), { recursive: true });
    await writeFile(resolve(source, "packages/ci-input-proof/dist/stale.js"), "throw new Error('stale distribution');\n");
    git("init", "--initial-branch=main");
    assert.match(git("var", "GIT_AUTHOR_IDENT"), /^iliya <iliyazelenkog@gmail\.com> /u);
    assert.match(git("var", "GIT_COMMITTER_IDENT"), /^iliya <iliyazelenkog@gmail\.com> /u);
    git("add", ".");
    git("commit", "-m", "test: initialize first RC TEST fixture");
    const commit = git("rev-parse", "HEAD").trim();
    const output = resolve(sandbox, "artifact");
    const prepare = (destination: string, sha = commit, nodeArgs: string[] = []): string => execFileSync(process.execPath, [...nodeArgs, resolve(source, "scripts/prepare-ci-input-proof-rc.mts"), destination, sha], { cwd: source, env, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    prepare(output);
    const receipt = JSON.parse(await readFile(resolve(output, "artifact.json"), "utf8")) as { version: string; tag: string; archiveFile: string; sha512: string; subject: string; sourceCommit: string };
    assert.equal(receipt.version, "0.1.0-rc.0");
    assert.equal(receipt.tag, "rc");
    assert.equal(receipt.sourceCommit, commit);
    assert.equal(receipt.subject, "pkg:npm/%40agent-teams/ci-input-proof@0.1.0-rc.0");
    const archive = resolve(output, "archive", receipt.archiveFile);
    assert.equal(receipt.sha512, createHash("sha512").update(await readFile(archive)).digest("hex"));
    const entries = execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).split("\n");
    assert(!entries.includes("package/dist/stale.js"));
    assert(entries.includes("package/dist/index.js"));
    assert(entries.includes("package/dist/index.d.ts"));
    const clean = resolve(sandbox, "unpacked");
    await mkdir(clean);
    execFileSync("tar", ["-xf", archive, "-C", clean]);
    const packedManifest = JSON.parse(await readFile(resolve(clean, "package/package.json"), "utf8")) as { publishConfig: Record<string, unknown> };
    assert(!Object.hasOwn(packedManifest.publishConfig, "provenance"), "provided-bundle archive must not request automatic regeneration");
    const sourceManifest = JSON.parse(await readFile(resolve(source, "packages/ci-input-proof/package.json"), "utf8")) as { publishConfig: { provenance: boolean } };
    assert.equal(sourceManifest.publishConfig.provenance, true, "canonical ordinary CI publication policy must stay enabled");
    const probe = resolve(clean, "package/public-import-probe.mts");
    await writeFile(probe, `import { compareLeafInventories } from "@agent-teams/ci-input-proof";\nconst same = { version: 1, digestScheme: "sha256", inputs: [{ path: "package.json", type: "file", mode: "100644", membership: "closed", content: "1".repeat(64) }] };\nconsole.log(JSON.stringify(compareLeafInventories(same, same, [])));\n`);
    const compilerManifestPath = createRequire(import.meta.url).resolve("typescript/package.json");
    const compiler = JSON.parse(await readFile(compilerManifestPath, "utf8")) as { bin: { tsc: string } };
    execFileSync(process.execPath, [resolve(dirname(compilerManifestPath), compiler.bin.tsc), "--ignoreConfig", "--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2024", probe], { cwd: resolve(clean, "package"), env, stdio: "pipe" });
    const publicResult = execFileSync(process.execPath, [probe], { cwd: resolve(clean, "package"), env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.deepEqual(JSON.parse(publicResult), { status: "compatible-inputs", changedContentPaths: [] });
    assert.match(await readFile(resolve(clean, "package/CHANGELOG.md"), "utf8"), /0\.1\.0-rc\.0/u);
    assert.equal(git("status", "--porcelain").trim(), "");
    await writeFile(resolve(output, "sentinel"), "retain prior output");
    assert.throws(() => prepare(output), (error: unknown) => error instanceof Error && "stderr" in error && String(error.stderr).includes("EEXIST"), "existing output must be rejected before reuse");
    assert.throws(() => prepare(resolve(sandbox, "wrong-head"), "0".repeat(40)), (error: unknown) => error instanceof Error && "stderr" in error && String(error.stderr).includes("ERR_ASSERTION"), "wrong source head must be rejected");
    assert.equal(await readFile(resolve(output, "sentinel"), "utf8"), "retain prior output");
    assert.equal(git("status", "--porcelain").trim(), "");
    // A real replacement between stat and read must fail before any output exists.
    const raceFile = resolve(source, "LICENSE");
    const originalBytes = await readFile(raceFile);
    const external = resolve(sandbox, "external-TEST-file");
    await writeFile(external, "external TEST bytes must not be read or packed");
    const hook = resolve(sandbox, "race-preload.mts");
    await writeFile(hook, `import fs from "node:fs/promises";\nimport { syncBuiltinESMExports } from "node:module";\nconst original = fs.lstat;\nlet swapped = false;\nfs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {\n  const stat = await original(...args);\n  if (!swapped && String(args[0]) === ${JSON.stringify(raceFile)}) {\n    swapped = true;\n    await fs.unlink(${JSON.stringify(raceFile)});\n    await fs.symlink(${JSON.stringify(external)}, ${JSON.stringify(raceFile)});\n  }\n  return stat;\n}) as typeof fs.lstat;\nsyncBuiltinESMExports();\n`);
    execFileSync(process.execPath, [resolve(dirname(compilerManifestPath), compiler.bin.tsc), "--ignoreConfig", "--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2024", "--typeRoots", resolve(root, "node_modules/@types"), "--types", "node", "--skipLibCheck", hook], { cwd: source, env, stdio: "pipe" });
    const racedOutput = resolve(sandbox, "raced-output");
    try {
      assert.throws(() => prepare(racedOutput, commit, ["--import", hook]), (error: unknown) => error instanceof Error && "stderr" in error && /ELOOP|ERR_ASSERTION/u.test(String(error.stderr)), "a replaced source file must be rejected before creating an artifact");
      await assert.rejects(lstat(racedOutput), { code: "ENOENT" });
    } finally {
      await unlink(raceFile);
      await writeFile(raceFile, originalBytes);
    }
    assert.equal(git("status", "--porcelain").trim(), "");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
