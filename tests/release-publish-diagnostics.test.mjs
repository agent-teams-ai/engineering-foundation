import assert from "node:assert/strict";
import test from "node:test";
import { tarballIntegrity } from "../scripts/release-publish-ordered.mjs";
import { publishNpmArtifact } from "../scripts/release-publish-ordered-runtime.mjs";
import { foundation, harness, present, RELEASE_TIMESTAMPS, run } from "./support/release-publish-ordered-fixtures.mjs";

for (const code of ["ENEEDAUTH", "EUSAGE", "EPRIVATE", "ENOENT", "EACCES"]) {
  test(`stops immediately on proven pre-publication refusal ${code}`, async () => {
    const runtime = harness();
    const diagnostics = [];
    let inspectionsAtPublish;
    runtime.publish = async (value, tag) => {
      runtime.calls.push(`publish:${value.name}:${tag}`);
      inspectionsAtPublish = runtime.calls.filter((call) => call.startsWith("inspect:")).length;
      publishNpmArtifact(value, tag, { spawn: () => ["ENOENT", "EACCES"].includes(code)
        ? { error: Object.assign(new Error("secret"), { code }), pid: 0, status: null }
        : { status: 1, stderr: `npm error code ${code}\nnpm error secret` } });
    };
    await assert.rejects(run(runtime, { reportPublishFailure: (message) => diagnostics.push(message) }),
      (error) => {
        assert.match(error.message, new RegExp(`${code}.*publication did not start`, "u"));
        assert.doesNotMatch(error.message, /secret/u);
        return true;
      });
    assert.equal(runtime.calls.filter((call) => call.startsWith("inspect:")).length, inspectionsAtPublish);
    assert.equal(runtime.calls.filter((call) => call.startsWith("publish:")).length, 1);
    assert.equal(runtime.calls.some((call) => /^(?:signature|release):/u.test(call)), false);
    assert.equal(diagnostics.length, 1);
  });
}

for (const result of [
  { status: 1, stderr: "npm error code E403" },
  { status: 1, stderr: "npm error code EPUBLISHCONFLICT" },
  { status: 1, stderr: "npm error code E503" },
  { status: null, error: Object.assign(new Error("secret"), { code: "ETIMEDOUT" }) },
  { status: null, signal: "SIGTERM" },
  { status: 1, stderr: "unknown secret" },
  { status: null, pid: 123, error: Object.assign(new Error("secret"), { code: "EACCES" }) },
]) {
  test(`ambiguous npm failure retains initial diagnostic and bounded observations: ${JSON.stringify(result)}`, async () => {
    const runtime = harness();
    const diagnostics = [];
    let inspectionsAtPublish;
    runtime.publish = async (value, tag) => {
      runtime.calls.push(`publish:${value.name}:${tag}`);
      inspectionsAtPublish = runtime.calls.filter((call) => call.startsWith("inspect:")).length;
      publishNpmArtifact(value, tag, { spawn: () => result });
    };
    await assert.rejects(run(runtime, { reportPublishFailure: (message) => diagnostics.push(message) }),
      (error) => {
        assert.match(error.message, /remained absent.*initial publish failure: npm publish failed/u);
        assert.doesNotMatch(error.message, /secret/u);
        return true;
      });
    assert.equal(runtime.calls.filter((call) => call.startsWith("inspect:")).length, inspectionsAtPublish + 2);
    assert.equal(runtime.calls.filter((call) => call.startsWith("publish:")).length, 1);
    assert.equal(runtime.calls.some((call) => /^(?:signature|release):/u.test(call)), false);
    assert.equal(diagnostics.length, 1);
  });
}

test("lost npm response logs sanitized failure and still verifies accepted artifacts", async () => {
  const runtime = harness();
  const originalPublish = runtime.publish;
  const diagnostics = [];
  runtime.publish = async (value, tag) => {
    await originalPublish(value, tag);
    publishNpmArtifact(value, tag, { spawn: () => ({ status: 1,
      stderr: "npm error code ECONNRESET\nAuthorization: Bearer secret\nhttps://user:password@example.test/?token=secret",
      stdout: "secret",
    }) });
  };
  await run(runtime, { reportPublishFailure: (message) => diagnostics.push(message) });
  assert.equal(diagnostics.length, 6);
  assert.equal(runtime.calls.filter((call) => call.startsWith("signature:")).length, 6);
  assert.equal(runtime.calls.filter((call) => call.startsWith("release:")).length, 6);
  assert.equal(runtime.calls.filter((call) => call.startsWith("publish:")).length, 6);
  assert.match(diagnostics.join("\n"), /ECONNRESET/u);
  assert.doesNotMatch(diagnostics.join("\n"), /secret|password|Bearer|example/u);
});

test("npm adapter preserves exact invocation and accepts zero exit", () => {
  const value = { ...foundation, archivePath: "/tmp/qualified.tgz" };
  publishNpmArtifact(value, "latest", { cwd: "/tmp", spawn: (command, args, options) => {
    assert.equal(command, "npm");
    assert.deepEqual(args, [
      "publish", "/tmp/qualified.tgz", "--access", "public", "--tag", "latest",
      "--provenance", "--ignore-scripts", "--registry=https://registry.npmjs.org/",
    ]);
    assert.equal(options.cwd, "/tmp");
    return { status: 0, stdout: "ignored", stderr: "" };
  } });
});

test("unclassified exceptions reconcile without leaking raw exception text", async () => {
  const runtime = harness();
  runtime.publish = async () => { throw new Error("credential-secret"); };
  await assert.rejects(run(runtime), (error) => {
    assert.match(error.message, /remained absent.*initial publish failure.*unclassified/u);
    assert.doesNotMatch(error.message, /credential-secret/u);
    return true;
  });
});

test("ambiguous publication still rejects conflicting registry bytes with initial diagnostic", async () => {
  const runtime = harness();
  runtime.publish = async (value, tag) => {
    const state = present(value, RELEASE_TIMESTAMPS.get(value.name), tag);
    state.integrity = tarballIntegrity(Buffer.from("conflicting bytes"));
    runtime.states.set(value.name, state);
    publishNpmArtifact(value, tag, { spawn: () => ({ status: 1, stderr: "npm error code ECONNRESET" }) });
  };
  await assert.rejects(run(runtime), /different tarball SRI.*initial publish failure.*ECONNRESET/u);
  assert.equal(runtime.calls.some((call) => /^(?:signature|release):/u.test(call)), false);
});

for (const lazy of [false, true]) {
  test(`signature fixture resolves and clones present state (lazy=${lazy})`, async () => {
    const snapshot = present(foundation, RELEASE_TIMESTAMPS.get(foundation.name));
    const runtime = harness({ [foundation.name]: lazy ? async (value) => {
      assert.equal(value, foundation);
      return snapshot;
    } : snapshot });
    assert.deepEqual(await runtime.inspect(foundation), snapshot);
    const provenance = await runtime.verifySignature(foundation);
    assert.deepEqual(provenance, snapshot.provenance);
    assert.notEqual(provenance, snapshot.provenance);
  });
  for (const state of [undefined, null, { status: "absent" }, { status: "unknown" }, {}]) {
    test(`signature fixture explicitly rejects non-present state ${JSON.stringify(state)} (lazy=${lazy})`, async () => {
      const runtime = harness({ [foundation.name]: lazy ? async () => state : state });
      await assert.rejects(runtime.verifySignature(foundation), (error) => {
        assert.equal(error.constructor, Error);
        assert.equal(error.message, `Signature verification requires a present snapshot for ${foundation.name}.`);
        return true;
      });
    });
  }
}
