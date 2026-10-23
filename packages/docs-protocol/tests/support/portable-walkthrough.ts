import { docsNewV2 } from "../../dist/index.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { DocsNewRequest } from "../../dist/index.js";
import { assertDocsCommandEnvelopeSchema } from "../../dist/features/docs-command/adapters/outbound/docs-command-envelope-schema-validator.js";

export type SnapshotReader = (root: string) => Promise<unknown>;

export const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
export const intent = {
  type: "adr",
  id: "ADR-0001",
  title: "Portable documentation",
  owner: "documentation/team",
  summary: "Adopt portable documentation.",
};
export function request<Overrides extends Partial<DocsNewRequest>>(
  root: string,
  overrides: Overrides,
) {
  return {
    consumerRoot: root,
    profilePath: "docs.config.yaml",
    intent,
    ...overrides,
  };
}

export async function runCli(args: readonly string[], cwd: string) {
  let stdout: string;
  let stderr: string;
  let exitCode: string | number | undefined;
  try {
    const result = await execute(process.execPath, [cli, ...args], { cwd });
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = 0;
  } catch (error) {
    assert.ok(error instanceof Error && "stdout" in error && "stderr" in error && "code" in error);
    assert.equal(typeof error.stdout, "string");
    assert.equal(typeof error.stderr, "string");
    assert.ok(typeof error.stdout === "string" && typeof error.stderr === "string");
    assert.ok(
      typeof error.code === "number" || typeof error.code === "string" || error.code === undefined,
    );
    stdout = error.stdout;
    stderr = error.stderr;
    exitCode = error.code;
  }
  assert.equal(stderr, "");
  const envelope: unknown = JSON.parse(stdout);
  await assertDocsCommandEnvelopeSchema(envelope);
  assertRecord(envelope);
  assertRecord(envelope.result);
  return { envelope: { ...envelope, result: envelope.result }, exitCode };
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
}
function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  assert.equal(typeof value, "string");
  assert.ok(typeof value === "string");
  return value;
}

export function words(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/gu)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

export async function literalRootOnboarding(root: string, snapshot: SnapshotReader): Promise<void> {
  const document = await readFile(
    new URL("../../../../docs/reference/open-source-docs-protocol.md", import.meta.url),
    "utf8",
  );
  const walkthrough = document.slice(
    document.indexOf("## Preview and apply bootstrap"),
    document.indexOf("## Optional MCP transport"),
  );
  const commands = [...walkthrough.matchAll(/```bash\n([\s\S]*?)```/gu)].flatMap((match) =>
    match[1]!
      .replace(/\\\n\s*/gu, " ")
      .trim()
      .split("\n"),
  );
  assert.equal(commands.length, 7, "execute every literal root walkthrough command");
  const digests = new Map<string, string>();
  for (const command of commands) {
    const [binary, operation] = words(command);
    assert.ok(operation !== undefined && operation !== "");
    assert.equal(binary, "docs-protocol");
    const args = words(
      command.replace("sha256:PLAN_DIGEST_FROM_DRY_RUN", digests.get(operation) ?? "missing"),
    ).slice(1);
    const before = await snapshot(root);
    const result = await execute(process.execPath, [cli, ...args], { cwd: root });
    assert.equal(result.stderr, "");
    if (args.includes("--dry-run")) {
      assert.deepEqual(await snapshot(root), before);
      const digest = /^Plan: (sha256:[0-9a-f]{64})$/mu.exec(result.stdout)?.[1];
      assert.ok(
        digest !== undefined && digest !== "",
        `${operation} human preview must expose its reviewable Plan digest`,
      );
      digests.set(operation, digest);
    }
    if (operation === "new" && args.includes("--apply")) {
      assert.equal(args[args.indexOf("--expect") + 1], digests.get("new"));
      assert.notEqual(digests.get("new"), digests.get("init"));
      const instruction = /^Next: add (\[.*\]\(.*\)) to (docs\/.*)$/mu.exec(result.stdout);
      assert.ok(instruction, "complete the returned manual reachability instruction");
      const index = join(root, instruction[2] ?? "");
      await writeFile(index, `${await readFile(index, "utf8")}\n${instruction[1]}\n`);
    }
    if (operation === "check") {
      assert.match(result.stdout, /^docs.check: success$/mu);
    }
  }
  assert.match(
    await readFile(join(root, "docs/decisions/0083-tenant-isolation.md"), "utf8"),
    /^owner: documentation\/team$/mu,
  );
}

