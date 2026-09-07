import { NodeDocsProfileReader } from "../adapters/outbound/node-profile-reader.js";
import type { DocsProfileReaderV2 } from "../application/model-v2.js";

export const readQualificationProfile = (input: Parameters<DocsProfileReaderV2["read"]>[0]) => new NodeDocsProfileReader().read(input);
