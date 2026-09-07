import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const registryShape = JSON.parse(await readFile(new URL(
  "./fixtures/actual-org-cohort-v2.json", import.meta.url
), "utf8"));

import {
  GitHubCohortAuthorityReader
} from "../dist/consumer-integration/adapters/github-cohort-authority-reader.js";

const AUTHORITY_LIMIT = 8 * 1024 * 1024;
const REVISION = "8".repeat(40);
const REPOSITORY = {
  provider: "github",
  id: "999999999",
  nameWithOwner: "agent-teams-ai/docs-upgrade-sandbox"
};
// The shared shape uses placeholder hashes. Bind this synthetic copy with fixed,
// independently computed canonical digests, accepted by the originalBase reader.
const registry = structuredClone(registryShape);
registry.cohorts[0].record_digest = "sha256:fbee8369005101b2051f06870b09da9a2bd7f95e0824882edaea03b6e7db17dc";
registry.events[0].event_digest = "sha256:c2a625302cec2cf258fd99316b5fc71fdd88e772ea0922e5fc2b88eb2d2f2ba6";

function overlongBody() {
  const chunk = Buffer.alloc(64 * 1024, 0x20);
  const totalBytes = AUTHORITY_LIMIT + (4 * 1024 * 1024);
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
    }
  });
  return {
    body,
    observed: () => ({ cancelled, deliveredBytes }),
    totalBytes
  };
}

test("stops missing and false-length authority responses at the byte limit", async (context) => {
  for (const [name, headers] of [
    ["missing Content-Length", { "content-type": "application/json" }],
    ["understated Content-Length", {
      "content-length": "1",
      "content-type": "application/json"
    }]
  ]) {
    await context.test(name, async () => {
      const fixture = overlongBody();
      const reader = new GitHubCohortAuthorityReader(async (url) =>
        String(url).endsWith("/commits/main")
          ? new Response(JSON.stringify({ sha: REVISION }))
          : new Response(fixture.body, { headers })
      );

      await assert.rejects(reader.read({
        cohortId: "irrelevant-overlong-authority",
        generation: 1,
        repository: REPOSITORY
      }), (error) => {
        assert.equal(error?.code, "DOCS_CONSUMER_AUTHORITY_INVALID");
        assert.equal(error?.message, "Central Cohort registry has invalid or overlong bytes.");
        return true;
      });

      const { cancelled, deliveredBytes } = fixture.observed();
      assert.equal(cancelled, true, "reader did not cancel the overlong response stream");
      assert.ok(deliveredBytes < fixture.totalBytes,
        `reader consumed all ${deliveredBytes} bytes before enforcing its byte limit`);
      assert.ok(deliveredBytes <= AUTHORITY_LIMIT + (2 * 64 * 1024),
        `reader consumed ${deliveredBytes} bytes before cancelling the overlong response`);
    });
  }
});

test("preserves fragmented success diagnostics and request cancellation", async (context) => {
  const fragmentedRevision = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(`{"sha":"${REVISION.slice(0, 20)}`));
      controller.enqueue(Buffer.from(`${REVISION.slice(20)}"}`));
      controller.close();
    }
  });
  const reader = new GitHubCohortAuthorityReader(async (url) =>
    String(url).endsWith("/commits/main")
      ? new Response(fragmentedRevision)
      : new Response("{}")
  );
  await assert.rejects(reader.read({
    cohortId: "missing",
    generation: 1,
    repository: REPOSITORY
  }), (error) => {
    assert.equal(error?.code, "DOCS_CONSUMER_AUTHORITY_INVALID");
    assert.equal(error?.message, "Central Cohort registry must use contract schema_version 1.");
    return true;
  });

  const cancellation = new AbortController();
  context.mock.method(AbortSignal, "timeout", () => cancellation.signal);
  const cancelledReader = new GitHubCohortAuthorityReader(async (_url, init) => {
    assert.equal(init?.signal, cancellation.signal);
    return new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener("abort", () => controller.error(init.signal.reason), {
          once: true
        });
      }
    }));
  });
  const pending = cancelledReader.read({
    cohortId: "cancelled",
    generation: 1,
    repository: REPOSITORY
  });
  cancellation.abort(new DOMException("fixture cancellation", "AbortError"));
  await assert.rejects(pending, {
    message: "fixture cancellation",
    name: "AbortError"
  });
});

