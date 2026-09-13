import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { CompilerState, Extractor } from "@microsoft/api-extractor";
import { ApiModel, ApiDeclaredItem, ApiExportedMixin } from "@microsoft/api-extractor-model";
import { preparePublicApiExtractor } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/prepare-public-api-extractor.js";
import { projectPublicApiObservation } from "../dist/capabilities/public-api-compatibility/application/policies/project-public-api-observation.js";
import { classifyPublicApiChange } from "../dist/capabilities/public-api-compatibility/application/policies/evaluate-public-api-compatibility.js";

// These are fresh real SDK models. Retained spike output is not the test oracle.
async function observe(source, subject = "A") {
  const root = await mkdtemp(join(tmpdir(), "foundation-audit-test-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "audit-fixture", version: "1.0.0", types: "index.d.ts" }));
    await writeFile(join(root, "index.d.ts"), source);
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, skipLibCheck: false }, files: ["index.d.ts"] }));
    const modelPath = join(root, "surface.api.json");
    const config = preparePublicApiExtractor({ packageRoot: root, manifestPath: join(root, "package.json"), entryPointPath: join(root, "index.d.ts"), tsconfigPath: join(root, "tsconfig.json"), apiJsonPath: modelPath, includeForgottenExports: true });
    const diagnostics = [];
    const result = Extractor.invoke(config, { compilerState: CompilerState.create(config), localBuild: true, messageCallback(message) { diagnostics.push({ id: message.messageId, severity: message.logLevel }); message.handled = true; } });
    const model = new ApiModel();
    const pkg = model.loadPackage(modelPath);
    const items = [];
    function walk(item, parentPublic = true) {
      const exported = ApiExportedMixin.isBaseClassOf(item) ? item.isExported : null;
      const isPublic = parentPublic && exported !== false;
      if (item instanceof ApiDeclaredItem) {
        items.push({ displayName: item.displayName, identity: { subject, packageName: "audit-fixture", exportPath: ".", canonicalReference: item.canonicalReference.toString() }, kind: item.kind, parentReference: item.parent.canonicalReference.toString(), parentKind: item.parent.kind, excerpt: item.excerpt.text, isExported: exported, public: isPublic,
          references: item.excerpt.spannedTokens.filter(token => token.kind === "Reference").map(token => {
            const target = model.resolveDeclarationReference(token.canonicalReference, item).resolvedApiItem;
            return { text: token.text, canonicalReference: token.canonicalReference.toString(), resolution: target ? "local" : "unresolved", ...(target ? { target: { subject, packageName: "audit-fixture", exportPath: ".", canonicalReference: target.canonicalReference.toString() } } : {}) };
          }) });
      }
      for (const member of item.members) {walk(member, isPublic);}
    }
    walk(pkg);
    return { subject, packageName: "audit-fixture", packageVersion: "1.0.0", exportPath: ".", toolchain: Extractor.version, items, result: { succeeded: result.succeeded }, diagnostics };
  } finally { await rm(root, { recursive: true, force: true }); }
}
const fingerprint = { sha256: value => createHash("sha256").update(`audit-test:${value}`).digest("hex") };

test("real hidden recursive model has exact nodes, ordered edges and terminating cycle", async () => {
  const observation = await observe("type Leaf = { value: string }; type Middle = Leaf; type Hidden = { next?: Hidden; item: Middle }; declare function f(x: Hidden): Hidden; export { f };\n");
  assert.equal(observation.result.succeeded, false);
  assert.deepEqual(observation.diagnostics.filter(d => d.severity === "error").map(d => d.id), ["ae-forgotten-export", "ae-forgotten-export", "ae-forgotten-export"]);
  const names = observation.items.map(i => i.identity.canonicalReference).toSorted();
  assert.deepEqual(names, ["audit-fixture!f:function(1)", "audit-fixture!~Hidden:type", "audit-fixture!~Leaf:type", "audit-fixture!~Middle:type"]);
  const edges = observation.items.flatMap(i => i.references.map(r => [i.identity.canonicalReference, r.target?.canonicalReference])).toSorted();
  assert.deepEqual(edges, [
    ["audit-fixture!f:function(1)", "audit-fixture!~Hidden:type"],
    ["audit-fixture!f:function(1)", "audit-fixture!~Hidden:type"],
    ["audit-fixture!~Hidden:type", "audit-fixture!~Hidden:type"],
    ["audit-fixture!~Hidden:type", "audit-fixture!~Middle:type"],
    ["audit-fixture!~Middle:type", "audit-fixture!~Leaf:type"]
  ]);
  const projection = projectPublicApiObservation([observation], "audit-fixture");
  assert.equal(projection.graphs.length, 1);
  assert.deepEqual(projection.graphs[0].nodes.map(n => n.identity[2]).toSorted(), names);
  assert.equal(projection.snapshot.entrypoints[0].items.length, 1);
  assert.deepEqual(projectPublicApiObservation([observation], "audit-fixture"), projection);
});

