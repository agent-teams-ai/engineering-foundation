import { runDocsCliWithRuntime } from "../adapters/inbound/cli.js";
import { createNodeDocsProtocol } from "./node-protocol.js";
import { type DocsProtocolApi } from "../adapters/inbound/protocol-api.js";
import * as bootstrap from "../../portable-bootstrap/composition.js";


export function runDocsCli(argv: readonly string[]): Promise<number>;
export function runDocsCli(argv: readonly string[], protocolFactory: () => DocsProtocolApi = createNodeDocsProtocol): Promise<number> {
  return runDocsCliWithRuntime(argv, protocolFactory, bootstrap);
}
export { renderDocsHumanV2, renderDocsHumanV3 } from "../adapters/inbound/docs-human-renderer.js";
export { docsCliErrorExecution, validatedMachineExecution } from "../adapters/inbound/docs-cli-machine.js";