export async function literalReadmeWalkthrough(
  root: string,
  snapshot: SnapshotReader,
): Promise<void> {
  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
  const quickstart = readme.slice(
    readme.indexOf("docs-protocol init"),
    readme.indexOf("See the [community workflow]"),
  );
  const commands = quickstart
    .replace(/\\\n\s*/gu, " ")
    .split("\n")
    .filter((line) => line.startsWith("docs-protocol "));
  assert.equal(commands.length, 7, "execute every command in the literal quickstart");
  let initDigest: string | undefined;
  let newDigest: string | undefined;
  for (const command of commands) {
    const args = words(
      command
        .replace("sha256:NEW_PLAN_DIGEST_FROM_PREVIEW", newDigest ?? "missing")
        .replace("sha256:PLAN_DIGEST_FROM_PREVIEW", initDigest ?? "missing"),
    ).slice(1);
    const before = await snapshot(root);
    const result = await runCli(args, root);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    if (args.includes("--dry-run")) {
      assert.deepEqual(await snapshot(root), before);
      if (args[0] === "init") {
        initDigest = stringField(result.envelope.result, "planDigest");
      } else {
        newDigest = stringField(result.envelope.result, "planDigest");
      }
    }
    if (args[0] === "new" && args.includes("--apply")) {
      assert.equal(result.envelope.result.planDigest, newDigest);
      assert.equal(result.envelope.result.writeState, "applied");
      const reachability = result.envelope.result.reachability;
      assertRecord(reachability);
      assert.equal(reachability.state, "manual-required");
      const index = join(root, stringField(reachability, "indexPath"));
      await writeFile(
        index,
        `${await readFile(index, "utf8")}\n${stringField(reachability, "markdownLink")}\n`,
      );
    }
  }
  assert.match(
    await readFile(join(root, "docs/decisions/0001-portable-documentation.md"), "utf8"),
    /^owner: documentation\/team$/mu,
  );
}

export async function checkAuthorityChanges(root: string, snapshot: SnapshotReader): Promise<void> {
  const changes: readonly (readonly [string, (source: string) => string])[] = [
    [
      ".docs-protocol/templates/adr.md",
      (s) => s.replace("## Context", "## Context\n\nAdditional approved template guidance."),
    ],
    ["docs/README.md", (s) => s.replace("summary: ", "summary: Updated catalog. ")],
    [
      ".docs-protocol/document-authoring.yaml",
      (s) => s.replace("initialStatus: proposed", "initialStatus: accepted"),
    ],
  ];
  for (const [path, change] of changes) {
    const preview = await docsNewV2(request(root, { apply: false }));
    assert.equal(preview.envelope.result.writeState, "preview");
    const original = await readFile(join(root, path), "utf8");
    await writeFile(join(root, path), change(original));
    const before = await snapshot(root);
    const changed = await docsNewV2(request(root, { apply: false }));
    assert.ok(changed.envelope.result.writeState === "preview");
    assert.notEqual(changed.envelope.result.planDigest, preview.envelope.result.planDigest, path);
    const rejected = await docsNewV2(
      request(root, { apply: true, expectedPlanDigest: preview.envelope.result.planDigest }),
    );
    assert.equal(rejected.envelope.outcome, "authority-stale", path);
    assert.deepEqual(await snapshot(root), before, path);
    await writeFile(join(root, path), original);
  }
}

export const supported = {
  skip:
    process.platform === "win32" &&
    "Known-file mutation is unsupported on Windows; separate refusal test covers that contract.",
};
export function newCliArguments(): string[] {
  return [
    "new",
    "--type",
    intent.type,
    "--id",
    intent.id,
    "--title",
    intent.title,
    "--owner",
    intent.owner,
    "--summary",
    intent.summary,
    "--json",
  ];
}
