import { createNodeDocsProtocol as createDocumentation } from "../../portable-documentation/composition.js";
import { createDocsProtocolApi } from "../adapters/inbound/protocol-api.js";
export const createNodeDocsProtocol = () => createDocsProtocolApi(createDocumentation());
