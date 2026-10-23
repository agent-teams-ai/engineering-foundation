import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import type { TestContext } from "node:test";
import { GitHubCohortAuthorityReader } from "../dist/consumer-integration/adapters/github-cohort-authority-reader.js";
interface StreamingRegistry {
  cohorts: [Record<string, unknown> & { record_digest: string }, ...Record<string, unknown>[]];
  events: [Record<string, unknown> & { event_digest: string }, ...Record<string, unknown>[]];
}
const registryShape = JSON.parse(
  await readFile(new URL("./fixtures/actual-org-cohort-v2.json", import.meta.url), "utf8"),
) as StreamingRegistry;

export const AUTHORITY_LIMIT = 8 * 1024 * 1024;
export const REVISION = "8".repeat(40);
export const REPOSITORY = {
  provider: "github",
  id: "999999999",
  nameWithOwner: "agent-teams-ai/docs-upgrade-sandbox",
};
// The shared shape uses placeholder hashes. Bind this synthetic copy with fixed,
// independently computed canonical digests, accepted by the originalBase reader.
export const registry = structuredClone(registryShape);
registry.cohorts[0].record_digest =
  "sha256:fbee8369005101b2051f06870b09da9a2bd7f95e0824882edaea03b6e7db17dc";
registry.events[0].event_digest =
  "sha256:c2a625302cec2cf258fd99316b5fc71fdd88e772ea0922e5fc2b88eb2d2f2ba6";

export function overlongBody() {
  const chunk = Buffer.alloc(64 * 1024, 0x20);
  const totalBytes = AUTHORITY_LIMIT + 4 * 1024 * 1024;
  let deliveredBytes = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (deliveredBytes === totalBytes) {
        controller.close();
        return;
      }
      deliveredBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    body,
    observed: () => ({ cancelled, deliveredBytes }),
    totalBytes,
  };
}

export function readOptions() {
  return { cohortId: "missing", generation: 1, repository: REPOSITORY };
}

export function readerForStage(stage: string, response: Response) {
  let requests = 0;
  const reader = new GitHubCohortAuthorityReader(async () => {
    requests++;
    return stage === "registry" && requests === 1
      ? new Response(JSON.stringify({ sha: REVISION }))
      : response;
  });
  return { reader, requests: () => requests };
}

export function fragmented(bytes: Uint8Array, chunkSize = 8191) {
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkSize, bytes.length);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
    }),
  );
}

export async function loopback(context: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  return new GitHubCohortAuthorityReader((url, init) =>
    fetch(
      `${origin}/${(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).endsWith("/commits/main") ? "revision" : "registry"}`,
      init,
    ),
  );
}
