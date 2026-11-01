import { applyEdits, modify } from "jsonc-parser";
import type { QualifiedDocsCohortBindingV2, ManagedSuccessorProfile } from "../domain/model.js";
import { assertConsumerIntegrationProfileSchema } from "./consumer-integration-schema-validator.js";
import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import { parseJsonRecord } from "./strict-json-record.js";

const managedPnpmVersion = "11.20.0";

function decode(bytes: Uint8Array, subject: string): string {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (source.startsWith("\uFEFF") || source.includes("\u0000")) {
    throw new TypeError(`${subject} contains a BOM or NUL byte.`);
  }
  return source;
}
function formatting(source: string) {
  const indent = source.match(/\n([\t ]+)"/u)?.[1] ?? "  ";
  return {
    eol: source.includes("\r\n") ? "\r\n" : "\n",
    insertSpaces: !indent.includes("\t"),
    tabSize: indent.includes("\t") ? 1 : indent.length,
  };
}

/** The finite managed generation transition changes only schema and the exact Cohort binding. */
export async function projectManagedGenerationProfile(input: {
  readonly bytes: Uint8Array;
  readonly cohort: QualifiedDocsCohortBindingV2 | ManagedSuccessorProfile["cohort"];
}): Promise<Uint8Array> {
  let source = decode(input.bytes, "Consumer integration profile");
  const profile = parseJsonRecord(source);
  await assertConsumerIntegrationProfileSchema(profile);
  if (profile["schemaVersion"] !== 3 && profile["schemaVersion"] !== 4) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_GENERATION_MISMATCH",
      "Managed generation transition requires profile3 or profile4.",
    );
  }
  for (const [path, value] of [
    [["schemaVersion"], input.cohort.schemaVersion === 3 ? 4 : 3],
    [["cohort"], input.cohort],
  ] as const) {
    source = applyEdits(
      source,
      modify(source, [...path], value, { formattingOptions: formatting(source) }),
    );
  }
  await assertConsumerIntegrationProfileSchema(parseJsonRecord(source));
  return Buffer.from(source, "utf8");
}

/** The managed transition owns these exact runtime fields; every other manifest field is retained. */
export function projectManagedGenerationRuntime(bytes: Uint8Array, node: string): Uint8Array {
  let source = decode(bytes, "package.json");
  const manifest = parseJsonRecord(source);
  if (
    typeof manifest["packageManager"] !== "string" ||
    !/^pnpm@11\.[0-9]+\.[0-9]+(?:\+sha512\.[A-Za-z0-9+/=]+)?$/u.test(manifest["packageManager"])
  ) {
    throw new TypeError("Managed generation transition requires the exact existing pnpm manager.");
  }
  const engines = manifest["engines"];
  for (const [path, value] of [
    [["packageManager"], `pnpm@${managedPnpmVersion}`],
    ...(typeof engines === "object" && engines !== null && Object.hasOwn(engines, "pnpm")
      ? [[["engines", "pnpm"], managedPnpmVersion] as const]
      : []),
    [["engines", "node"], node],
  ] as const) {
    source = applyEdits(
      source,
      modify(source, [...path], value, { formattingOptions: formatting(source) }),
    );
  }
  return Buffer.from(source, "utf8");
}
