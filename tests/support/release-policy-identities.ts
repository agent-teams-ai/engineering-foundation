import { bootstrapPackageById } from "../../scripts/npm-package-bootstrap.mjs";
import { publishablePackageByName } from "../../scripts/publishable-packages.mjs";
import { DOCS_MCP_PACKAGE } from "../../scripts/release-publish-ordered.mjs";
export const foundation = { name: "@agent-teams/engineering-foundation", version: "0.16.0" };
export const ciInputProof = { name: "@agent-teams/ci-input-proof", version: "0.0.0" };
export const releaseChecks = {
  name: publishablePackageByName("@agent-teams/release-checks").name,
  version: "0.0.0",
};
export const featureModuleStandard = {
  name: "@agent-teams/feature-module-standard",
  version: "0.0.0",
};
export const repositoryMutation = {
  name: publishablePackageByName("@agent-teams/repository-mutation").name,
  version: "0.0.0",
};
export const documentAuthoring = {
  name: publishablePackageByName("@agent-teams/document-authoring").name,
  version: "0.0.0",
};
export const privateSpike = {
  name: "@agent-teams/source-dependency-parser-spike",
  version: "0.0.0",
};
export const docsBootstrap = bootstrapPackageById("docs-protocol");
export const docsProtocol = {
  name: docsBootstrap.name,
  version: docsBootstrap.bootstrapVersion,
};
export const docsProtocolMcp = {
  name: publishablePackageByName(DOCS_MCP_PACKAGE).name,
  version: "0.1.0-rc.0",
};
export const docsProtocolMcpBaselineVersion = "0.0.0";
export const docsProtocolAdapter = {
  name: publishablePackageByName("@agent-teams/docs-protocol-agent-teams").name,
  version: "0.0.0",
};
export const freshPreState = {
  mode: "pre",
  tag: "rc",
  initialVersions: {
    [foundation.name]: foundation.version,
    [privateSpike.name]: privateSpike.version,
  },
  changesets: [],
};

export function freshDecisionInput() {
  return {
    inventory: {
      metadata: ["README.md", "config.json", "pre.json"],
      pending: [],
      unexpected: [],
    },
    packages: { private: [privateSpike], public: [foundation] },
    preState: freshPreState,
  };
}