test("hidden mutation changes public graph signature with identical public excerpt", async () => {
  const a = await observe("type Hidden = string; declare function f(x: Hidden): Hidden; export { f };\n");
  const c = await observe("type Hidden = number; declare function f(x: Hidden): Hidden; export { f };\n", "C");
  assert.equal(a.items.find(i => i.public).excerpt, c.items.find(i => i.public).excerpt);
  const left = projectPublicApiObservation([a], "audit-fixture");
  const right = projectPublicApiObservation([c], "audit-fixture");
  const diff = classifyPublicApiChange(left.snapshot, right.snapshot, fingerprint);
  assert.equal(diff.classification, "breaking");
  assert.deepEqual(diff.changed, [{ exportPath: ".", canonicalReference: "audit-fixture!f:function(1)" }]);
  const same = await observe("type Hidden = string; declare function f(x: Hidden): Hidden; export { f };\n", "C");
  assert.equal(classifyPublicApiChange(left.snapshot, projectPublicApiObservation([same], "audit-fixture").snapshot, fingerprint).classification, "none");
});

test("ambient counterexample and explicit export preserve canonical identity transition", async () => {
  const hidden = await observe("type Hidden = string; declare function f(x: Hidden): Hidden; export { f };\n");
  const exported = await observe("export type Hidden = string; export declare function f(x: Hidden): Hidden;\n", "C");
  const ambient = await observe("declare type Hidden = string; export declare function f(x: Hidden): Hidden;\n");
  assert.equal(hidden.items.find(i => i.kind === "TypeAlias").isExported, false);
  assert.equal(ambient.items.find(i => i.kind === "TypeAlias").isExported, true);
  assert.equal(exported.items.find(i => i.kind === "TypeAlias").identity.canonicalReference, "audit-fixture!Hidden:type");
  const diff = classifyPublicApiChange(projectPublicApiObservation([hidden], "audit-fixture").snapshot, projectPublicApiObservation([exported], "audit-fixture").snapshot, fingerprint);
  assert.equal(diff.classification, "breaking");
  assert.deepEqual(diff.added, [{ exportPath: ".", canonicalReference: "audit-fixture!Hidden:type" }]);
});

test("real member collection permutations preserve sorted graphs, snapshots and fingerprints", async () => {
  const observation = await observe("export interface I { z: string; a: number; }\n");
  assert.equal(observation.result.succeeded, true);
  const original = projectPublicApiObservation([observation], "audit-fixture");
  const permuted = projectPublicApiObservation([{ ...observation, items: observation.items.toReversed() }], "audit-fixture");
  assert.deepEqual(original.graphs.find(graph => graph.root.canonicalReference === "audit-fixture!I:interface").nodes.map(node => node.identity[2]),
    ["audit-fixture!I#a:member", "audit-fixture!I#z:member", "audit-fixture!I:interface"]);
  assert.deepEqual(permuted, original);
  assert.equal(fingerprint.sha256(JSON.stringify(permuted.snapshot)), fingerprint.sha256(JSON.stringify(original.snapshot)));
  assert.equal(classifyPublicApiChange(original.snapshot, permuted.snapshot, fingerprint).classification, "none");
});
