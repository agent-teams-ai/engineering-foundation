import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";

import { planDocumentationDocumentV2 } from "@agent-teams/engineering-foundation/document-authoring";

import { DocsProtocol } from "../application/docs-protocol.js";
import { NodeDocsAdoptionInspector } from "../adapters/node-adoption-inspector.js";
import { NodeCodeAnchorMatcher } from "../adapters/node-code-anchor-matcher.js";
import { NodeFoundationDocsPort } from "../adapters/foundation-docs-port.js";
import { NodeDocsProfileReader } from "../adapters/node-profile-reader.js";
import { normalizeCodeAnchors, normalizeDocumentIds } from "../domain/document-semantics.js";
import type { DocsFindQuery, DocsNewRequest } from "../domain/model.js";
import { crashAtDurablePublishing } from "./crash-driver.js";
import {
  applyReachability,
  changedPaths,
  fileSnapshot,
  isQualificationEvidenceExcludedPath,
  qualificationEvidencePolicy,
  type QualificationEvidenceEntryKind,
  type QualificationEvidencePolicy,
  snapshot
} from "./filesystem-evidence.js";
import type {
  DocsProtocolQualificationContractV2,
  DocsProtocolQualificationReceiptV2,
  DocsProtocolQualificationScenarioV2,
  DocsProtocolQualificationV2Request
} from "./v2-contract.js";
import { assertConsumerIntegrationProfileSchema } from "../consumer-integration/adapters/consumer-integration-schema-validator.js";
import {
  checkConsumerIntegration,
  type ConsumerIntegrationDesiredStateV1
} from "../consumer-integration/index.js";

type ManagedIntegrationCandidate = Omit<ConsumerIntegrationDesiredStateV1, "schemaVersion"> & {
  readonly schemaVersion: unknown;
  readonly qualification?: {
    readonly contractPath: "architecture/foundation/docs-protocol-qualification.json";
    readonly gateCommand: "pnpm docs:protocol:check";
  };
};

export type { DocsFindQuery, DocsNewRequest } from "../domain/model.js";

export interface DocsProtocolQualificationScenario {
  readonly find: {
    readonly expectedIds: readonly string[];
    readonly query: DocsFindQuery;
  };
  readonly newDocument: Omit<DocsNewRequest, "apply" | "consumerRoot" | "profilePath" | "signal">;
}

export interface DocsProtocolQualificationRequest {
  readonly fixtureRoot: string;
  readonly profilePath?: string;
  readonly scenario: DocsProtocolQualificationScenario;
  readonly signal?: AbortSignal;
}

export interface DocsProtocolQualificationReceipt {
  readonly appliedDocumentPath: string;
  readonly checks: readonly ["info", "find", "preview", "crash", "doctor", "recover", "receipt", "parent", "apply", "index", "check", "source-unchanged"];
  readonly projectId: string;
  readonly schemaVersion: 1;
}

export type {
  DocsProtocolQualificationContractV2,
  DocsProtocolQualificationReceiptV2,
  DocsProtocolQualificationScenarioV2,
  DocsProtocolQualificationV2Request
} from "./v2-contract.js";

const MAX_QUALIFICATION_AUTHORITY_BYTES = 8 * 1024 * 1024;

function digest(value: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function readContainedBoundedFile(
  root: string,
  repositoryPath: string,
  label: string,
  maximumBytes = MAX_QUALIFICATION_AUTHORITY_BYTES
): Promise<{ readonly bytes: Buffer; readonly digest: `sha256:${string}`; readonly path: string }> {
  if (repositoryPath.startsWith("/") || repositoryPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} must be one canonical repository-relative path.`);
  }
  const absolute = resolvePath(root, repositoryPath);
  const relativePath = relative(root, absolute);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes the consumer root.`);
  }
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    throw new Error(`${label} must be one bounded regular file.`);
  }
  const physical = await realpath(absolute);
  if (physical !== absolute) {
    throw new Error(`${label} must not traverse a symlink.`);
  }
  const bytes = await readFile(physical);
  if (bytes.byteLength !== metadata.size || bytes.byteLength > maximumBytes) {
    throw new Error(`${label} changed during its bounded read.`);
  }
  return Object.freeze({ bytes, digest: digest(bytes), path: repositoryPath });
}

