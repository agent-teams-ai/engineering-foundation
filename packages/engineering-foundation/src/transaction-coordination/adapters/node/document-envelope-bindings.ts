import {
  assertDocumentPlanDigests,
  documentTemporaryPath
} from "@agent-teams/document-authoring/qualification";
import type { InternalFoundationTransactionStatus } from "../../application/model/internal-transaction-status.js";
import {
  classifyNodeTemporaryIdentity,
  unverifiableDocumentTemporaryStatus
} from "./document-temporary-identity.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  readonly journalVersion: 1 | 2 | 3;
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
    : options.journalVersion === 2 ? new Map([
        ["PREPARED", new Set(["absent:pending:false:false", "absent:preexisting:false:false"])],
        ["PUBLISHING", new Set(["absent:publishing:true:false"])],
        ["PUBLISHED", new Set(["absent:published:false:true"])]
      ]) : new Map([
        ["PREPARED", new Set(["absent:pending:false:false", "absent:preexisting:false:false"])],
        ["MATERIALIZING", new Set(["absent:materializing:false:false"])],
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
  readonly format?: "envelope-v2" | "envelope-v3" | "envelope-v4";
  readonly journal: Record<string, unknown>;
  readonly journalVersion: 1 | 2 | 3;
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
