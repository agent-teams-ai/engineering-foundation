import { createHash } from "node:crypto";

type LegacyJson =
  | boolean
  | null
  | number
  | string
  | readonly LegacyJson[]
  | { readonly [key: string]: LegacyJson };

const knownLegacyBuilds = new Map([
  [
    "0.13.0",
    "sha256:f2790b0ad34abf94aa7b44f2d590c77dfcd1119b4a6cfb2dcb1fa4a80f40cc84"
  ],
  [
    "0.13.1",
    "sha256:39dd226ddd4cd861a2535cc59b2fe5c1a23f0e5b2c4be3190851b87f27ad3072"
  ]
] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function legacyCanonicalJson(value: LegacyJson): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (value.normalize("NFC") !== value) {
      throw new Error("Legacy canonical JSON strings must use NFC.");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error("Legacy canonical JSON numbers must be safe integers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value as readonly LegacyJson[];
    return `[${items.map((item) => legacyCanonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  for (const [key] of entries) {
    if (key.normalize("NFC") !== key) {
      throw new Error("Legacy canonical JSON keys must use NFC.");
    }
  }
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${legacyCanonicalJson(item)}`)
    .join(",")}}`;
}

function legacySha256Bytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function legacySha256Json(value: LegacyJson): string {
  return legacySha256Bytes(Buffer.from(legacyCanonicalJson(value), "utf8"));
}
export function legacyFoundationEnvelopeSha256Json(value: unknown): string {
  return legacySha256Json(value as LegacyJson);
}


function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  subject: string
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${subject} does not have the released legacy shape.`);
  }
}

function assertLegacyPlanShape(plan: Record<string, unknown>): void {
  assertKeys(
    plan,
    [
      "authority",
      "compiler",
      "destination",
      "destinationPrecondition",
      "diagnostics",
      "expectedParent",
      "identityProjection",
      "intent",
      "intentDigest",
      "output",
      "planDigest",
      "projectId",
      "protocolVersion",
      "referencedDocuments",
      "requiredAdapterCapabilities",
      "schemaVersion",
      "selectedOwner"
    ],
    [],
    "Legacy Document Plan"
  );
  const intent = plan["intent"];
  const compiler = plan["compiler"];
  const output = plan["output"];
  if (!isRecord(intent) || !isRecord(compiler) || !isRecord(output)) {
    throw new Error("Legacy Document Plan nested shape is invalid.");
  }
  assertKeys(
    intent,
    ["id", "owner", "schemaVersion", "summary", "title", "type"],
    ["additionalMetadata", "related"],
    "Legacy Document Intent"
  );
  if (
    plan["schemaVersion"] !== 1 ||
    plan["protocolVersion"] !== 1 ||
    compiler["id"] !== "@agent-teams/engineering-foundation" ||
    output["mode"] !== "0644" ||
    output["mediaType"] !== "text/markdown; charset=utf-8"
  ) {
    throw new Error("Legacy Document Plan constants are invalid.");
  }
  const precondition = plan["destinationPrecondition"];
  const expectedParent = plan["expectedParent"];
  const requiredCapabilities = plan["requiredAdapterCapabilities"];
  if (
    !isRecord(precondition) ||
    !isRecord(expectedParent) ||
    !Array.isArray(requiredCapabilities) ||
    precondition["state"] !== "absent" ||
    expectedParent["state"] !== "directory" ||
    expectedParent["ancestry"] !== "real-directories" ||
    requiredCapabilities.length !== 1 ||
    requiredCapabilities[0] !== "create-file-no-replace/v1"
  ) {
    throw new Error("Legacy Document Plan publication contract is invalid.");
  }
  assertKeys(precondition, ["state"], [], "Legacy destination precondition");
  assertKeys(
    expectedParent,
    ["ancestry", "path", "state"],
    [],
    "Legacy expected parent"
  );
}

function selectedFoundation(value: unknown): Record<string, unknown> | undefined {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== 2 ||
    value["operationKind"] !== "document-authoring" ||
    value["payloadKind"] !== "document-authoring-journal/v1"
  ) {
    return undefined;
  }
  const handler = value["recoveryHandler"];
  const foundation = value["foundation"];
  return isRecord(handler) &&
    handler["id"] === "foundation.document-authoring" &&
    handler["contractVersion"] === 1 &&
    isRecord(foundation) &&
    isKnownLegacyDocumentEnvelopeBuild(foundation)
    ? foundation
    : undefined;
}

