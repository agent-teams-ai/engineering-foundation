import { createHash } from "node:crypto";
import { DOCS_ADOPTION_MAX_ROUTING_BYTES } from "../../portable-documentation/domain.js";
import { PORTABLE_BOOTSTRAP_BEGIN_MARKER, PORTABLE_BOOTSTRAP_END_MARKER, portableBootstrapManagedBlock, type PortableBootstrapDesiredFile } from "./portable-bootstrap-assets.js";
import type { PortableBootstrapInput, PortableBootstrapFilePlan, PortableBootstrapIssue, BootstrapOperation, BootstrapObservedFile, BootstrapTransactionPlan } from "./bootstrap-model.js";
const MAXIMUM_ROOT_LENGTH = 4096, MAXIMUM_PROJECT_ID_LENGTH = 160, MAXIMUM_OWNER_ID_LENGTH = 214;
const PROJECT_ID = /^[a-z0-9][a-z0-9._/-]*$/u;
const OWNER_ID = /^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/u;

function assertCanonicalId(
  value: string,
  name: "ownerId" | "projectId",
  pattern: RegExp,
  maximumLength: number
): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
    value.normalize("NFC") !== value || !pattern.test(value) || value.startsWith("/") ||
    value.endsWith("/") || value.includes("//") || value.split("/").some((part) =>
      part === "." || part === ".."
    )) {
    throw new TypeError(`${name} must be one bounded canonical identifier.`);
  }
}

