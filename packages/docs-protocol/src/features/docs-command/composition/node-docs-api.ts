import { createNodeDocsApi } from "../adapters/inbound/node-docs-api.js";
import { createNodeDocsProtocol } from "./node-protocol.js";
export const { docsInfoV2, docsFindV2, docsFindV3, docsContextV1, docsNewV2, docsDoctorV2, docsRecoverV2, docsCheckV2 } = createNodeDocsApi(createNodeDocsProtocol);
export { docsProfilePath } from "../adapters/inbound/node-docs-api.js";
