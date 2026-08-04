import type {
  JsonValue,
  AuthorityScaffoldReadSet,
  ScaffoldAuthorityEvidenceV1,
  ScaffoldAuthorityVerifierV1,
  AuthorityScaffoldCompilationInput,
  AuthorityScaffoldPlan,
  ScaffoldRenderingIntent,
  AuthorityScaffoldingConfig,
  AuthorityScaffoldTargetCatalog
} from "../../contract/types.js";
import { sha256Json } from "../../kernel/canonical-json.js";
import { createScaffoldAuthorityEvidence } from "../../kernel/authority-evidence.js";
import { assertAuthorityScaffoldPlanDigest } from "../../kernel/plan-validation.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { assertSchema } from "../../../schema-catalog.js";
import { parseStrictYamlSource } from "../../../strict-yaml.js";
import {
  assertion,
  readContainedRepositoryFile,
  type LoadedRepositoryFile
} from "./node-repository-file.js";
import { ScaffoldAuthorityStaleError } from "./node-authority-error.js";
import { MAX_SCAFFOLD_PLAN_BYTES } from "./node-scaffold-limits.js";

export type ScaffoldAuthorityInputFaultInjector = (
  point: { readonly phase: "before-authority-source-stability-check" }
) => Promise<void> | void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactlyOne<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
  message: string
): T {
  const matches = values.filter(predicate);
  if (matches.length !== 1) {
    throw new ScaffoldError("SCAFFOLD_INPUT_INVALID", message);
  }
  return matches[0] as T;
}

function mapAuthorityCatalog(value: unknown): AuthorityScaffoldTargetCatalog {
  const raw = value as {
    readonly version: 2;
    readonly packages: readonly {
      readonly id: string;
      readonly role: string;
      readonly path: string;
      readonly package_name: string;
      readonly owner_document_id: string;
      readonly owner_document_path: string;
    }[];
  };
  return Object.freeze({
    version: 2,
    packages: Object.freeze(
      raw.packages.map((entry) =>
        Object.freeze({
          id: entry.id,
          role: entry.role,
          path: entry.path,
          packageName: entry.package_name,
          ownerDocument: Object.freeze({
            id: entry.owner_document_id,
            path: entry.owner_document_path
          })
        })
      )
    )
  });
}

function parseMarkdownOwnerFrontmatter(source: string): {
  readonly id: string;
  readonly status: string;
} {
  const normalized = source.replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "Owner document must start with strict YAML frontmatter."
    );
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "Owner document YAML frontmatter must have a closing delimiter."
    );
  }
  const parsed = parseStrictYamlSource(
    normalized.slice(4, end),
    "scaffold-owner-document"
  );
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).toSorted().join(",") !== "id,status" ||
    typeof parsed.id !== "string" ||
    typeof parsed.status !== "string" ||
    !/^[a-z0-9][a-z0-9._/-]*$/u.test(parsed.id) ||
    !/^[a-z0-9][a-z0-9._/-]*$/u.test(parsed.status)
  ) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "Owner document frontmatter must contain normalized id and status strings."
    );
  }
  return Object.freeze({ id: parsed.id, status: parsed.status });
}

async function assertAuthoritySourceSetStable(options: {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly catalogPath: string;
  readonly ownerPath: string;
  readonly expected: readonly ReturnType<typeof assertion>[];
}): Promise<void> {
  const files = await Promise.all([
    readContainedRepositoryFile(
      options.consumerRoot,
      options.configPath,
      "scaffolding-config-stability"
    ),
    readContainedRepositoryFile(
      options.consumerRoot,
      options.catalogPath,
      "scaffold-target-catalog-stability"
    ),
    readContainedRepositoryFile(
      options.consumerRoot,
      options.ownerPath,
      "scaffold-owner-document-stability"
    )
  ]);
  if (
    files.map(assertion).some((observed, index) => {
      const expected = options.expected[index];
      return (
        expected === undefined ||
        observed.path !== expected.path ||
        observed.size !== expected.size ||
        observed.digest !== expected.digest
      );
    })
  ) {
    throw new ScaffoldAuthorityStaleError(
      "Consumer authority changed while Foundation was reading its canonical source set."
    );
  }
}

