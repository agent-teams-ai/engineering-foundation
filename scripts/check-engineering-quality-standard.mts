import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const expected = Object.freeze({
  repository: "agent-teams-ai/.github",
  path: "docs/engineering-quality-standard.md",
  commit: "1a692c151d11fb9b917513a3a6875fdec6fc9ed3",
  blob: "bd4447f775697e7f96dac7599537e0fa2183eeb2",
  sha256: "f6bc3c93d9ce31ee48df2eeb423edd7d11374af56d9ea3c001a982e20fc07c22",
  size: 19951,
});

const cmsPrefix = 'docs/architecture/evidence/doctor-guidance-20261022/common-assembly';
const cmsExpected = Object.freeze({
  repository: 'agent-teams-ai/get-modular', path: 'docs/architecture/common-assembly.md',
  anchor: 'consumer-module-standard', commit: '7131d0d7a6bb5dd4c3e8906ccac065c0be0e0333',
  blob: 'dad8b6280cf999d9079d3106094e5626b63d83f4',
  sha256: 'a6dac5d303adf80be3151c6703c919b715fd880a941a4ad68e927c87a7ee5882',
  size: 81946,
});

const runtimeSeam = Object.freeze({
  currentPins: Object.freeze({
    'CMS guidance commit': cmsExpected.commit,
    'CMS guidance SHA-256': cmsExpected.sha256,
    'EQS guidance commit': expected.commit,
    'EQS guidance SHA-256': expected.sha256,
    'Workflow boundary': 'existing-static-adapter',
    'Workflow owner': 'engineering-foundation/repository-agent-workflow',
    'Workflow lifecycle': 'Host custody and cleanup; no Assembly or lifecycle-kernel adoption',
    'Doctor boundary': 'existing-static-adapter',
    'Doctor owner': 'stack-toolchain/toolchain-execution',
    'Doctor lifecycle': 'caller-owned process budget and cleanup; no Assembly adoption',
  }),
  tokens: Object.freeze([
    "Status: `not-adopted`; closed static selection only",
    "3dd68a6b26f42159714a4640b613534a55c2c6aa",
    "e5cb510c5ea83e54a6833cc40b6ad31fc5cf8c70d9838e4e0c6923edc6f70919",
    "7d6535dd86533566620040233290869825000d2b",
    "20c281b3137f5d3c198250e9f8101c0ecd4cbc75",
    "5287ef4ebae3dce19feb9378a9a0ac9267b30878",
    "81063add7de50ffe2b91cc74bf7271b298624c21",
    "f9f4c8ad381254fb07cba737d6443542348395c1",
    "66d6d3d2c2643edac414ded48c0ee0586774dd07",
    "uses lifecycle-kernel or introduces an Assembly node",
  ]),
  paths: Object.freeze([
    "packages/engineering-foundation/src/process-execution/application/runtime-selection.ts",
    "packages/engineering-foundation/src/capabilities/quality-gate-runner/composition/select-package-script-executor.ts",
    "packages/engineering-foundation/src/capabilities/quality-gate-runner/composition/node-quality-gate-command.ts",
    "packages/engineering-foundation/src/capabilities/repository-agent-workflow/composition/select-package-script-runner.ts",
    "packages/engineering-foundation/src/capabilities/repository-agent-workflow/composition/node-commands.ts",
    "packages/engineering-foundation/src/process-execution/node-process-runner.ts",
    "packages/engineering-foundation/src/process-execution/windows-command-launch.ts",
    "packages/engineering-foundation/src/process-execution/node-runtime-verifier.ts",
    "packages/engineering-foundation/src/capabilities/repository-agent-workflow/adapters/inbound/cli/check-changed-command.ts",
    "packages/engineering-foundation/src/capabilities/repository-agent-workflow/application/ports/check-changed.ts",
    "packages/engineering-foundation/src/capabilities/repository-agent-workflow/adapters/outbound/filesystem/mutable-check-input-custody.ts",
    "packages/engineering-foundation/src/capabilities/repository-agent-workflow/adapters/outbound/pnpm/mutable-pnpm-check-runner.ts",
    "packages/engineering-foundation/src/capabilities/repository-agent-workflow/adapters/outbound/pnpm/qualified-pnpm-check-runner.ts",
  ]),
});