function readOptions() {
  return { cohortId: "missing", generation: 1, repository: REPOSITORY };
}

function readerForStage(stage, response) {
  let requests = 0;
  const reader = new GitHubCohortAuthorityReader(async () => {
    requests++;
    return stage === "registry" && requests === 1
      ? new Response(JSON.stringify({ sha: REVISION }))
      : response;
  });
  return { reader, requests: () => requests };
}

for (const stage of ["revision", "registry"]) {
  const subject = stage === "revision" ? "Central authority revision" : "Central Cohort registry";
  for (const [description, headers] of [
    ["absent", {}], ["zero", { "content-length": "0" }],
    ["understated", { "content-length": "1" }],
    ["malformed", { "content-length": "wrong" }]
  ]) {
    test(`${stage}: ${description} length cancels at first excess chunk`, async () => {
      const fixture = overlongBody();
      const { reader, requests } = readerForStage(stage, new Response(fixture.body, { headers }));
      await assert.rejects(reader.read(readOptions()), {
        code: "DOCS_CONSUMER_AUTHORITY_INVALID",
        message: `${subject} has invalid or overlong bytes.`
      });
      assert.equal(fixture.observed().cancelled, true);
      assert.ok(fixture.observed().deliveredBytes <= AUTHORITY_LIMIT + 128 * 1024);
      assert.equal(fixture.body.locked, false);
      assert.equal(requests(), stage === "revision" ? 1 : 2);
    });
  }

  for (const [description, responseInit, code, message] of [
    ["HTTP error", { status: 503, headers: { "content-length": String(AUTHORITY_LIMIT + 1) } },
      "DOCS_CONSUMER_AUTHORITY_UNAVAILABLE", `${subject} returned HTTP 503.`],
    ["oversized header", { headers: { "content-length": String(AUTHORITY_LIMIT + 1) } },
      "DOCS_CONSUMER_AUTHORITY_INVALID", `${subject} exceeds the authority size limit.`]
  ]) {
    test(`${stage}: ${description} cancels without pulling a body`, async () => {
      let pulls = 0;
      let reason;
      const body = new ReadableStream({
        pull() { pulls++; },
        cancel(error) { reason = error; }
      }, { highWaterMark: 0 });
      const { reader } = readerForStage(stage, new Response(body, responseInit));
      await assert.rejects(reader.read(readOptions()), (error) => {
        assert.equal(error.code, code);
        assert.equal(error.message, message);
        assert.equal(reason, error);
        return true;
      });
      assert.equal(pulls, 0);
      assert.equal(body.locked, false);
    });
  }

  test(`${stage}: read failure retains identity and releases its lock`, async () => {
    const failure = new Error("fixture transport failed", { cause: new Error("socket failed") });
    const body = new ReadableStream({ pull(controller) { controller.error(failure); } });
    const { reader } = readerForStage(stage, new Response(body));
    await assert.rejects(reader.read(readOptions()), (error) => error === failure);
    assert.equal(body.locked, false);
  });

  for (const body of [null, ""]) {
    test(`${stage}: empty ${body === null ? "null" : "stream"} preserves diagnostic`, async () => {
      const response = new Response(body);
      const { reader } = readerForStage(stage, response);
      await assert.rejects(reader.read(readOptions()), {
        code: "DOCS_CONSUMER_AUTHORITY_INVALID",
        message: `${subject} has invalid or overlong bytes.`
      });
      assert.notEqual(response.body?.locked, true);
    });
  }
}

test("cleanup failure keeps the size diagnostic and the cancellation cause", async () => {
  const cause = new Error("fixture cancel failed");
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(AUTHORITY_LIMIT + 1)); },
    cancel() { throw cause; }
  });
  const { reader } = readerForStage("registry", new Response(body));
  await assert.rejects(reader.read(readOptions()), (error) => {
    assert.equal(error.code, "DOCS_CONSUMER_AUTHORITY_INVALID");
    assert.equal(error.message, "Central Cohort registry has invalid or overlong bytes.");
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(body.locked, false);
});

function fragmented(bytes, chunkSize = 8191) {
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    }
  }));
}

