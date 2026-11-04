import assert from "node:assert/strict";
import { link, mkdtemp, realpath, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { inspectRetiredTemporaryDuplicates } from "../../../packages/repository-mutation/dist/node.js";
import {
  createQualityInputWitness,
  QUALITY_INPUT_LIMITS,
} from "../../../packages/engineering-foundation/dist/features/quality-coverage/adapters/quality-input-witness.js";

export function registerQualityInputBudgetCases(): void {
  void test(
    "provisional reservations do not reject valid inventories near the unique-byte limit",
    preservesValidNearLimitInventories,
  );
  void test(
    "retirement inspection preserves identity authority while obeying caller budget",
    retirementKeepsIdentityAndCallerBudget,
  );
  void test(
    "provisional cumulative reservations retain valid final concurrent reads",
    preservesCumulativeRemainder,
  );
}

async function preservesCumulativeRemainder(): Promise<void> {
  const block = new Uint8Array(QUALITY_INPUT_LIMITS.fileBytes);
  const single = new Uint8Array(1);
  const witness = createQualityInputWitness("/consumer", async ({ candidate, maxBytes }) => {
    const bytes = candidate.endsWith("bulk") ? block : single;
    assert.ok(bytes.byteLength <= maxBytes);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    return bytes;
  });
  for (let index = 0; index < 127; index += 1) {
    await witness.readToolFile({
      root: "/consumer",
      candidate: "/consumer/bulk",
      maxBytes: block.byteLength,
    });
  }
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      witness.readToolFile({
        root: "/consumer",
        candidate: `/consumer/${index}`,
        maxBytes: block.byteLength,
      }),
    ),
  );
}

async function preservesValidNearLimitInventories(): Promise<void> {
  const large = new Uint8Array(15 * 1024 * 1024);
  const small = new Uint8Array(1);
  const paths = Array.from({ length: 40 }, (_, i) => `${i}.ts`);
  const witness = createQualityInputWitness("/consumer", async ({ candidate, maxBytes }) => {
    const index = Number(basename(candidate).split(".")[0]);
    const bytes = index < 33 ? large : small;
    assert.ok(bytes.byteLength <= maxBytes);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    return bytes;
  });
  await witness.capture({
    async read() {
      return { filePaths: paths, sourcePaths: [], manifestPaths: [] };
    },
  });
  await witness.verify();
  await witness.verify();
}

async function retirementKeepsIdentityAndCallerBudget(): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "quality-retired-budget-")));
  try {
    const marker = `.foundation-retired-evidence-/${randomUUID()}/owned-temporary`;
    await mkdir(join(root, marker, ".."), { recursive: true });
    await writeFile(join(root, "source.ts"), "export const value = 1;\n");
    await link(join(root, "source.ts"), join(root, marker));
    const paths = ["source.ts", marker];
    assert.deepEqual(await inspectRetiredTemporaryDuplicates(root, paths), [
      { path: marker, counterpart: "source.ts" },
    ]);
    let granted = 0;
    let observed = 0;
    let checkpoints = 0;
    const budget = {
      beforeRead(maximum: number) {
        assert.equal(maximum, 2 * 1024 * 1024);
        if (++granted > 1) {
          throw new Error("caller budget exhausted");
        }
        return maximum;
      },
      afterRead(bytes: number) {
        observed += bytes;
      },
      checkpoint() {
        checkpoints += 1;
      },
    };
    await assert.rejects(
      inspectRetiredTemporaryDuplicates(root, paths, budget),
      /caller budget exhausted/u,
    );
    assert.equal(observed, Buffer.byteLength("export const value = 1;\n"));
    assert.ok(checkpoints > 1);
    await assert.rejects(
      inspectRetiredTemporaryDuplicates(root, paths, {
        ...budget,
        beforeRead: () => QUALITY_INPUT_LIMITS.fileBytes,
      }),
      /cannot widen/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
