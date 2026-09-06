import { DocsProtocol } from "../dist/features/portable-documentation/application/docs-protocol.js";
import { YamlCompiledOutputReader } from "../dist/features/portable-documentation/adapters/outbound/yaml-compiled-output-reader.js";
import { createCommunityMiniSearchIndex } from "../dist/features/portable-documentation/adapters/outbound/minisearch-adapter.js";
import { createDocsProtocolApi } from "../dist/features/docs-command/adapters/inbound/protocol-api.js";
import { NodeDocumentAuthoringPort } from "../dist/features/portable-documentation/adapters/outbound/document-authoring-port.js";
import { NodeDocsProfileReader } from "../dist/features/portable-documentation/adapters/outbound/node-profile-reader.js";
import { NodeDocsAdoptionInspector } from "../dist/features/portable-documentation/adapters/outbound/node-adoption-inspector.js";
import { NodeCodeAnchorMatcher } from "../dist/features/portable-documentation/adapters/outbound/node-code-anchor-matcher.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { docsInitApply, docsInitPlan, docsNewV2, docsCheckV2 } from "../dist/index.js";
import { assertDocsCommandEnvelopeSchema } from "../dist/features/docs-command/adapters/outbound/docs-command-envelope-schema-validator.js";
import { portableRepository, snapshot } from "./fixtures/portable-test-repository.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const supported = { skip: process.platform === "win32" && "Known-file mutation is unsupported on Windows; separate refusal test covers that contract." };
const intent = { type: "adr", id: "ADR-0001", title: "Portable documentation", owner: "documentation/team", summary: "Adopt portable documentation." };
const request = (root, overrides = {}) => ({ consumerRoot: root, profilePath: "docs.config.yaml", intent, ...overrides });

async function runCli(args, cwd) {
  let result;
  try {result = { ...await execute(process.execPath, [cli, ...args], { cwd }), code: 0 };}
  catch (error) {result = error;}
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  await assertDocsCommandEnvelopeSchema(envelope);
  return { envelope, exitCode: result.code };
}

function words(command) {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/gu)].map((match) => match[1] ?? match[2] ?? match[3]);
}

test("literal root onboarding completes human previews, reviewed applies and reachability", supported, async () => portableRepository(async (root) => {
  const document = await readFile(new URL("../../../docs/reference/open-source-docs-protocol.md", import.meta.url), "utf8");
  const walkthrough = document.slice(document.indexOf("## Preview and apply bootstrap"), document.indexOf("## Optional MCP transport"));
  const commands = [...walkthrough.matchAll(/```bash\n([\s\S]*?)```/gu)]
    .flatMap((match) => match[1].replace(/\\\n\s*/gu, " ").trim().split("\n"));
  assert.equal(commands.length, 7, "execute every literal root walkthrough command");
  const digests = new Map();
  for (const command of commands) {
    const [binary, operation] = words(command);
    assert.equal(binary, "docs-protocol");
    const args = words(command.replace("sha256:PLAN_DIGEST_FROM_DRY_RUN", digests.get(operation) ?? "missing")).slice(1);
    const before = await snapshot(root);
    const result = await execute(process.execPath, [cli, ...args], { cwd: root });
    assert.equal(result.stderr, "");
    if (args.includes("--dry-run")) {
      assert.deepEqual(await snapshot(root), before);
      const digest = /^Plan: (sha256:[0-9a-f]{64})$/mu.exec(result.stdout)?.[1];
      assert.ok(digest, `${operation} human preview must expose its reviewable Plan digest`);
      digests.set(operation, digest);
    }
    if (operation === "new" && args.includes("--apply")) {
      assert.equal(args[args.indexOf("--expect") + 1], digests.get("new"));
      assert.notEqual(digests.get("new"), digests.get("init"));
      const instruction = /^Next: add (\[.*\]\(.*\)) to (docs\/.*)$/mu.exec(result.stdout);
      assert.ok(instruction, "complete the returned manual reachability instruction");
      const index = join(root, instruction[2]);
      await writeFile(index, `${await readFile(index, "utf8")}\n${instruction[1]}\n`);
    }
    if (operation === "check") {assert.match(result.stdout, /^docs.check: success$/mu);}
  }
  assert.match(await readFile(join(root, "docs/decisions/0083-tenant-isolation.md"), "utf8"), /^owner: documentation\/team$/mu);
}, { bootstrap: false }));

