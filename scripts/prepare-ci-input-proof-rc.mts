import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { appendFile, copyFile, cp, lstat, mkdir, open, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const packageRoot = "packages/ci-input-proof";
const packageName = "@agent-teams/ci-input-proof";
const version = "0.1.0-rc.0";

function run(command: string, args: string[], cwd = root): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 60_000, env: { ...process.env, CI: "true" } });
}

function fileIdentity(stat: Stats): readonly number[] {
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs];
}

async function main(): Promise<void> {
  const [destinationArgument, expectedCommit] = process.argv.slice(2);
  assert(destinationArgument && expectedCommit && /^[a-f0-9]{40}$/u.test(expectedCommit), "new output directory and exact source commit required");
  assert.equal(run("git", ["rev-parse", "HEAD"]).trim(), expectedCommit);
  assert.equal(run("git", ["status", "--porcelain", "--untracked-files=normal"]).trim(), "", "source checkout must be clean");
  const destination = resolve(await realpath(dirname(resolve(destinationArgument))), basename(destinationArgument));
  const fromSource = relative(await realpath(root), destination);
  assert(fromSource === ".." || fromSource.startsWith(`..${sep}`) || isAbsolute(fromSource), "output must be outside source");
  assert(!/[\r\n]/u.test(destination), "output path cannot contain newlines");
  const cli = require.resolve("@changesets/cli/bin.js");
  const cliManifest = JSON.parse(await readFile(require.resolve("@changesets/cli/package.json"), "utf8")) as { version: string };
  assert.equal(cliManifest.version, "2.31.1", "release derivation requires the reviewed CLI pin");
  const compilerManifestPath = require.resolve("typescript/package.json");
  const compiler = JSON.parse(await readFile(compilerManifestPath, "utf8")) as { version: string; bin: { tsc: string } };
  assert.equal(compiler.version, "7.0.2", "build requires the reviewed compiler pin");
  const original = JSON.parse(await readFile(resolve(root, packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
  assert.equal(original.name, packageName);
  assert.equal(original.version, "0.0.0", "first RC preparation cannot advance an existing release");
  const trackedEntries = run("git", ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean).map(entry => {
    const separator = entry.indexOf("\t");
    const [mode, , stage] = entry.slice(0, separator).split(" ");
    assert(separator > 0 && stage === "0" && ["100644", "100755", "120000"].includes(mode ?? ""), "unsupported Git source entry");
    return { path: entry.slice(separator + 1), symlink: mode === "120000" };
  });
  async function sourceInventory(): Promise<Record<string, string>> {
    return Object.fromEntries(await Promise.all(trackedEntries.map(async ({ path, symlink: isLink }) => {
      const absolute = resolve(root, path);
      let stat: Stats;
      let bytes: string | Buffer;
      if (isLink) {
        // Index type selects the operation; readlink never follows the target.
        bytes = await readlink(absolute);
        stat = await lstat(absolute);
        assert(stat.isSymbolicLink(), `source link replaced during read: ${path}`);
      } else {
        const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          stat = await file.stat();
          assert(stat.isFile(), `unsupported tracked source entry: ${path}`);
          bytes = await file.readFile();
          assert.deepEqual(fileIdentity(await file.stat()), fileIdentity(stat), `source entry changed during read: ${path}`);
        } finally {
          await file.close();
        }
      }
      assert.deepEqual(fileIdentity(await lstat(absolute)), fileIdentity(stat), `source path changed during read: ${path}`);
      return [path, `${stat.mode}:${createHash("sha256").update(bytes).digest("hex")}`];
    })));
  }
  const before = await sourceInventory();
  assert.equal(run("git", ["status", "--porcelain", "--untracked-files=normal"]).trim(), "", "source checkout changed during inventory");
  await mkdir(destination); // Refuse reuse; never delete a previous artifact or another run's output.
  try {
    const projection = resolve(destination, "projection");
    const projectedPackage = resolve(projection, packageRoot);
    await mkdir(projectedPackage, { recursive: true });
    await mkdir(resolve(projection, ".changeset"));
    await writeFile(resolve(projection, "package.json"), JSON.stringify({ name: "ci-input-proof-rc-projection", private: true, packageManager: "pnpm@11.20.0" }));
    await copyFile(resolve(root, "pnpm-workspace.yaml"), resolve(projection, "pnpm-workspace.yaml"));
    await copyFile(resolve(root, packageRoot, "package.json"), resolve(projectedPackage, "package.json"));
    await copyFile(resolve(root, ".changeset/ci-input-proof-kernel.md"), resolve(projection, ".changeset/ci-input-proof-kernel.md"));
    const config = JSON.parse(await readFile(resolve(root, ".changeset/config.json"), "utf8")) as Record<string, unknown>;
    // The standard CLI changelog has no GitHub API dependency. Other release policy is retained.
    await writeFile(resolve(projection, ".changeset/config.json"), JSON.stringify({ ...config, changelog: [require.resolve("@changesets/cli/changelog"), null] }));
    for (const file of ["README.md", "CHANGELOG.md"]) {
      await copyFile(resolve(root, packageRoot, file), resolve(projectedPackage, file));
    }
    await copyFile(resolve(root, "LICENSE"), resolve(projectedPackage, "LICENSE"));
    run(process.execPath, [cli, "pre", "enter", "rc"], projection);
    run(process.execPath, [cli, "version"], projection);
    const generated = JSON.parse(await readFile(resolve(projectedPackage, "package.json"), "utf8")) as Record<string, unknown>;
    assert.equal(generated.version, version);
    assert.deepEqual({ ...generated, version: original.version }, original, "versioning cannot change unrelated manifest fields");
    const pre = JSON.parse(await readFile(resolve(projection, ".changeset/pre.json"), "utf8")) as { initialVersions: Record<string, string>; changesets: string[] };
    assert.deepEqual(pre.initialVersions, { [packageName]: "0.0.0" });
    assert.deepEqual(pre.changesets, ["ci-input-proof-kernel"]);
    // npm treats automatic generation and a supplied bundle as mutually exclusive.
    // This signed artifact uses the latter; canonical source keeps automatic CI provenance.
    const publishConfig = generated.publishConfig as Record<string, unknown>;
    const { provenance: automaticProvenance, ...providedBundlePublishConfig } = publishConfig;
    assert.equal(automaticProvenance, true);
    generated.publishConfig = providedBundlePublishConfig;
    await writeFile(resolve(projectedPackage, "package.json"), `${JSON.stringify(generated, null, 2)}\n`);
    // Compile in the fresh projection so an ignored stale dist cannot enter the archive.
    await cp(resolve(root, packageRoot, "src"), resolve(projectedPackage, "src"), { recursive: true });
    await copyFile(resolve(root, packageRoot, "tsconfig.json"), resolve(projectedPackage, "tsconfig.json"));
    run(process.execPath, [resolve(dirname(compilerManifestPath), compiler.bin.tsc), "--build", resolve(projectedPackage, "tsconfig.json"), "--pretty", "false"]);
    const archiveDirectory = resolve(destination, "archive");
    await mkdir(archiveDirectory);
    const report = JSON.parse(run("pnpm", ["pack", "--pack-destination", archiveDirectory, "--json", "--config.ignore-scripts=true", "--config.verify-deps-before-run=false"], projectedPackage)) as { filename: string };
    assert.equal(typeof report.filename, "string");
    const archivePath = resolve(projectedPackage, report.filename);
    assert.equal(dirname(archivePath), archiveDirectory, "archive must belong to this output directory");
    const packed = JSON.parse(run("tar", ["-xOf", archivePath, "package/package.json"])) as { name: string; version: string };
    assert.equal(packed.name, packageName);
    assert.equal(packed.version, version);
    const archive = await readFile(archivePath);
    const sha512 = createHash("sha512").update(archive).digest("hex");
    const subject = `pkg:npm/%40agent-teams/ci-input-proof@${version}`;
    const receipt = { schemaVersion: 1, package: packageName, version, tag: "rc", sourceCommit: expectedCommit, cliVersion: cliManifest.version, provenanceMode: "provided-bundle", sha512, subject, archiveFile: basename(archivePath), sourceFilesChecked: trackedEntries.length };
    assert.deepEqual(await sourceInventory(), before, "release preparation cannot modify canonical source files");
    await writeFile(resolve(destination, "artifact.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `sha512=${sha512}\nsubject=${subject}\narchive_path=${archivePath}\n`);
    }
    console.log(JSON.stringify(receipt));
  } finally {
    assert.deepEqual(await sourceInventory(), before, "canonical source must remain unchanged after failure too");
    assert.equal(run("git", ["rev-parse", "HEAD"]).trim(), expectedCommit, "canonical source commit must stay fixed");
    assert.equal(run("git", ["status", "--porcelain", "--untracked-files=normal"]).trim(), "", "canonical source checkout must stay clean");
  }
}

await main();
