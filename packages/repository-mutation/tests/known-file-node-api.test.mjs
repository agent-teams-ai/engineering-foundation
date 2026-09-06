import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const nodeBindings = [
  ["", "applyKnownFileTransaction"], ["", "recoverKnownFileTransaction"],
  ["", "inspectKnownFileTransactionBarrier"],
  ["/node", "classifyExactFilePostimage"], ["/node", "cleanupIdentityMatchingOwnedTemporary"],
  ["/node", "prepareExactSiblingTemporary"], ["/node", "publishAbsentFile"],
  ["/qualification", "applyKnownFileTransaction"], ["/qualification", "recoverKnownFileTransaction"],
  ["/qualification", "prepareExactSiblingTemporary"], ["/qualification", "publishAbsentFile"]
];

test("known-file Node factory forwards all eleven operations without binding or changing completion", () => {
  const script = `
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    const root = ${JSON.stringify(new URL("../dist/repository-mutation/", import.meta.url).href)};
    const modules = {
      "node-known-file-transaction": ["applyKnownFileTransaction", "applyKnownFileTransactionWithFaults"],
      "node-absent-file-publication": ["classifyExactFilePostimage", "publishAbsentFile", "publishAbsentFileWithFaults"],
      "node-cleanup-owned-temporary": ["cleanupIdentityMatchingOwnedTemporary"],
      "node-known-file-transaction-inspection": ["inspectKnownFileTransactionBarrier"],
      "node-prepare-exact-sibling-temporary": ["prepareExactSiblingTemporary", "prepareExactSiblingTemporaryWithFaults"],
      "node-known-file-transaction-recovery": ["recoverKnownFileTransaction", "recoverKnownFileTransactionWithFaults"]
    };
    const calls = [];
    let completion, failure;
    for (const [module, names] of Object.entries(modules)) {
      const namedExports = {};
      for (const name of names) {
        const operation = (...args) => {
          calls.push({ name, args });
          if (failure) { throw failure; }
          return completion;
        };
        Object.defineProperty(operation, "bind", {
          get() { assert.fail("An adapter must not interpret an operation's bind property"); }
        });
        namedExports[name] = operation;
      }
      mock.module(new URL("adapters/node/" + module + ".js", root).href, { namedExports });
    }
    const { createKnownFileNodeApi } = await import(new URL("composition/node-api.js", root));
    const coordination = new Proxy({}, { get() { assert.fail("Factory eagerly observed a dependency"); } });
    const api = createKnownFileNodeApi(coordination);
    const another = createKnownFileNodeApi(coordination);
    const names = Object.values(modules).flat().sort();
    assert.deepEqual(Object.keys(api).sort(), names);
    assert.equal(calls.length, 0);
    const opaque = Object.freeze({ get claim() { assert.fail("Forwarder inspected its request"); } });
    const postimage = Object.freeze({ bytes: Buffer.from("exact bytes") });
    for (const name of names) {
      assert.notEqual(api[name], another[name]);
      const args = name === "classifyExactFilePostimage" ? ["/unused", postimage] : [opaque];
      const receipt = Object.freeze({ outcome: name });
      let settle;
      completion = new Promise((resolve) => { settle = resolve; });
      const returned = api[name](...args);
      assert.equal(returned, completion, name + " must preserve the original promise and timing");
      const call = calls.at(-1);
      assert.equal(call.name, name);
      assert.equal(call.args.length, args.length + 1);
      assert.equal(call.args[0], coordination);
      args.forEach((arg, index) => assert.equal(call.args[index + 1], arg));
      settle(receipt);
      assert.equal(await returned, receipt);
      const cause = Object.freeze({ cause: name });
      const reason = new Error(name, { cause });
      completion = Promise.reject(reason);
      assert.equal(api[name](...args), completion);
      await assert.rejects(completion, (error) => error === reason && error.cause === cause);
      failure = new DOMException(name, "AbortError");
      assert.throws(() => api[name](...args), (error) => error === failure);
      failure = undefined;
    }
    assert.equal(calls.length, names.length * 3);
  `;
  const invocation = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--input-type=module", "--eval", script
  ], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(invocation.error, undefined, invocation.error?.message);
  assert.equal(invocation.status, 0, invocation.stdout + invocation.stderr);
});