test("literal README walkthrough uses its generated owner and reviewed new digest", supported, async () => portableRepository(async (root) => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const quickstart = readme.slice(readme.indexOf("docs-protocol init"), readme.indexOf("See the [community workflow]"));
  const commands = quickstart.replace(/\\\n\s*/gu, " ").split("\n").filter((line) => line.startsWith("docs-protocol "));
  assert.equal(commands.length, 7, "execute every command in the literal quickstart");
  let initDigest;
  let newDigest;
  for (const command of commands) {
    const args = words(command.replace("sha256:NEW_PLAN_DIGEST_FROM_PREVIEW", newDigest ?? "missing").replace("sha256:PLAN_DIGEST_FROM_PREVIEW", initDigest ?? "missing")).slice(1);
    const before = await snapshot(root);
    const result = await runCli(args, root);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    if (args.includes("--dry-run")) {
      assert.deepEqual(await snapshot(root), before);
      if (args[0] === "init") {initDigest = result.envelope.result.planDigest;}
      else {newDigest = result.envelope.result.planDigest;}
    }
    if (args[0] === "new" && args.includes("--apply")) {
      assert.equal(result.envelope.result.planDigest, newDigest);
      assert.equal(result.envelope.result.writeState, "applied");
      const reachability = result.envelope.result.reachability;
      assert.equal(reachability.state, "manual-required");
      const index = join(root, reachability.indexPath);
      await writeFile(index, `${await readFile(index, "utf8")}\n${reachability.markdownLink}\n`);
    }
  }
  assert.match(await readFile(join(root, "docs/decisions/0001-portable-documentation.md"), "utf8"), /^owner: documentation\/team$/mu);
}, { bootstrap: false }));

test("API and CLI refuse unreviewed bytes without any persisted effects", supported, async () => portableRepository(async (root) => {
  const preview = await docsNewV2(request(root, { apply: false }));
  const digest = preview.envelope.result.planDigest;
  const before = await snapshot(root);
  const args = ["new", "--type", intent.type, "--id", intent.id, "--title", intent.title, "--owner", intent.owner, "--summary", intent.summary, "--json"];
  for (const [expectedPlanDigest, outcome, exitCode] of [
    ["bad", "invalid-input", 2], [`sha256:${"0".repeat(64)}`, "authority-stale", 1], [`${digest}\n`, "invalid-input", 2]
  ]) {
    for (const response of [
      await docsNewV2(request(root, { apply: true, expectedPlanDigest })),
      await runCli([...args, "--apply", "--expect", expectedPlanDigest], root)
    ]) {
      assert.equal(response.exitCode, exitCode);
      assert.equal(response.envelope.outcome, outcome);
      await assertDocsCommandEnvelopeSchema(response.envelope);
      assert.deepEqual(await snapshot(root), before);
    }
  }
  for (const suffix of [["--dry-run", "--expect", digest], ["--apply", "--expect"], ["--apply", "--expect", digest, "--expect", digest]]) {
    assert.equal((await runCli([...args, ...suffix], root)).exitCode, 2);
    assert.deepEqual(await snapshot(root), before);
  }
  const applied = await docsNewV2(request(root, { apply: true, expectedPlanDigest: digest }));
  assert.equal(applied.envelope.result.writeState, "applied");
  assert.equal(applied.envelope.result.compiled.document.content, preview.envelope.result.compiled.document.content);
  assert.equal(await readFile(join(root, applied.envelope.result.documentPath), "utf8"), preview.envelope.result.compiled.document.content);
}));

