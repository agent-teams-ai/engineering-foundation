export {
  captureFileHandleIdentity,
  pathMatchesRegularFileIdentity as pathMatchesFileIdentity,
  readBoundedRegularFile
} from "../../../repository-mutation/adapters/node/node-bounded-regular-file.js";
export type {
  BoundedRegularFileRead,
  BoundedRegularFileReadFaultInjector
} from "../../../repository-mutation/adapters/node/node-bounded-regular-file.js";
export type { PortablePathIdentity as PortableFileIdentity } from "../../../repository-mutation/application/model/path-identity.js";
