import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { planDocumentationDocumentV2 } from "@agent-teams/document-authoring";

import { NodeDocsAdoptionInspector } from "../adapters/node-adoption-inspector.js";
import { NodeCodeAnchorMatcher } from "../adapters/node-code-anchor-matcher.js";
import { NodeDocumentAuthoringPort } from "../adapters/document-authoring-port.js";
import { NodeDocsProfileReader } from "../adapters/node-profile-reader.js";
import { DocsProtocol } from "../application/docs-protocol.js";
import { normalizeCodeAnchors, normalizeDocumentIds } from "../domain/document-semantics.js";
import type { DocsFindQuery, DocsNewRequest } from "../domain/model.js";
import { crashAtDurablePublishing } from "./crash-driver.js";
import { portableBootstrapDesiredFiles } from "../community/bootstrap/portable-bootstrap-assets.js";

const MAX_QUALIFICATION_AUTHORITY_BYTES = 8 * 1024 * 1024;

export function portableQualificationSkill(): Buffer {
  const skill = portableBootstrapDesiredFiles("qualification/project", "qualification/owner")
    .find(({ path }) => path === ".agents/skills/docs-authoring/SKILL.md");
  if (skill === undefined) {
    throw new Error("Portable qualification Skill is missing from the core bootstrap authority.");
  }
  return Buffer.from(skill.bytes);
}

export function digest(value: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function readContainedBoundedFile(
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
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximumBytes) {
    throw new Error(`${label} must be one bounded, non-hardlinked regular file.`);
  }
  const physical = await realpath(absolute);
  if (physical !== absolute) {
    throw new Error(`${label} must not traverse a symlink.`);
  }
  const bytes = await readFile(physical);
  const after = await lstat(absolute);
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 ||
    after.dev !== metadata.dev || after.ino !== metadata.ino || after.size !== metadata.size ||
    bytes.byteLength !== metadata.size || bytes.byteLength > maximumBytes) {
    throw new Error(`${label} changed during its bounded read.`);
  }
  return Object.freeze({ bytes, digest: digest(bytes), path: repositoryPath });
}

export async function bootstrapQualificationInstallation(consumerRoot: string, rewriteManifest: boolean): Promise<{
  readonly docsVersion: string;
  readonly authoringVersion: string;
  readonly mutationVersion: string;
}> {
  const docsManifestPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const authoringManifestPath = fileURLToPath(import.meta.resolve("@agent-teams/document-authoring/package.json"));
  const mutationManifestPath = fileURLToPath(import.meta.resolve("@agent-teams/repository-mutation/package.json"));
  const [docsManifest, authoringManifest, mutationManifest, consumerManifest] = await Promise.all([
    readFile(docsManifestPath, "utf8").then((source) => JSON.parse(source) as { readonly version: string }),
    readFile(authoringManifestPath, "utf8").then((source) => JSON.parse(source) as { readonly version: string }),
    readFile(mutationManifestPath, "utf8").then((source) => JSON.parse(source) as { readonly version: string }),
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
        "@agent-teams/document-authoring": authoringManifest.version,
        "@agent-teams/repository-mutation": mutationManifest.version
      }
    }, null, 2)}\n`, "utf8");
  } else {
    const dependencies = typeof consumerManifest["devDependencies"] === "object" &&
      consumerManifest["devDependencies"] !== null
      ? consumerManifest["devDependencies"] as Record<string, unknown>
      : {};
    if (dependencies["@agent-teams/docs-protocol"] !== docsManifest.version ||
      dependencies["@agent-teams/document-authoring"] !== authoringManifest.version ||
      dependencies["@agent-teams/repository-mutation"] !== mutationManifest.version) {
      throw new Error("Qualification requires the exact executing portable packages in devDependencies.");
    }
  }
  const scope = join(consumerRoot, "node_modules", "@agent-teams");
  await mkdir(scope, { recursive: true });
  await Promise.all([
    symlink(dirname(docsManifestPath), join(scope, "docs-protocol"), process.platform === "win32" ? "junction" : "dir"),
    symlink(dirname(authoringManifestPath), join(scope, "document-authoring"), process.platform === "win32" ? "junction" : "dir"),
    symlink(dirname(mutationManifestPath), join(scope, "repository-mutation"), process.platform === "win32" ? "junction" : "dir")
  ]);
  await writeFile(join(consumerRoot, ".agent-teams-document-authoring-qualification-fixture.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: "agent-teams-document-authoring-qualification-fixture",
    consumerRoot: await realpath(consumerRoot)
  })}\n`, "utf8");
  return Object.freeze({
    docsVersion: docsManifest.version,
    authoringVersion: authoringManifest.version,
    mutationVersion: mutationManifest.version
  });
}