test("template, catalog and authoring authority changes invalidate the reviewed Plan", supported, async () => portableRepository(async (root) => {
  const changes = [
    [".docs-protocol/templates/adr.md", (s) => s.replace("## Context", "## Context\n\nAdditional approved template guidance.")],
    ["docs/README.md", (s) => s.replace("summary: ", "summary: Updated catalog. ")],
    [".docs-protocol/document-authoring.yaml", (s) => s.replace("initialStatus: proposed", "initialStatus: accepted")]
  ];
  for (const [path, change] of changes) {
    const preview = await docsNewV2(request(root, { apply: false }));
    const original = await readFile(join(root, path), "utf8");
    await writeFile(join(root, path), change(original));
    const before = await snapshot(root);
    const changed = await docsNewV2(request(root, { apply: false }));
    assert.notEqual(changed.envelope.result.planDigest, preview.envelope.result.planDigest, path);
    const rejected = await docsNewV2(request(root, { apply: true, expectedPlanDigest: preview.envelope.result.planDigest }));
    assert.equal(rejected.envelope.outcome, "authority-stale", path);
    assert.deepEqual(await snapshot(root), before, path);
    await writeFile(join(root, path), original);
  }
}));

test("outer profile is distinct from Plan identity and current blocker policy still applies", supported, async () => portableRepository(async (root) => {
  const blocker = await docsNewV2(request(root, { apply: true }));
  assert.equal(blocker.envelope.result.writeState, "applied", "direct Apply remains supported");
  const subject = request(root, { apply: false, intent: { ...intent, id: "ADR-0002", title: "Dependent decision" }, blockedBy: ["ADR-0001"] });
  const preview = await docsNewV2(subject);
  const profilePath = join(root, "docs.config.yaml");
  const original = await readFile(profilePath, "utf8");
  await writeFile(profilePath, original.replace("subjectIncompatibleStatuses: [accepted, active, deprecated, superseded]", "subjectIncompatibleStatuses: [done]"));
  const changedOuter = await docsNewV2(subject);
  assert.equal(changedOuter.envelope.result.planDigest, preview.envelope.result.planDigest);
  await writeFile(profilePath, original.replace("statuses: [proposed]", "statuses: [todo]"));
  const before = await snapshot(root);
  await assert.rejects(docsNewV2({ ...subject, apply: true, expectedPlanDigest: preview.envelope.result.planDigest }), /configured blocker/u);
  assert.deepEqual(await snapshot(root), before);
}));

test("metadata format remains annotation while explicit schema constraints enforce values", supported, async () => portableRepository(async (root) => {
  const path = join(root, ".docs-protocol/metadata.schema.json");
  const schema = JSON.parse(await readFile(path, "utf8"));
  schema.properties.evidence_url = { type: "string", format: "uri" };
  await writeFile(path, JSON.stringify(schema));
  const input = request(root, { apply: false, additionalMetadata: { evidence_url: "not a URI" } });
  assert.equal((await docsNewV2(input)).envelope.outcome, "success");
  schema.properties.evidence_url.pattern = "^https://";
  await writeFile(path, JSON.stringify(schema));
  await assert.rejects(docsNewV2(input));
  assert.equal((await docsCheckV2(request(root))).envelope.outcome, "success");
}));

test("Windows bootstrap mutation explicitly refuses before effects", { skip: process.platform !== "win32" && "Windows refusal requires Windows" }, async () => portableRepository(async (root, init) => {
  const preview = await docsInitPlan(init);
  const before = await snapshot(root);
  await assert.rejects(docsInitApply({ ...init, expectedPlanDigest: preview.planDigest }), (error) => error.code === "KNOWN_FILE_APPLY_UNSUPPORTED");
  assert.deepEqual(await snapshot(root), before);
}, { bootstrap: false }));


