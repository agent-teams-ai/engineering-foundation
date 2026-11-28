import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolveInstalledPublicKernel } from "../tools/ef70-managed-campaign/installed-public-kernel.ts";
import {
  observeGet,
  type ObservationBudget,
  type ObservationRuntime,
  type ResponseObservation,
  type WaitObservation,
} from "../tools/ef70-managed-campaign/observation-transport.ts";
import {
  admitAuthoritySelection,
  assertCurrentAuthority,
  parseAuthorityRevision,
} from "../tools/ef70-managed-campaign/authority-selection.ts";

// Independent fixtures; these tests perform no GitHub or managed operation.
const revision = "b208d41f81029a39a7100ac04d3309d989b95c42";
const tree = "670e391ce66e343b99d005922a38797e0f2a48b1";
const otherRevision = "8636f328f4ac7b1b6eeb764d1414391849fdc783";

function branch() {
  return { name: "main", protected: true, commit: { sha: revision } };
}

function commit() {
  return { sha: revision, tree: { sha: tree } };
}

test("EF70 admits the explicit current protected Central commit and its immutable tree", () => {
  assert.equal(parseAuthorityRevision(revision), revision);
  const selection = admitAuthoritySelection(revision, branch(), commit());
  assert.deepEqual(selection, {
    revision: "b208d41f81029a39a7100ac04d3309d989b95c42",
    tree: "670e391ce66e343b99d005922a38797e0f2a48b1",
  });
  assert.equal(Object.isFrozen(selection), true);
});

test("EF70 authority input has no default, branch alias, abbreviated or malformed SHA", () => {
  for (const value of [
    undefined,
    null,
    "",
    "main",
    "refs/heads/main",
    "latest",
    "b208d41",
    "0".repeat(40),
    revision.toUpperCase(),
    " " + revision,
    revision + "\n",
    revision + "\0",
    42,
    { revision },
  ]) {
    assert.throws(() => parseAuthorityRevision(value), /explicit immutable/u);
  }
});

test("EF70 refuses a moved protected main instead of selecting its newer commit", () => {
  const current = branch();
  current.commit.sha = otherRevision;
  assert.throws(() => admitAuthoritySelection(revision, current, commit()), /no longer current/u);
});

test("EF70 refuses an unprotected branch and a response for another branch", () => {
  assert.throws(
    () => admitAuthoritySelection(revision, { ...branch(), protected: false }, commit()),
    /must remain protected/u,
  );
  assert.throws(
    () => admitAuthoritySelection(revision, { ...branch(), name: "candidate" }, commit()),
    /fixed Central main/u,
  );
});

test("EF70 refuses a different immutable commit even when its tree matches", () => {
  assert.throws(
    () => admitAuthoritySelection(revision, branch(), { sha: otherRevision, tree: { sha: tree } }),
    /must match the selection/u,
  );
});

test("EF70 requires an immutable Git tree identity from the selected commit", () => {
  for (const value of [
    undefined,
    null,
    {},
    { sha: "" },
    { sha: "0".repeat(40) },
    { sha: "main" },
  ]) {
    assert.throws(() =>
      admitAuthoritySelection(revision, branch(), { sha: revision, tree: value }),
    );
  }
});

test("EF70 refuses malformed authority observations without a fallback", () => {
  for (const value of [undefined, null, [], "main", {}, { protected: true, commit: null }]) {
    assert.throws(() => admitAuthoritySelection(revision, value, commit()));
    assert.throws(() => admitAuthoritySelection(revision, branch(), value));
  }
});

test("EF70 retains its original selection when a later current-main observation moves", () => {
  const initialBranch = branch();
  const initialCommit = commit();
  const selection = admitAuthoritySelection(revision, initialBranch, initialCommit);
  initialBranch.commit.sha = otherRevision;
  initialCommit.tree.sha = "7b932bebee5dc817e5bc643459972d0fff9c6747";
  assert.throws(
    () => assertCurrentAuthority(selection.revision, initialBranch),
    /no longer current/u,
  );
  assert.deepEqual(selection, { revision, tree });
  assertCurrentAuthority(selection.revision, branch());
});

const observationEpoch = 1_800_000_000_000;
const observationUrl = new URL(
  "https://api.github.com/repos/agent-teams-ai/engineering-foundation/actions/runs/42",
);
const observationHeaders = { Accept: "application/json", "User-Agent": "EF70-test" };

