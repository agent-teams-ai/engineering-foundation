import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyKnownFileTransaction,
  assertKnownFileTransactionPlan,
  compileKnownFileTransactionPlan,
  inspectKnownFileTransactionBarrier,
  type KnownFileTransactionOperationInput,
  type KnownFileTransactionPlanV1,
} from "../dist/index.js";

function creation(
  path = "planned.txt",
  bytes: Uint8Array = Buffer.from("planned bytes\n"),
): KnownFileTransactionOperationInput {
  return { path, precondition: { state: "absent" }, postimage: { bytes } };
}

function compileUnknown(value: unknown): KnownFileTransactionPlanV1 {
  const result: unknown = Reflect.apply(compileKnownFileTransactionPlan, undefined, [value]);
  assertKnownFileTransactionPlan(result);
  return result;
}

function getter(value: object, key: string, invoked: () => void, result: unknown): object {
  Object.defineProperty(value, key, {
    enumerable: true,
    get() {
      invoked();
      return result;
    },
  });
  return value;
}

function mutablePlan(): KnownFileTransactionPlanV1 {
  const value: unknown = JSON.parse(
    JSON.stringify(compileKnownFileTransactionPlan({ operations: [creation()] })),
  );
  assertKnownFileTransactionPlan(value);
  return value;
}

export function assertInertKnownFileInputs(): number {
  let invoked = 0;
  const invocation = () => {
    invoked += 1;
  };
  const ownMap = Object.assign([creation()], {
    map() {
      invocation();
      return [];
    },
  });
  const inheritedMap: unknown = Object.setPrototypeOf(
    [creation()],
    getter({}, "map", invocation, () => []),
  );
  const sparse = [creation()];
  Reflect.deleteProperty(sparse, "0");
  const symbolic = [creation()];
  Object.defineProperty(symbolic, Symbol.iterator, {
    value() {
      invocation();
      return [][Symbol.iterator]();
    },
  });
  const hidden = { ...creation() };
  Object.defineProperty(hidden, "extra", { value: "hidden" });
  const cycle: Record<string, unknown> = {};
  cycle["cycle"] = cycle;
  const inputs: readonly unknown[] = [
    { operations: ownMap },
    { operations: inheritedMap },
    { operations: sparse },
    { operations: symbolic },
    getter({}, "operations", invocation, [creation()]),
    { operations: [getter({ ...creation() }, "path", invocation, "planned.txt")] },
    { operations: [{ ...creation(), extra: invocation }] },
    { operations: [{ ...creation(), [Symbol("extra")]: "symbolic key" }] },
    { operations: [{ ...creation(), extra: getter({}, "value", invocation, 1) }] },
    { operations: [hidden] },
    { operations: [{ ...creation(), extra: cycle }] },
  ];
  for (const input of inputs) {
    assert.throws(() => compileUnknown(input), { name: "KnownFileTransactionPlanError" });
  }
  const wireGetter = mutablePlan();
  getter(wireGetter, "schemaVersion", invocation, 1);
  const wireImageGetter = mutablePlan();
  getter(wireImageGetter.operations.at(0)!.postimage, "contentBase64", invocation, "");
  const wirePathCoercion = mutablePlan();
  Reflect.set(wirePathCoercion.operations.at(0)!, "path", {
    toString() {
      invocation();
      return "planned.txt";
    },
  });
  const wireExtra = mutablePlan();
  Reflect.set(wireExtra.operations.at(0)!, "extra", "closed wire input");
  const wireArray = mutablePlan();
  Reflect.set(wireArray.operations, "map", () => {
    invocation();
    return [];
  });
  const wireCases = [wireGetter, wireImageGetter, wirePathCoercion, wireExtra, wireArray];
  for (const candidate of wireCases) {
    assert.throws(
      () => {
        assertKnownFileTransactionPlan(candidate);
      },
      {
        name: "KnownFileTransactionPlanError",
      },
    );
  }
  assert.equal(invoked, 0, "admission must not execute caller accessors, methods or coercions");
  return inputs.length + wireCases.length;
}

