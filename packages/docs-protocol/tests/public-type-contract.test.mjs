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
    readFile(new URL("../dist/features/qualification/adapters/qualification-runtime.d.ts", import.meta.url), "utf8")
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
    const output = await promisify(execFile)(process.execPath, [compiler, "--noEmit", "--strict", "--skipLibCheck", "--module", "nodenext", "--target", "es2024", join(root, "contract.mts")], { cwd: root });
    assert.equal(output.stdout, "");
    assert.equal(output.stderr, "");
  } finally {await rm(root, { recursive: true, force: true });}
});
