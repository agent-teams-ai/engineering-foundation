import { sha256Json as sha256DocumentJson } from "../../../canonical-json.js";
import { assertDocumentPlanDigests } from "../../../document-authoring/application/policies/document-contract-digests.js";
import { documentTemporaryPath } from "../../../document-authoring/application/policies/document-temporary-path.js";
import type { JsonValue } from "../../../scaffolding/contract/types.js";
import type { InternalFoundationTransactionStatus } from "../../application/model/internal-transaction-status.js";
import { assertSchema } from "../../../schema-catalog.js";
import {
  classifyNodeTemporaryIdentity,
  unverifiableDocumentTemporaryStatus
} from "./document-temporary-identity.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertDocumentEnvelopeDigests(
  envelope: Record<string, unknown>
): void {
  const journal = envelope["journal"];
  if (envelope["payloadDigest"] !== sha256DocumentJson(journal as JsonValue)) {
    throw new Error("Foundation transaction payload digest is invalid.");
  }
  const { envelopeDigest, ...body } = envelope;
  if (envelopeDigest !== sha256DocumentJson(body as JsonValue)) {
    throw new Error("Foundation transaction envelope digest is invalid.");
  }
}

function assertTemporaryBinding(options: {
  readonly journal: Record<string, unknown>;
  readonly plan: Record<string, unknown>;
  readonly legacyDigestSemantics: boolean;
}): "legacy-or-absent" | "verifiable" | "unverifiable" {
  const ownedTemporary = options.journal["ownedTemporary"];
  if (ownedTemporary === undefined) {
    return "legacy-or-absent";
  }
  const output = options.plan["output"];
  const expectedTemporary = options.legacyDigestSemantics
    ? `${String(options.plan["destination"])}.foundation-document.tmp`
    : documentTemporaryPath(
        String(options.plan["destination"]),
        String(options.plan["planDigest"])
      );
  if (
    !isRecord(output) ||
    !isRecord(ownedTemporary) ||
    ownedTemporary["digest"] !== output["digest"] ||
    ownedTemporary["path"] !== expectedTemporary
  ) {
    throw new Error("Document transaction temporary binding is invalid.");
  }
  if (options.legacyDigestSemantics) {
    return "legacy-or-absent";
  }
  const identity = classifyNodeTemporaryIdentity(ownedTemporary["identity"]);
  if (identity === "invalid") {
    throw new Error("Document transaction temporary identity is invalid.");
  }
  return identity;
}

function assertLifecycleBinding(options: {
  readonly journal: Record<string, unknown>;
  readonly journalVersion: 1 | 2;
  readonly plan: Record<string, unknown>;
  readonly state: unknown;
}): void {
  const destination = options.journal["destination"];
  const precondition = options.plan["destinationPrecondition"];
  if (
    !isRecord(destination) ||
    destination["path"] !== options.plan["destination"] ||
    !isRecord(precondition)
  ) {
    throw new Error("Document transaction semantic binding is invalid.");
  }
  const hasTemporary = options.journal["ownedTemporary"] !== undefined;
  const hasPublication = options.journal["publicationIdentity"] !== undefined;
  const lifecycle = `${String(precondition["state"])}:${String(destination["state"])}:${String(hasTemporary)}:${String(hasPublication)}`;
  const expected = options.journalVersion === 1
    ? new Map([
        ["PREPARED", new Set(["absent:pending:false:false", "absent:preexisting:false:false"])],
        ["PUBLISHING", new Set(["absent:publishing:true:false"])],
        ["PUBLISHED", new Set(["absent:published:false:false"])]
      ])
    : new Map([
        ["PREPARED", new Set(["absent:pending:false:false", "absent:preexisting:false:false"])],
        ["PUBLISHING", new Set(["absent:publishing:true:false"])],
        ["PUBLISHED", new Set(["absent:published:false:true"])]
      ]);
  if (expected.get(String(options.state))?.has(lifecycle) !== true) {
    throw new Error("Document transaction lifecycle binding is invalid.");
  }
  if (hasPublication) {
    const identity = classifyNodeTemporaryIdentity(
      options.journal["publicationIdentity"]
    );
    if (identity !== "verifiable") {
      throw new Error("Document publication identity must be valid and nonzero.");
    }
  }
}

export function inspectDocumentTransactionBindings(options: {
  readonly foundation: Record<string, unknown>;
  readonly format?: "envelope-v2" | "envelope-v3";
  readonly journal: Record<string, unknown>;
  readonly journalVersion: 1 | 2;
  readonly legacyDigestSemantics?: boolean;
  readonly plan: Record<string, unknown>;
  readonly state: unknown;
}): InternalFoundationTransactionStatus | undefined {
  const legacyDigestSemantics = options.legacyDigestSemantics ?? false;
  if (!legacyDigestSemantics) {
    assertDocumentPlanDigests(options.plan);
  }
  const temporary = assertTemporaryBinding({
    journal: options.journal,
    plan: options.plan,
    legacyDigestSemantics
  });
  assertLifecycleBinding(options);
  return temporary === "unverifiable"
    ? unverifiableDocumentTemporaryStatus(
        options.foundation,
        options.format ?? "envelope-v2"
      )
    : undefined;
}

export async function inspectCurrentDocumentEnvelope(options: {
  readonly value: Record<string, unknown>;
  readonly installedVersion: string;
  readonly installedBuildIdentity: string;
  readonly pending: (identity: {
    readonly foundationVersion: string;
    readonly foundationBuildIdentity: string;
    readonly installedVersion: string;
    readonly installedBuildIdentity: string;
  }) => InternalFoundationTransactionStatus;
}): Promise<InternalFoundationTransactionStatus> {
  await assertSchema(
    "foundation-transaction-envelope/v3",
    options.value,
    "foundation-transaction-slot"
  );
  assertDocumentEnvelopeDigests(options.value);
  const foundation = options.value["foundation"];
  const handler = options.value["recoveryHandler"];
  const journal = options.value["journal"];
  if (
    options.value["operationKind"] !== "document-authoring" ||
    options.value["payloadKind"] !== "document-authoring-journal/v2" ||
    !isRecord(handler) || handler["id"] !== "foundation.document-authoring" ||
    handler["contractVersion"] !== 2 || !isRecord(foundation) ||
    typeof foundation["version"] !== "string" ||
    typeof foundation["buildIdentity"] !== "string" || !isRecord(journal) ||
    journal["schemaVersion"] !== 2
  ) {
    throw new Error("Current Document transaction envelope binding is invalid.");
  }
  const plan = journal["plan"];
  const compiler = isRecord(plan) ? plan["compiler"] : undefined;
  if (!isRecord(plan) || !isRecord(compiler) ||
    compiler["version"] !== foundation["version"] ||
    compiler["buildIdentity"] !== foundation["buildIdentity"]) {
    throw new Error("Current Document transaction compiler binding is invalid.");
  }
  const status = inspectDocumentTransactionBindings({
    foundation, format: "envelope-v3", journal, journalVersion: 2, plan,
    state: options.value["state"]
  });
  return status ?? options.pending({
    foundationVersion: foundation["version"],
    foundationBuildIdentity: foundation["buildIdentity"],
    installedVersion: options.installedVersion,
    installedBuildIdentity: options.installedBuildIdentity
  });
}
