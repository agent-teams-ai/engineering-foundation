import { lstat, mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FoundationTransactionCoordinator } from "../../packages/engineering-foundation/dist/transaction-coordination/application/foundation-transaction-coordinator.js";
import { installedFoundationBuildIdentity } from "../../packages/engineering-foundation/dist/transaction-coordination/adapters/node/installed-foundation-build-identity.js";
import { documentPlanDigest } from "../../packages/document-authoring/dist/document-authoring/application/policies/document-contract-digests.js";
import { sha256Json } from "../../packages/engineering-foundation/dist/scaffolding/kernel/canonical-json.js";
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const documentFixture = JSON.parse(
  await readFile(
    join(
      repositoryRoot,
      "tests",
      "fixtures",
      "document-authoring-contracts",
      "valid-v1.json",
    ),
    "utf8",
  ),
);
const installedBuildIdentity = await installedFoundationBuildIdentity();

async function createRoot(prefix = "foundation-transaction-") {
  return mkdtemp(join(tmpdir(), prefix));
}

function slotPath(root) {
  return join(root, ".agent-teams-local", "scaffolding-transaction.json");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function observeEvidence(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    const type = metadata.isFile()
      ? "file"
      : metadata.isDirectory()
        ? "directory"
        : metadata.isSymbolicLink()
          ? "symbolic-link"
          : "other";
    return {
      exists: true,
      type,
      ...(metadata.isFile() ? { bytes: await handle.readFile() } : {}),
    };
  } catch (error) {
    if (error?.code === "EISDIR" || error?.code === "EACCES") {
      const metadata = await lstat(path);
      return {
        exists: true,
        type: metadata.isDirectory()
          ? "directory"
          : metadata.isSymbolicLink()
            ? "symbolic-link"
            : "other",
      };
    }
    if (error?.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function buildDocumentEnvelope(
  version = "0.12.0",
  buildIdentity = installedBuildIdentity,
) {
  const envelope = structuredClone(documentFixture.documentEnvelope);
  envelope.foundation.version = version;
  envelope.foundation.buildIdentity = buildIdentity;
  envelope.journal.plan = structuredClone(documentFixture.plan);
  envelope.journal.plan.compiler.version = version;
  envelope.journal.plan.compiler.buildIdentity = buildIdentity;
  envelope.journal.plan.planDigest = documentPlanDigest(envelope.journal.plan);
  envelope.payloadDigest = sha256Json(envelope.journal);
  const { envelopeDigest: _envelopeDigest, ...envelopeBody } = envelope;
  envelope.envelopeDigest = sha256Json(envelopeBody);
  return envelope;
}

function coordinatorWith(status) {
  let releaseCount = 0;
  return {
    coordinator: new FoundationTransactionCoordinator({
      lock: {
        async acquire() {
          return async () => {
            releaseCount += 1;
          };
        },
      },
      slot: {
        async inspect() {
          return status;
        },
      },
    }),
    releaseCount: () => releaseCount,
  };
}

export { createRoot, slotPath, writeJson, observeEvidence, buildDocumentEnvelope, coordinatorWith, installedBuildIdentity };
