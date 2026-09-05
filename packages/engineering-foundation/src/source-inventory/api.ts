// Stable file-observation facts; concrete Node operations remain in node.ts.
export { ContainedFileReadError } from "./application/model/contained-file.js";
export type {
  BoundedFileRead,
  ContainedFileLocation,
  ContainedFileObservation,
  ContainedFileReadFailure
} from "./application/model/contained-file.js";
export { assertRepositoryRelativePath } from "./application/policies/repository-relative-path.js";
export type { SourceFileSnapshot } from "./application/model/source-file-snapshot.js";
export type { SourceTreeReader } from "./application/ports/source-tree-reader.js";
