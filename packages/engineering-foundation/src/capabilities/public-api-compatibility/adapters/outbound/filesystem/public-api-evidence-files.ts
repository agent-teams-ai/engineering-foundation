import { link, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertNotCancelled, publicApiFileFailure, publicApiInputError as inputError } from "../../../application/policies/public-api-evidence-errors.js";
import type { PublicApiFileReader, PublicApiPathInspection, PublicApiRepositoryEvidence } from "../../../application/ports/public-api-evidence.js";
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
function contained(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  );
}

export async function canonicalRoot(consumerRoot: string): Promise<string> {
  return realpath(consumerRoot).catch(() =>
    inputError(
      "CONSUMER_ROOT_UNAVAILABLE",
      "Consumer root must be an existing accessible directory.",
      "public-api-evidence"
    )
  );
}

async function safePath(
  root: string,
  repositoryPath: string,
  kind: "directory" | "file",
  paths: PublicApiPathInspection
): Promise<string> {
  const candidate = resolve(root, repositoryPath);
  if (await paths.traversesSymbolicLink(root, candidate)) {
    inputError(
      "PUBLIC_API_EVIDENCE_SYMLINK_PROHIBITED",
      `Public API evidence cannot traverse a symbolic link: ${repositoryPath}.`,
      "public-api-evidence"
    );
  }
  const canonical = await realpath(candidate).catch(() =>
    inputError(
      "PUBLIC_API_EVIDENCE_UNAVAILABLE",
      `Public API evidence is unavailable: ${repositoryPath}.`,
      "public-api-evidence"
    )
  );
  if (!contained(root, canonical)) {
    inputError(
      "PUBLIC_API_EVIDENCE_ESCAPE",
      `Public API evidence escapes the consumer repository: ${repositoryPath}.`,
      "public-api-evidence"
    );
  }
  const metadata = await stat(canonical);
  if (
    (kind === "file" && (!metadata.isFile() || metadata.size > MAX_INPUT_BYTES)) ||
    (kind === "directory" && !metadata.isDirectory())
  ) {
    inputError(
      "PUBLIC_API_EVIDENCE_INVALID",
      `Public API evidence is not a valid ${kind}: ${repositoryPath}.`,
      "public-api-evidence"
    );
  }
  return canonical;
}

function publicApiEvidenceReadError(
  error: unknown,
  repositoryPath: string,
  phase: string
): never {
  if (publicApiFileFailure(error) !== undefined) {
    const code =
      publicApiFileFailure(error) === "symlink"
        ? "PUBLIC_API_EVIDENCE_SYMLINK_PROHIBITED"
        : publicApiFileFailure(error) === "escape"
          ? "PUBLIC_API_EVIDENCE_ESCAPE"
          : publicApiFileFailure(error) === "invalid"
            ? "PUBLIC_API_EVIDENCE_INVALID"
            : "PUBLIC_API_EVIDENCE_UNAVAILABLE";
    inputError(code, `Public API evidence is unavailable or changed: ${repositoryPath}.`, phase);
  }
  throw error;
}

export async function readPublicApiEvidenceFile(input: {
  readonly allowMissing: true;
  readonly maxBytes: number;
  readonly repositoryPath: string;
  readonly root: string;
  readonly phase: string;
}, files: PublicApiFileReader): Promise<Buffer | undefined>;
export async function readPublicApiEvidenceFile(input: {
  readonly allowMissing?: false;
  readonly maxBytes: number;
  readonly repositoryPath: string;
  readonly root: string;
  readonly phase: string;
}, files: PublicApiFileReader): Promise<Buffer>;
export async function readPublicApiEvidenceFile(input: {
  readonly allowMissing?: boolean;
  readonly maxBytes: number;
  readonly repositoryPath: string;
  readonly root: string;
  readonly phase: string;
}, files: PublicApiFileReader): Promise<Buffer | undefined> {
  try {
    const bytes = await files.read({
      candidate: resolve(input.root, input.repositoryPath),
      maxBytes: input.maxBytes,
      root: input.root
    });
    if (bytes.byteLength > input.maxBytes) {
      inputError("PUBLIC_API_EVIDENCE_INVALID", `Public API evidence is unavailable or changed: ${input.repositoryPath}.`, input.phase);
    }
    return Buffer.from(bytes);
  } catch (error) {
    if (
      input.allowMissing === true &&
      publicApiFileFailure(error) !== undefined &&
      publicApiFileFailure(error) === "missing"
    ) {
      return undefined;
    }
    return publicApiEvidenceReadError(error, input.repositoryPath, input.phase);
  }
}

export async function writePublicApiEvidenceFile(
  consumerRoot: string,
  repositoryPath: string,
  snapshot: unknown,
  options: { readonly signal?: AbortSignal; readonly mode: "create" | "replace" | { readonly expectedBytes: Buffer }; readonly validate?: () => Promise<void> },
  evidence: PublicApiRepositoryEvidence
): Promise<void> {
    const { signal, mode } = options;
    assertNotCancelled(signal);
    const expectedBytes = typeof mode === "object" ? mode.expectedBytes : undefined;
    const root = await canonicalRoot(consumerRoot);
    const requestedBaselinePath = resolve(root, repositoryPath);
    const baselinePath =
      mode !== "create"
        ? await safePath(root, repositoryPath, "file", evidence.paths)
        : join(
            await safePath(root, dirname(repositoryPath), "directory", evidence.paths),
            repositoryPath.slice(repositoryPath.lastIndexOf("/") + 1)
          );
    if (baselinePath !== requestedBaselinePath) {
      inputError(
        "PUBLIC_API_EVIDENCE_ESCAPE",
        `Public API evidence escapes the consumer repository: ${repositoryPath}.`,
        "public-api-baseline-promotion"
      );
    }
    await options.validate?.();
    const temporaryDirectory = await mkdtemp(
      join(dirname(baselinePath), ".public-api-baseline-")
    );
    try {
      const temporaryPath = join(temporaryDirectory, "baseline.json");
      await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o644
      });
      assertNotCancelled(signal);
      // Revalidate the named ancestry after staging and before publishing.
      await safePath(root, dirname(repositoryPath), "directory", evidence.paths);
      if (mode !== "create") {
        await safePath(root, repositoryPath, "file", evidence.paths);
        if (expectedBytes !== undefined) {
          const current = await readPublicApiEvidenceFile({ root, repositoryPath, maxBytes: MAX_INPUT_BYTES,
            phase: "public-api-baseline-promotion" }, evidence.files);
          if (!current.equals(expectedBytes)) {
            inputError("PUBLIC_API_BASELINE_PROMOTION_STALE", `Public API baseline changed before promotion: ${repositoryPath}.`, "public-api-baseline-promotion");
          }
        }
      }
      if (mode === "create") {
        try {
          await link(temporaryPath, baselinePath);
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            String(error.code) === "EEXIST"
          ) {
            inputError(
              "PUBLIC_API_BASELINE_BOOTSTRAP_CONFLICT",
              `Initial public API baseline appeared concurrently: ${repositoryPath}.`,
              "public-api-baseline-promotion"
            );
          }
          throw error;
        }
      } else {
        await rename(temporaryPath, baselinePath);
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
}
