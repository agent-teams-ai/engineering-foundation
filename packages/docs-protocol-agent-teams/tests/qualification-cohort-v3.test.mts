import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import {
  createDocsProtocolQualificationV3
} from "../dist/qualification/application-api.js";
import { parsePackedManagedRuntimePolicy } from
  "../dist/consumer-integration/adapters/unselected-cohort-v3-loader.js";
import { runDocsProtocolQualificationV3 } from "../dist/qualification/index.js";
import { createNodeDocsProtocolQualificationRuntimeObserver } from
  "../dist/qualification/adapters/outbound/node-qualification-runtime.js";
import type {
  DocsProtocolQualificationRuntimeObservation
} from "../dist/qualification/application/model/v3-contract.js";
import type {
  PackedManagedRuntimePolicy
} from "../dist/consumer-integration/application/policies/qualified-docs-cohort-v3.js";
import {
  createRequestFixture,
  exactRuntime,
  isCohortReceipt,
  observeLockfile,
  observePackedPolicy,
  policy,
  qualification,
  request,
  receiptDigest,
  type PackedRuntimePolicyFixture
} from "./qualification-cohort-v3-fixtures.mts";

test("Gen3 valid observation and lock closure emits the exact namespace receipt", async () => {
  const result = qualification(request);
  if (!isCohortReceipt(result)) {
    assert.fail("Gen3 request must emit a Cohort v3 receipt.");
  }
  const receipt = result;
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.namespace, "docs-protocol-cohort-v3-qualification-receipt/v1");
  assert.equal(receipt.profileSchemaVersion, 4);
  assert.equal(receipt.cohort.schemaVersion, 3);
  assert.deepEqual(receipt.packages.map(({ key }) => key), [
    "repositoryMutation",
    "documentAuthoring",
    "docsProtocol",
    "docsProtocolAgentTeams",
    "engineeringFoundation"
  ]);
  assert.equal(receipt.schemas.qualificationReceipt, 1);
  assert.equal(receipt.runtime.runtimeClosure.domain, "agent-teams.docs-runtime-closure/v2");
  assert.equal(receipt.receiptDigest, receiptDigest(receipt));
  assert.notEqual(
    receipt.receiptDigest,
    receiptDigest({ ...receipt, namespace: "docs-protocol-cohort-v3-qualification-receipt/v2" })
  );
  const schema = JSON.parse(await readFile(
    new URL("../schemas/docs-protocol-cohort-v3-qualification-receipt/v1.schema.json", import.meta.url),
    "utf8"
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
});

test("public runDocsProtocolQualificationV3 observes the actual process without a blanket skip", async () => {
  const [schemaInput, assetInput] = await Promise.all([
    readFile(new URL("../schemas/managed-runtime-policy/v1.schema.json", import.meta.url), "utf8"),
    readFile(new URL("../assets/runtime-policy.v1.json", import.meta.url), "utf8")
  ]);
  const parsedPolicy = parsePackedManagedRuntimePolicy(schemaInput, assetInput);
  assert.match(parsedPolicy.sourceDigest, /^sha256:[0-9a-f]{64}$/u);
  const actualPolicy = parsedPolicy as PackedRuntimePolicyFixture;
  const publicRequest = createRequestFixture(actualPolicy);
  const privateActualQualification = createDocsProtocolQualificationV3(
    observeLockfile,
    () => exactRuntime,
    () => actualPolicy
  );
  const observeCurrent = createNodeDocsProtocolQualificationRuntimeObserver();
  let observed: DocsProtocolQualificationRuntimeObservation;
  try {
    observed = observeCurrent();
  } catch (error) {
    assert.equal(process.versions.node, exactRuntime.nodeVersion);
    assert.equal(process.platform, exactRuntime.platform);
    assert.equal(process.arch, exactRuntime.architecture);
    assert.match(String(error), /could not observe the resolved pnpm executable/u);
    assert.throws(
      () => runDocsProtocolQualificationV3(publicRequest),
      /could not observe the resolved pnpm executable/u
    );
    return;
  }
  const isExactRuntime = observed.nodeVersion === exactRuntime.nodeVersion &&
    observed.pnpmVersion === exactRuntime.pnpmVersion &&
    observed.platform === exactRuntime.platform &&
    observed.architecture === exactRuntime.architecture;
  assert.notEqual(runDocsProtocolQualificationV3, qualification);
  if (isExactRuntime) {
    const publicReceipt = runDocsProtocolQualificationV3(publicRequest);
    if (!isCohortReceipt(publicReceipt)) {
      assert.fail("Public Gen3 request must emit a Cohort v3 receipt.");
    }
    const privateReceipt = privateActualQualification(publicRequest);
    if (!isCohortReceipt(privateReceipt)) {
      assert.fail("Private injected Gen3 request must emit a Cohort v3 receipt.");
    }
    assert.equal(publicReceipt.namespace, "docs-protocol-cohort-v3-qualification-receipt/v1");
    assert.equal(publicReceipt.receiptDigest, privateReceipt.receiptDigest);
  } else {
    assert.throws(
      () => runDocsProtocolQualificationV3(publicRequest),
      {
        name: "Error",
        message: "Qualification Cohort v3 observed Node runtime mismatch."
      }
    );
  }
});

test("real process observer reflects the current process and fake injection remains distinct", async t => {
  const root = await mkdtemp(join(tmpdir(), "qualification-bun-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = JSON.stringify({ name: "qualification-bun-cwd", private: true, packageManager: "bun@1.4.3" });
  await writeFile(join(root, "package.json"), manifest);
  const entry = new URL("../dist/qualification/adapters/outbound/node-qualification-runtime.js", import.meta.url).href;
  const probe = spawnSync(process.execPath, ["--input-type=module", "--eval",
    `import { createNodeDocsProtocolQualificationRuntimeObserver } from ${JSON.stringify(entry)};
     process.stdout.write(JSON.stringify(createNodeDocsProtocolQualificationRuntimeObserver()()));`
  ], { cwd: root, encoding: "utf8", timeout: 15_000 });
  assert.equal(probe.error, undefined);
  assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  assert.equal(probe.signal, null);
  assert.equal(probe.stderr, "");
  const child: DocsProtocolQualificationRuntimeObservation = JSON.parse(probe.stdout);
  assert.equal(child.nodeVersion, process.versions.node);
  assert.equal(child.platform, process.platform);
  assert.equal(child.architecture, process.arch);
  assert.equal(child.pnpmVersion,
    process.versions.node === "26.11.1" && process.platform === "linux" && process.arch === "x64"
      ? exactRuntime.pnpmVersion : undefined);
  assert.equal(await readFile(join(root, "package.json"), "utf8"), manifest);
  assert.deepEqual(await readdir(root), ["package.json"]);

  const observeCurrent = createNodeDocsProtocolQualificationRuntimeObserver();
  const observed = observeCurrent();
  assert.equal(observed.nodeVersion, process.versions.node);
  assert.equal(observed.platform, process.platform);
  assert.equal(observed.architecture, process.arch);
  if (observed.pnpmVersion !== undefined) {
    assert.equal(observed.pnpmVersion, exactRuntime.pnpmVersion);
  }

  let fakeCalls = 0;
  const fakeRuntime: DocsProtocolQualificationRuntimeObservation = { ...exactRuntime };
  const fakeObserver = (): DocsProtocolQualificationRuntimeObservation => {
    fakeCalls++;
    return fakeRuntime;
  };
  const injected = createDocsProtocolQualificationV3(observeLockfile, fakeObserver, observePackedPolicy);
  injected(request);
  assert.equal(fakeCalls, 1);
  assert.notStrictEqual(fakeRuntime, observed);
  assert.notStrictEqual(fakeObserver, observeCurrent);
});

test("packed policy thunk is lazy and generation-4-only", () => {
  let policyCalls = 0;
  const countingPolicy = (): PackedManagedRuntimePolicy => {
    policyCalls++;
    return policy;
  };
  const lazyQualification = createDocsProtocolQualificationV3(
    observeLockfile,
    () => exactRuntime,
    countingPolicy
  );
  const malformed = structuredClone(request);
  Reflect.deleteProperty(malformed.evidence, "cohort");
  assert.throws(
    () => lazyQualification(malformed),
    /evidence is invalid or incomplete/u
  );
  assert.equal(policyCalls, 0);
  const legacyShaped = structuredClone(request);
  Object.defineProperty(legacyShaped.profile, "schemaVersion", {
    value: 3,
    enumerable: true,
    configurable: true,
    writable: true
  });
  assert.throws(() => lazyQualification(legacyShaped), /invalid or unsupported/u);
  assert.equal(policyCalls, 0);
  lazyQualification(request);
  assert.equal(policyCalls, 1);
});

test("Gen3 rejects accessor, hidden and nonplain evidence before callbacks", () => {
  let lockfileCalls = 0;
  let runtimeCalls = 0;
  let policyCalls = 0;
  const guarded = createDocsProtocolQualificationV3(
    (observedRequest) => {
      lockfileCalls++;
      return observeLockfile(observedRequest);
    },
    () => {
      runtimeCalls++;
      return exactRuntime;
    },
    () => {
      policyCalls++;
      return observePackedPolicy();
    }
  );

  const accessorRequest = createRequestFixture(policy);
  Object.defineProperty(accessorRequest.evidence.runtime, "selectedLane", {
    get: () => "node-26-managed-qualified",
    enumerable: true,
    configurable: true
  });
  assert.throws(
    () => guarded(accessorRequest),
    {
      name: "TypeError",
      message: "Consumer input must not contain accessors or hidden properties."
    }
  );

  const hiddenRequest = createRequestFixture(policy);
  Object.defineProperty(hiddenRequest.evidence, "hidden", {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true
  });
  assert.throws(
    () => guarded(hiddenRequest),
    {
      name: "TypeError",
      message: "Consumer input must not contain accessors or hidden properties."
    }
  );

  const symbolRequest = createRequestFixture(policy);
  Object.defineProperty(symbolRequest.evidence, Symbol("hidden"), {
    value: true,
    enumerable: true,
    configurable: true,
    writable: true
  });
  assert.throws(
    () => guarded(symbolRequest),
    {
      name: "TypeError",
      message: "Consumer input must not contain symbol properties."
    }
  );

  const nonPlainRequest = createRequestFixture(policy);
  Object.setPrototypeOf(nonPlainRequest.evidence, {});
  assert.throws(
    () => guarded(nonPlainRequest),
    {
      name: "TypeError",
      message: "Consumer input must use plain JSON objects and arrays."
    }
  );

  const proxyRequest = new Proxy(createRequestFixture(policy), {});
  assert.throws(
    () => guarded(proxyRequest),
    {
      name: "TypeError",
      message: "Qualification request must be stable plain JSON data with lockfile bytes."
    }
  );
  let rootGetterCalls = 0;
  const accessorRootRequest = createRequestFixture(policy);
  Object.defineProperty(accessorRootRequest, "profile", {
    get: () => {
      rootGetterCalls++;
      return accessorRootRequest.profile;
    },
    enumerable: true,
    configurable: true
  });
  assert.throws(
    () => guarded(accessorRootRequest),
    {
      name: "TypeError",
      message: "Qualification request must be stable plain JSON data with lockfile bytes."
    }
  );
  assert.equal(rootGetterCalls, 0);
  assert.deepEqual([lockfileCalls, runtimeCalls, policyCalls], [0, 0, 0]);
});

test("observer mutation cannot change the admitted request used by the receipt", () => {
  const mutableRequest = createRequestFixture(policy);
  const expected = qualification(mutableRequest);
  const expectedBytes = Uint8Array.from(mutableRequest.lockfileBytes);
  const changedDigest = `sha256:${"f".repeat(64)}` as const;
  const mutationQualification = createDocsProtocolQualificationV3(
    (observedRequest) => {
      const observedEvidence = observedRequest.evidence;
      if (!("runtime" in observedEvidence) || !("policy" in observedEvidence)) {
        throw new Error("Observer mutation test requires Cohort v3 evidence.");
      }
      assert.equal(
        Reflect.set(observedEvidence.runtime, "selectedLane", "node-24-production-default"),
        false
      );
      assert.equal(
        Reflect.set(observedEvidence.policy, "sourceDigest", changedDigest),
        false
      );
      assert.notStrictEqual(observedRequest.lockfileBytes, mutableRequest.lockfileBytes);
      assert.deepEqual(observedRequest.lockfileBytes, expectedBytes);
      const observation = observeLockfile(observedRequest);
      assert.equal(
        Reflect.set(mutableRequest.evidence.runtime, "selectedLane", "node-24-production-default"),
        true
      );
      assert.equal(
        Reflect.set(mutableRequest.evidence.policy, "sourceDigest", changedDigest),
        true
      );
      mutableRequest.lockfileBytes.fill(0);
      assert.deepEqual(observedRequest.lockfileBytes, expectedBytes);
      return observation;
    },
    () => exactRuntime,
    observePackedPolicy
  );

  assert.deepEqual(mutationQualification(mutableRequest), expected);
  assert.equal(mutableRequest.evidence.runtime.selectedLane, "node-24-production-default");
  assert.equal(mutableRequest.evidence.policy.sourceDigest, changedDigest);
});

test("native backing bounds reject SharedArrayBuffer and oversized ordinary buffers before callbacks", () => {
  let lockfileCalls = 0;
  let runtimeCalls = 0;
  let policyCalls = 0;
  const guarded = createDocsProtocolQualificationV3(
    (observedRequest) => {
      lockfileCalls++;
      return observeLockfile(observedRequest);
    },
    () => {
      runtimeCalls++;
      return exactRuntime;
    },
    () => {
      policyCalls++;
      return observePackedPolicy();
    }
  );
  const sharedRequest = {
    ...createRequestFixture(policy),
    lockfileBytes: new Uint8Array(new SharedArrayBuffer(1))
  };
  const oversizedRequest = {
    ...createRequestFixture(policy),
    lockfileBytes: new Uint8Array(new ArrayBuffer(33 * 1024 * 1024), 0, 1)
  };
  assert.throws(
    () => guarded(sharedRequest),
    {
      name: "TypeError",
      message: "Qualification v3 lockfile must contain 1..33554432 bytes."
    }
  );
  assert.throws(
    () => guarded(oversizedRequest),
    {
      name: "TypeError",
      message: "Qualification v3 lockfile must contain 1..33554432 bytes."
    }
  );
  assert.deepEqual([lockfileCalls, runtimeCalls, policyCalls], [0, 0, 0]);

  const ordinaryRequest = createRequestFixture(policy);
  assert.equal(isCohortReceipt(guarded(ordinaryRequest)), true);
  assert.deepEqual([lockfileCalls, runtimeCalls, policyCalls], [1, 1, 1]);
});

test("real process observer refuses caller-spoofed runtime and declared profile alone cannot green", () => {
  const spoofed = structuredClone(request);
  Object.defineProperty(spoofed.evidence.runtime.qualificationRuntime, "nodeVersion", {
    value: "26.10.0",
    enumerable: true,
    configurable: true,
    writable: true
  });
  assert.throws(() => qualification(spoofed), /runtime evidence mismatch/u);
  const wrongObserver = createDocsProtocolQualificationV3(observeLockfile, () => ({
    nodeVersion: "26.10.0",
    platform: "linux",
    architecture: "x64"
  }), observePackedPolicy);
  assert.throws(() => wrongObserver(request), /observed Node runtime mismatch/u);
  const wrongPlatform = createDocsProtocolQualificationV3(observeLockfile, () => ({
    nodeVersion: "26.11.1",
    platform: "macos",
    architecture: "x64"
  }), observePackedPolicy);
  assert.throws(() => wrongPlatform(request), /observed Node runtime mismatch/u);
  const missingPnpm = createDocsProtocolQualificationV3(observeLockfile, () => ({
    nodeVersion: "26.11.1",
    platform: "linux",
    architecture: "x64"
  }), observePackedPolicy);
  assert.throws(() => missingPnpm(request), /observed Node runtime mismatch/u);
});

test("Gen3 rejects mixed generations, schemas and package coordinates", () => {
  const wrongGeneration = structuredClone(request);
  Object.defineProperty(wrongGeneration.profile.cohort, "schemaVersion", {
    value: 2,
    enumerable: true,
    configurable: true,
    writable: true
  });
  assert.throws(() => qualification(wrongGeneration), /invalid or unsupported/u);
  const wrongSchema = structuredClone(request);
  Object.defineProperty(wrongSchema.evidence.schemas, "managedState", {
    value: 2,
    enumerable: true,
    configurable: true,
    writable: true
  });
  assert.throws(() => qualification(wrongSchema), /schema bindings 4\/3\/1/u);
  const wrongPackage = structuredClone(request);
  Object.defineProperty(wrongPackage.evidence.packages.docsProtocol, "version", {
    value: "0.5.1",
    enumerable: true,
    configurable: true,
    writable: true
  });
  assert.throws(() => qualification(wrongPackage), /version mismatch/u);
  const wrongCoordinate = structuredClone(request);
  Object.defineProperty(wrongCoordinate.profile.cohort.packages.docsProtocol, "version", {
    value: "0.5.1",
    enumerable: true,
    configurable: true,
    writable: true
  });
  assert.throws(
    () => qualification(wrongCoordinate),
    {
      name: "ConsumerIntegrationNodeError",
      message: "@agent-teams/docs-protocol importer evidence must select exact cohort version 0.5.1."
    }
  );
});

test("legacy receipt v3 bytes and digest are independent of the new namespace schema", async () => {
  const bytes = await readFile(
    new URL("../schemas/docs-protocol-qualification-receipt/v3.schema.json", import.meta.url)
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "cc8e8fb12c461bbce4922dec9996a42a79bbab010395c4f60821a6d588e738fe"
  );
  const schema = JSON.parse(bytes.toString("utf8"));
  assert.equal(schema.$id, "https://agent-teams.ai/schemas/docs-protocol-qualification-receipt/v3");
  assert.equal(schema.properties.schemaVersion.const, 3);
});
