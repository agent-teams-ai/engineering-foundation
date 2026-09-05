import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";

test("portable declarations retain generic result contracts without managed root aliases", async () => {
  const [api, application, root, qualification, qualificationRuntime] = await Promise.all([
    readFile(new URL("../dist/features/docs-command/adapters/inbound/node-docs-api.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/features/portable-documentation/application/docs-protocol.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/qualification/index.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/features/qualification/application/runtime.d.ts", import.meta.url), "utf8")
  ]);
  assert.match(api, /docsNewV2: \(input: DocsNewRequest\) => Promise<DocsExecutionV2<DocsNewResultV2>>/u);
  assert.match(application, /newDocumentV2\(request: DocsNewRequest\): Promise<DocsOperationResult<DocsNewResultV2, "docs.new">>/u);
  assert.match(root, /\bDocsNewResult\b/u);
  assert.match(root, /\bDocsNewRequest\b/u);
  assert.match(root, /DocsNewResultV2/u);
  assert.match(qualification, /runDocsProtocolQualification/u);
  assert.match(qualificationRuntime, /export interface PortableQualificationProtocol/u);
  for (const method of ["checkV2", "doctorV2", "findV2", "infoV2", "newDocumentV2", "recoverV2"]) {
    assert.match(qualificationRuntime, new RegExp(`readonly ${method}: \\(input:`, "u"));
  }
  assert.doesNotMatch(qualificationRuntime, /Pick<DocsProtocol|typeof docs(?:Check|Doctor|Find|Info|New|Recover)V2/u);
  for (const source of [root, qualification]) {
    assert.doesNotMatch(source, /consumerIntegration|CANONICAL_DOCS_SKILL|QualifiedDocsCohort|runDocsProtocolQualificationV2/u);
  }
});


test("public request remains source-compatible and preview errors require result narrowing", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-public-types-"));
  try {
    const apiPath = fileURLToPath(new URL("../dist/index.js", import.meta.url)).replaceAll("\\", "/");
    await writeFile(join(root, "contract.mts"), `
import { docsNewV2, validatePortableRepositoryPath, validatePortableRepositoryPathV2 } from ${JSON.stringify(apiPath)};
import type { DocsJsonValueV2, DocsNewRequest, DocsProtocolProfileV3, DocsProtocolProfileV4, DocsReceiptOutcome } from ${JSON.stringify(apiPath)};
import type { DocumentJsonValue } from ${JSON.stringify(apiPath.replace(/index\.js$/u, "qualification/index.js"))};
declare const rootJson: DocsJsonValueV2;
declare const qualificationJson: DocumentJsonValue;
const sameRootJson: DocsJsonValueV2 = qualificationJson;
const sameQualificationJson: DocumentJsonValue = rootJson;
const receiptOutcome: DocsReceiptOutcome = "cancelled";
// @ts-expect-error portable receipt states remain closed
const unknownReceipt: DocsReceiptOutcome = "new-provider-state";
void [sameRootJson, sameQualificationJson, receiptOutcome, unknownReceipt];
declare const existingRequest: DocsNewRequest;
void docsNewV2({ ...existingRequest, apply: true });
void docsNewV2({ ...existingRequest, apply: true, expectedPlanDigest: "sha256:example" });
// @ts-expect-error digest values are strings at the public boundary
void docsNewV2({ ...existingRequest, expectedPlanDigest: 42 });
declare const oldProfile: DocsProtocolProfileV3;
const historicalIdentity: 3 = oldProfile.schemaVersion;
// @ts-expect-error v3 does not acquire a new serialized policy
oldProfile.relations;
const successor: DocsProtocolProfileV4 = { ...oldProfile, schemaVersion: 4, relations: { blockers: { types: ["task"], statuses: ["todo"], subjectIncompatibleStatuses: ["done"] } } };
// @ts-expect-error v4 cannot impersonate the v3 wire identity
const legacy: DocsProtocolProfileV3 = successor;
const execution = await docsNewV2(existingRequest);
// @ts-expect-error an empty invalid-input wire result has no required kind
const alwaysNew: { readonly kind: "new" } = execution.envelope.result;
// @ts-expect-error the empty result also makes direct discriminator access optional
const alwaysNewKind: "new" = execution.envelope.result.kind;
if (execution.envelope.result.writeState === "preview") {
  const content: string = execution.envelope.result.compiled.document.content;
  void content;
}
void [historicalIdentity, successor, validatePortableRepositoryPath("CON.yaml"), validatePortableRepositoryPathV2("docs.yaml")];
`);
    const compiler = fileURLToPath(new URL("../../../node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/bin/tsc", import.meta.url));
    const output = await promisify(execFile)(process.execPath, [compiler, "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--module", "nodenext", "--target", "es2024", join(root, "contract.mts")], { cwd: root });
    assert.equal(output.stdout, "");
    assert.equal(output.stderr, "");
  } finally {await rm(root, { recursive: true, force: true });}
});