function transport(responses: (Response | Error)[]) {
  let clock = observationEpoch;
  const requests: {
    url: string;
    method: string | undefined;
    headers: HeadersInit | undefined;
    redirect: RequestRedirect | undefined;
    at: number;
  }[] = [];
  const captures: { body: Buffer; observation: ResponseObservation }[] = [];
  const waits: WaitObservation[] = [];
  const slices: number[] = [];
  const order: string[] = [];
  const runtime: ObservationRuntime = {
    request: async (url, init) => {
      order.push("request");
      requests.push({
        url,
        method: init.method,
        headers: init.headers,
        redirect: init.redirect,
        at: clock,
      });
      const response = responses.shift();
      assert(response, "Unexpected extra HTTP request");
      if (response instanceof Error) {
        throw response;
      }
      return response;
    },
    now: () => clock,
    wait: async (milliseconds) => {
      order.push("sleep");
      slices.push(milliseconds);
      clock += milliseconds;
    },
    capture: (body, observation) => {
      order.push("capture");
      captures.push({ body: Buffer.from(body), observation });
    },
    captureWait: (observation) => {
      order.push("wait-decision");
      waits.push(observation);
    },
  };
  return { runtime, requests, captures, waits, slices, order };
}

function readObservation(
  selected: ReturnType<typeof transport>,
  budget: ObservationBudget = { remainingWaitMs: 68 * 60_000 },
  maximum = 8 * 1024 * 1024,
  url = observationUrl,
  headers: Readonly<Record<string, string>> = observationHeaders,
) {
  return observeGet(
    { url, headers, label: "producer-preflight-run", maximum },
    budget,
    selected.runtime,
  );
}

test("EF70 retains an ordinary successful observation with no retry or waiting", async () => {
  const selected = transport([new Response('{"id":42}')]);
  const bytes = await readObservation(selected);
  assert.equal(bytes.toString(), '{"id":42}');
  assert.equal(selected.requests.length, 1);
  assert.deepEqual(selected.waits, []);
  assert.deepEqual(selected.order, ["request", "capture"]);
  const observation = selected.captures[0]!.observation;
  assert.equal(observation.status, 200);
  assert.equal(observation.attempt, 1);
  assert.equal(observation.bodyComplete, true);
  assert.equal(observation.successful, true);
  assert.equal(observation.authorizationHeaderSent, false);
});

test("EF70 retains primary quota refusals and waits until the recorded reset", async () => {
  for (const status of [403, 429]) {
    const selected = transport([
      new Response('{"message":"rate limit"}', {
        status,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String((observationEpoch + 90_000) / 1000),
        },
      }),
      new Response("accepted"),
    ]);
    const budget = { remainingWaitMs: 68 * 60_000 };
    assert.equal((await readObservation(selected, budget)).toString(), "accepted");
    assert.equal(selected.requests.length, 2);
    assert.equal(selected.requests[1]!.at, observationEpoch + 91_500);
    assert.equal(selected.waits[0]!.waitMs, 91_500);
    assert.equal(budget.remainingWaitMs, 68 * 60_000 - 91_500);
    assert.deepEqual(selected.order.slice(0, 4), ["request", "capture", "wait-decision", "sleep"]);
    assert.equal(selected.captures[0]!.observation.successful, false);
    assert.equal(selected.captures[0]!.body.toString(), '{"message":"rate limit"}');
    assert.equal(selected.captures[1]!.observation.successful, true);
    assert.equal(selected.captures[1]!.observation.attempt, 2);
  }
});

