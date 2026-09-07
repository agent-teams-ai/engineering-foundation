import assert from "node:assert/strict";
import test from "node:test";
import { validateFeatureModules } from "../scripts/check-feature-modules.mjs";

const load = (path) => import(`../packages/engineering-foundation/dist/${path}.js`);

// Execute the unchanged repository owner/layer guard over the actual source.
test("capability adapters mediate reporting through their own application policies", async () => {
  const result = await validateFeatureModules();
  assert.equal(result.modules, 6);
  assert.deepEqual(result.problems.filter(({ message }) =>
    message.startsWith("packages/engineering-foundation/src/composition/capability-modules.ts:")
  ), []);

  assert.deepEqual(result.problems.filter(({ code }) =>
    ["input-error", "source-policy", "unowned-source", "unowned-edge"].includes(code)
  ), []);
  assert.deepEqual(result.problems.filter(({ message }) =>
    message.startsWith("packages/engineering-foundation/src/capabilities/") &&
    message.includes(" -> packages/engineering-foundation/src/features/validation-reporting/") &&
    message.includes("adapters cannot import application")
  ), []);
});

// The reporting owner preserves references; ReadonlyMap is a type contract,
// not a runtime mutation barrier for a caller-owned Map.
test("capability descriptors freeze their slots while retaining caller-owned values", async () => {
  const { createCapabilityModule, createCapabilityModules } = await load("features/validation-reporting/api");
  const definition = { id: "fixture", run: () => assert.fail("construction must not run a capability") };
  const rules = new Map();
  const descriptor = createCapabilityModule(definition, rules);
  assert.deepEqual(Object.keys(descriptor), ["definition", "rules"]);
  assert.equal(descriptor.definition, definition);
  assert.equal(descriptor.rules, rules);
  assert.ok(Object.isFrozen(descriptor));
  assert.equal(Object.isFrozen(definition), false);
  assert.equal(Object.isFrozen(rules), false);
  assert.throws(() => { descriptor.definition = {}; }, TypeError);
  assert.throws(() => { descriptor.rules = new Map(); }, TypeError);
  assert.throws(() => { delete descriptor.definition; }, TypeError);
  const explanation = { id: "fixture.later" };
  rules.set(explanation.id, explanation);
  assert.equal(descriptor.rules.get(explanation.id), explanation);
  definition.id = "changed";
  assert.equal(descriptor.definition.id, "changed");
  const last = createCapabilityModule({ id: "last" }, new Map());
  const input = [descriptor, last, descriptor];
  const modules = createCapabilityModules(input);
  assert.equal(modules, input);
  assert.ok(Object.isFrozen(modules));
  assert.equal(modules[0], descriptor);
  assert.equal(modules[1], last);
  assert.equal(modules[2], descriptor);
  assert.throws(() => { modules[0] = last; }, TypeError);
  assert.throws(() => modules.pop(), TypeError);
  assert.throws(() => modules.push(last), TypeError);
  const empty = createCapabilityModules([]);
  assert.deepEqual(empty, []);
  assert.ok(Object.isFrozen(empty));
});

test("selected modules retain construction order and registry projection identities", async () => {
  const { CAPABILITY_MODULES } = await load("composition/capability-modules");
  const { createCapabilityRegistry, createRuleRegistries } = await load("features/validation-reporting/api");
  const selections = [
    ["contract-json-schema-releases", "JSON_SCHEMA_RELEASE_RULES_BY_ID"],
    ["contract-protobuf-evolution", "PROTOBUF_EVOLUTION_RULES_BY_ID"],
    ["documentation-local-references", "DOCUMENTATION_LOCAL_REFERENCE_RULES_BY_ID"],
    ["executable-specifications", "EXECUTABLE_SPECIFICATION_RULES_BY_ID"],
    ["governance-architecture-decisions", "ARCHITECTURE_DECISION_GOVERNANCE_RULES_BY_ID"],
    ["public-api-compatibility", "PUBLIC_API_COMPATIBILITY_RULES_BY_ID"],
    ["quality-gate-runner", "QUALITY_GATE_RUNNER_RULES_BY_ID"],
    ["repository-agent-workflow", "REPOSITORY_AGENT_WORKFLOW_RULES_BY_ID"],
    ["repository-security-baseline", "REPOSITORY_SECURITY_RULES_BY_ID"],
    ["source-dependencies", "SOURCE_DEPENDENCY_RULES_BY_ID"],
    ["suppression-governance", "SUPPRESSION_GOVERNANCE_RULES_BY_ID"],
    ["workspace-dependency-declarations", "RULES_BY_ID"]
  ];
  assert.equal(CAPABILITY_MODULES.length, selections.length);
  assert.deepEqual(CAPABILITY_MODULES.map(({ definition }) => definition.id), [
    "contract.json-schema-releases", "contract.protobuf-evolution",
    "documentation.local-references", "quality.executable-specifications",
    "governance.architecture-decisions", "package.public-api-compatibility",
    "quality.gate-runner", "repository.agent-workflow", "repository.security-baseline",
    "architecture.source-dependencies", "quality.suppression-governance",
    "workspace.dependency-declarations"
  ]);
  assert.ok(Object.isFrozen(CAPABILITY_MODULES));
  const capabilities = createCapabilityRegistry(CAPABILITY_MODULES);
  const rules = createRuleRegistries(CAPABILITY_MODULES);
  for (const [index, [path, exportedRules]] of selections.entries()) {
    const descriptor = CAPABILITY_MODULES[index];
    assert.ok(Object.isFrozen(descriptor));
    assert.equal(descriptor.rules, (await load(`capabilities/${path}/module`))[exportedRules]);
    assert.equal(capabilities.get(descriptor.definition.id), descriptor.definition);
    assert.equal(rules[index], descriptor.rules);
  }
});
