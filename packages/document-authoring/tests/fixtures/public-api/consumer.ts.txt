import {
  applyDocumentationPlan,
  applyDocumentationPlanV2,
  planDocumentationDocument,
  planDocumentationDocumentV2,
  recoverDocumentationTransaction,
  recoverDocumentationTransactionV2,
  type ApplyDocumentPlanRequest,
  type DocumentPlan,
  type DocumentPlanContract,
  type DocumentPlanV1,
  type DocumentPlanV2,
  type DocumentReceipt,
  type DocumentReceiptContract,
  type DocumentReceiptV1,
  type DocumentReceiptV2,
  type PlanDocumentationDocumentRequest,
  type PlanDocumentationDocumentRequestContract,
  type PlanDocumentationDocumentRequestV2,
  type RecoverDocumentTransactionRequest
} from "@agent-teams/document-authoring";

declare const v1Request: PlanDocumentationDocumentRequest;
declare const genericRequest: PlanDocumentationDocumentRequestContract;
declare const v2Request: PlanDocumentationDocumentRequestV2;
declare const unknownPlan: unknown;
declare const v1Plan: DocumentPlan;
declare const v1Receipt: DocumentReceipt;
declare const applyRequest: ApplyDocumentPlanRequest;
declare const recoveryRequest: RecoverDocumentTransactionRequest;

// Leave results inferred: annotating them with the expected union can conceal
// an incorrectly narrow public signature.
const genericV1Plan = await planDocumentationDocument(v1Request);
const genericPlan = await planDocumentationDocument(genericRequest);
const genericV2Plan = await planDocumentationDocument(v2Request);
const literalV2Plan = await planDocumentationDocument({
  consumerRoot: ".",
  profilePath: "document-authoring.yaml",
  intent: {},
  parentPolicy: "create-missing-real-directories"
});
const literalV1Plan = await planDocumentationDocument({
  consumerRoot: ".", profilePath: "document-authoring.yaml", intent: {}
});
const explicitV2Plan = await planDocumentationDocumentV2(v2Request);
explicitV2Plan satisfies DocumentPlanV2;
const explicitV2Receipt = await applyDocumentationPlanV2({
  consumerRoot: ".", plan: explicitV2Plan
});
explicitV2Receipt satisfies DocumentReceiptV2;

const unknownReceipt = await applyDocumentationPlan({ consumerRoot: ".", plan: unknownPlan });
const genericReceipt = await applyDocumentationPlan(applyRequest);
const v1ReceiptResult = await applyDocumentationPlan({ consumerRoot: ".", plan: v1Plan });
const v2ReceiptResult = await applyDocumentationPlan({ consumerRoot: ".", plan: explicitV2Plan });
const unionReceipt = await applyDocumentationPlan({ consumerRoot: ".", plan: genericPlan });
const recovered = await recoverDocumentationTransaction(recoveryRequest);
const recoveredV2Name = await recoverDocumentationTransactionV2(recoveryRequest);

// Both versions must be assignable to each declared generic return, including
// recovery: its name supplies no discriminant for the persisted transaction.
const planResults: (typeof genericPlan)[] = [v1Plan, explicitV2Plan];
const receiptResults: (typeof genericReceipt)[] = [v1Receipt, explicitV2Receipt];
const recoveryResults: (typeof recovered)[] = [v1Receipt, explicitV2Receipt];
const recoveryV2Results: (typeof recoveredV2Name)[] = [v1Receipt, explicitV2Receipt];

function narrowPlan(plan: DocumentPlanContract): void {
  if (plan.schemaVersion === 1) {
    plan satisfies DocumentPlan;
    plan.protocolVersion satisfies 1;
    plan.requiredAdapterCapabilities satisfies readonly ["create-file-no-replace/v1"];
    // @ts-expect-error v1 Plans do not declare directory materialization.
    void plan.parentMaterialization;
  } else {
    plan satisfies DocumentPlanV2;
    plan.protocolVersion satisfies 2;
    plan.parentMaterialization.policy satisfies "create-missing-real-directories";
  }
}

function narrowReceipt(receipt: DocumentReceiptContract): void {
  if (receipt.schemaVersion === 1) {
    receipt satisfies DocumentReceipt;
    receipt.protocolVersion satisfies 1;
    void receipt.commit.atomicity;
    // @ts-expect-error v1 Receipts do not declare fileAtomicity.
    void receipt.commit.fileAtomicity;
    // @ts-expect-error v1 Receipts do not declare directory materialization.
    void receipt.directoryMaterialization;
  } else {
    receipt satisfies DocumentReceiptV2;
    receipt.protocolVersion satisfies 2;
    void receipt.commit.fileAtomicity;
    void receipt.directoryMaterialization;
    // @ts-expect-error v2 Receipts do not declare atomicity.
    void receipt.commit.atomicity;
  }
}

for (const plan of [genericV1Plan, genericPlan, genericV2Plan, literalV1Plan, literalV2Plan]) {
  narrowPlan(plan);
}
for (const receipt of [unknownReceipt, genericReceipt, v1ReceiptResult, v2ReceiptResult,
  unionReceipt, recovered, recoveredV2Name]) {
  narrowReceipt(receipt);
}

// Generic callers must narrow the actual result before v1-specific access.
// @ts-expect-error A generic Plan is not guaranteed to be v1.
genericPlan satisfies DocumentPlan;
// @ts-expect-error A generic Receipt is not guaranteed to be v1.
genericReceipt satisfies DocumentReceipt;
// @ts-expect-error A recovered Receipt is not guaranteed to be v1.
recovered satisfies DocumentReceipt;
// @ts-expect-error Unnarrowed generic apply cannot access atomicity.
void unknownReceipt.commit.atomicity;
// @ts-expect-error Unnarrowed generic recovery cannot access atomicity.
void recovered.commit.atomicity;
// @ts-expect-error Even the explicit V2 recovery name can recover v1.
void recoveredV2Name.commit.fileAtomicity;

// Narrow an inferred return directly, through the other version discriminant.
if (recovered.protocolVersion === 1) {
  recovered.schemaVersion satisfies 1;
  recovered.commit.atomicity satisfies "single-file-atomic-create" | "not-applicable";
} else {
  recovered.schemaVersion satisfies 2;
  recovered.commit.fileAtomicity satisfies "single-file-atomic-create" | "not-applicable";
}
// @ts-expect-error An unnarrowed generic result also cannot access v2 fields.
void genericReceipt.commit.fileAtomicity;

v1Plan satisfies DocumentPlanV1;
v1Receipt satisfies DocumentReceiptV1;
v1Plan.schemaVersion satisfies 1;
v1Receipt.protocolVersion satisfies 1;
// @ts-expect-error The existing DocumentPlan alias remains v1 only.
explicitV2Plan satisfies DocumentPlan;
// @ts-expect-error The existing DocumentReceipt alias remains v1 only.
explicitV2Receipt satisfies DocumentReceipt;
// @ts-expect-error Explicit V2 planning still requires parentPolicy.
await planDocumentationDocumentV2(v1Request);
// @ts-expect-error Explicit V2 apply does not admit unknown input.
await applyDocumentationPlanV2({ consumerRoot: ".", plan: unknownPlan });
// @ts-expect-error Explicit V2 apply does not admit v1.
await applyDocumentationPlanV2({ consumerRoot: ".", plan: v1Plan });
// @ts-expect-error The generic API does not widen the closed parent policy.
await planDocumentationDocument({ ...v1Request, parentPolicy: "replace-directories" });

void [planResults, receiptResults, recoveryResults, recoveryV2Results];