async function bootstrapQualificationInstallation(consumerRoot: string, rewriteManifest: boolean): Promise<{
  readonly docsVersion: string;
  readonly foundationVersion: string;
}> {
  const docsManifestPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const foundationManifestPath = fileURLToPath(import.meta.resolve("@agent-teams/engineering-foundation/package.json"));
  const [docsManifest, foundationManifest, consumerManifest] = await Promise.all([
    readFile(docsManifestPath, "utf8").then((source) => JSON.parse(source) as { readonly version: string }),
    readFile(foundationManifestPath, "utf8").then((source) => JSON.parse(source) as { readonly version: string }),
    readFile(join(consumerRoot, "package.json"), "utf8").then((source) => JSON.parse(source) as Record<string, unknown>)
  ]);
  if (rewriteManifest) {
    await writeFile(join(consumerRoot, "package.json"), `${JSON.stringify({
      ...consumerManifest,
      devDependencies: {
        ...((typeof consumerManifest["devDependencies"] === "object" && consumerManifest["devDependencies"] !== null)
          ? consumerManifest["devDependencies"] as Record<string, unknown>
          : {}),
        "@agent-teams/docs-protocol": docsManifest.version,
        "@agent-teams/engineering-foundation": foundationManifest.version
      }
    }, null, 2)}\n`, "utf8");
  }
  const scope = join(consumerRoot, "node_modules", "@agent-teams");
  await mkdir(scope, { recursive: true });
  await Promise.all([
    symlink(dirname(docsManifestPath), join(scope, "docs-protocol"), process.platform === "win32" ? "junction" : "dir"),
    symlink(dirname(foundationManifestPath), join(scope, "engineering-foundation"), process.platform === "win32" ? "junction" : "dir")
  ]);
  await writeFile(join(consumerRoot, ".agent-teams-document-authoring-qualification-fixture.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "agent-teams-document-authoring-qualification-fixture",
    consumerRoot: await realpath(consumerRoot)
  })}\n`, "utf8");
  return Object.freeze({ docsVersion: docsManifest.version, foundationVersion: foundationManifest.version });
}

function requireSuccess(label: string, execution: { readonly envelope?: unknown; readonly exitCode: number }): void {
  if (execution.exitCode !== 0) {
    throw new Error(`Docs Protocol qualification ${label} failed with exit code ${execution.exitCode}: ${JSON.stringify(execution.envelope ?? {})}.`);
  }
}

function documentResult(execution: { readonly envelope: { readonly result: unknown }; readonly exitCode: number }): {
  readonly documentPath: string;
  readonly planDigest: string;
  readonly compiled?: { readonly document?: { readonly content?: string; readonly digest?: string } };
  readonly receiptDigest?: string;
  readonly reachability: unknown;
} {
  requireSuccess("document", execution);
  const result = execution.envelope.result as Record<string, unknown>;
  if (typeof result["documentPath"] !== "string" || typeof result["planDigest"] !== "string" || !("reachability" in result)) {
    throw new Error("Docs Protocol qualification expected a successful document result.");
  }
  return {
    documentPath: result["documentPath"],
    planDigest: result["planDigest"],
    ...((typeof result["compiled"] === "object" && result["compiled"] !== null) ? { compiled: result["compiled"] } : {}),
    ...(typeof result["receiptDigest"] === "string" ? { receiptDigest: result["receiptDigest"] } : {}),
    reachability: result["reachability"]
  };
}

async function parentState(root: string, documentPath: string): Promise<"directory" | "missing"> {
  const repositoryParent = dirname(documentPath);
  const absolute = resolvePath(root, repositoryParent);
  const relativeParent = relative(resolvePath(root), absolute);
  if (relativeParent === ".." || relativeParent.startsWith(`..${sep}`)) {
    throw new Error("Qualification document parent escapes its owned temporary consumer.");
  }
  try {
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Qualification document parent must be a real directory.");
    }
    return "directory";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {return "missing";}
    throw error;
  }
}

function createProtocol(): DocsProtocol {
  return new DocsProtocol({
    adoption: new NodeDocsAdoptionInspector(),
    anchors: new NodeCodeAnchorMatcher(),
    foundation: new NodeFoundationDocsPort(),
    profiles: new NodeDocsProfileReader()
  });
}

function qualificationMetadata(
  base: Omit<DocsNewRequest, "apply">,
  blockedBy: readonly string[],
  codeAnchors: readonly { readonly enforcement: "advisory" | "required"; readonly pattern: string }[]
) {
  return {
    ...base.additionalMetadata,
    ...(blockedBy.length === 0 ? {} : { blocked_by: blockedBy }),
    ...(codeAnchors.length === 0
      ? {}
      : { code_anchors: codeAnchors.map(({ enforcement, pattern }) => ({ enforcement, pattern })) })
  };
}

function signalOption(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

async function interruptAndRecover(input: {
  readonly base: Omit<DocsNewRequest, "apply">;
  readonly consumerRoot: string;
  readonly previewResult: ReturnType<typeof documentResult>;
  readonly profilePath: string;
  readonly protocol: DocsProtocol;
}): Promise<{
  readonly receiptDigest: string;
  readonly receipt: {
    readonly commit: { readonly publication: "published"; readonly state: "committed" };
    readonly directoryMaterialization?: {
      readonly observedCreatedDirectories: readonly string[];
      readonly state: string;
    };
    readonly outcome: "applied";
  };
}> {
  const profile = await new NodeDocsProfileReader().read({
    consumerRoot: input.consumerRoot,
    profilePath: input.profilePath,
    ...signalOption(input.base.signal)
  });
  const blockedBy = normalizeDocumentIds(input.base.blockedBy ?? [], "blocked_by");
  const related = normalizeDocumentIds([...(input.base.related ?? []), ...blockedBy], "related");
  const codeAnchors = normalizeCodeAnchors(input.base.codeAnchors ?? []);
  const additionalMetadata = qualificationMetadata(input.base, blockedBy, codeAnchors);
  const crashPlan = await planDocumentationDocumentV2({
    consumerRoot: input.consumerRoot,
    profilePath: profile.foundationProfile.path,
    parentPolicy: "create-missing-real-directories",
    intent: {
      schemaVersion: 1,
      ...input.base.intent,
      ...(related.length === 0 ? {} : { related }),
      ...(Object.keys(additionalMetadata).length === 0 ? {} : { additionalMetadata })
    },
    ...signalOption(input.base.signal)
  });
  if (crashPlan.destination !== input.previewResult.documentPath || crashPlan.planDigest !== input.previewResult.planDigest) {
    throw new Error("Qualification crash Plan differs from the unified Docs Protocol preview.");
  }
  await crashAtDurablePublishing(input.consumerRoot, crashPlan, input.base.signal);
  const interruptedDoctor = await input.protocol.doctor({
    consumerRoot: input.consumerRoot,
    profilePath: input.profilePath,
    ...signalOption(input.base.signal)
  });
  if (interruptedDoctor.exitCode !== 1 || interruptedDoctor.envelope.outcome !== "recovery-required" ||
    interruptedDoctor.envelope.result.transaction.state !== "recoverable") {
    throw new Error("Qualification doctor did not observe its genuine interrupted transaction.");
  }
  const recovered = await input.protocol.recover({
    consumerRoot: input.consumerRoot,
    profilePath: input.profilePath,
    ...signalOption(input.base.signal)
  });
  requireSuccess("recover", recovered);
  if (recovered.envelope.result.transactionState !== "recovered" || recovered.envelope.result.writeState !== "committed" ||
    typeof recovered.envelope.result.receiptDigest !== "string" || recovered.envelope.result.receipt.outcome !== "applied" ||
    recovered.envelope.result.receipt.commit.state !== "committed" || recovered.envelope.result.receipt.commit.publication !== "published") {
    throw new Error("Qualification recovery did not return truthful committed Receipt evidence.");
  }
  return recovered.envelope.result as {
    readonly receiptDigest: string;
    readonly receipt: {
      readonly commit: { readonly publication: "published"; readonly state: "committed" };
      readonly directoryMaterialization?: { readonly observedCreatedDirectories: readonly string[]; readonly state: string };
      readonly outcome: "applied";
    };
  };
}

export async function runDocsProtocolQualification(request: DocsProtocolQualificationRequest): Promise<DocsProtocolQualificationReceipt> {
  const sourceRoot = await realpath(resolvePath(request.fixtureRoot));
  const before = await snapshot(sourceRoot);
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "atd-q-")));
  const consumerRoot = join(temporary, "consumer");
  const profilePath = request.profilePath ?? "architecture/foundation/docs-protocol.yaml";
  try {
    request.signal?.throwIfAborted();
    await cp(sourceRoot, consumerRoot, { recursive: true, errorOnExist: true, force: false, dereference: false });
    await bootstrapQualificationInstallation(consumerRoot, true);
    const protocol = createProtocol();
    const info = await protocol.info({ consumerRoot, profilePath, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    requireSuccess("info", info);
    const find = await protocol.find({ consumerRoot, profilePath, query: request.scenario.find.query, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    requireSuccess("find", find);
    const ids = find.envelope.result.documents.map(({ id }) => id);
    if (JSON.stringify(ids) !== JSON.stringify(request.scenario.find.expectedIds)) {
      throw new Error(`Docs Protocol qualification find mismatch: ${JSON.stringify(ids)}.`);
    }
    const base = { ...request.scenario.newDocument, consumerRoot, profilePath, ...(request.signal === undefined ? {} : { signal: request.signal }) };
    const beforePreview = await fileSnapshot(consumerRoot);
    const preview = await protocol.newDocument({ ...base, apply: false });
    requireSuccess("preview", preview);
    if (changedPaths(beforePreview, await fileSnapshot(consumerRoot)).length !== 0) {
      throw new Error("Preview mutated its owned disposable consumer.");
    }
    const previewResult = documentResult(preview);
    const parentBeforeApply = await parentState(consumerRoot, previewResult.documentPath);
    const recovered = await interruptAndRecover({ base, consumerRoot, previewResult, profilePath, protocol });
    const appliedResult = {
      ...previewResult,
      receiptDigest: recovered.receiptDigest
    };
    const applyChanges = changedPaths(beforePreview, await fileSnapshot(consumerRoot));
    const expectedDirectories = new Set<string>(
      recovered.receipt.directoryMaterialization?.observedCreatedDirectories ?? []
    );
    const unexpectedApplyChanges = applyChanges.filter((entry) => {
      const path = entry.slice(entry.indexOf(":") + 1);
      return path !== appliedResult.documentPath &&
        path !== ".agent-teams-local" &&
        !expectedDirectories.has(path) &&
        !path.startsWith(".agent-teams-local/") &&
        !path.endsWith("/.foundation-retired-evidence-") &&
        !path.includes("/.foundation-retired-evidence-/");
    });
    if (unexpectedApplyChanges.length > 0) {
      throw new Error(`Apply changed paths outside its exact document and Foundation transaction lifecycle: ${JSON.stringify(unexpectedApplyChanges)}.`);
    }
    if (await parentState(consumerRoot, appliedResult.documentPath) !== "directory") {
      throw new Error("Apply did not leave a real document parent directory.");
    }
    if (parentBeforeApply === "missing" && recovered.receipt.directoryMaterialization?.state !== "created-and-retained") {
      throw new Error("Missing-parent qualification recovery did not truthfully report retained Plan v2 materialization.");
    }
    await applyReachability(consumerRoot, appliedResult.reachability);
    const check = await protocol.check({ consumerRoot, profilePath, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (check.exitCode !== 0) {throw new Error(`Docs Protocol qualification check failed: ${JSON.stringify(check.envelope)}.`);}
    const doctor = await protocol.doctor({ consumerRoot, profilePath, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    requireSuccess("doctor", doctor);
    if (await snapshot(sourceRoot) !== before) {
      throw new Error("Qualification modified its source fixture.");
    }
    return Object.freeze({
      appliedDocumentPath: appliedResult.documentPath,
      checks: Object.freeze(["info", "find", "preview", "crash", "doctor", "recover", "receipt", "parent", "apply", "index", "check", "source-unchanged"] as const),
      projectId: info.envelope.result.projectId,
      schemaVersion: 1
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(canonicalJson).join(",")}]`;}
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readQualificationContractV2(root: string, path: string): Promise<{
  readonly contract: DocsProtocolQualificationContractV2;
  readonly evidence: { readonly path: string; readonly digest: `sha256:${string}` };
}> {
  const source = await readContainedBoundedFile(root, path, "Qualification contract");
  const value = JSON.parse(source.bytes.toString("utf8")) as { readonly schemaVersion?: unknown };
  if (value.schemaVersion === 1) {
    throw new Error("DOCS_QUALIFICATION_V1_MIGRATION_REQUIRED: replace fixtureRoot/tests/pins/paths/gate with schemaVersion 2 scenarios; managed integration owns package and route authority.");
  }
  const schema = JSON.parse(await readFile(new URL("../../schemas/docs-protocol-qualification/v2.schema.json", import.meta.url), "utf8")) as object;
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(value)) {
    const details = (validate.errors ?? []).slice(0, 8).map(({ instancePath, message }) => `${instancePath || "/"} ${message ?? "is invalid"}`).join("; ");
    throw new TypeError(`docs-protocol-qualification/v2 validation failed: ${details}`);
  }
  return Object.freeze({
    contract: value as DocsProtocolQualificationContractV2,
    evidence: Object.freeze({ path: source.path, digest: source.digest })
  });
}

