export interface DocumentPhysicalIdentity {
  readonly adapter: "node-filesystem";
  readonly version: 1;
  readonly dev: string;
  readonly ino: string;
  readonly birthtimeNs: string;
}

const DECIMAL_IDENTITY_COMPONENT = /^(?:0|[1-9][0-9]{0,31})$/u;

export function assertDocumentPhysicalIdentity(
  value: unknown
): asserts value is DocumentPhysicalIdentity {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Document physical identity is not an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(candidate).length !== 5 ||
    candidate.adapter !== "node-filesystem" ||
    candidate.version !== 1 ||
    ![
      candidate.dev,
      candidate.ino,
      candidate.birthtimeNs
    ].every((part) => typeof part === "string" &&
      DECIMAL_IDENTITY_COMPONENT.test(part)) ||
    candidate.dev === "0" ||
    candidate.ino === "0" ||
    candidate.birthtimeNs === "0"
  ) {
    throw new Error(
      "Document physical identity is invalid or contains a zero component."
    );
  }
}