test("the actual workspace graph resolves the eleven Node bindings to their adapter owner", (t) => {
  const script = `
    import { readFile } from "node:fs/promises";
    import { fileURLToPath } from "node:url";
    const root = ${JSON.stringify(new URL("../../../", import.meta.url).href)};
    const { observeDependencies } = await import(new URL("scripts/feature-modules/dependencies.mjs", root));
    const { indexSurfaces, surfaceBindings } = await import(new URL("scripts/feature-modules/surfaces.mjs", root));
    const { default: YAML } = await import(new URL("node_modules/yaml/dist/index.js", root));
    const profile = JSON.parse(await readFile(new URL("architecture/foundation/feature-modules.json", root), "utf8"));
    const policy = YAML.parse(await readFile(new URL(profile.topology.sourcePolicy, root), "utf8"));
    const graph = await observeDependencies(fileURLToPath(root), profile.topology.sourcePolicy);
    const problems = [];
    const files = [...graph.sourceSnapshots.keys()].filter((path) =>
      profile.modules.some(({ sourceRoot }) => path.startsWith(sourceRoot + "/")));
    const sources = indexSurfaces(files, problems, graph.sourceSnapshots);
    const bind = (selectedSources) => surfaceBindings(profile, policy, graph.observations, selectedSources, graph.packageExportTargets);
    const bindings = bind(sources);
    const prefix = "@agent-teams/repository-mutation";
    const probes = ${JSON.stringify(nodeBindings)};
    const simplify = (owners) => owners.map((entry) => entry?.owner ? {
      path: entry.path, module: entry.owner.module.id, feature: entry.owner.feature?.id,
      layer: entry.owner.layer?.role
    } : null);
    const perBinding = probes.map(([subpath, name]) => {
      const observation = graph.observations.find((entry) => entry.result.kind === "workspace-package" &&
        entry.reference.specifier === prefix + subpath &&
        sources.get(entry.path)?.references.get(entry.reference.start)?.type === "ImportDeclaration");
      if (!observation) { throw new Error("Missing real workspace observation for " + subpath); }
      // Select one binding over the same accepted observation and complete source graph.
      const surface = sources.get(observation.path);
      const reference = surface.references.get(observation.reference.start);
      const references = new Map(surface.references);
      references.set(observation.reference.start, { ...reference,
        specifiers: [{ type: "ImportSpecifier", imported: { name }, local: { name } }] });
      const selectedSources = new Map(sources);
      selectedSources.set(observation.path, { ...surface, references });
      return { specifier: prefix + subpath, name, owners: simplify(bind(selectedSources).owners(observation)) };
    });
    const callers = [
      "packages/docs-protocol-agent-teams/src/consumer-integration/composition/known-file-transaction.ts",
      "packages/docs-protocol/src/features/portable-bootstrap/adapters/outbound/node-bootstrap-transactions.ts",
      "packages/document-authoring/src/document-authoring/adapters/node/node-document-publisher.ts",
      "packages/engineering-foundation/src/scaffolding/adapters/node/filesystem-operation-state.ts"
    ];
    const groups = graph.observations.filter((entry) => callers.includes(entry.path) &&
      entry.result.kind === "workspace-package" && probes.some(([suffix, name]) =>
        entry.reference.specifier === prefix + suffix &&
        sources.get(entry.path)?.references.get(entry.reference.start)?.specifiers?.some((item) =>
          item.imported?.name === name))).map((entry) => ({
      path: entry.path, specifier: entry.reference.specifier, owners: simplify(bindings.owners(entry))
    }));
    process.stdout.write(JSON.stringify({
      files: files.length, observations: graph.observations.length,
      errors: [...problems, ...graph.diagnostics.filter(({ severity }) => severity === "error")],
      groups, perBinding
    }));
  `;
  const invocation = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8", timeout: 180_000, maxBuffer: 2 * 1024 * 1024
  });
  assert.equal(invocation.error, undefined, invocation.error?.message);
  assert.equal(invocation.status, 0, invocation.stdout + invocation.stderr);
  const evidence = JSON.parse(invocation.stdout);
  t.diagnostic(JSON.stringify(evidence));
  assert.deepEqual(evidence.errors, []);
  assert.equal(evidence.groups.length, 5);
  const adapter = "packages/repository-mutation/src/repository-mutation/adapters/node/node-known-file-api.ts";
  for (const group of evidence.groups) {
    assert.ok(group.owners.every((owner) => owner !== null), JSON.stringify(group));
    assert.ok(group.owners.some((owner) => owner.path === adapter && owner.layer === "adapters"), JSON.stringify(group));
  }
  assert.equal(evidence.perBinding.length, 11);
  for (const binding of evidence.perBinding) {
    assert.deepEqual(binding.owners, [{ path: adapter, module: "repository-mutation",
      feature: "known-file-transactions", layer: "adapters" }], JSON.stringify(binding));
  }
});