test("EF70 honors the later provider deadline and preserves the same request", async () => {
  for (const [retryAfter, resetSeconds, expectedWait] of [
    ["180", 90, 180_000],
    ["90", 180, 181_500],
  ] as const) {
    const selected = transport([
      new Response("rate limited", {
        status: 429,
        headers: {
          "retry-after": retryAfter,
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(observationEpoch / 1000 + resetSeconds),
          "set-cookie": "must-not-be-retained",
          "x-github-request-id": "independent-request-fixture",
        },
      }),
      new Response("ok"),
    ]);
    const headers = { ...observationHeaders, Authorization: "Bearer test-only-sentinel" };
    await readObservation(
      selected,
      undefined,
      undefined,
      new URL("https://api.github.com/repos/agent-teams-ai/.github/branches/main"),
      headers,
    );
    assert.equal(selected.waits[0]!.waitMs, expectedWait);
    assert.equal(selected.requests.length, 2);
    for (const request of selected.requests) {
      assert.equal(request.url, selected.requests[0]!.url);
      assert.equal(request.method, "GET");
      assert.equal(request.redirect, "error");
      assert.deepEqual(request.headers, headers);
    }
    assert.equal(selected.captures[0]!.observation.authorizationHeaderSent, true);
    assert.equal(
      selected.captures[0]!.observation.headers["x-github-request-id"],
      "independent-request-fixture",
    );
    const evidence = JSON.stringify([selected.captures, selected.waits]);
    assert.equal(evidence.includes("test-only-sentinel"), false);
    assert.equal(evidence.includes("must-not-be-retained"), false);
  }
});

test("EF70 stops unknown HTTP refusals without an authentication or host fallback", async () => {
  for (const status of [401, 403, 404, 429, 500, 503]) {
    const selected = transport([new Response("provider refusal", { status })]);
    await assert.rejects(readObservation(selected), /backoff/u);
    assert.equal(selected.requests.length, 1);
    assert.equal(selected.captures[0]!.body.toString(), "provider refusal");
    assert.equal(selected.captures[0]!.observation.successful, false);
    assert.deepEqual(selected.waits, []);
  }
  const npm = transport([
    new Response("registry refusal", { status: 403, headers: { "retry-after": "60" } }),
  ]);
  await assert.rejects(
    readObservation(npm, undefined, undefined, new URL("https://registry.npmjs.org/example")),
    /backoff/u,
  );
  assert.equal(npm.requests.length, 1);
  assert.deepEqual(npm.waits, []);
});