test("consumer feature example enforces declared layer edges and curated entrypoints", async () => portableRepository(async (root) => {
  await cp(new URL("./fixtures/feature-module-example", import.meta.url), root, { recursive: true });
  const foundation = fileURLToPath(new URL("../../engineering-foundation/dist/cli.js", import.meta.url));
  const check = async () => {
    try { return { ...await execute(process.execPath, [foundation, "check", "--consumer", root]), code: 0 }; }
    catch (error) { return error; }
  };
  const valid = await check();
  assert.equal(valid.code, 0, valid.stdout);
  const negativeImports = [
    ["features/availability/application/availability.ts", 'import { MemoryStock } from "../adapters/memory.js";\nvoid MemoryStock;\n'],
    ["index.ts", 'import { createAvailability as hidden } from "./features/availability/application/availability.js";\nvoid hidden;\n']
  ];
  for (const [relative, source] of negativeImports) {
    const path = join(root, "packages/stock/src", relative);
    const original = await readFile(path, "utf8");
    await writeFile(path, source + original);
    const invalid = await check();
    assert.equal(invalid.code, 1, invalid.stdout);
    assert.match(invalid.stdout, /architecture.source-dependencies/u);
    assert.match(invalid.stdout, /boundary|entrypoint/u);
    await writeFile(path, original);
  }
}, { bootstrap: false }));

test("matching digest retains lower-layer destination preimage checks", supported, async () => portableRepository(async (root) => {
  const preview = await docsNewV2(request(root, { apply: false }));
  let enteredApply = false;
  class ConcurrentWriter extends NodeDocumentAuthoringPort {
    async apply(input) {
      enteredApply = true;
      await writeFile(join(root, input.plan.destination), "Concurrent writer owns these bytes.\n");
      return super.apply(input);
    }
  }
  const protocol = createDocsProtocolApi(new DocsProtocol({ compiledOutput: new YamlCompiledOutputReader(), searchIndex: createCommunityMiniSearchIndex(),
    foundation: new ConcurrentWriter(), profiles: new NodeDocsProfileReader(),
    adoption: new NodeDocsAdoptionInspector(), anchors: new NodeCodeAnchorMatcher()
  }));
  const result = await protocol.newDocumentV2(request(root, { apply: true, expectedPlanDigest: preview.envelope.result.planDigest }));
  assert.equal(enteredApply, true, "the matching approval reached the real writer");
  assert.notEqual(result.envelope.outcome, "success");
  assert.equal(await readFile(join(root, preview.envelope.result.documentPath), "utf8"), "Concurrent writer owns these bytes.\n");
}));