function wireUnion(values) {
  return values.map((value) => JSON.stringify(value)).join(" | ");
}

test("outer envelopes preserve old generic contracts and match the published wire vocabulary", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-envelope-types-"));
  try {
    const apiPath = fileURLToPath(new URL("../dist/index.js", import.meta.url)).replaceAll("\\", "/");
    const cases = await Promise.all([2, 3].map(async (version) => {
      const schema = JSON.parse(await readFile(new URL(`../schemas/docs-protocol-portable-command-envelope/v${version}.schema.json`, import.meta.url), "utf8"));
      // Reproduce the pre-correction declarations using the unchanged public
      // operation vocabulary, independently of the new outer DTO definitions.
      return `
interface OldEnvelopeV${version}<Result = unknown> {
  readonly schemaVersion: ${version};
  readonly protocol: { readonly id: typeof DOCS_PROTOCOL_ID; readonly version: typeof DOCS_PROTOCOL_VERSION };
  readonly command: DocsCommandV${version};
  readonly outcome: DocsCommandOutcome;
  readonly diagnostics: readonly DocsDiagnostic[];
  readonly result: Result;
}
interface OldExecutionV${version}<Result> {
  readonly envelope: OldEnvelopeV${version}<Result>;
  readonly exitCode: 0 | 1 | 2 | 3 | 130;
}
function roundTripV${version}<Result>(old: OldExecutionV${version}<Result>, current: DocsExecutionV${version}<Result>) {
  const oldExecution: OldExecutionV${version}<Result> = current;
  const newExecution: DocsExecutionV${version}<Result> = old;
  const oldEnvelope: OldEnvelopeV${version}<Result> = current.envelope;
  const newEnvelope: DocsCommandEnvelopeV${version}<Result> = old.envelope;
  const result: Result = newEnvelope.result;
  return [oldExecution, newExecution, oldEnvelope, newEnvelope, result];
}
type EnvelopeV${version} = DocsCommandEnvelopeV${version}<{ count: number }>;
type SameShapeV${version} = Assert<Equal<EnvelopeV${version}, OldEnvelopeV${version}<{ count: number }>>>;
type SameDefaultV${version} = Assert<Equal<DocsCommandEnvelopeV${version}["result"], unknown>>;
type SameCommandsV${version} = Assert<Equal<EnvelopeV${version}["command"], ${wireUnion(schema.properties.command.enum)}>>;
type SameOutcomesV${version} = Assert<Equal<EnvelopeV${version}["outcome"], ${wireUnion(schema.properties.outcome.enum)}>>;
type SameProtocolV${version} = Assert<Equal<EnvelopeV${version}["protocol"], { readonly id: ${JSON.stringify(schema.$defs.protocol.properties.id.const)}; readonly version: ${schema.$defs.protocol.properties.version.const} }>>;
type SamePhasesV${version} = Assert<Equal<EnvelopeV${version}["diagnostics"][number]["phase"], ${wireUnion(schema.$defs.diagnostic.properties.phase.enum)}>>;
type SameSeveritiesV${version} = Assert<Equal<EnvelopeV${version}["diagnostics"][number]["severity"], ${wireUnion(schema.$defs.diagnostic.properties.severity.enum)}>>;
type SameExitCodesV${version} = Assert<Equal<DocsExecutionV${version}<never>["exitCode"], 0 | 1 | 2 | 3 | 130>>;
declare const envelopeV${version}: EnvelopeV${version};
declare const executionV${version}: DocsExecutionV${version}<{ count: number }>;
declare const diagnosticV${version}: EnvelopeV${version}["diagnostics"][number];
// The envelope is readonly; caller-owned Result retains its own mutability.
envelopeV${version}.result.count += 1;
${["schemaVersion", "protocol", "command", "outcome", "diagnostics", "result", "protocol.id", "protocol.version"].map((field) => `// @ts-expect-error envelope ${field} remains readonly\nenvelopeV${version}.${field} = envelopeV${version}.${field};`).join("\n")}
${["message", "phase", "ruleId", "severity", "subject"].map((field) => `// @ts-expect-error diagnostic ${field} remains readonly\ndiagnosticV${version}.${field} = diagnosticV${version}.${field};`).join("\n")}
// @ts-expect-error diagnostic arrays remain readonly
envelopeV${version}.diagnostics.push(diagnosticV${version});
// @ts-expect-error execution envelopes remain readonly
executionV${version}.envelope = envelopeV${version};
// @ts-expect-error execution exit codes remain readonly
executionV${version}.exitCode = 0;
// @ts-expect-error execution requires its generic parameter
type MissingResultV${version} = DocsExecutionV${version};
// @ts-expect-error an unknown default result requires narrowing
const defaultResultV${version}: { count: number } = ({} as DocsCommandEnvelopeV${version}).result;
${[
        ["schemaVersion", version === 2 ? "3" : "2"],
        ["protocol", '{ id: "wrong-protocol", version: 1 }'],
        ["protocol", '{ id: "agent-teams.docs-protocol", version: 2 }'],
        ["command", '"docs.unknown"'],
        ["outcome", '"unknown"'],
        ["result", '{ count: "wrong" }'],
        ...(version === 2 ? [["command", '"docs.context"'], ["command", '"docs.init"']] : []),
      ].map(([field, value], index) => `// @ts-expect-error invalid ${field} is rejected\nconst invalidV${version}_${index}: EnvelopeV${version} = { ...envelopeV${version}, ${field}: ${value} };`).join("\n")}
// @ts-expect-error unknown diagnostic phases are rejected
const phaseV${version}: EnvelopeV${version}["diagnostics"][number] = { ...diagnosticV${version}, phase: "transport" };
// @ts-expect-error unknown diagnostic severities are rejected
const severityV${version}: EnvelopeV${version}["diagnostics"][number] = { ...diagnosticV${version}, severity: "fatal" };
// @ts-expect-error exit codes remain a closed union
const exitV${version}: DocsExecutionV${version}<unknown> = { ...executionV${version}, exitCode: 4 };
declare const unionV${version}: DocsCommandEnvelopeV${version}<{ kind: "found"; value: string } | { kind: "empty" }>;
if (unionV${version}.result.kind === "found") {
  const value: string = unionV${version}.result.value;
} else {
  // @ts-expect-error result unions still require narrowing
  unionV${version}.result.value;
}
`;
    }));
    await writeFile(join(root, "contract.mts"), `
import { DOCS_PROTOCOL_ID, DOCS_PROTOCOL_VERSION } from ${JSON.stringify(apiPath)};
import type { DocsCommandEnvelopeV2, DocsCommandEnvelopeV3, DocsExecutionV2, DocsExecutionV3, DocsCommandV2, DocsCommandV3, DocsCommandOutcome, DocsDiagnostic } from ${JSON.stringify(apiPath)};
type Assert<Value extends true> = Value;
type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2) ? true : false;
${cases.join("\n")}
`);
    const compiler = fileURLToPath(new URL("../../../node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/bin/tsc", import.meta.url));
    const output = await promisify(execFile)(process.execPath, [compiler, "--ignoreConfig", "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--skipLibCheck", "--module", "nodenext", "--target", "es2024", join(root, "contract.mts")], { cwd: root });
    assert.equal(output.stdout, "");
    assert.equal(output.stderr, "");
  } finally {await rm(root, { recursive: true, force: true });}
});
