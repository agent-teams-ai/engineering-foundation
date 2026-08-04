import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { cliPath, withSourceFixture } from "./support/capability-fixtures.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const comparatorPath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
  "binary-string-comparator.js"
);
const { compareBinaryStrings, compareBinaryStringSequences } = await import(
  pathToFileURL(comparatorPath).href
);

function environmentForLocale(language) {
  const environment = { ...process.env, LANG: language };
  delete environment.LC_ALL;
  delete environment.LC_COLLATE;
  return environment;
}

function checkInLocale(consumerRoot, language) {
  const result = spawnSync(
    process.execPath,
    [cliPath, "check", "--consumer", consumerRoot, "--format", "json"],
    {
      cwd: repositoryRoot,
      env: environmentForLocale(language)
    }
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, result.stderr.toString("utf8"));
  assert.deepEqual(result.stderr, Buffer.alloc(0));
  return result.stdout;
}

test("keeps canonically equivalent identifiers distinct in binary order", () => {
  const decomposed = "e\u0301";
  const composed = "\u00e9";

  assert.equal(decomposed.normalize("NFC"), composed);
  assert.notEqual(compareBinaryStrings(decomposed, composed), 0);
  assert.deepEqual(
    [composed, decomposed].toSorted(compareBinaryStrings),
    [decomposed, composed]
  );
  assert.notEqual(
    compareBinaryStringSequences(["a", "\0b"], ["a\0", "b"]),
    0
  );
});

test("emits byte-identical source diagnostics across LANG settings", async () => {
  await withSourceFixture(async (consumerRoot) => {
    await Promise.all([
      writeFile(
        join(consumerRoot, "packages", "app", "src", "domain", "zebra.ts"),
        "const = ;\n",
        "utf8"
      ),
      writeFile(
        join(consumerRoot, "packages", "app", "src", "domain", "\u00e4lg.ts"),
        "const = ;\n",
        "utf8"
      )
    ]);

    const outputs = ["C", "en_US.UTF-8", "sv_SE.UTF-8"].map((language) =>
      checkInLocale(consumerRoot, language)
    );

    for (const output of outputs.slice(1)) {
      assert.deepEqual(output, outputs[0]);
    }

    const report = JSON.parse(outputs[0].toString("utf8"));
    assert.deepEqual(
      report.capabilities[0].diagnostics.map((diagnostic) => diagnostic.location.path),
      [
        "packages/app/src/domain/zebra.ts",
        "packages/app/src/domain/\u00e4lg.ts"
      ]
    );
  });
});
