import assert from "node:assert/strict";
import { posix } from "node:path";
import test from "node:test";
import { WARNING_CODES } from "../packages/feature-module-standard/dist/index.js";
import { conformanceCases } from "../packages/feature-module-standard/dist/fixtures.js";
import { within } from "../scripts/feature-modules/profile.mjs";
import { kernelProblems } from "../scripts/feature-modules/kernel.mjs";

// Conformance: the repository checker runs the shared fixtures that its own profile model can express. A fixture with a
// sub-feature cannot be written as a repository profile, so only fixtures without nested feature roots take part.
const overlap = new Map([
  ["deep-import", "cross-feature-deep-import"],
  ["layer-direction", "layer-direction"],
  ["feature-cycle", "feature-cycle"],
]);
const flat = (input) =>
  input.featureRoots.every(
    (root) => !input.featureRoots.some((other) => other !== root && within(root, other)),
  );

function repository({ input }) {
  const features = input.featureRoots
    .map((root) => ({
      id: posix.basename(root),
      layers: ["domain", "application", "contracts", "adapters", "composition", "testing"].flatMap(
        (role) => {
          const roots = input.roleRoots
            .filter((mapped) => mapped.role === role && within(mapped.root, root))
            .map((mapped) => mapped.root);
          return roots.length === 0 ? [] : [{ role, roots }];
        },
      ),
    }))
    .filter((feature) => feature.layers.length > 0);
  const profile = {
    modules: [
      {
        id: "fixture",
        sourceRoot: "src",
        features,
        moduleAssembly: [],
        generatedRoots: [],
        exceptions: [],
      },
    ],
  };
  const policy = {
    boundaries: [
      { id: "fixture.public", roots: ["src"], entrypoints: input.surfaces?.public ?? [] },
    ],
  };
  const observations = input.imports.map((record) => ({
    path: record.from,
    reference: {
      kind:
        record.reexport === true
          ? "export"
          : record.mode === "type-only"
            ? "static-type"
            : "static",
    },
    result: { kind: "local-file", path: record.to },
  }));
  return { profile, policy, observations };
}

const expressible = conformanceCases.filter(
  (fixture) => flat(fixture.input) && fixture.input.testFiles === undefined,
);

test("the repository checker can express the flat shared fixtures", () => {
  assert.ok(expressible.length >= 5, `only ${expressible.length} flat fixtures`);
});

for (const fixture of expressible) {
  test(`repository checker conforms to shared fixture ${fixture.id}`, () => {
    const { profile, policy, observations } = repository(fixture);
    const problems = [];
    kernelProblems(profile, policy, fixture.input.files, observations, problems);
    // An error the adapter cannot translate fails closed as one feature-root problem.
    const expected = fixture.expect
      .filter((code) => !WARNING_CODES.includes(code))
      .map((code) => overlap.get(code) ?? "feature-root")
      .toSorted();
    assert.deepEqual(problems.map(({ code }) => code).toSorted(), expected, fixture.description);
  });
}

test("the adapter fails closed on a feature name shared by two roots and on an untranslated kernel error", () => {
  const input = { featureRoots: ["src/a/x", "src/b/x"], roleRoots: [], files: [], imports: [] };
  const { profile, policy, observations } = repository({
    input: {
      ...input,
      roleRoots: [
        { root: "src/a/x/api.ts", role: "application" },
        { root: "src/b/x/api.ts", role: "application" },
      ],
    },
  });
  const duplicate = [];
  kernelProblems(profile, policy, [], observations, duplicate);
  assert.deepEqual(
    duplicate.map(({ code }) => code),
    ["feature-root"],
  );
  const cycle = conformanceCases.find(({ id }) => id === "profile-mapped-cycle");
  const loop = [];
  const {
    profile: loopProfile,
    policy: loopPolicy,
    observations: loopObservations,
  } = repository(cycle);
  kernelProblems(loopProfile, loopPolicy, cycle.input.files, loopObservations, loop);
  assert.deepEqual(loop.map(({ code }) => code).toSorted(), ["feature-cycle", "feature-root"]);
});