test("EF70 retains malformed provider metadata and refuses to guess a wait", async () => {
  const headers: Record<string, string>[] = [
    { "retry-after": "tomorrow" },
    { "retry-after": "-1" },
    { "retry-after": "1.5" },
    { "retry-after": "1e2" },
    { "retry-after": "9007199254740992" },
    { "x-ratelimit-remaining": "unknown" },
    { "x-ratelimit-remaining": "0" },
    { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "unknown" },
    { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9007199254740991" },
    { "retry-after": "60", "x-ratelimit-remaining": "0" },
  ];
  for (const responseHeaders of headers) {
    const selected = transport([
      new Response("retained before metadata rejection", { status: 403, headers: responseHeaders }),
    ]);
    await assert.rejects(readObservation(selected), /header|deadline/u);
    assert.equal(selected.requests.length, 1);
    assert.equal(selected.captures.length, 1);
    assert.equal(selected.captures[0]!.body.toString(), "retained before metadata rejection");
    assert.deepEqual(selected.waits, []);
  }
});

test("EF70 bounds repeated rate replies to four requests and three increasing waits", async () => {
  const selected = transport(
    Array.from(
      { length: 4 },
      () => new Response("limited", { status: 429, headers: { "retry-after": "0" } }),
    ),
  );
  await assert.rejects(readObservation(selected), /attempts exhausted/u);
  assert.equal(selected.requests.length, 4);
  assert.equal(selected.captures.length, 4);
  assert.deepEqual(
    selected.waits.map((entry) => entry.waitMs),
    [60_000, 120_000, 240_000],
  );
  assert(selected.captures.every((entry) => entry.observation.successful === false));
});

test("EF70 shares its wait budget and never shortens a provider delay", async () => {
  const budget = { remainingWaitMs: 90_000 };
  const selected = transport([
    new Response("limited", { status: 429, headers: { "retry-after": "0" } }),
    new Response("first completed"),
    new Response("limited again", { status: 403, headers: { "retry-after": "60" } }),
    new Response("must not be requested"),
  ]);
  await readObservation(selected, budget);
  assert.equal(budget.remainingWaitMs, 30_000);
  await assert.rejects(readObservation(selected, budget), /shared bootstrap wait budget/u);
  assert.equal(selected.requests.length, 3);
  assert.equal(selected.captures.length, 3);
  assert.equal(selected.waits.length, 1);
  assert.equal(budget.remainingWaitMs, 30_000);
  const beyond = transport([
    new Response("provider requires a longer wait", {
      status: 429,
      headers: { "retry-after": "4081" },
    }),
  ]);
  await assert.rejects(readObservation(beyond), /shared bootstrap wait budget/u);
  assert.equal(beyond.requests.length, 1);
  assert.deepEqual(beyond.waits, []);
});

test("EF70 refuses another GET until the provider wait deadline elapsed", async () => {
  const selected = transport([
    new Response("limited", { status: 429, headers: { "retry-after": "60" } }),
    new Response("must not be requested"),
  ]);
  await assert.rejects(
    observeGet(
      {
        url: observationUrl,
        headers: observationHeaders,
        label: "provider-wait",
        maximum: 1024,
      },
      { remainingWaitMs: 68 * 60_000 },
      { ...selected.runtime, wait: async () => {} },
    ),
    /deadline has not elapsed/u,
  );
  assert.equal(selected.requests.length, 1);
});

test("EF70 enforces streaming bounds and marks retained prefixes as incomplete", async () => {
  const exact = transport([new Response("x".repeat(64))]);
  assert.equal((await readObservation(exact, undefined, 64)).length, 64);
  const overflow = transport([new Response("x".repeat(65))]);
  await assert.rejects(readObservation(overflow, undefined, 64), /Incomplete bounded/u);
  assert.equal(overflow.captures[0]!.body.length, 64);
  assert.equal(overflow.captures[0]!.observation.bodyComplete, false);
  assert.equal(overflow.captures[0]!.observation.bodyTruncated, true);
  assert.equal(overflow.captures[0]!.observation.successful, false);
  for (const bytes of [64 * 1024, 64 * 1024 + 1]) {
    const failed = transport([
      new Response("e".repeat(bytes), {
        status: 403,
        headers: bytes > 64 * 1024 ? { "retry-after": "60" } : {},
      }),
    ]);
    await assert.rejects(readObservation(failed), /Incomplete bounded|backoff/u);
    assert.equal(failed.captures[0]!.body.length, 64 * 1024);
    assert.equal(failed.captures[0]!.observation.bodyComplete, bytes === 64 * 1024);
    assert.equal(failed.requests.length, 1);
    assert.deepEqual(failed.waits, []);
  }
});

test("EF70 retains an interrupted response prefix and never retries a partial body", async () => {
  let pulls = 0;
  const selected = transport([
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0) {
            controller.enqueue(Buffer.from("prefix"));
          } else {
            controller.error(new Error("body interrupted"));
          }
        },
      }),
      { status: 429, headers: { "retry-after": "60" } },
    ),
  ]);
  await assert.rejects(readObservation(selected), /Incomplete bounded/u);
  const retained = selected.captures[0]!;
  assert.equal(retained.body.toString(), "prefix");
  assert.equal(retained.observation.bodyComplete, false);
  assert.equal(retained.observation.bodyReadError, "body interrupted");
  assert.equal(retained.observation.successful, false);
  assert.equal(selected.requests.length, 1);
  assert.deepEqual(selected.waits, []);
});

test("EF70 does not retry network errors or accept a missing response body", async () => {
  const network = transport([new Error("network unavailable")]);
  await assert.rejects(readObservation(network), /network unavailable/u);
  assert.equal(network.requests.length, 1);
  assert.deepEqual(network.captures, []);
  assert.deepEqual(network.waits, []);
  const missing = transport([new Response(null, { status: 204 })]);
  await assert.rejects(readObservation(missing), /Incomplete bounded/u);
  assert.equal(missing.captures[0]!.body.length, 0);
  assert.equal(missing.captures[0]!.observation.bodyComplete, false);
  assert.equal(missing.captures[0]!.observation.bodyReadError, "Response body is missing");
  assert.deepEqual(missing.waits, []);
});

function installedKernelFixture() {
  const installation = realpathSync(mkdtempSync(join(tmpdir(), "ef70-public-kernel-")));
  const kernelRoot = join(installation, "node_modules/@agent-teams/repository-mutation");
  const entry = join(kernelRoot, "public/runtime.js");
  mkdirSync(join(kernelRoot, "public"), { recursive: true });
  writeFileSync(join(installation, "package.json"), '{"private":true,"type":"module"}\n');
  writeFileSync(entry, 'export const fixtureIdentity = "selected-public-kernel";\n');
  writeFileSync(join(kernelRoot, "private.cjs"), 'throw new Error("Private fallback executed");\n');
  const manifest = (publicRoot: unknown) => {
    writeFileSync(
      join(kernelRoot, "package.json"),
      JSON.stringify({
        name: "@agent-teams/repository-mutation",
        version: "0.5.2",
        type: "module",
        main: "./private.cjs",
        exports: { ".": publicRoot, "./package.json": "./package.json" },
      }) + "\n",
    );
  };
  manifest({ types: "./public/runtime.d.ts", import: "./public/runtime.js" });
  return { installation, kernelRoot, entry, manifest };
}

