import { createDocsInit } from "../application/docs-init.js";
import { bootstrapPorts } from "./portable-bootstrap.js";
export const { docsInitApplyPreflight, docsInitPlan, docsInitApply, docsInitRecover } = createDocsInit(bootstrapPorts);
/** @public Preserves the type reference emitted in the package public declarations. */
export type { DocsInitRequest, DocsInitApplyRequest, DocsInitPlan, DocsInitApplyResult, DocsInitRecovery } from "../application/docs-init-model.js";