/** Selects legacy semantics before any corrected schema or digest code runs. */
export function isKnownLegacyDocumentEnvelope(value: unknown): boolean {
  return selectedFoundation(value) !== undefined;
}

function isKnownLegacyDocumentEnvelopeBuild(
  foundation: Record<string, unknown>
): boolean {
  const version = foundation["version"];
  const buildIdentity = foundation["buildIdentity"];
  return (
    typeof version === "string" &&
    typeof buildIdentity === "string" &&
    knownLegacyBuilds.get(version as "0.13.0" | "0.13.1") === buildIdentity
  );
}

/** Replays the exact document hash semantics shipped by 0.13.0 and 0.13.1. */
export function assertLegacyDocumentEnvelope(
  envelope: Record<string, unknown>
): void {
  assertKeys(
    envelope,
    [
      "adapterContractVersion",
      "envelopeDigest",
      "foundation",
      "journal",
      "operationKind",
      "payloadDigest",
      "payloadKind",
      "recoveryHandler",
      "schemaVersion",
      "state"
    ],
    [],
    "Legacy Foundation envelope"
  );
  const foundation = envelope["foundation"];
  const handler = envelope["recoveryHandler"];
  const journal = envelope["journal"];
  if (!isRecord(foundation) || !isRecord(handler) || !isRecord(journal)) {
    throw new Error("Legacy Foundation envelope nested shape is invalid.");
  }
  assertKeys(foundation, ["buildIdentity", "version"], [], "Legacy Foundation identity");
  assertKeys(handler, ["contractVersion", "id"], [], "Legacy recovery handler");
  assertKeys(journal, ["destination", "plan", "schemaVersion"], ["ownedTemporary"], "Legacy document journal");
  if (
    !isKnownLegacyDocumentEnvelopeBuild(foundation) ||
    envelope["operationKind"] !== "document-authoring" ||
    envelope["payloadKind"] !== "document-authoring-journal/v1" ||
    envelope["adapterContractVersion"] !== 1 ||
    handler["id"] !== "foundation.document-authoring" ||
    handler["contractVersion"] !== 1 ||
    journal["schemaVersion"] !== 1 ||
    !["PREPARED", "PUBLISHING", "PUBLISHED"].includes(String(envelope["state"]))
  ) {
    throw new Error("Legacy Foundation envelope constants are invalid.");
  }
  const plan = journal["plan"];
  const destination = journal["destination"];
  if (!isRecord(plan) || !isRecord(destination)) {
    throw new Error("Legacy Document Plan is invalid.");
  }
  assertKeys(destination, ["path", "state"], [], "Legacy journal destination");
  const ownedTemporary = journal["ownedTemporary"];
  if (ownedTemporary !== undefined) {
    if (!isRecord(ownedTemporary)) {
      throw new Error("Legacy owned temporary is invalid.");
    }
    assertKeys(
      ownedTemporary,
      ["digest", "path"],
      [],
      "Legacy owned temporary"
    );
  }
  assertLegacyDocumentPlanDigests(plan);
  if (envelope["payloadDigest"] !== legacySha256Json(journal as LegacyJson)) {
    throw new Error("Legacy transaction payload digest is invalid.");
  }
  const { envelopeDigest, ...body } = envelope;
  if (envelopeDigest !== legacySha256Json(body as LegacyJson)) {
    throw new Error("Legacy transaction envelope digest is invalid.");
  }
}

function assertLegacyDocumentPlanDigests(
  plan: Record<string, unknown>
): void {
  assertLegacyPlanShape(plan);
  const intent = plan["intent"] as Record<string, unknown>;
  const output = plan["output"] as Record<string, unknown>;
  if (plan["intentDigest"] !== legacySha256Json(intent as LegacyJson)) {
    throw new Error("Legacy Document Intent digest is invalid.");
  }
  if (typeof output["contentBase64"] !== "string") {
    throw new Error("Legacy Document output is invalid.");
  }
  const outputBytes = Buffer.from(output["contentBase64"], "base64");
  if (
    outputBytes.toString("base64") !== output["contentBase64"] ||
    output["size"] !== outputBytes.byteLength ||
    output["digest"] !== legacySha256Bytes(outputBytes)
  ) {
    throw new Error("Legacy Document output binding is invalid.");
  }
  const { planDigest, ...body } = plan;
  if (planDigest !== legacySha256Json(body as LegacyJson)) {
    throw new Error("Legacy Document Plan digest is invalid.");
  }
}
