import assert from "node:assert/strict";
import { posix } from "node:path";
import test from "node:test";
import { conformanceCases } from "../packages/feature-module-standard/dist/fixtures.js";
import { within } from "../scripts/feature-modules/profile.mjs";
import { kernelProblems } from "../scripts/feature-modules/kernel.mjs";

// Conformance: the repository checker runs the shared fixtures that its own profile model can express. A fixture with a
// sub-feature cannot be written as a repository profile, so only fixtures without nested feature roots take part.
const overlap = new Map([["deep-import", "cross-feature-deep-import"], ["layer-direction", "layer-direction"], ["feature-cycle", "feature-cycle"]]);
const flat = (input) => input.featureRoots.every((root) => !input.featureRoots.some((other) => other !== root && within(root, other)));

function repository({ input }) {
  const features = input.featureRoots.map((root) => ({
    id: posix.basename(root),
    layers: ["domain", "application", "contracts", "adapters", "composition", "testing"].flatMap((role) => {
      const roots = input.roleRoots.filter((mapped) => mapped.role === role && within(mapped.root, root)).map((mapped) => mapped.root);
      return roots.length === 0 ? [] : [{ role, roots }];
    })
  })).filter((feature) => feature.layers.length > 0);
  const profile = { modules: [{ id: "fixture", sourceRoot: "src", features, moduleAssembly: [], generatedRoots: [], exceptions: [] }] };
  const policy = { boundaries: [{ id: "fixture.public", roots: ["src"], entrypoints: input.surfaces?.public ?? [] }] };
  const observations = input.imports.map((record) => ({
    path: record.from,
    reference: { kind: record.reexport === true ? "export" : record.mode === "type-only" ? "static-type" : "static" },
    result: { kind: "local-file", path: record.to }
  }));
  return { profile, policy, observations };
}

const expressible = conformanceCases.filter((fixture) => flat(fixture.input) && fixture.input.testFiles === undefined);

test("the repository checker can express the flat shared fixtures", () => {
  assert.ok(expressible.length >= 5, `only ${expressible.length} flat fixtures`);
});

for (const fixture of expressible) {
  test(`repository checker conforms to shared fixture ${fixture.id}`, () => {
    const { profile, policy, observations } = repository(fixture);
    const problems = [];
    kernelProblems(profile, policy, fixture.input.files, observations, problems);
    const expected = fixture.expect.filter((code) => overlap.has(code)).map((code) => overlap.get(code)).toSorted();
    assert.deepEqual(problems.map(({ code }) => code).toSorted(), expected, fixture.description);
  });
}