test("EF70 loads the declared import-only kernel public entry when CommonJS resolution refuses", async (t) => {
  const fixture = installedKernelFixture();
  t.after(() => rmSync(fixture.installation, { recursive: true, force: true }));
  const legacy = createRequire(join(fixture.installation, "package.json"));
  assert.throws(() => legacy.resolve("@agent-teams/repository-mutation"), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
  const selected = resolveInstalledPublicKernel(fixture.installation);
  assert.equal(selected.kernelRoot, fixture.kernelRoot);
  assert.equal(selected.entrypointURL, pathToFileURL(fixture.entry).href);
  const module: unknown = await import(selected.entrypointURL);
  assert(module !== null && typeof module === "object");
  assert.equal(Reflect.get(module, "fixtureIdentity"), "selected-public-kernel");
});

test("EF70 refuses unsupported public conditions instead of bypassing their resolution order", (t) => {
  const fixture = installedKernelFixture();
  t.after(() => rmSync(fixture.installation, { recursive: true, force: true }));
  for (const condition of ["node", "default", "require"]) {
    fixture.manifest({
      [condition]: "./private.cjs",
      types: "./public/runtime.d.ts",
      import: "./public/runtime.js",
    });
    assert.throws(
      () => resolveInstalledPublicKernel(fixture.installation),
      /Unsupported installed kernel public export conditions/u,
    );
  }
});

test("EF70 refuses nonliteral and escaping declared public import targets", (t) => {
  const fixture = installedKernelFixture();
  t.after(() => rmSync(fixture.installation, { recursive: true, force: true }));
  const forbidden = join(fixture.kernelRoot, "NODE_MODULES/other");
  mkdirSync(forbidden, { recursive: true });
  writeFileSync(join(forbidden, "index.js"), 'throw new Error("Forbidden target executed");\n');
  for (const target of [
    "../private.cjs",
    "./../private.cjs",
    "/private.cjs",
    "file:///private.cjs",
    "./public//runtime.js",
    "./public/./runtime.js",
    "./node_modules/other/index.js",
    "./NODE_MODULES/other/index.js",
    "./Node_Modules/other/index.js",
    "./public/%2e%2e/private.cjs",
    "./public/runtime.js?selection=other",
    "./public/runtime.js#other",
  ]) {
    fixture.manifest({ types: "./public/runtime.d.ts", import: target });
    assert.throws(
      () => resolveInstalledPublicKernel(fixture.installation),
      /Public ESM target/u,
    );
  }
});

test("EF70 refuses a public entry that escapes its physical kernel through a directory link", (t) => {
  const fixture = installedKernelFixture();
  t.after(() => rmSync(fixture.installation, { recursive: true, force: true }));
  const outside = join(fixture.installation, "outside-kernel");
  mkdirSync(outside);
  writeFileSync(join(outside, "runtime.js"), 'throw new Error("Escaped entry executed");\n');
  symlinkSync(outside, join(fixture.kernelRoot, "bridge"), "junction");
  fixture.manifest({ types: "./public/runtime.d.ts", import: "./bridge/runtime.js" });
  assert.throws(
    () => resolveInstalledPublicKernel(fixture.installation),
    /Public ESM entry must remain inside the selected physical kernel/u,
  );
});

test("EF70 refuses an ancestor kernel when the selected installation has no kernel", (t) => {
  const fixture = installedKernelFixture();
  t.after(() => rmSync(fixture.installation, { recursive: true, force: true }));
  const child = join(fixture.installation, "different-installation");
  mkdirSync(child);
  writeFileSync(join(child, "package.json"), '{"private":true,"type":"module"}\n');
  assert.equal(
    createRequire(join(child, "package.json")).resolve("@agent-teams/repository-mutation/package.json"),
    join(fixture.kernelRoot, "package.json"),
  );
  assert.throws(() => resolveInstalledPublicKernel(child), { code: "ENOENT" });
});