export function requireSuccess(label: string, execution: { readonly envelope?: unknown; readonly exitCode: number }): void {
  if (execution.exitCode !== 0) {
    throw new Error(`Docs Protocol qualification ${label} failed with exit code ${execution.exitCode}: ${JSON.stringify(execution.envelope ?? {})}.`);
  }
}

export function documentResult(execution: { readonly envelope: { readonly result: unknown }; readonly exitCode: number }): {
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

export function createProtocol(): DocsProtocol {
  return new DocsProtocol({
    adoption: new NodeDocsAdoptionInspector(),
    anchors: new NodeCodeAnchorMatcher(),
    foundation: new NodeDocumentAuthoringPort(),
    profiles: new NodeDocsProfileReader()
  });
}

export interface PortableQualificationProtocol {
  readonly checkV2: (input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly envelope: { readonly result: { readonly kind: "check" } };
    readonly exitCode: 0 | 1 | 2 | 3 | 130;
  }>;
  readonly doctorV2: (input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly envelope: {
      readonly outcome:
        | "authority-stale"
        | "cancelled"
        | "conflict"
        | "execution-failure"
        | "invalid-input"
        | "recovery-required"
        | "success"
        | "violation";
      readonly result: {
        readonly environment: {
          readonly installedFoundationBuildIdentity: string;
          readonly installedFoundationVersion: string;
        };
        readonly kind: "doctor";
        readonly transaction:
          | { readonly state: "idle" }
          | { readonly state: "recoverable" }
          | { readonly state: "manual-recovery-required" };
      };
    };
    readonly exitCode: 0 | 1 | 2 | 3 | 130;
  }>;
  readonly findV2: (input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly query: DocsFindQuery;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly envelope: {
      readonly result: {
        readonly kind: "find";
        readonly documents: readonly { readonly id: string }[];
      };
    };
    readonly exitCode: 0 | 1 | 2 | 3 | 130;
  }>;
  readonly infoV2: (input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly envelope: {
      readonly result: {
        readonly kind: "info";
        readonly projectId: string;
        readonly types: readonly { readonly type: string }[];
      };
    };
    readonly exitCode: 0 | 1 | 2 | 3 | 130;
  }>;
  readonly newDocumentV2: (input: DocsNewRequest) => Promise<{
    readonly envelope: { readonly result: { readonly kind: "new" } };
    readonly exitCode: 0 | 1 | 2 | 3 | 130;
  }>;
  readonly recoverV2: (input: {
    readonly consumerRoot: string;
    readonly profilePath: string;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly envelope: {
      readonly result:
        | {
            readonly kind: "recover";
            readonly transactionState: "no-pending-transaction";
            readonly writeState: "unchanged";
          }
        | {
            readonly kind: "recover";
            readonly transactionState: "manual-required";
            readonly writeState: "unknown";
          }
        | {
            readonly kind: "recover";
            readonly transactionState: "recovered" | "recovery-required";
            readonly writeState: "committed" | "published-recovery-required" | "unchanged" | "unknown";
            readonly receiptDigest: `sha256:${string}`;
            readonly receipt: {
              readonly commit: {
                readonly publication: "none" | "preexisting-exact" | "published" | "unknown";
                readonly state: "committed" | "manual-recovery-required" | "not-published" | "recovery-required";
              };
              readonly directoryMaterialization?: {
                readonly observedCreatedDirectories: readonly string[];
                readonly state: "none-created" | "created-and-retained" | "preserved-unknown";
              };
              readonly outcome:
                | "applied"
                | "already-applied"
                | "authority-stale"
                | "cancelled"
                | "failed-before-publication"
                | "manual-recovery-required"
                | "recovery-required"
                | "rejected";
            };
          };
    };
    readonly exitCode: 0 | 1 | 2 | 3 | 130;
  }>;
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

export function signalOption(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

export async function interruptAndRecover(input: {
  readonly base: Omit<DocsNewRequest, "apply">;
  readonly consumerRoot: string;
  readonly previewResult: ReturnType<typeof documentResult>;
  readonly profilePath: string;
  readonly protocol: PortableQualificationProtocol;
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
  const interruptedDoctor = await input.protocol.doctorV2({
    consumerRoot: input.consumerRoot,
    profilePath: input.profilePath,
    ...signalOption(input.base.signal)
  });
  if (interruptedDoctor.exitCode !== 1 || interruptedDoctor.envelope.outcome !== "recovery-required" ||
    interruptedDoctor.envelope.result.transaction.state !== "recoverable") {
    throw new Error("Qualification doctor did not observe its genuine interrupted transaction.");
  }
  const recovered = await input.protocol.recoverV2({
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