export function assertCompatibleKnownFileInputs(): void {
  assert.deepEqual(compileKnownFileTransactionPlan({ operations: [] }).operations, []);
  const zero = compileKnownFileTransactionPlan({
    operations: [creation("empty", new Uint8Array())],
  });
  assert.equal(zero.operations.at(0)!.postimage.size, 0);
  const buffer = Buffer.from([0, 1, 2, 3]);
  const view = new Uint8Array(buffer.buffer, buffer.byteOffset + 1, 2);
  const expected = compileKnownFileTransactionPlan({
    operations: [creation("view", Buffer.from([1, 2]))],
  });
  const operation = {
    path: "view",
    precondition: Object.assign(
      { __proto__: null },
      {
        state: "absent",
        explanation: ["inert", { optional: undefined }],
      },
    ),
    postimage: Object.assign(
      { __proto__: null },
      {
        bytes: view,
        mode: undefined,
        label: "consumer",
      },
    ),
    extra: { count: 1, empty: null, token: Symbol("inert extra value") },
  };
  const actual = compileUnknown(Object.assign({ __proto__: null }, { operations: [operation] }));
  assert.deepEqual(actual, expected);
  buffer.fill(9);
  assert.deepEqual(actual, expected, "compiled bytes must not retain the caller's native view");
  assert.equal(Object.isFrozen(actual.operations.at(0)!.postimage), true);
  let calls = 0;
  const native = Buffer.from([1, 2]);
  getter(
    native,
    "byteLength",
    () => {
      calls += 1;
    },
    100,
  );
  getter(
    native,
    "buffer",
    () => {
      calls += 1;
    },
    new ArrayBuffer(0),
  );
  getter(
    native,
    "byteOffset",
    () => {
      calls += 1;
    },
    0,
  );
  assert.deepEqual(
    compileKnownFileTransactionPlan({ operations: [creation("view", native)] }),
    expected,
  );
  assert.equal(calls, 0, "native view geometry must not call shadowing getters");
}

export function assertKnownFileInputBudgets(): void {
  const tooMany = Array.from({ length: 33 }, () => ({}));
  assert.throws(() => compileUnknown({ operations: tooMany }), /at most 32/u);
  const wire = mutablePlan();
  Reflect.set(wire, "operations", tooMany);
  assert.throws(() => {
    assertKnownFileTransactionPlan(wire);
  }, /at most 32/u);
  assert.throws(
    () =>
      compileUnknown({
        operations: [
          {
            path: "a",
            precondition: {
              state: "known-file",
              acceptedPreimages: Array.from({ length: 17 }, () => ({})),
            },
            postimage: {},
          },
        ],
      }),
    /at most 16/u,
  );
  const large = Buffer.alloc(6 * 1024 * 1024);
  assert.throws(
    () =>
      compileUnknown({
        operations: [creation("a", large), creation("b", large), creation("c", large)],
      }),
    /Transaction evidence exceeds/u,
  );
  const single = compileKnownFileTransactionPlan({ operations: [creation("a", large)] });
  const image = single.operations.at(0)!.postimage;
  // An intentionally bad digest would reject during hashing. The aggregate
  // error must win because the whole wire budget is admitted before decoding.
  const largeWire = {
    ...single,
    operations: ["a", "b", "c"].map((path) => ({
      path,
      precondition: { state: "absent" },
      postimage: { ...image, digest: `sha256:${"0".repeat(64)}` },
    })),
  };
  assert.throws(() => {
    assertKnownFileTransactionPlan(largeWire);
  }, /Transaction evidence exceeds/u);
  assert.throws(() => {
    assertKnownFileTransactionPlan({
      ...single,
      operations: [{ ...single.operations[0], postimage: { ...image, size: 0 } }],
    });
  }, /bytes or digest/u);
  const oneByte = compileKnownFileTransactionPlan({
    operations: [creation("a", Buffer.from([0]))],
  });
  assert.throws(() => {
    assertKnownFileTransactionPlan({
      ...oneByte,
      operations: [
        {
          ...oneByte.operations[0],
          postimage: { ...oneByte.operations.at(0)!.postimage, contentBase64: "AB==" },
        },
      ],
    });
  }, /bytes or digest/u);
}

export async function assertOwnedKnownFilePlan(root: string): Promise<void> {
  const bytes = "planned bytes\n";
  await writeFile(join(root, "existing.txt"), bytes);
  const original = compileKnownFileTransactionPlan({ operations: [creation()] });
  const supplied = mutablePlan();
  const applying = applyKnownFileTransaction({ consumerRoot: root, plan: supplied });
  Reflect.set(supplied.operations.at(0)!, "path", "existing.txt");
  if (process.platform === "win32") {
    await assert.rejects(applying, { code: "KNOWN_FILE_APPLY_UNSUPPORTED" });
    assert.deepEqual(await readdir(root), ["existing.txt"]);
    return;
  }
  const receipt = await applying;
  assert.equal(await readFile(join(root, "planned.txt"), "utf8"), bytes);
  assert.equal(await readFile(join(root, "existing.txt"), "utf8"), bytes);
  assert.equal(receipt.planDigest, original.planDigest);
  assert.equal(receipt.outcome, "applied");
  assert.deepEqual(receipt.operations, [
    {
      path: "planned.txt",
      outcome: "created",
      resultDigest: original.operations.at(0)!.postimage.digest,
    },
  ]);
  const replay = await applyKnownFileTransaction({ consumerRoot: root, plan: original });
  assert.equal(replay.outcome, "already-satisfied");
  assert.equal(replay.planDigest, original.planDigest);
  assert.equal(replay.operations.at(0)!.path, "planned.txt");
  assert.equal((await inspectKnownFileTransactionBarrier({ consumerRoot: root })).state, "idle");
}
