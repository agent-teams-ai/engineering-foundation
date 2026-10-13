import { spawnSync } from "node:child_process";

import type {
  DocsProtocolQualificationRuntimeObservation,
  DocsProtocolQualificationRuntimeObserver
} from "../../application-api.js";

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function isQualifiedNodeRuntime(): boolean {
  return process.versions.node === "26.11.1" &&
    process.platform === "linux" &&
    process.arch === "x64";
}

function observeResolvedPnpmVersion(): string | undefined {
  if (!isQualifiedNodeRuntime()) {
    return undefined;
  }
  const result = spawnSync("pnpm", ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    throw new Error("Qualification runtime could not observe the resolved pnpm executable.");
  }
  const version = result.stdout.trim();
  if (!SEMVER.test(version)) {
    throw new Error("Qualification runtime observed an invalid pnpm version.");
  }
  return version;
}

/**
 * Feature-local physical Node and resolved pnpm observation. Registry/canary
 * install, temporary-root, and cleanup orchestration remains with the Host.
 */
export function createNodeDocsProtocolQualificationRuntimeObserver():
  DocsProtocolQualificationRuntimeObserver {
  return function observeNodeDocsProtocolQualificationRuntime():
    DocsProtocolQualificationRuntimeObservation {
    const pnpmVersion = observeResolvedPnpmVersion();
    return Object.freeze({
      nodeVersion: process.versions.node,
      ...(pnpmVersion === undefined ? {} : { pnpmVersion }),
      platform: process.platform,
      architecture: process.arch
    });
  };
}
