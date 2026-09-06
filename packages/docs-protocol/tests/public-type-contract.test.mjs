import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("public diagnostics retain named-interface and declaration-merging semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-diagnostic-types-"));
  try {
    const scope = join(root, "node_modules", "@agent-teams");
    await mkdir(scope, { recursive: true });
    await symlink(fileURLToPath(new URL("../", import.meta.url)), join(scope, "docs-protocol"), "junction");
    const fixtures = {
      "conditional-record": `
import type { DocsCommandEnvelopeV2, DocsCommandEnvelopeV3, DocsDiagnostic } from "@agent-teams/docs-protocol";
type Classification<T> = T extends Record<string, unknown> ? "record" : "diagnostic";
const standalone: Classification<DocsDiagnostic> = "diagnostic";
const v2: Classification<DocsCommandEnvelopeV2["diagnostics"][number]> = "diagnostic";
const v3: Classification<DocsCommandEnvelopeV3["diagnostics"][number]> = "diagnostic";
declare const diagnostic: DocsDiagnostic;
declare const envelopeV2: DocsCommandEnvelopeV2;
declare const envelopeV3: DocsCommandEnvelopeV3;
${["diagnostic", "envelopeV2.diagnostics[0]!", "envelopeV3.diagnostics[0]!"].map((value, index) => `// @ts-expect-error named diagnostics have no implicit dictionary index signature
const record${index}: Record<string, unknown> = ${value};`).join("\n")}
// @ts-expect-error arbitrary properties remain unavailable
diagnostic["arbitrary"];
${["message", "phase", "ruleId", "severity", "subject"].map((field) => `// @ts-expect-error standalone diagnostic ${field} remains readonly
diagnostic.${field} = diagnostic.${field};`).join("\n")}
void [standalone, v2, v3];
`,
      "declaration-merging": `
import type { DocsCommandEnvelopeV2, DocsCommandEnvelopeV3, DocsDiagnostic,
  docsCheckV2, docsContextV1, docsDoctorV2, docsFindV2, docsFindV3, docsInfoV2, docsNewV2, docsRecoverV2
} from "@agent-teams/docs-protocol";
declare module "@agent-teams/docs-protocol" {
  interface DocsDiagnostic { readonly fixtureTag: "diagnostic"; }
}
declare const standalone: DocsDiagnostic;
const tag: "diagnostic" = standalone.fixtureTag;
${["DocsCommandEnvelopeV2", "DocsCommandEnvelopeV3",
        ...["docsCheckV2", "docsContextV1", "docsDoctorV2", "docsFindV2", "docsFindV3", "docsInfoV2", "docsNewV2", "docsRecoverV2"].map((name) => `Awaited<ReturnType<typeof ${name}>>["envelope"]`)
      ].map((envelope, index) => `declare const diagnostic${index}: ${envelope}["diagnostics"][number];
const tag${index}: "diagnostic" = diagnostic${index}.fixtureTag;
const same${index}: DocsDiagnostic = diagnostic${index};`).join("\n")}
// @ts-expect-error merged fields retain their declared readonly modifier
standalone.fixtureTag = "diagnostic";
`
    };
    const compiler = fileURLToPath(new URL("../../../node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/bin/tsc", import.meta.url));
    for (const [name, source] of Object.entries(fixtures)) {
      const fixturePath = join(root, `${name}.mts`);
      await writeFile(fixturePath, source);
      // Compile separately so augmentation cannot influence the Record probe.
      const output = await promisify(execFile)(process.execPath, [compiler, "--ignoreConfig", "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--skipLibCheck", "--module", "nodenext", "--target", "es2024", fixturePath], { cwd: root });
      assert.equal(output.stdout, "");
      assert.equal(output.stderr, "");
    }
  } finally {await rm(root, { recursive: true, force: true });}
});

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