async function checkRetainedPin(
  prefix: string,
  pin: Readonly<{ blob: string; sha256: string; size: number }>,
  label: "EQS" | "CMS",
  extension: ".md" | ".txt" = ".md",
): Promise<void> {
  const provenance: unknown = JSON.parse(await readFile(`${prefix}.provenance.json`, "utf8"));
  if (!isDeepStrictEqual(provenance, pin)) {
    throw new Error(`${label} provenance does not match the reviewed pin`);
  }
  const bytes = await readFile(`${prefix}${extension}`);
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (
    bytes.length !== pin.size ||
    blob !== pin.blob ||
    createHash("sha256").update(bytes).digest("hex") !== pin.sha256
  ) {
    throw new Error(`${label} retained bytes do not match the reviewed pin`);
  }
}

/** Retained upstream bytes are input evidence, never a consumer-owned policy. */
export async function checkEngineeringQualityStandard(root: string): Promise<void> {
  await checkRetainedPin(resolve(root, "standards/engineering-quality-standard"), expected, "EQS");
  await checkRetainedPin(resolve(root, cmsPrefix), cmsExpected, "CMS", ".txt");
  const eqsDelta = await readFile(
    resolve(
      root,
      "docs/architecture/evidence/toolchain-guidance-20261021/engineering-quality-standard.diff",
    ),
  );
  if (
    createHash("sha256").update(eqsDelta).digest("hex") !==
    "962ad4ab851e6d5ebfd782c8887cd5f3dc65f33d866eba7da4e888f4cb524bad"
  ) {
    throw new Error("EQS retained delta does not match the reviewed input");
  }
  const currentEqsDelta = await readFile(
    resolve(root, "docs/architecture/evidence/f3-guidance-20261023/engineering-quality-standard.diff"),
  );
  if (createHash("sha256").update(currentEqsDelta).digest("hex") !==
      "0e6c05f963f2c65a2e04b85fc1075b835cd247d7d7dca497e4721f211f9a533d") {
    throw new Error("EQS current retained delta does not match the reviewed input");
  }
  const delta = await readFile(resolve(root, `${cmsPrefix}.diff`));
  if (createHash('sha256').update(delta).digest('hex') !==
      '1caa65055dcde91309e2317d70faf339cd82b2ba42f16a8902bc3025cf4f1bf3') {
    throw new Error('CMS retained delta does not match the reviewed input');
  }
  const seam = await readFile(
    resolve(root, "docs/architecture/runtime-profile-static-seam.md"),
    "utf8",
  );
  for (const [label, pin] of Object.entries(runtimeSeam.currentPins)) {
    const records = seam.split(/\r?\n/u).filter((line) => line.startsWith(`${label}:`));
    if (records.length !== 1 || records[0] !== `${label}: \`${pin}\``) {
      throw new Error(
        `Runtime profile seam current guidance does not match the reviewed pin: ${label}`,
      );
    }
  }
  if (runtimeSeam.tokens.some((token) => !seam.includes(token))) {
    throw new Error(
      "Runtime profile seam does not retain the reviewed current and historical guidance records",
    );
  }
  for (const path of runtimeSeam.paths) {
    const isFile = await stat(resolve(root, path)).then(
      (info) => info.isFile(),
      () => false,
    );
    if (!seam.includes(path) || !isFile) {
      throw new Error(`Runtime profile seam path is missing or unclassified: ${path}`);
    }
  }
}

const entry = process.argv.at(1);
const invoked = entry === undefined ? undefined : pathToFileURL(resolve(entry)).href;
if (invoked === import.meta.url) {
  await checkEngineeringQualityStandard(fileURLToPath(new URL("../", import.meta.url)));
  process.stdout.write(
    "Retained EQS/CMS inputs and reviewed runtime seam guidance pins verified.\n",
  );
}
