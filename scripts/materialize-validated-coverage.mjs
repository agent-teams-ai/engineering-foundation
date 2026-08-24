import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function materializeValidatedRawCoverage(validated, outputDirectory, faultInjector) {
  await faultInjector?.({ phase: "after-validation" });
  for (const { evidence, validatedFiles } of validated.artifacts) {
    for (const { bytes, name } of validatedFiles) {
      const record = evidence.rawFiles.find(({ path }) => basename(path) === name);
      if (record === undefined || record.sha256 !== digest(bytes) || record.size !== bytes.byteLength) {
        throw new Error(
          `Coverage evidence is invalid: shard ${evidence.shard.id} retained raw bytes differ from validated evidence`,
        );
      }
      await writeFile(join(outputDirectory, `${evidence.shard.id}-${name}`), bytes, { flag: "wx" });
    }
  }
}