export function assertInput(input: Omit<PortableBootstrapInput, "mode"> & { readonly mode: unknown }): void {
  if (Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("Portable bootstrap input must be a plain object.");
  }
  if (typeof input.consumerRoot !== "string" || input.consumerRoot.length === 0 ||
    input.consumerRoot.length > MAXIMUM_ROOT_LENGTH || input.consumerRoot.includes("\u0000")) {
    throw new TypeError("consumerRoot must be one bounded filesystem path.");
  }
  if (input.mode !== "dry-run" && input.mode !== "apply") {
    throw new TypeError("mode must be dry-run or apply.");
  }
  assertCanonicalId(input.projectId, "projectId", PROJECT_ID, MAXIMUM_PROJECT_ID_LENGTH);
  assertCanonicalId(input.ownerId, "ownerId", OWNER_ID, MAXIMUM_OWNER_ID_LENGTH);
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

export function portablePlanDigest(
  input: {
    readonly desired: readonly PortableBootstrapDesiredFile[];
    readonly files: readonly PortableBootstrapFilePlan[];
    readonly issues: readonly PortableBootstrapIssue[];
    readonly ownerId: string;
    readonly projectId: string;
    readonly transactionPlan: BootstrapTransactionPlan | undefined;
  }
): `sha256:${string}` {
  const body = JSON.stringify({
    protocol: "agent-teams.docs-protocol.portable-bootstrap/v1",
    projectId: input.projectId,
    ownerId: input.ownerId,
    files: input.desired.map(({ bytes, ownership, path }) => ({
      path,
      ownership,
      digest: createHash("sha256").update(bytes).digest("hex")
    })),
    agentsManagedBlockDigest: createHash("sha256").update(portableBootstrapManagedBlock("\n")).digest("hex"),
    observedPlanDigest: input.transactionPlan?.planDigest ?? null,
    observations: input.files.map(({ ownership, path, writeState }) => ({ ownership, path, writeState })),
    issues: input.issues
  });
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

export function planCreateOnlyFile(
  file: PortableBootstrapDesiredFile,
  observation: BootstrapObservedFile | undefined
): {
  readonly file: PortableBootstrapFilePlan;
  readonly issue?: PortableBootstrapIssue;
  readonly operation?: BootstrapOperation;
} {
  const current = observation === undefined ? undefined : { bytes: Buffer.from(observation.contentBase64, "base64"), mode: observation.mode };
  if (current === undefined) {
    return {
      file: { path: file.path, ownership: file.ownership, writeState: "create" },
      operation: {
        path: file.path,
        precondition: { state: "absent" },
        postimage: { contentBase64: Buffer.from(file.bytes).toString("base64") }
      }
    };
  }
  if (current.bytes.equals(file.bytes)) {
    return {
      file: { path: file.path, ownership: file.ownership, writeState: "current" },
      operation: {
        path: file.path,
        precondition: { state: "known-file", acceptedPreimages: [{ contentBase64: current.bytes.toString("base64"), mode: current.mode }] },
        postimage: { contentBase64: current.bytes.toString("base64"), mode: current.mode }
      }
    };
  }
  return {
    file: { path: file.path, ownership: file.ownership, writeState: "blocked" },
    issue: {
      code: "PORTABLE_BOOTSTRAP_CONFLICT",
      path: file.path,
      message: "A create-only bootstrap target already exists with different bytes."
    }
  };
}

function agentsSizeIssue(bytes: Uint8Array): PortableBootstrapIssue | undefined {
  return bytes.byteLength > DOCS_ADOPTION_MAX_ROUTING_BYTES ? {
    code: "PORTABLE_BOOTSTRAP_AGENTS_TOO_LARGE",
    path: "AGENTS.md",
    message: `Managed AGENTS.md postimage exceeds the ${DOCS_ADOPTION_MAX_ROUTING_BYTES} byte adoption limit.`
  } : undefined;
}

function hasExactManagedBlock(input: {
  readonly beginCount: number;
  readonly block: string;
  readonly endCount: number;
  readonly eol: string;
  readonly source: string;
}): boolean {
  const begin = input.source.indexOf(PORTABLE_BOOTSTRAP_BEGIN_MARKER);
  const end = input.source.indexOf(PORTABLE_BOOTSTRAP_END_MARKER);
  return input.beginCount === 1 && input.endCount === 1 && input.source.includes(input.block) &&
    begin < end && (begin === 0 || input.source.slice(0, begin).endsWith(input.eol)) &&
    (end + PORTABLE_BOOTSTRAP_END_MARKER.length === input.source.length ||
      input.source.slice(end + PORTABLE_BOOTSTRAP_END_MARKER.length).startsWith(input.eol));
}

export function planAgentsFile(
  observation: BootstrapObservedFile | undefined
): {
  readonly file: PortableBootstrapFilePlan;
  readonly issue?: PortableBootstrapIssue;
  readonly operation?: BootstrapOperation;
} {
  const agents = observation === undefined ? undefined : { bytes: Buffer.from(observation.contentBase64, "base64"), mode: observation.mode };
  if (agents === undefined) {
    const bytes = Buffer.from(`${portableBootstrapManagedBlock("\n")}\n`, "utf8");
    return {
      file: { path: "AGENTS.md", ownership: "managed-block", writeState: "create" },
      operation: {
        path: "AGENTS.md",
        precondition: { state: "absent" },
        postimage: { contentBase64: bytes.toString("base64") }
      }
    };
  }
  const currentSizeIssue = agentsSizeIssue(agents.bytes);
  if (currentSizeIssue !== undefined) {
    return {
      file: { path: "AGENTS.md", ownership: "managed-block", writeState: "blocked" },
      issue: currentSizeIssue
    };
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(agents.bytes);
  } catch {
    return {
      file: { path: "AGENTS.md", ownership: "managed-block", writeState: "blocked" },
      issue: {
        code: "PORTABLE_BOOTSTRAP_INVALID_AGENTS_MARKERS",
        path: "AGENTS.md",
        message: "AGENTS.md must be strict UTF-8 text without BOM or NUL bytes."
      }
    };
  }
  if (source.startsWith("\uFEFF") || source.includes("\u0000")) {
    return {
      file: { path: "AGENTS.md", ownership: "managed-block", writeState: "blocked" },
      issue: {
        code: "PORTABLE_BOOTSTRAP_INVALID_AGENTS_MARKERS",
        path: "AGENTS.md",
        message: "AGENTS.md must be strict UTF-8 text without BOM or NUL bytes."
      }
    };
  }
  const beginCount = count(source, PORTABLE_BOOTSTRAP_BEGIN_MARKER);
  const endCount = count(source, PORTABLE_BOOTSTRAP_END_MARKER);
  const eol = source.includes("\r\n") && !source.replaceAll("\r\n", "").includes("\n")
    ? "\r\n"
    : "\n";
  const block = portableBootstrapManagedBlock(eol);
  if (beginCount === 0 && endCount === 0) {
    const separator = source.length === 0 ? "" : source.endsWith(`${eol}${eol}`) ? "" :
      source.endsWith(eol) ? eol : `${eol}${eol}`;
    const postimage = Buffer.concat([agents.bytes, Buffer.from(`${separator}${block}${eol}`, "utf8")]);
    const postimageSizeIssue = agentsSizeIssue(postimage);
    if (postimageSizeIssue !== undefined) {
      return {
        file: { path: "AGENTS.md", ownership: "managed-block", writeState: "blocked" },
        issue: postimageSizeIssue
      };
    }
    return {
      file: { path: "AGENTS.md", ownership: "managed-block", writeState: "replace" },
      operation: {
        path: "AGENTS.md",
        precondition: { state: "known-file", acceptedPreimages: [{ contentBase64: agents.bytes.toString("base64"), mode: agents.mode }] },
        postimage: { contentBase64: postimage.toString("base64"), mode: agents.mode }
      }
    };
  }
  const exactBlock = hasExactManagedBlock({ beginCount, block, endCount, eol, source });
  if (exactBlock) {
    return {
      file: { path: "AGENTS.md", ownership: "managed-block", writeState: "current" },
      operation: {
        path: "AGENTS.md",
        precondition: { state: "known-file", acceptedPreimages: [{ contentBase64: agents.bytes.toString("base64"), mode: agents.mode }] },
        postimage: { contentBase64: agents.bytes.toString("base64"), mode: agents.mode }
      }
    };
  }
  return {
    file: { path: "AGENTS.md", ownership: "managed-block", writeState: "blocked" },
    issue: {
      code: "PORTABLE_BOOTSTRAP_INVALID_AGENTS_MARKERS",
      path: "AGENTS.md",
      message: "AGENTS.md contains duplicate, incomplete, or modified portable documentation markers."
    }
  };
}