test("task/todo/done vocabulary works with the real catalog, planner and writer", supported, async () => portableRepository(async (root) => {
  const { parse, stringify } = await import("yaml");
  const profilePath = join(root, ".docs-protocol/document-authoring.yaml");
  const authoring = parse(await readFile(profilePath, "utf8"));
  const taskType = authoring.authoring.artifactTypes.find(({ type }) => type === "tutorial");
  taskType.type = "task";
  taskType.initialStatus = "todo";
  taskType.placement.directory = "docs/tasks";
  taskType.identity.grammar.prefixSegments = ["work", "task"];
  await writeFile(profilePath, stringify(authoring));
  const templatePath = join(root, ".docs-protocol/templates/tutorial.md");
  await writeFile(templatePath, (await readFile(templatePath, "utf8")).replace("type: tutorial", "type: task").replace("status: proposed", "status: todo"));
  const schemaPath = join(root, ".docs-protocol/metadata.schema.json");
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  schema.properties.type.enum.push("task");
  schema.oneOf.push({ type: "object", required: ["type", "status"], properties: { type: { const: "task" }, status: { enum: ["todo", "done"] } } });
  await writeFile(schemaPath, JSON.stringify(schema));
  const portablePath = join(root, "docs.config.yaml");
  const portable = parse(await readFile(portablePath, "utf8"));
  portable.relations.blockers = { types: ["task"], statuses: ["todo"], subjectIncompatibleStatuses: ["done"] };
  await writeFile(portablePath, stringify(portable));

  const taskArgs = ["new", "--type", "task", "--id", "work.task.first", "--title", "First task", "--owner", "documentation/team", "--summary", "First portable task.", "--json"];
  const preview = await runCli([...taskArgs, "--dry-run"], root);
  assert.equal(preview.exitCode, 0, JSON.stringify(preview));
  const blocker = await runCli([...taskArgs, "--apply", "--expect", preview.envelope.result.planDigest], root);
  assert.equal(blocker.exitCode, 0, JSON.stringify(blocker));
  const second = request(root, { apply: false, intent: { ...intent, type: "task", id: "work.task.second", title: "Second task" }, blockedBy: ["work.task.first"] });
  const dependent = await docsNewV2(second);
  assert.deepEqual(dependent.envelope.result.compiled.relations, { blockedBy: ["work.task.first"], related: ["work.task.first"] });
  const applied = await docsNewV2({ ...second, apply: true, expectedPlanDigest: dependent.envelope.result.planDigest });
  assert.equal(applied.envelope.result.writeState, "applied");
  assert.equal((await docsCheckV2(request(root))).envelope.outcome, "success");
  const subjectPath = join(root, applied.envelope.result.documentPath);
  await writeFile(subjectPath, (await readFile(subjectPath, "utf8")).replace("status: todo", "status: done"));
  const checked = await docsCheckV2(request(root));
  assert.equal(checked.envelope.outcome, "violation");
  assert.ok(checked.envelope.diagnostics.some(({ message }) => /done.*cannot retain blockers/u.test(message)));
}));

test("init preserves an existing v3 tree and requires explicit migration", supported, async () => portableRepository(async (root, init) => {
  const { parse, stringify } = await import("yaml");
  const path = join(root, "docs.config.yaml");
  const profile = parse(await readFile(path, "utf8"));
  profile.schemaVersion = 3;
  delete profile.relations;
  await writeFile(path, stringify(profile));
  assert.equal((await docsCheckV2(request(root))).envelope.outcome, "success");
  const before = await snapshot(root);
  const plan = await docsInitPlan(init);
  assert.equal(plan.writeState, "blocked");
  assert.ok(plan.issues.some(({ path: issuePath }) => issuePath === "docs.config.yaml"));
  assert.deepEqual(await snapshot(root), before);
}));

test("matching approval preserves foreign transaction evidence encountered by Apply", supported, async () => portableRepository(async (root) => {
  const preview = await docsNewV2(request(root, { apply: false }));
  const evidencePath = join(root, ".agent-teams-local/scaffolding-transaction.json");
  const evidence = Buffer.from('{"foreign":"preserve exact bytes"}\n');
  let applied = false;
  class ForeignEvidence extends NodeDocumentAuthoringPort {
    async apply(input) {
      applied = true;
      await writeFile(evidencePath, evidence);
      return super.apply(input);
    }
  }
  const protocol = createDocsProtocolApi(new DocsProtocol({ compiledOutput: new YamlCompiledOutputReader(), searchIndex: createCommunityMiniSearchIndex(),
    foundation: new ForeignEvidence(), profiles: new NodeDocsProfileReader(),
    adoption: new NodeDocsAdoptionInspector(), anchors: new NodeCodeAnchorMatcher()
  }));
  const result = await protocol.newDocumentV2(request(root, { apply: true, expectedPlanDigest: preview.envelope.result.planDigest }));
  assert.equal(applied, true);
  assert.equal(result.envelope.outcome, "recovery-required");
  assert.deepEqual(await readFile(evidencePath), evidence);
  await assert.rejects(readFile(join(root, preview.envelope.result.documentPath)), { code: "ENOENT" });
}));