for (const stage of ["revision", "registry"]) {
  test(`${stage}: accepts exactly 8 MiB and preserves complete authority`, async () => {
    const bodies = [Buffer.from(JSON.stringify({ sha: REVISION })), Buffer.from(JSON.stringify(registry))];
    const index = stage === "revision" ? 0 : 1;
    const padded = Buffer.alloc(AUTHORITY_LIMIT, 0x20);
    bodies[index].copy(padded);
    bodies[index] = padded;
    const responses = bodies.map((bytes) => fragmented(bytes));
    const requests = [];
    const reader = new GitHubCohortAuthorityReader(async (url, init) => {
      requests.push({ url: String(url), init });
      return responses[requests.length - 1];
    });
    const authority = await reader.read({ ...readOptions(), cohortId: registry.cohorts[0].cohort_id, generation: 2 });
    assert.equal(authority.revision, REVISION);
    assert.equal(authority.cohort.cohortId, registry.cohorts[0].cohort_id);
    assert.equal(authority.cohort.recordDigest, registry.cohorts[0].record_digest);
    assert.equal(Object.keys(authority.cohort.packages).length, 5);
    assert.deepEqual(authority.cohort.packages.docsProtocol, {
      version: registry.cohorts[0].packages[2].version,
      integrity: registry.cohorts[0].packages[2].integrity
    });
    assert.deepEqual(requests.map(({ url }) => url), [
      "https://api.github.com/repos/agent-teams-ai/.github/commits/main",
      `https://raw.githubusercontent.com/agent-teams-ai/.github/${REVISION}/governance/docs-qualified-cohorts.json`
    ]);
    assert.deepEqual(requests.map(({ init }) => init.headers), [
      { Accept: "application/vnd.github+json", "User-Agent": "agent-teams-docs" },
      { Accept: "application/json", "User-Agent": "agent-teams-docs" }
    ]);
    for (const { init } of requests) {
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
    }
    assert.notEqual(requests[0].init.signal, requests[1].init.signal);
    assert.ok(responses.every((response) => !response.body.locked));
  });

  test(`${stage}: body cancellation preserves its reason and 20-second deadline`, async (context) => {
    const controller = new AbortController();
    context.mock.method(AbortSignal, "timeout", (milliseconds) => {
      assert.equal(milliseconds, 20_000);
      return controller.signal;
    });
    let started;
    const reading = new Promise((resolve) => { started = resolve; });
    const body = new ReadableStream({
      pull(stream) {
        controller.signal.addEventListener("abort", () => stream.error(controller.signal.reason), { once: true });
        started();
      }
    }, { highWaterMark: 0 });
    const { reader } = readerForStage(stage, new Response(body));
    const pending = reader.read(readOptions());
    await reading;
    const reason = new DOMException("fixture deadline expired", "TimeoutError");
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(body.locked, false);
  });
}

test("preserves UTF-8 across individual byte chunks and strict JSON diagnostics", async () => {
  const revision = Buffer.from(JSON.stringify({ sha: REVISION, note: "π🙂" }));
  const reader = new GitHubCohortAuthorityReader(async (url) =>
    String(url).endsWith("/commits/main") ? fragmented(revision, 1) : fragmented(Buffer.from(JSON.stringify(registry)), 1));
  const result = await reader.read({ ...readOptions(), cohortId: registry.cohorts[0].cohort_id, generation: 2 });
  assert.equal(result.cohort.recordDigest, registry.cohorts[0].record_digest);
  for (const bytes of [Buffer.from([0xff]), Buffer.from('{"schema_version":1,"schema_version":1}'), Buffer.from("{")]) {
    const { reader: invalidReader } = readerForStage("registry", fragmented(bytes, 1));
    await assert.rejects(invalidReader.read(readOptions()), (error) => {
      assert.equal(error.code, "DOCS_CONSUMER_AUTHORITY_INVALID");
      assert.equal(error.message, "Central Cohort registry is not strict duplicate-free UTF-8 JSON.");
      assert.ok(error.cause instanceof Error);
      return true;
    });
  }
});

async function loopback(context, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return new GitHubCohortAuthorityReader((url, init) =>
    fetch(`${origin}/${String(url).endsWith("/commits/main") ? "revision" : "registry"}`, init));
}