test("real domain and application imports reject all eleven public Node bindings by layer direction", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "known-file-node-boundaries-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const script = `
    import assert from "node:assert/strict";
    import { cp, readFile, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const root = ${JSON.stringify(new URL("../../../", import.meta.url).href)};
    const fixture = ${JSON.stringify(fixture)};
    const { copySourcePolicyFixture } = await import(new URL("tests/helpers/local-mode-boundaries.mjs", root));
    const { validateFeatureModules } = await import(new URL("scripts/check-feature-modules.mjs", root));
    const { observeDependencies, validateObservations } = await import(new URL("scripts/feature-modules/dependencies.mjs", root));
    const { indexSurfaces, surfaceBindings } = await import(new URL("scripts/feature-modules/surfaces.mjs", root));
    const { default: YAML } = await import(new URL("node_modules/yaml/dist/index.js", root));
    await copySourcePolicyFixture(fixture);
    for (const path of ["standards", "docs", "tests", "README.md"]) {
      await cp(new URL(path, root), join(fixture, path), { recursive: true });
    }
    const profile = JSON.parse(await readFile(join(fixture, "architecture/foundation/feature-modules.json"), "utf8"));
    const policyPath = join(fixture, profile.topology.sourcePolicy);
    const policy = YAML.parse(await readFile(policyPath, "utf8"));
    const prefix = "@agent-teams/repository-mutation";
    const probes = ${JSON.stringify(nodeBindings)};
    const content = probes.map(([suffix, name], index) =>
      "import { " + name + " as operation" + index + " } from " + JSON.stringify(prefix + suffix) + ";"
    ).join("\\n") + "\\nexport { " + probes.map((_, index) => "operation" + index).join(", ") + " };\\n";
    const added = [];
    for (const role of ["domain", "application"]) {
      const path = "packages/docs-protocol/src/features/portable-documentation/" + role + "/factory-ownership-negative.ts";
      await writeFile(join(fixture, path), content, { flag: "wx" });
      added.push({ role, path });
      // Admit only the disposable fixture's package edge so a missing declaration cannot prove rejection.
      const boundary = policy.boundaries.find(({ id }) => id === "docs-protocol.portable-documentation." + role);
      assert.ok(boundary, role + " boundary must exist");
      if (!boundary.allow.packages.includes(prefix)) { boundary.allow.packages.push(prefix); }
    }
    await writeFile(policyPath, YAML.stringify(policy));
    const result = await validateFeatureModules({ repositoryRoot: fixture });
    const graph = await observeDependencies(fixture, profile.topology.sourcePolicy);
    const problems = [];
    const files = [...graph.sourceSnapshots.keys()].filter((path) =>
      profile.modules.some(({ sourceRoot }) => path.startsWith(sourceRoot + "/")));
    const sources = indexSurfaces(files, problems, graph.sourceSnapshots);
    const bindings = surfaceBindings(profile, policy, graph.observations, sources, graph.packageExportTargets);
    const negatives = added.map(({ role, path }) => ({
      role, path,
      problems: result.problems.filter(({ message }) => message.startsWith(path + " ->")),
      perBinding: graph.observations.filter((entry) => entry.path === path)
        .sort((a, b) => a.reference.start - b.reference.start).map((observation) => {
          const reference = sources.get(path).references.get(observation.reference.start);
          const rejected = [];
          validateObservations(profile, policy, [observation], rejected, { sources, bindings });
          return {
            kind: observation.result.kind, specifier: observation.reference.specifier,
            type: reference.type, names: reference.specifiers.map(({ imported }) => imported.name),
            owners: bindings.owners(observation).map((entry) => entry?.owner ? {
              path: entry.path, module: entry.owner.module.id, feature: entry.owner.feature?.id,
              layer: entry.owner.layer?.role
            } : null),
            problems: rejected.filter(({ message }) => message.startsWith(path + " ->"))
          };
        })
    }));
    process.stdout.write(JSON.stringify({
      errors: [...problems, ...graph.diagnostics.filter(({ severity }) => severity === "error"),
        ...result.problems.filter(({ code }) => ["input-error", "source-policy"].includes(code))],
      findings: result.problems.length, negatives
    }));
  `;
  const invocation = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8", timeout: 180_000, maxBuffer: 2 * 1024 * 1024
  });
  assert.equal(invocation.error, undefined, invocation.error?.message);
  assert.equal(invocation.status, 0, invocation.stdout + invocation.stderr);
  const evidence = JSON.parse(invocation.stdout);
  t.diagnostic(JSON.stringify(evidence));
  assert.deepEqual(evidence.errors, []);
  assert.deepEqual(evidence.negatives.map(({ role }) => role), ["domain", "application"]);
  const adapter = "packages/repository-mutation/src/repository-mutation/adapters/node/node-known-file-api.ts";
  for (const negative of evidence.negatives) {
    const expected = { code: "layer-direction", message:
      `${negative.path} -> ${adapter}: ${negative.role} cannot import adapters.` };
    assert.equal(negative.perBinding.length, 11);
    for (const [index, binding] of negative.perBinding.entries()) {
      const [suffix, name] = nodeBindings[index];
      assert.equal(binding.kind, "workspace-package");
      assert.equal(binding.type, "ImportDeclaration");
      assert.equal(binding.specifier, "@agent-teams/repository-mutation" + suffix);
      assert.deepEqual(binding.names, [name]);
      assert.deepEqual(binding.owners, [{ path: adapter, module: "repository-mutation",
        feature: "known-file-transactions", layer: "adapters" }], JSON.stringify(binding));
      assert.deepEqual(binding.problems, [expected], `${negative.role}: ${binding.specifier}#${name}`);
    }
    assert.deepEqual(negative.problems, nodeBindings.map(() => expected));
  }
});