async function loadAuthorityScaffoldCompilationInput(options: {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly foundationVersion: string;
  readonly intent: unknown;
  readonly configFile: LoadedRepositoryFile;
  readonly configValue: unknown;
  readonly faultInjector?: ScaffoldAuthorityInputFaultInjector;
}): Promise<AuthorityScaffoldCompilationInput> {
  await Promise.all([
    assertSchema("scaffolding-config", options.configValue, "scaffolding-config"),
    assertSchema("scaffold-intent", options.intent, "scaffold-intent")
  ]);
  const config = options.configValue as AuthorityScaffoldingConfig;
  const catalogFile = await readContainedRepositoryFile(
    options.consumerRoot,
    config.targetCatalogPath,
    "scaffold-target-catalog"
  );
  const catalogValue = parseStrictYamlSource(
    catalogFile.source,
    "scaffold-target-catalog"
  );
  await assertSchema(
    "scaffold-target-catalog",
    catalogValue,
    "scaffold-target-catalog"
  );
  const catalog = mapAuthorityCatalog(catalogValue);
  const intent = options.intent as ScaffoldRenderingIntent;
  const composition = requireExactlyOne(
    config.compositions,
    (candidate) => candidate.id === intent.compositionId,
    `Composition must exist exactly once: ${intent.compositionId}.`
  );
  const target = requireExactlyOne(
    catalog.packages,
    (candidate) => candidate.id === intent.targetRef,
    `Scaffold target must exist exactly once: ${intent.targetRef}.`
  );
  const authorityVerifiers = composition.authorityVerifiers as readonly ScaffoldAuthorityVerifierV1[];
  if (authorityVerifiers.length !== 1) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "The selected Composition must contain exactly one authority verifier."
    );
  }
  const verifier = authorityVerifiers[0];
  if (verifier === undefined) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "The selected Composition must admit exactly one supported authority verifier."
    );
  }
  const ownerFile = await readContainedRepositoryFile(
    options.consumerRoot,
    target.ownerDocument.path,
    "scaffold-owner-document"
  );
  const owner = parseMarkdownOwnerFrontmatter(ownerFile.source);
  if (owner.id !== target.ownerDocument.id) {
    throw new ScaffoldAuthorityStaleError(
      "Owner document frontmatter ID does not match the target catalog binding."
    );
  }
  if (!verifier.parameters.allowedStatuses.includes(owner.status)) {
    throw new ScaffoldAuthorityStaleError(
      "Owner document status is not admitted by the selected Composition."
    );
  }
  const authorityReadSet = Object.freeze([
    assertion(options.configFile),
    assertion(catalogFile),
    assertion(ownerFile)
  ]) satisfies AuthorityScaffoldReadSet;
  const [configAssertion, catalogAssertion, ownerAssertion] = authorityReadSet;
  const evidence: ScaffoldAuthorityEvidenceV1 = createScaffoldAuthorityEvidence({
    schemaVersion: 1,
    verifier: Object.freeze({ id: verifier.id, contractVersion: verifier.contractVersion }),
    projectId: config.projectId,
    targetRef: intent.targetRef,
    targetIdentityDigest: sha256Json(target as unknown as JsonValue),
    ownerDocument: Object.freeze({
      id: target.ownerDocument.id,
      path: target.ownerDocument.path,
      status: owner.status
    }),
    sources: Object.freeze([
      Object.freeze({ role: "config" as const, assertion: configAssertion }),
      Object.freeze({ role: "owner-document" as const, assertion: ownerAssertion }),
      Object.freeze({ role: "target-catalog" as const, assertion: catalogAssertion })
    ])
  });
  await assertSchema(
    "scaffold-authority-evidence",
    evidence,
    "scaffold-authority-evidence"
  );
  await options.faultInjector?.({
    phase: "before-authority-source-stability-check"
  });
  await assertAuthoritySourceSetStable({
    consumerRoot: options.consumerRoot,
    configPath: options.configPath,
    catalogPath: config.targetCatalogPath,
    ownerPath: target.ownerDocument.path,
    expected: authorityReadSet
  });
  return Object.freeze({
    foundationVersion: options.foundationVersion,
    configPath: options.configPath,
    config,
    intent,
    catalog,
    authorityEvidence: evidence,
    authorityReadSet
  });
}

export async function loadAuthorityScaffoldCompilationInputFromFile(options: {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly intentPath: string;
  readonly foundationVersion: string;
  readonly faultInjector?: ScaffoldAuthorityInputFaultInjector;
}): Promise<AuthorityScaffoldCompilationInput> {
  const [configFile, intentFile] = await Promise.all([
    readContainedRepositoryFile(
      options.consumerRoot,
      options.configPath,
      "scaffolding-config"
    ),
    readContainedRepositoryFile(
      options.consumerRoot,
      options.intentPath,
      "scaffold-intent"
    )
  ]);
  return loadAuthorityScaffoldCompilationInput({
    consumerRoot: options.consumerRoot,
    configPath: options.configPath,
    foundationVersion: options.foundationVersion,
    intent: parseStrictYamlSource(intentFile.source, "scaffold-intent"),
    configFile,
    configValue: parseStrictYamlSource(configFile.source, "scaffolding-config"),
    ...(options.faultInjector === undefined
      ? {}
      : { faultInjector: options.faultInjector })
  });
}

export async function loadAuthorityScaffoldCompilationInputFromIntent(options: {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly foundationVersion: string;
  readonly intent: unknown;
  readonly faultInjector?: ScaffoldAuthorityInputFaultInjector;
}): Promise<AuthorityScaffoldCompilationInput> {
  const configFile = await readContainedRepositoryFile(
    options.consumerRoot,
    options.configPath,
    "scaffolding-config"
  );
  return loadAuthorityScaffoldCompilationInput({
    consumerRoot: options.consumerRoot,
    configPath: options.configPath,
    foundationVersion: options.foundationVersion,
    intent: options.intent,
    configFile,
    configValue: parseStrictYamlSource(configFile.source, "scaffolding-config"),
    ...(options.faultInjector === undefined
      ? {}
      : { faultInjector: options.faultInjector })
  });
}

export async function readAuthorityScaffoldPlanFile(
  consumerRoot: string,
  planPath: string
): Promise<AuthorityScaffoldPlan> {
  const planFile = await readContainedRepositoryFile(
    consumerRoot,
    planPath,
    "scaffold-plan",
    MAX_SCAFFOLD_PLAN_BYTES
  );
  const value = parseStrictYamlSource(planFile.source, "scaffold-plan");
  await assertSchema("scaffold-plan", value, "scaffold-plan");
  const plan = value as AuthorityScaffoldPlan;
  assertAuthorityScaffoldPlanDigest(plan);
  return plan;
}