async function copyDisposableConsumer(
  sourceRoot: string,
  consumerRoot: string,
  policy: QualificationEvidencePolicy
): Promise<void> {
  await cp(sourceRoot, consumerRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
    dereference: false,
    async filter(source) {
      const repositoryPath = relative(sourceRoot, source).split(sep).join("/");
      if (repositoryPath === "") {return true;}
      const metadata = await lstat(source);
      const entryKind: QualificationEvidenceEntryKind = metadata.isDirectory() ? "directory"
        : metadata.isFile() ? "file"
          : metadata.isSymbolicLink() ? "symbolic-link"
            : "other";
      return !await isQualificationEvidenceExcludedPath(
        sourceRoot,
        repositoryPath,
        policy,
        "source",
        entryKind
      );
    }
  });
}

async function overlayLocalDevelopmentSkill(consumerRoot: string, skillPath: string, enabled: boolean): Promise<void> {
  if (!enabled) {return;}
  // This overlay is intentionally limited to the package-owned canonical Skill
  // and happens only after the consumer has been copied into an owned temp root.
  // Profile projection and every document operation still use the consumer's
  // declared managed integration contract.
  const target = join(consumerRoot, skillPath);
  const targetMetadata = await lstat(target);
  if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) {
    throw new Error("Local-development qualification Skill target must be a regular file.");
  }
  const canonicalSkill = await readFile(new URL("../../skills/docs/SKILL.md", import.meta.url));
  await writeFile(target, canonicalSkill);
}

