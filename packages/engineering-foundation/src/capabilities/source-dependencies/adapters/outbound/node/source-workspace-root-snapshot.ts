import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import { CapabilityInputError } from "../../../../../capability-runtime.js";
import {
  captureStableRepositoryPath,
  revalidateStableRepositoryPath,
  type SourceWorkspaceFileSystem,
  type StableRepositoryPath
} from "./source-workspace-filesystem.js";

interface InspectUniqueRootsInput {
  readonly canonicalConsumerRoot: string;
  readonly expectedKind: "directory" | "source";
  readonly label: string;
  readonly operations: SourceWorkspaceFileSystem;
  readonly roots: readonly string[];
  readonly signal?: AbortSignal;
  readonly symbolicLinkCode?: string;
}

interface RevalidateRootsInput {
  readonly canonicalConsumerRoot: string;
  readonly operations: SourceWorkspaceFileSystem;
  readonly roots: readonly StableRepositoryPath[];
  readonly signal?: AbortSignal;
}

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "source-workspace-topology",
    retryable: false
  });
}

function portableCanonicalIdentity(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

export async function inspectUniqueRoots(
  input: InspectUniqueRootsInput
): Promise<readonly StableRepositoryPath[]> {
  const identities = new Map<string, string>();
  const inspected: StableRepositoryPath[] = [];
  for (const repositoryPath of input.roots.toSorted(compareBinaryStrings)) {
    const root = await captureStableRepositoryPath(
      input.canonicalConsumerRoot,
      repositoryPath,
      input.expectedKind,
      input.operations,
      input.signal
    );
    const identity = portableCanonicalIdentity(root.canonicalPath);
    const existing = identities.get(identity);
    if (existing !== undefined) {
      inputError(
        "SOURCE_ROOT_REALPATH_DUPLICATE",
        `${input.label} share a canonical or portable filesystem identity: ${existing} and ${repositoryPath}.`
      );
    }
    identities.set(identity, repositoryPath);
    inspected.push(root);
  }
  const symbolicLink = inspected.find((root) => root.traversesSymbolicLink);
  if (symbolicLink !== undefined) {
    inputError(
      input.symbolicLinkCode ?? "SOURCE_SYMLINK_PROHIBITED",
      `Schema v2 source paths cannot traverse symbolic links: ${symbolicLink.repositoryPath}.`
    );
  }
  return Object.freeze(inspected);
}

export async function revalidateRoots(
  input: RevalidateRootsInput
): Promise<void> {
  for (const root of input.roots) {
    await revalidateStableRepositoryPath(
      input.canonicalConsumerRoot,
      root,
      input.operations,
      input.signal
    );
  }
}
