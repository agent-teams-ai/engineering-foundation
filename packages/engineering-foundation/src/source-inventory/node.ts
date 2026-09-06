// Curated infrastructure surface for composition and existing private Node callers.
import type { ContainedFileObservation } from "./api.js";
import {
  inspectContainedRegularFile,
  readContainedRegularFile
} from "./adapters/outbound/filesystem/contained-file-reader.js";

export const containedFileObservation: ContainedFileObservation = {
  inspect: inspectContainedRegularFile,
  read: readContainedRegularFile
};

export {
  inspectContainedRegularFile,
  pathTraversesSymbolicLink,
  readContainedRegularFile
} from "./adapters/outbound/filesystem/contained-file-reader.js";
export { ContainedFileReadError } from "./api.js";