for (const stage of ["revision", "registry"]) {
  test(`${stage}: real HTTP stream closes early without Content-Length`, { timeout: 10_000 }, async (context) => {
    let delivered = 0;
    let finish;
    const disconnected = new Promise((resolve) => { finish = resolve; });
    const reader = await loopback(context, (request, response) => {
      if (request.url !== `/${stage}`) { response.end(JSON.stringify({ sha: REVISION })); return; }
      response.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      let timer;
      response.on("close", () => { clearTimeout(timer); finish(); });
      function send() {
        if (response.destroyed) { return; }
        delivered += chunk.length;
        response.write(chunk);
        if (delivered === 32 * 1024 * 1024) { response.end(); return; }
        timer = setTimeout(send, 1);
      }
      send();
    });
    await assert.rejects(reader.read(readOptions()), {
      code: "DOCS_CONSUMER_AUTHORITY_INVALID",
      message: `${stage === "revision" ? "Central authority revision" : "Central Cohort registry"} has invalid or overlong bytes.`
    });
    await disconnected;
    assert.ok(delivered < 32 * 1024 * 1024, `fully consumed ${delivered} bytes`);
  });
}

test("real HTTP decompression cannot hide excess bytes behind a small wire length", { timeout: 10_000 }, async (context) => {
  const compressed = gzipSync(Buffer.alloc(AUTHORITY_LIMIT + 1, 0x20));
  assert.ok(compressed.length < AUTHORITY_LIMIT);
  const reader = await loopback(context, (request, response) => {
    if (request.url === "/revision") { response.end(JSON.stringify({ sha: REVISION })); return; }
    response.writeHead(200, { "content-encoding": "gzip", "content-length": String(compressed.length) });
    response.end(compressed);
  });
  await assert.rejects(reader.read(readOptions()), {
    code: "DOCS_CONSUMER_AUTHORITY_INVALID",
    message: "Central Cohort registry has invalid or overlong bytes."
  });
});

test("real HTTP authority success and stalled-body deadline", { timeout: 10_000 }, async (context) => {
  let stalled = false;
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  const reader = await loopback(context, (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/revision") { response.end(JSON.stringify({ sha: REVISION })); return; }
    if (stalled) { response.write("{"); return; }
    const bytes = Buffer.from(JSON.stringify(registry));
    response.write(bytes.subarray(0, 101));
    response.end(bytes.subarray(101));
  });
  const options = { ...readOptions(), cohortId: registry.cohorts[0].cohort_id, generation: 2 };
  const authority = await reader.read(options);
  assert.equal(authority.cohort.recordDigest, registry.cohorts[0].record_digest);
  stalled = true;
  context.mock.method(AbortSignal, "timeout", (milliseconds) => {
    assert.equal(milliseconds, 20_000);
    return realTimeout(250);
  });
  await assert.rejects(reader.read(options), { name: "TimeoutError" });
});

test("managed help/version JSON combinations retain invocation-error contracts", () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  for (const args of [["--help"], ["help"], ["check", "--help"], ["qualify", "--help"], ["--version"], ["version"]]) {
    const result = spawnSync(process.execPath, [cli, ...args, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stderr, "");
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.schemaVersion, args[0] === "qualify" ? 2 : 1);
    assert.equal(envelope.outcome, args[0] === "qualify" ? "invalid-input" : "blocked");
    if (args[0] === "qualify") {
      assert.equal(envelope.command, "docs.qualify");
      assert.deepEqual(envelope.diagnostics, [{
        ruleId: "docs.qualification.invalid-input",
        severity: "error",
        phase: "input",
        subject: "docs.qualify",
        message: "qualify accepts no positional arguments."
      }]);
    } else {
      assert.equal(envelope.issues[0].code, "DOCS_CONSUMER_CLI_INVALID");
    }
  }
  for (const args of [[], ["--help"], ["help"], ["qualify", "--help"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Usage: agent-teams-docs-managed/u);
  }
});

test("managed leading JSON help returns one invocation-error envelope", () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  for (const args of [["--json", "--help"], ["--", "--json", "--help"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: 1,
      command: "consumer.check",
      outcome: "blocked",
      issues: [{
        code: "DOCS_CONSUMER_CLI_INVALID", severity: "error", subject: "--json",
        message: "--help does not accept --json."
      }]
    });
  }
});
