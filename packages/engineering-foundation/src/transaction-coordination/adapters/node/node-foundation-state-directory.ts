import {
  ensureMutationStateDirectory,
  pruneMutationStateDirectory,
  syncMutationStateDirectory,
  syncMutationStateDirectoryStrictly
} from "@agent-teams/repository-mutation/node";

export const ensureFoundationStateDirectory = ensureMutationStateDirectory;
export const pruneFoundationStateDirectory = pruneMutationStateDirectory;
export const syncFoundationStateDirectory = syncMutationStateDirectory;
export const syncFoundationStateDirectoryStrictly = syncMutationStateDirectoryStrictly;