function scenarioRequest(
  scenario: DocsProtocolQualificationScenarioV2,
  consumerRoot: string,
  profilePath: string,
  signal?: AbortSignal
): Omit<DocsNewRequest, "apply"> {
  return {
    consumerRoot,
    profilePath,
    intent: {
      type: scenario.type,
      id: scenario.intent.id,
      title: scenario.intent.title,
      owner: scenario.intent.owner,
      summary: scenario.intent.summary,
      ...(scenario.intent.slug === undefined ? {} : { slug: scenario.intent.slug }),
      ...(scenario.intent.destination === undefined ? {} : { destination: scenario.intent.destination })
    },
    ...(scenario.intent.related === undefined ? {} : { related: scenario.intent.related }),
    ...(scenario.intent.blockedBy === undefined ? {} : { blockedBy: scenario.intent.blockedBy }),
    ...(scenario.intent.codeAnchors === undefined ? {} : { codeAnchors: scenario.intent.codeAnchors }),
    ...(scenario.intent.metadata === undefined ? {} : { additionalMetadata: scenario.intent.metadata }),
    ...(signal === undefined ? {} : { signal })
  };
}

function assertExpectedScenario(
  scenario: DocsProtocolQualificationScenarioV2,
  result: ReturnType<typeof documentResult> & { readonly compiled?: { readonly document?: { readonly content?: string; readonly digest?: string } } }
): void {
  if (result.documentPath !== scenario.expected.documentPath) {
    throw new Error(`Qualification scenario ${scenario.id} path mismatch: ${result.documentPath}.`);
  }
  if (canonicalJson(result.reachability) !== canonicalJson(scenario.expected.reachability)) {
    throw new Error(`Qualification scenario ${scenario.id} reachability mismatch.`);
  }
  if (scenario.expected.goldenDigest !== undefined && result.compiled?.document?.digest !== scenario.expected.goldenDigest) {
    throw new Error(`Qualification scenario ${scenario.id} golden digest mismatch.`);
  }
}

