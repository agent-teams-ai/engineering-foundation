import type {
  JsonValue
} from "../application/model/scaffold-values.js";
import type {
  ScaffoldAuthorityEvidenceV1,
  ScaffoldAuthoritySourceAssertionV1,
  ScaffoldReadAssertionV1,
  AuthorityScaffoldTarget
} from "../application/model/scaffold-compilation.js";
import { ScaffoldError } from "../scaffold-error.js";
import { canonicalJson, sha256Json } from "./canonical-json.js";

function canonicalSources(
  sources: readonly ScaffoldAuthoritySourceAssertionV1[]
): ScaffoldAuthorityEvidenceV1["sources"] {
  const source = <TRole extends ScaffoldAuthoritySourceAssertionV1["role"]>(
    role: TRole
  ): ScaffoldAuthoritySourceAssertionV1 & { readonly role: TRole } => {
    const matches = sources.filter((candidate) => candidate.role === role);
    if (matches.length !== 1) {
      throw new ScaffoldError(
        "SCAFFOLD_PLAN_INVALID",
        `Scaffolding Authority Evidence must contain exactly one ${role} source.`
      );
    }
    return matches[0] as ScaffoldAuthoritySourceAssertionV1 & {
      readonly role: TRole;
    };
  };
  return Object.freeze([
    source("config"),
    source("owner-document"),
    source("target-catalog")
  ]);
}

function canonicalEvidenceBody(
  evidence: Omit<ScaffoldAuthorityEvidenceV1, "evidenceDigest">
): Omit<ScaffoldAuthorityEvidenceV1, "evidenceDigest"> {
  return Object.freeze({
    ...evidence,
    sources: canonicalSources(evidence.sources)
  });
}

export function createScaffoldAuthorityEvidence(
  evidence: Omit<ScaffoldAuthorityEvidenceV1, "evidenceDigest">
): ScaffoldAuthorityEvidenceV1 {
  const body = canonicalEvidenceBody(evidence);
  return Object.freeze({
    ...body,
    evidenceDigest: sha256Json(body as unknown as JsonValue)
  });
}

export function assertScaffoldAuthorityEvidenceDigest(
  evidence: ScaffoldAuthorityEvidenceV1
): void {
  const { evidenceDigest: _evidenceDigest, ...body } = evidence;
  const expected = sha256Json(
    canonicalEvidenceBody(body) as unknown as JsonValue
  );
  if (evidence.evidenceDigest !== expected) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      "Scaffolding Authority Evidence digest does not match its canonical content."
    );
  }
}

export function assertAuthorityEvidenceSourceBindings(options: {
  readonly evidence: ScaffoldAuthorityEvidenceV1;
  readonly target: AuthorityScaffoldTarget;
  readonly projectId: string;
  readonly targetRef: string;
  readonly configPath: string;
  readonly targetCatalogPath: string;
  readonly authorityReadSet: readonly ScaffoldReadAssertionV1[];
}): void {
  const { evidence, target } = options;
  assertScaffoldAuthorityEvidenceDigest(evidence);
  if (
    evidence.projectId !== options.projectId ||
    evidence.targetRef !== options.targetRef ||
    evidence.targetIdentityDigest !==
      sha256Json(target as unknown as JsonValue) ||
    evidence.ownerDocument.id !== target.ownerDocument.id ||
    evidence.ownerDocument.path !== target.ownerDocument.path
  ) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      "Scaffolding Authority Evidence is not bound to the selected target."
    );
  }
  const expectedRoles = new Set(["config", "target-catalog", "owner-document"]);
  const expectedPaths = new Map([
    ["config", options.configPath],
    ["target-catalog", options.targetCatalogPath],
    ["owner-document", target.ownerDocument.path]
  ]);
  const evidencePaths = new Set<string>();
  for (const source of evidence.sources) {
    if (
      !expectedRoles.delete(source.role) ||
      evidencePaths.has(source.assertion.path) ||
      expectedPaths.get(source.role) !== source.assertion.path
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_PLAN_INVALID",
        "Scaffolding Authority Evidence source roles are not bound to canonical paths."
      );
    }
    evidencePaths.add(source.assertion.path);
  }
  if (expectedRoles.size !== 0) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      "Scaffolding Authority Evidence does not contain every required source."
    );
  }
  const readSet = new Map(
    options.authorityReadSet.map((assertion) => [assertion.path, assertion])
  );
  if (readSet.size !== options.authorityReadSet.length || readSet.size !== 3) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      "Scaffolding source-bound must bind exactly three authority read sources."
    );
  }
  for (const source of evidence.sources) {
    const assertion = readSet.get(source.assertion.path);
    if (
      assertion === undefined ||
      canonicalJson(assertion as unknown as JsonValue) !==
        canonicalJson(source.assertion as unknown as JsonValue)
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_PLAN_INVALID",
        "Scaffolding Authority Evidence and Plan read set disagree."
      );
    }
  }
}
