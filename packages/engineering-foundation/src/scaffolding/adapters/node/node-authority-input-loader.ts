import type {
  AuthorityScaffoldReadSet,
  ScaffoldAuthorityEvidenceV1,
  ScaffoldAuthorityVerifierV1,
  AuthorityScaffoldCompilationInput,
  AuthorityScaffoldPlan,
  AuthorityScaffoldTarget,
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
import { resolveOwnerDocument } from "./node-owner-document-resolver.js";
import { MAX_SCAFFOLD_PLAN_BYTES } from "./node-scaffold-limits.js";

export type ScaffoldAuthorityInputFaultInjector = (
  point: { readonly phase: "before-authority-source-stability-check" }
) => Promise<void> | void;

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

interface UnresolvedAuthorityScaffoldTarget {
  readonly id: string;
  readonly role: string;
  readonly path: string;
  readonly packageName: string;
  readonly ownerDocumentId: string;
}

interface UnresolvedAuthorityScaffoldTargetCatalog {
  readonly version: 2;
  readonly packages: readonly UnresolvedAuthorityScaffoldTarget[];
}

function mapAuthorityCatalog(
  value: unknown
): UnresolvedAuthorityScaffoldTargetCatalog {
  const raw = value as {
    readonly version: 2;
    readonly packages: readonly {
      readonly id: string;
      readonly role: string;
      readonly path: string;
      readonly package_name: string;
      readonly owner_document: string;
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
          ownerDocumentId: entry.owner_document
        })
      )
    )
  });
}

async function assertAuthoritySourceSetStable(options: {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly catalogPath: string;
  readonly ownerDocumentId: string;
  readonly documentRoots: readonly string[];
  readonly ownerIndexDigest: string;
  readonly expected: readonly ReturnType<typeof assertion>[];
}): Promise<void> {
  const [files, owner] = await Promise.all([
    Promise.all([
      readContainedRepositoryFile(
        options.consumerRoot,
        options.configPath,
        "scaffolding-config-stability"
      ),
      readContainedRepositoryFile(
        options.consumerRoot,
        options.catalogPath,
        "scaffold-target-catalog-stability"
      )
    ]),
    resolveOwnerDocument({
      consumerRoot: options.consumerRoot,
      documentRoots: options.documentRoots,
      ownerDocumentId: options.ownerDocumentId
    })
  ]);
  const observed = [...files.map(assertion), assertion(owner.file)];
  if (
    owner.indexDigest !== options.ownerIndexDigest ||
    observed.some((current, index) => {
      const expected = options.expected[index];
      return (
        expected === undefined ||
        current.path !== expected.path ||
        current.size !== expected.size ||
        current.digest !== expected.digest
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
  const unresolvedCatalog = mapAuthorityCatalog(catalogValue);
  const intent = options.intent as ScaffoldRenderingIntent;
  const composition = requireExactlyOne(
    config.compositions,
    (candidate) => candidate.id === intent.compositionId,
    `Composition must exist exactly once: ${intent.compositionId}.`
  );
  const target = requireExactlyOne(
    unresolvedCatalog.packages,
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
  const owner = await resolveOwnerDocument({
    consumerRoot: options.consumerRoot,
    documentRoots: verifier.parameters.documentRoots,
    ownerDocumentId: target.ownerDocumentId
  });
  if (!verifier.parameters.allowedStatuses.includes(owner.status)) {
    throw new ScaffoldAuthorityStaleError(
      "Owner document status is not admitted by the selected Composition."
    );
  }
  const resolvedTarget = Object.freeze({
    id: target.id,
    role: target.role,
    path: target.path,
    packageName: target.packageName,
    ownerDocument: Object.freeze({ id: owner.id, path: owner.file.path })
  }) satisfies AuthorityScaffoldTarget;
  const catalog = Object.freeze({
    version: 2 as const,
    packages: Object.freeze([resolvedTarget])
  }) satisfies AuthorityScaffoldTargetCatalog;
  const authorityReadSet = Object.freeze([
    assertion(options.configFile),
    assertion(catalogFile),
    assertion(owner.file)
  ]) satisfies AuthorityScaffoldReadSet;
  const [configAssertion, catalogAssertion, ownerAssertion] = authorityReadSet;
  const evidence: ScaffoldAuthorityEvidenceV1 = createScaffoldAuthorityEvidence({
    schemaVersion: 1,
    verifier: Object.freeze({ id: verifier.id, contractVersion: verifier.contractVersion }),
    projectId: config.projectId,
    targetRef: intent.targetRef,
    targetIdentityDigest: sha256Json(resolvedTarget),
    ownerDocument: Object.freeze({
      id: resolvedTarget.ownerDocument.id,
      path: resolvedTarget.ownerDocument.path,
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
    ownerDocumentId: target.ownerDocumentId,
    documentRoots: verifier.parameters.documentRoots,
    ownerIndexDigest: owner.indexDigest,
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
