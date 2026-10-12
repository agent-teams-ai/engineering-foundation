import type {
  DocsProtocolQualificationRuntimeObservation,
  DocsProtocolQualificationRuntimeObserver
} from "../../application/model/v3-contract.js";

/**
 * Feature-local physical Node observation. Pnpm and registry/canary execution
 * remain with the public-registry canary Host.
 */
export function createNodeDocsProtocolQualificationRuntimeObserver():
  DocsProtocolQualificationRuntimeObserver {
  return function observeNodeDocsProtocolQualificationRuntime():
    DocsProtocolQualificationRuntimeObservation {
    return Object.freeze({
      nodeVersion: process.versions.node,
      platform: process.platform,
      architecture: process.arch
    });
  };
}
