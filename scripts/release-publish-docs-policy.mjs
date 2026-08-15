import {
  DOCS_PROTOCOL_BOOTSTRAP,
  ordinaryReleaseDocsPolicy,
} from "./docs-protocol-bootstrap.mjs";
import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";

function workspaceManifest(state, name) {
  const packageInfo = [...state.packages.private, ...state.packages.public].find(
    (candidate) => candidate.name === name,
  );
  return packageInfo === undefined ? undefined : JSON.parse(packageInfo.manifestBytes);
}

function changesetsConfig(state) {
  const config = state.inventory.files.find(({ name }) => name === "config.json");
  return config === undefined ? undefined : JSON.parse(config.bytes);
}

export function assertOrdinaryDocsReleasePolicy(state, registryState) {
  const docsRegistry = registryState.find(({ name }) => name === DOCS_PROTOCOL_BOOTSTRAP.name);
  ordinaryReleaseDocsPolicy({
    changesetsConfig: changesetsConfig(state),
    docsManifest: workspaceManifest(state, DOCS_PROTOCOL_BOOTSTRAP.name),
    foundationManifest: workspaceManifest(state, DOCS_PROTOCOL_BOOTSTRAP.foundationName),
    preState: state.preState,
    publishablePackageNames: PUBLISHABLE_PACKAGES.map(({ name }) => name),
    registryVersion: docsRegistry?.versions.includes(DOCS_PROTOCOL_BOOTSTRAP.version)
      ? DOCS_PROTOCOL_BOOTSTRAP.version
      : undefined,
  });
}
