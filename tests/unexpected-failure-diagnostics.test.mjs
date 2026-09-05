import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import {
  CapabilityInputError,
  capabilityFailureReport,
  capabilityReport,
  foundationReport,
} from "../packages/engineering-foundation/dist/capability-runtime.js";
import { FoundationError } from "../packages/engineering-foundation/dist/local-mode/application/errors/foundation-error.js";
import { classifyUnexpectedFailure } from "../packages/engineering-foundation/dist/unexpected-failure.js";

const classifications = [
  [
    { code: "ENOENT" },
    "UNEXPECTED_FILESYSTEM_FAILURE",
    "An unexpected filesystem failure occurred.",
  ],
  [
    new SyntaxError("private parser source"),
    "UNEXPECTED_PARSER_FAILURE",
    "An unexpected parser failure occurred.",
  ],
  [
    new FoundationError("PROCESS_FAILED", "private process output"),
    "UNEXPECTED_PROCESS_FAILURE",
    "An unexpected process failure occurred.",
  ],
  [
    new TypeError("private contract value"),
    "UNEXPECTED_CONTRACT_FAILURE",
    "An unexpected contract failure occurred.",
  ],
  [
    { code: "ERR_ASSERTION", name: "AssertionError" },
    "UNEXPECTED_INTERNAL_INVARIANT_FAILURE",
    "An internal invariant failed unexpectedly.",
  ],
  [new Error("private unknown value"), "UNEXPECTED_FAILURE", "An unexpected failure occurred."],
];

test("classifies unexpected failures from stable signals", () => {
  for (const [error, expectedCode, expectedMessage] of classifications) {
    assert.deepEqual(classifyUnexpectedFailure(error, "test-phase"), {
      code: expectedCode,
      message: expectedMessage,
      phase: "test-phase",
      retryable: false,
    });
  }
});

test("does not project raw errors, paths, repository content, secrets, or stacks", () => {
  const sensitive = [
    "/Users/example/private-repository/config.yml",
    "repository source line",
    "secret-token-123",
    "at privateFunction (/Users/example/private-repository/file.ts:4:2)",
  ];
  const error = new Error(sensitive.slice(0, 3).join(" "));
  error.code = "EACCES";
  error.stack = sensitive[3];

  const serialized = JSON.stringify(classifyUnexpectedFailure(error, "capability-execution"));
  for (const value of sensitive) {
    assert.equal(serialized.includes(value), false);
  }

  const hostileGetter = {};
  Object.defineProperties(hostileGetter, {
    code: {
      get() {
        throw new Error("secret code getter value");
      },
    },
    name: {
      get() {
        throw new Error("secret name getter value");
      },
    },
  });
  const hostilePrototype = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("secret prototype value");
      },
    },
  );
  for (const hostile of [hostileGetter, hostilePrototype]) {
    assert.deepEqual(classifyUnexpectedFailure(hostile, "capability-execution"), {
      code: "UNEXPECTED_FAILURE",
      message: "An unexpected failure occurred.",
      phase: "capability-execution",
      retryable: false,
    });
  }
});

test("shares bounded diagnostics through the released v1 report contract", async () => {
  const capability = capabilityFailureReport({
    capabilityId: "test-capability",
    capabilityConfigSchemaVersion: 1,
    error: Object.assign(new Error("/private/root secret"), { code: "ENOENT" }),
    phase: "test-capability-execution",
  });
  const report = foundationReport({
    foundationVersion: "1.2.3",
    coverage: "selected",
    capabilities: [capability],
  });
  assert.equal(report.reportSchemaVersion, 1);
  assert.equal(report.capabilities[0].problem.code, "UNEXPECTED_FILESYSTEM_FAILURE");
  assert.equal(JSON.stringify(report).includes("/private/root secret"), false);

  const schemaRoot = new URL(
    "../packages/engineering-foundation/schemas/foundation-check-report/",
    import.meta.url,
  );
  const v1 = JSON.parse(await readFile(new URL("v1.schema.json", schemaRoot), "utf8"));
  const ajv = new Ajv2020({ strict: true });
  ajv.addSchema(v1);
  assert.equal(ajv.validate(v1.$id, report), true, JSON.stringify(ajv.errors));
});

