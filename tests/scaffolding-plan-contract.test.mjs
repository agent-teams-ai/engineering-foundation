import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

import { planScaffoldFromFile } from "../packages/engineering-foundation/dist/scaffolding/index.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const schemaRoot = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "schemas"
);
const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-consumer"
);

async function schemaValidator(schemaId) {
  const [name, version] = schemaId.split("/");
  const schema = JSON.parse(
    await readFile(join(schemaRoot, name, version + ".schema.json"), "utf8")
  );
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

async function yamlFixture(path) {
  return parseYaml(
    await readFile(join(fixtureRoot, ...path.split("/")), "utf8")
  );
}

async function contractFixtures() {
  const [
    config,
    intent,
    targetCatalog,
    plan,
    validateConfig,
    validateIntent,
    validateTargetCatalog,
    validatePlan
  ] = await Promise.all([
    yamlFixture("architecture/foundation/scaffolding.yaml"),
    yamlFixture("intents/facets-forward.yaml"),
    yamlFixture("architecture/package-catalog.yaml"),
    planScaffoldFromFile({
      consumerRoot: fixtureRoot,
      intentPath: "intents/facets-forward.yaml"
    }),
    schemaValidator("scaffolding-config/v1"),
    schemaValidator("scaffold-intent/v1"),
    schemaValidator("scaffold-target-catalog/v1"),
    schemaValidator("scaffold-plan/v1")
  ]);
  return {
    config,
    intent,
    targetCatalog,
    plan,
    validateConfig,
    validateIntent,
    validateTargetCatalog,
    validatePlan
  };
}

function assertAccepted(validate, value, subject) {
  assert.equal(
    validate(value),
    true,
    subject + ": " + JSON.stringify(validate.errors)
  );
}

function assertRejected(validate, value, subject) {
  assert.equal(
    validate(value),
    false,
    subject + ": " + JSON.stringify(validate.errors)
  );
}

test("accepts canonical source fixtures and compiler output", async () => {
  const {
    config,
    intent,
    targetCatalog,
    plan,
    validateConfig,
    validateIntent,
    validateTargetCatalog,
    validatePlan
  } = await contractFixtures();

  assertAccepted(validateConfig, config, "scaffolding config fixture");
  assertAccepted(validateIntent, intent, "scaffold intent fixture");
  assertAccepted(validateTargetCatalog, targetCatalog, "target catalog fixture");
  assertAccepted(validatePlan, plan, "compiler output");
});

test("matches the repository exact SemVer policy for compiler versions", async () => {
  const { plan, validatePlan } = await contractFixtures();

  for (const version of ["1.0.0+build.7", "1.0.0-rc.4+build.7"]) {
    const candidate = structuredClone(plan);
    candidate.compiler.version = version;
    assertAccepted(validatePlan, candidate, "compiler version " + version);
  }
  for (const version of ["1.0.0-01", "1.0.0-.", "1.0.0+build."]) {
    const candidate = structuredClone(plan);
    candidate.compiler.version = version;
    assertRejected(validatePlan, candidate, "compiler version " + version);
  }
});

test("rejects widened embedded Intent IDs in both contracts", async () => {
  const { intent, plan, validateIntent, validatePlan } =
    await contractFixtures();
  const mutations = [
    {
      label: "composition ID",
      apply(value) {
        value.compositionId = "Testing-package";
      }
    },
    {
      label: "target reference",
      apply(value) {
        value.targetRef = "Testing.generated";
      }
    },
    {
      label: "facet definition reference",
      apply(value) {
        value.facets[0].ref.id = "Foundation.fixture-readme";
      }
    },
    {
      label: "overlong composition ID",
      apply(value) {
        value.compositionId = "a".repeat(161);
      }
    }
  ];

  for (const { label, apply } of mutations) {
    const standaloneIntent = structuredClone(intent);
    apply(standaloneIntent);
    assertRejected(validateIntent, standaloneIntent, "Intent " + label);

    const embeddedPlan = structuredClone(plan);
    apply(embeddedPlan.intent);
    assertRejected(validatePlan, embeddedPlan, "Plan intent " + label);
  }
});

test("rejects widened authority values copied into Plan", async () => {
  const {
    config,
    targetCatalog,
    plan,
    validateConfig,
    validateTargetCatalog,
    validatePlan
  } = await contractFixtures();
  const sourceParityCases = [
    {
      label: "project ID",
      source: config,
      validateSource: validateConfig,
      mutateSource(value) {
        value.projectId = "Foundation-scaffolding-fixture";
      },
      mutatePlan(value) {
        value.projectId = "Foundation-scaffolding-fixture";
      }
    },
    {
      label: "overlong project ID",
      source: config,
      validateSource: validateConfig,
      mutateSource(value) {
        value.projectId = "a".repeat(161);
      },
      mutatePlan(value) {
        value.projectId = "a".repeat(161);
      }
    },
    {
      label: "target catalog path",
      source: config,
      validateSource: validateConfig,
      mutateSource(value) {
        value.targetCatalogPath = "architecture//package-catalog.yaml";
      },
      mutatePlan(value) {
        value.authority.targetCatalogPath = "architecture//package-catalog.yaml";
      }
    },
    {
      label: "composition ID",
      source: config,
      validateSource: validateConfig,
      mutateSource(value) {
        value.compositions[0].id = "Testing-package";
      },
      mutatePlan(value) {
        value.composition.id = "Testing-package";
      }
    },
    {
      label: "profile definition reference",
      source: config,
      validateSource: validateConfig,
      mutateSource(value) {
        value.compositions[0].scaffoldProfile.ref.id =
          "Foundation.node-typescript-fixture";
      },
      mutatePlan(value) {
        value.composition.scaffoldProfile.id =
          "Foundation.node-typescript-fixture";
      }
    },
    {
      label: "recipe definition reference",
      source: config,
      validateSource: validateConfig,
      mutateSource(value) {
        value.compositions[0].recipe.ref.id =
          "Foundation.conformance-fixture-package";
      },
      mutatePlan(value) {
        value.composition.recipe.id = "Foundation.conformance-fixture-package";
      }
    },
    {
      label: "facet definition reference",
      source: config,
      validateSource: validateConfig,
      mutateSource(value) {
        value.compositions[0].facets.default[0].ref.id =
          "Foundation.fixture-readme";
      },
      mutatePlan(value) {
        value.composition.facets[0].id = "Foundation.fixture-readme";
      }
    },
    {
      label: "policy definition reference",
      source: config,
      validateSource: validateConfig,
      mutateSource(value) {
        value.compositions[0].policies[0].ref.id =
          "Foundation.target-role";
      },
      mutatePlan(value) {
        value.composition.policies[0].id = "Foundation.target-role";
      }
    },
    {
      label: "target ID",
      source: targetCatalog,
      validateSource: validateTargetCatalog,
      mutateSource(value) {
        value.packages[0].id = "Testing.generated";
      },
      mutatePlan(value) {
        value.target.id = "Testing.generated";
      }
    },
    {
      label: "target role",
      source: targetCatalog,
      validateSource: validateTargetCatalog,
      mutateSource(value) {
        value.packages[0].role = "Testing";
      },
      mutatePlan(value) {
        value.target.role = "Testing";
      }
    },
    {
      label: "target path",
      source: targetCatalog,
      validateSource: validateTargetCatalog,
      mutateSource(value) {
        value.packages[0].path = "packages//testing/generated";
      },
      mutatePlan(value) {
        value.target.path = "packages//testing/generated";
      }
    },
    {
      label: "target package name",
      source: targetCatalog,
      validateSource: validateTargetCatalog,
      mutateSource(value) {
        value.packages[0].package_name = "@Fixture/generated";
      },
      mutatePlan(value) {
        value.target.packageName = "@Fixture/generated";
      }
    },
    {
      label: "target owner document",
      source: targetCatalog,
      validateSource: validateTargetCatalog,
      mutateSource(value) {
        value.packages[0].owner_document = "ADR-\u0001";
      },
      mutatePlan(value) {
        value.target.ownerDocument = "ADR-\u0001";
      }
    }
  ];

  for (const {
    label,
    source,
    validateSource,
    mutateSource,
    mutatePlan
  } of sourceParityCases) {
    const invalidSource = structuredClone(source);
    mutateSource(invalidSource);
    assertRejected(validateSource, invalidSource, "source " + label);

    const forgedPlan = structuredClone(plan);
    mutatePlan(forgedPlan);
    assertRejected(validatePlan, forgedPlan, "Plan " + label);
  }

  for (const { label, mutate } of [
    {
      label: "authority config path",
      mutate(value) {
        value.authority.configPath = "architecture//foundation/scaffolding.yaml";
      }
    },
    {
      label: "definition evidence reference",
      mutate(value) {
        value.definitions[0].ref.id = "Foundation.fixture-readme";
      }
    },
    {
      label: "resolved facet reference",
      mutate(value) {
        value.resolved.facets[0].ref.id = "Foundation.fixture-readme";
      }
    },
    {
      label: "resolved policy reference",
      mutate(value) {
        value.resolved.policies[0].ref.id = "Foundation.target-role";
      }
    }
  ]) {
    const forgedPlan = structuredClone(plan);
    mutate(forgedPlan);
    assertRejected(validatePlan, forgedPlan, "Plan " + label);
  }
});

test("retains broader IDs for generated operations and diagnostics", async () => {
  const { plan, validatePlan } = await contractFixtures();
  const generatedPlan = structuredClone(plan);
  generatedPlan.operations[0].id = "Materialize/@generated-output";
  generatedPlan.diagnostics.push({
    ruleId: "Generated/Rule@1",
    severity: "info",
    phase: "planning",
    subject: "generated output",
    message: "Generated artifact identifier remains valid.",
    remediation: "No action required."
  });

  assertAccepted(validatePlan, generatedPlan, "generated artifact IDs");
});