test("bounded release callers distinguish honest results from structural spellings", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-release-callers-"));
  try {
    const apiPath = fileURLToPath(new URL("../dist/index.js", import.meta.url)).replaceAll("\\", "/");
    const authoringPath = fileURLToPath(new URL("../../document-authoring/dist/index.js", import.meta.url)).replaceAll("\\", "/");
    await writeFile(join(root, "contract.mts"), `
import type { DocsNewResultV2, DocsNewRequest, DocsExecutionV2, DocsFindDocument, DocsReceiptOutcome } from ${JSON.stringify(apiPath)};
import type { docsRecoverV2 } from ${JSON.stringify(apiPath)};
import type { PortableQualificationProtocol, interruptAndRecover } from ${JSON.stringify(apiPath.replace(/index\.js$/u, "qualification/index.js"))};
import type { DocumentIntent, DocumentDescriptor, DocumentMetadataObject, DocumentReceiptContract } from ${JSON.stringify(authoringPath)};
// The released new result had only branches with a required kind.
type OldNewResult = Exclude<DocsNewResultV2, { readonly kind?: never }>;
declare const oldNew: OldNewResult;
const oldCaller: "new" = oldNew.kind;
const acceptsOldResult: DocsNewResultV2 = oldNew;
declare const currentNew: DocsNewResultV2;
// @ts-expect-error the actual invalid-input empty result breaks the old caller
const currentCaller: "new" = currentNew.kind;
type OldQualificationResult = { readonly envelope: { readonly result: { readonly kind: "new" } }; readonly exitCode: 0 | 1 | 2 | 3 | 130 };
declare const oldQualification: OldQualificationResult;
const oldQualificationCaller: "new" = oldQualification.envelope.result.kind;
declare const currentQualification: Awaited<ReturnType<PortableQualificationProtocol["newDocumentV2"]>>;
// @ts-expect-error qualification must represent empty invalid-input results too
const qualificationCaller: OldQualificationResult = currentQualification;
const qualificationProducer: typeof currentQualification = oldQualification;
type OldProtocol = Omit<PortableQualificationProtocol, "newDocumentV2"> & { readonly newDocumentV2: (input: DocsNewRequest) => Promise<OldQualificationResult> };
type CurrentInterrupt = typeof interruptAndRecover;
type OldInterrupt = (input: Omit<Parameters<CurrentInterrupt>[0], "protocol"> & { readonly protocol: OldProtocol }) => ReturnType<CurrentInterrupt>;
declare const oldInterrupt: OldInterrupt;
declare const currentInterrupt: CurrentInterrupt;
const acceptsOldInterruptCaller: OldInterrupt = currentInterrupt;
// @ts-expect-error the old implementation cannot accept a protocol returning an empty result
const oldInterruptImplementation: CurrentInterrupt = oldInterrupt;

// These dependencies retain their released structural shapes.
declare const intent: Omit<DocumentIntent, "schemaVersion" | "related" | "additionalMetadata">;
declare const currentIntent: DocsNewRequest["intent"];
const oldIntent: typeof intent = currentIntent;
const newIntent: typeof currentIntent = intent;
declare const metadata: DocumentMetadataObject;
declare const currentMetadata: DocsFindDocument["metadata"];
const oldMetadata: typeof metadata = currentMetadata;
const newMetadata: typeof currentMetadata = metadata;
declare const outcome: DocumentReceiptContract["outcome"];
declare const currentOutcome: DocsReceiptOutcome;
const oldOutcome: typeof outcome = currentOutcome;
const newOutcome: typeof currentOutcome = outcome;
// Moving the result union inside the generic preserves ordinary result reads,
// but does not distribute an envelope into the old union of envelopes.
type CurrentRecovery = Awaited<ReturnType<typeof docsRecoverV2>>;
type Distribute<Result> = Result extends unknown ? DocsExecutionV2<Result> : never;
type OldRecovery = Distribute<CurrentRecovery["envelope"]["result"]>;
declare const oldRecovery: OldRecovery;
declare const currentRecovery: CurrentRecovery;
const newRecovery: CurrentRecovery = oldRecovery;
const result: OldRecovery["envelope"]["result"] = currentRecovery.envelope.result;
// @ts-expect-error a caller accepting the released outer union needs adaptation
const oldRecoveryCaller: OldRecovery = currentRecovery;
// Flattened DTO fields retain ordinary DocumentDescriptor compatibility.
declare const document: DocsFindDocument;
const descriptor: DocumentDescriptor = document;
void [oldCaller, acceptsOldResult, currentCaller, oldQualificationCaller, qualificationCaller, qualificationProducer,
 oldIntent, newIntent, oldMetadata, newMetadata, oldOutcome, newOutcome, newRecovery, result, oldRecoveryCaller, descriptor];
`);
    const compiler = fileURLToPath(new URL("../../../node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/bin/tsc", import.meta.url));
    const output = await promisify(execFile)(process.execPath, [compiler, "--ignoreConfig", "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--skipLibCheck", "--module", "nodenext", "--target", "es2024", join(root, "contract.mts")], { cwd: root });
    assert.equal(output.stdout, "");
    assert.equal(output.stderr, "");
    // An upstream interface augmentation was inherited before DTO separation.
    await writeFile(join(root, "augmentation.mts"), `
import type { DocsFindDocument, DocsNewRequest } from ${JSON.stringify(apiPath)};
import type { DocumentDescriptor, DocumentIntent, DocumentMetadataObject } from ${JSON.stringify(authoringPath)};
declare module ${JSON.stringify(authoringPath)} {
  interface DocumentDescriptor { readonly releaseCallerTag: "retained"; }
  interface DocumentIntent { readonly releaseIntentTag: "retained"; }
  interface DocumentMetadataObject { readonly releaseMetadataTag: "retained"; }
}
interface ReleasedFindDocument extends DocumentDescriptor {}
declare const before: ReleasedFindDocument;
const beforeCaller: "retained" = before.releaseCallerTag;
declare const after: DocsFindDocument;
// @ts-expect-error portable DTOs no longer inherit upstream augmentation
const afterCaller: "retained" = after.releaseCallerTag;
type ReleasedIntent = Omit<DocumentIntent, "schemaVersion" | "related" | "additionalMetadata">;
declare const baseIntent: DocsNewRequest["intent"];
const beforeIntent: ReleasedIntent = { ...baseIntent, releaseIntentTag: "retained" };
// @ts-expect-error the projected request no longer includes upstream augmentation
const afterIntent: DocsNewRequest["intent"] = { ...baseIntent, releaseIntentTag: "retained" };
declare const beforeMetadata: DocumentMetadataObject;
const beforeMetadataCaller: "retained" = beforeMetadata.releaseMetadataTag;
// @ts-expect-error the independent dictionary cannot promise the upstream augmented field
const afterMetadataCaller: "retained" = after.metadata.releaseMetadataTag;
void [beforeCaller, afterCaller, beforeIntent, afterIntent, beforeMetadataCaller, afterMetadataCaller];
`);
    const augmentation = await promisify(execFile)(process.execPath, [compiler, "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--module", "nodenext", "--target", "es2024", join(root, "augmentation.mts")], { cwd: root });
    assert.equal(augmentation.stdout, "");
    assert.equal(augmentation.stderr, "");
  } finally {await rm(root, { recursive: true, force: true });}
});