test("keeps all 12 capability wrappers on the exact bounded phase inventory", async () => {
  const capabilitiesRoot = new URL(
    "../packages/engineering-foundation/src/capabilities/",
    import.meta.url,
  );
  const expected = new Map([
    ["contract-json-schema-releases", "json-schema-release-execution"],
    ["contract-protobuf-evolution", "protobuf-evolution-execution"],
    ["documentation-local-references", "documentation-local-references-execution"],
    ["executable-specifications", "executable-specification-execution"],
    ["governance-architecture-decisions", "architecture-decision-governance-execution"],
    ["public-api-compatibility", "public-api-compatibility-execution"],
    ["quality-gate-runner", "quality-gate-runner-execution"],
    ["repository-agent-workflow", "repository-agent-workflow-execution"],
    ["repository-security-baseline", "repository-security-execution"],
    ["source-dependencies", "source-dependency-execution"],
    ["suppression-governance", "suppression-governance-execution"],
    ["workspace-dependency-declarations", "capability-execution"],
  ]);
  const directories = (await readdir(capabilitiesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const wrapperDirectories = (
    await Promise.all(
      directories.map(async (directory) => {
        try {
          await readFile(new URL(`${directory}/module.ts`, capabilitiesRoot), "utf8");
          return directory;
        } catch (error) {
          if (error?.code === "ENOENT") {
            return null;
          }
          throw error;
        }
      }),
    )
  )
    .filter((directory) => directory !== null)
    .toSorted();
  assert.deepEqual(wrapperDirectories, [...expected.keys()].toSorted());

  for (const [directory, phase] of expected) {
    const source = await readFile(new URL(`${directory}/module.ts`, capabilitiesRoot), "utf8");
    assert.equal(
      source.match(/capabilityFailureReport\(\{/gu)?.length,
      1,
      `${directory} must have exactly one bounded failure wrapper`,
    );
    assert.match(source, new RegExp(`phase: "${phase}"`));
  }
});

test("preserves cancellation outcomes without exposing cancellation details", () => {
  const cancelled = capabilityFailureReport({
    capabilityId: "test-capability",
    capabilityConfigSchemaVersion: 1,
    error: Object.assign(new Error("private cancellation detail"), {
      name: "ProcessCancellationError",
    }),
    phase: "test-capability-execution",
  });
  assert.deepEqual(cancelled, {
    capabilityId: "test-capability",
    capabilityConfigSchemaVersion: 1,
    diagnostics: [],
    outcome: "cancelled",
    problem: {
      code: "EXECUTION_CANCELLED",
      message: "Capability execution was cancelled.",
      phase: "test-capability-execution",
      retryable: false,
    },
    summary: { errors: 0, warnings: 0, infos: 0 },
  });
  assert.equal(JSON.stringify(cancelled).includes("private cancellation detail"), false);
});

test("preserves expected input failures and successful report bytes", () => {
  const expectedProblem = {
    code: "CONFIG_INVALID",
    message: "Configuration is invalid.",
    phase: "configuration",
    retryable: false,
  };
  assert.deepEqual(
    capabilityFailureReport({
      capabilityId: "test-capability",
      capabilityConfigSchemaVersion: 1,
      error: new CapabilityInputError(expectedProblem),
      phase: "unused",
    }),
    capabilityReport({
      capabilityId: "test-capability",
      capabilityConfigSchemaVersion: 1,
      outcome: "invalid-input",
      problem: expectedProblem,
    }),
  );

  const report = foundationReport({
    foundationVersion: "1.2.3",
    coverage: "full",
    capabilities: [
      capabilityReport({
        capabilityId: "test-capability",
        capabilityConfigSchemaVersion: 1,
      }),
    ],
  });
  assert.equal(
    JSON.stringify(report),
    '{"reportSchemaVersion":1,"foundationVersion":"1.2.3","coverage":"full","outcome":"passed","summary":{"errors":0,"warnings":0,"infos":0},"capabilities":[{"capabilityId":"test-capability","capabilityConfigSchemaVersion":1,"outcome":"passed","summary":{"errors":0,"warnings":0,"infos":0},"diagnostics":[]}]}',
  );
});