function assertScenarioCoverage(contract: DocsProtocolQualificationContractV2, declaredTypes: readonly string[]): void {
  const scenarioTypes = contract.scenarios.map(({ type }) => type);
  if (new Set(contract.scenarios.map(({ id }) => id)).size !== contract.scenarios.length ||
    new Set(scenarioTypes).size !== scenarioTypes.length || canonicalJson(scenarioTypes.toSorted()) !== canonicalJson(declaredTypes.toSorted())) {
    throw new Error(`Qualification scenarios must cover every authorable type exactly once; expected ${declaredTypes.join(", ")}.`);
  }
}

export async function runDocsProtocolQualificationV2(
  request: DocsProtocolQualificationV2Request
): Promise<DocsProtocolQualificationReceiptV2> {
  const sourceRoot = await realpath(resolvePath(request.consumerRoot));
  const integrationPath = request.integrationPath ?? "architecture/foundation/docs-consumer-integration.json";
  const integrationFile = await readContainedBoundedFile(sourceRoot, integrationPath, "Managed integration profile");
  const integration = JSON.parse(integrationFile.bytes.toString("utf8")) as ManagedIntegrationCandidate;
  await assertConsumerIntegrationProfileSchema(integration);
  if (integration.schemaVersion !== 2 || integration.qualification === undefined) {
    throw new Error("DOCS_QUALIFICATION_V1_MIGRATION_REQUIRED: managed integration schemaVersion 2 with qualification authority is required.");
  }
  const evidencePolicy = qualificationEvidencePolicy(integration.governedDocsRoots ?? []);
  const before = await snapshot(sourceRoot, evidencePolicy) as `sha256:${string}`;
  const qualification = await readQualificationContractV2(sourceRoot, integration.qualification.contractPath);
  const contract = qualification.contract;
  if (request.localDevelopment !== true) {
    const managed = await checkConsumerIntegration({
      consumerRoot: sourceRoot,
      integrationProfilePath: integrationPath
    });
    if (managed.outcome !== "current") {
      throw new Error(`Released-cohort qualification requires a current exact managed integration: ${JSON.stringify(managed.issues)}.`);
    }
  }
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "atd-q2-")));
  const consumerRoot = join(temporary, "consumer");
  try {
    request.signal?.throwIfAborted();
    await copyDisposableConsumer(sourceRoot, consumerRoot, evidencePolicy);
    const executingPackages = await bootstrapQualificationInstallation(consumerRoot, request.localDevelopment === true);
    await overlayLocalDevelopmentSkill(consumerRoot, integration.skillPath, request.localDevelopment === true);
    const manifest = JSON.parse(await readFile(join(consumerRoot, "package.json"), "utf8")) as { readonly scripts?: Readonly<Record<string, unknown>> };
    if (typeof manifest.scripts?.["docs:protocol:check"] !== "string") {
      throw new Error(`Managed qualification gate ${integration.qualification.gateCommand} must resolve to a package script; it is never executed by qualification.`);
    }
    const protocol = createProtocol();
    const base = { consumerRoot, profilePath: integration.profilePath, ...signalOption(request.signal) };
    const info = await protocol.info(base);
    requireSuccess("info", info);
    const infoResult = info.envelope.result;
    const declaredTypes = infoResult.types.map(({ type }) => type);
    assertScenarioCoverage(contract, declaredTypes);
    requireSuccess("find", await protocol.find({ ...base, query: {} }));
    requireSuccess("check", await protocol.check(base));
    const initialDoctor = await protocol.doctor(base);
    requireSuccess("doctor", initialDoctor);
    const idleRecovery = await protocol.recover(base);
    requireSuccess("recover", idleRecovery);
    if (idleRecovery.envelope.result.transactionState !== "no-pending-transaction") {
      throw new Error("Qualification recover did not prove the initial idle state.");
    }
    // New authoring remains one-file canonical frontmatter. A declared sidecar
    // is qualified separately through the suite-wide info/find/check catalog
    // roundtrip and is never a writer destination.
    const receipts: { id: string; type: string; documentPath: string; outputDigest: string }[] = [];
    for (const [index, scenario] of contract.scenarios.entries()) {
      const scenarioBase = scenarioRequest(scenario, consumerRoot, integration.profilePath, request.signal);
      const beforePreview = await fileSnapshot(consumerRoot, evidencePolicy);
      const preview = await protocol.newDocument({ ...scenarioBase, apply: false });
      const previewResult = documentResult(preview) as ReturnType<typeof documentResult> & { readonly compiled: { readonly document: { readonly content: string; readonly digest: string } } };
      if (changedPaths(beforePreview, await fileSnapshot(consumerRoot, evidencePolicy)).length !== 0) {
        throw new Error(`Qualification scenario ${scenario.id} preview mutated the disposable consumer.`);
      }
      assertExpectedScenario(scenario, previewResult);
      if (scenario.expected.goldenFile !== undefined) {
        const golden = await readContainedBoundedFile(
          consumerRoot,
          scenario.expected.goldenFile,
          `Qualification scenario ${scenario.id} golden file`
        );
        if (golden.bytes.toString("utf8") !== previewResult.compiled.document.content) {throw new Error(`Qualification scenario ${scenario.id} golden file mismatch.`);}
      }
      if (index === 0) {
        await interruptAndRecover({ base: scenarioBase, consumerRoot, previewResult, profilePath: integration.profilePath, protocol });
      } else {
        const applied = await protocol.newDocument({ ...scenarioBase, apply: true });
        const appliedResult = documentResult(applied) as typeof previewResult;
        if (appliedResult.planDigest !== previewResult.planDigest || appliedResult.compiled.document.content !== previewResult.compiled.document.content) {
          throw new Error(`Qualification scenario ${scenario.id} preview/apply parity mismatch.`);
        }
      }
      const actual = await readFile(join(consumerRoot, previewResult.documentPath), "utf8");
      if (actual !== previewResult.compiled.document.content) {throw new Error(`Qualification scenario ${scenario.id} materialized bytes differ from preview.`);}
      await applyReachability(consumerRoot, previewResult.reachability);
      requireSuccess(`check after ${scenario.id}`, await protocol.check(base));
      receipts.push({ id: scenario.id, type: scenario.type, documentPath: previewResult.documentPath, outputDigest: previewResult.compiled.document.digest });
    }
    requireSuccess("doctor", await protocol.doctor(base));
    requireSuccess("recover", await protocol.recover(base));
    if (await snapshot(sourceRoot, evidencePolicy) !== before) {throw new Error("Qualification modified its source consumer.");}
    const [profileEvidence, skillEvidence, packageManifestEvidence, lockfileEvidence, executingModule] = await Promise.all([
      readContainedBoundedFile(consumerRoot, integration.profilePath, "Docs Protocol profile"),
      readContainedBoundedFile(consumerRoot, integration.skillPath, "Documentation Skill"),
      readContainedBoundedFile(consumerRoot, "package.json", "Package manifest"),
      readContainedBoundedFile(consumerRoot, "pnpm-lock.yaml", "pnpm lockfile", 64 * 1024 * 1024),
      readFile(fileURLToPath(import.meta.url))
    ]);
    const environment = initialDoctor.envelope.result.environment as {
      readonly installedFoundationBuildIdentity: `sha256:${string}`;
      readonly installedFoundationVersion: string;
    };
    if (request.localDevelopment !== true && (
      executingPackages.docsVersion !== integration.cohort.packages.docsProtocol.version ||
      executingPackages.foundationVersion !== integration.cohort.packages.engineeringFoundation.version ||
      environment.installedFoundationVersion !== integration.cohort.packages.engineeringFoundation.version
    )) {
      throw new Error("Released-cohort qualification execution identity does not match the exact cohort package versions.");
    }
    const hasGolden = contract.scenarios.some(({ expected }) =>
      expected.goldenFile !== undefined || expected.goldenDigest !== undefined);
    const body = Object.freeze({
      schemaVersion: 2,
      cohortAdmissible: request.localDevelopment !== true,
      evidenceClass: request.localDevelopment === true ? "local-development" : "released-cohort",
      projectId: infoResult.projectId,
      scenarios: Object.freeze(receipts.map((receipt) => Object.freeze(receipt))),
      checks: Object.freeze([
        "info", "find", "check", "doctor", "recover", "preview", "apply", "path", "reachability",
        ...(hasGolden ? ["golden" as const] : []),
        "source-unchanged"
      ] as const),
      derived: Object.freeze({
        contractPath: integration.qualification.contractPath,
        gateCommand: integration.qualification.gateCommand,
        packageVersions: Object.freeze({ docsProtocol: integration.cohort.packages.docsProtocol.version, engineeringFoundation: integration.cohort.packages.engineeringFoundation.version }),
        profilePath: integration.profilePath
      }),
      evidence: Object.freeze({
        sourceDigest: before,
        integration: Object.freeze({ path: integrationPath, digest: integrationFile.digest }),
        contract: qualification.evidence,
        profile: Object.freeze({ path: profileEvidence.path, digest: profileEvidence.digest }),
        skill: Object.freeze({ path: skillEvidence.path, digest: skillEvidence.digest }),
        packageManifestDigest: packageManifestEvidence.digest,
        lockfileDigest: lockfileEvidence.digest,
        executingDocsProtocol: Object.freeze({ version: executingPackages.docsVersion, buildDigest: digest(executingModule) }),
        executingFoundation: Object.freeze({
          version: environment.installedFoundationVersion,
          buildIdentity: environment.installedFoundationBuildIdentity
        }),
        cohort: Object.freeze({ ...integration.cohort })
      })
    });
    return Object.freeze({
      ...body,
      receiptDigest: digest(canonicalJson(body))
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
