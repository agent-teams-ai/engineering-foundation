import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = join(
  repositoryRoot,
  "packages",
  "engineering-foundation"
);
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "agent-teams-foundation-pack-")
);

const forbiddenEntries = [
  "/.git/",
  "/node_modules/",
  "/src/",
  "/tests/",
  ".env",
  "auth.json",
  "foundation-link.json"
];

try {
  await execFileAsync(
    "pnpm",
    ["pack", "--pack-destination", temporaryRoot],
    { cwd: packageRoot }
  );

  const archiveName = (await readdir(temporaryRoot)).find((name) =>
    name.endsWith(".tgz")
  );
  if (archiveName === undefined) {
    throw new Error("pnpm pack did not produce a tarball.");
  }

  const archivePath = join(temporaryRoot, archiveName);
  const { stdout: listing } = await execFileAsync(
    "tar",
    ["-tzf", archivePath],
    { cwd: temporaryRoot }
  );
  for (const forbidden of forbiddenEntries) {
    if (listing.includes(forbidden)) {
      throw new Error(`Forbidden package entry detected: ${forbidden}`);
    }
  }
  for (const required of [
    "package/package.json",
    "package/LICENSE",
    "package/README.md",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/cli.js"
  ]) {
    if (!listing.split(/\r?\n/u).includes(required)) {
      throw new Error(`Required package entry missing: ${required}`);
    }
  }

  const consumerRoot = join(temporaryRoot, "consumer");
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "foundation-pack-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        packageManager: "pnpm@11.18.0",
        dependencies: {
          "@agent-teams/engineering-foundation": `file:${archivePath}`
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await execFileAsync(
    "pnpm",
    ["install", "--ignore-scripts", "--no-frozen-lockfile"],
    { cwd: consumerRoot }
  );
  await execFileAsync(
    "node",
    [
      "--input-type=module",
      "--eval",
      [
        'import { defineFoundationConfig } from "@agent-teams/engineering-foundation";',
        "const config = defineFoundationConfig({",
        "  schemaVersion: 1,",
        '  projectId: "pack-consumer",',
        '  projectKind: "tooling",',
        "  capabilities: { lint: { enabled: true } }",
        "});",
        'if (config.projectId !== "pack-consumer") process.exit(2);'
      ].join("\n")
    ],
    { cwd: consumerRoot }
  );
  const { stdout: versionOutput } = await execFileAsync(
    "pnpm",
    ["exec", "agent-teams-foundation", "--version"],
    { cwd: consumerRoot }
  );

  const packedManifest = JSON.parse(
    await readFile(
      join(
        consumerRoot,
        "node_modules",
        "@agent-teams",
        "engineering-foundation",
        "package.json"
      ),
      "utf8"
    )
  );
  if (versionOutput.trim() !== packedManifest.version) {
    throw new Error("Packed CLI version differs from packed package version.");
  }

  process.stdout.write(
    `Package tarball verified: ${archiveName} (${packedManifest.version})\n`
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
