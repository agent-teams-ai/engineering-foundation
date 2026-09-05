import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const distRoot = process.env.FOUNDATION_DIST_ROOT ?? process.env.ENGINEERING_FOUNDATION_DIST_ROOT ??
  fileURLToPath(new URL("../../packages/engineering-foundation/dist/", import.meta.url));
const load = (path) => import(pathToFileURL(join(distRoot, path)).href);
const [source, workspace, schemas, governance, protobuf, processExecution, workflow, schemaCatalog, configurationInput] = await Promise.all([
  load("source-inventory/module.js"),
  load("workspace-inventory/module.js"),
  load("capabilities/contract-json-schema-releases/module.js"),
  load("capabilities/governance-architecture-decisions/module.js"),
  load("capabilities/contract-protobuf-evolution/module.js"),
  load("process-execution/module.js"),
  load("capabilities/repository-agent-workflow/adapters/outbound/process/process-execution.js"),
  load("schema-catalog.js"),
  load("features/configuration-input/node.js"),
]);
export const createJsonSchemaInspector = schemas.createJsonSchemaInspector;
export const readAcceptedArchitectureDecisionEvidence = (input) => governance.readAcceptedArchitectureDecisionEvidence(input, schemaCatalog.assertSchema);
export const promoteArchitectureDecisionBaseline = (input) => governance.promoteArchitectureDecisionBaseline(input, schemaCatalog.assertSchema);
export const createManagedProcessExecutor = processExecution.createManagedProcessExecutor;
export const createWorkflowProcess = () => workflow.createProcessExecution(createManagedProcessExecutor());
export function sourceDependencyAdapters() {
  return { sourceReader: source.createSourceTreeReader(), inventoryReader: workspace.createWorkspaceInventoryReader(), assertSchema: schemaCatalog.assertSchema };
}
export function schemaConfigurationDependencies() {
  return { readYaml: configurationInput.loadStrictYamlFile, assertSchema: schemaCatalog.assertSchema };
}
export function executableSpecificationAdapters() {
  return { workspaceManifestPathReader: workspace.createWorkspaceInventoryReader(), createJsonSchemaInspector, assertSchema: schemaCatalog.assertSchema };
}
export function protobufAdapters() {
  return { acceptedDecisionEvidence: new protobuf.GovernanceAcceptedDecisionEvidenceAcl(readAcceptedArchitectureDecisionEvidence) };
}
