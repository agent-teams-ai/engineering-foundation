import type { FoundationDiagnostic } from "../../../../check-contract.js";
import type {
  ConsumerGateBinding,
  ExecutableSpecification,
  ExecutableSpecificationCatalog,
  ExecutableSpecificationObservation
} from "../model/executable-specification.js";
import {
  EXECUTABLE_SPECIFICATION_RULES,
  type ExecutableSpecificationRuleMetadata
} from "../rules.js";

function diagnostic(input: {
  readonly rule: ExecutableSpecificationRuleMetadata;
  readonly subject: string;
  readonly path: string;
  readonly message: string;
  readonly evidence?: readonly { readonly kind: string; readonly value: string }[];
}): FoundationDiagnostic {
  return {
    ruleId: input.rule.id,
    severity: input.rule.severity,
    subject: input.subject,
    message: input.message,
    location: { path: input.path },
    relatedLocations: [],
    evidence: input.evidence ?? [],
    remediation: input.rule.remediation,
    requiresArchitectureReview: input.rule.requiresArchitectureReview
  };
}

function duplicateValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].toSorted();
}

function gateKey(binding: ConsumerGateBinding): string {
  return `${binding.packageName}\u0000${binding.script}`;
}

function specificationGates(
  specification: ExecutableSpecification
): readonly (readonly [string, ConsumerGateBinding])[] {
  return [
    ["typeGeneration", specification.gateBindings.typeGeneration],
    ["property", specification.gateBindings.property],
    ["mutation", specification.gateBindings.mutation],
    ...(specification.stateModel.kind === "xstate"
      ? ([["spec-model", specification.stateModel.gateBinding]] as const)
      : [])
  ];
}

function generatedAndModelPaths(specification: ExecutableSpecification): readonly string[] {
  return [
    ...specification.generatedTypes.map((binding) => binding.outputPath),
    ...(specification.stateModel.kind === "xstate"
      ? [
          specification.stateModel.modelPath,
          specification.stateModel.adapterPath,
          specification.stateModel.tracesPath,
          specification.stateModel.diagramPath
        ]
      : [])
  ];
}

function evaluateBindings(
  specification: ExecutableSpecification,
  observation: ExecutableSpecificationObservation
): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const schemaIds = new Set(observation.jsonSchemas.schemaIds);
  for (const document of specification.documents) {
    if (!schemaIds.has(document.schemaId)) {
      diagnostics.push(
        diagnostic({
          rule: EXECUTABLE_SPECIFICATION_RULES.schemaBindingUnknown,
          subject: `${specification.id}:document:${document.path}`,
          path: document.path,
          message: `Document binds an unknown local schema ID: ${document.schemaId}.`
        })
      );
    }
  }
  for (const binding of specification.generatedTypes) {
    if (!schemaIds.has(binding.schemaId)) {
      diagnostics.push(
        diagnostic({
          rule: EXECUTABLE_SPECIFICATION_RULES.schemaBindingUnknown,
          subject: `${specification.id}:generated-type:${binding.outputPath}`,
          path: binding.outputPath,
          message: `Generated type binds an unknown local schema ID: ${binding.schemaId}.`
        })
      );
    }
  }
  for (const schemaId of duplicateValues(
    specification.generatedTypes.map((binding) => binding.schemaId)
  )) {
    diagnostics.push(
      diagnostic({
        rule: EXECUTABLE_SPECIFICATION_RULES.generatedTypeBindingDuplicate,
        subject: `${specification.id}:schema:${schemaId}`,
        path: specification.documents[0]?.path ?? observation.id,
        message: `Schema ID has more than one generated type binding: ${schemaId}.`
      })
    );
  }
  for (const outputPath of duplicateValues(
    specification.generatedTypes.map((binding) => binding.outputPath)
  )) {
    diagnostics.push(
      diagnostic({
        rule: EXECUTABLE_SPECIFICATION_RULES.generatedTypeBindingDuplicate,
        subject: `${specification.id}:output:${outputPath}`,
        path: outputPath,
        message: `Generated type output path is bound more than once: ${outputPath}.`
      })
    );
  }
  return diagnostics;
}

function evaluateGates(
  specification: ExecutableSpecification,
  observation: ExecutableSpecificationObservation
): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const gates = specificationGates(specification);
  for (const duplicate of duplicateValues(gates.map(([, binding]) => gateKey(binding)))) {
    const [packageName = "", script = ""] = duplicate.split("\u0000");
    diagnostics.push(
      diagnostic({
        rule: EXECUTABLE_SPECIFICATION_RULES.gateNotDistinct,
        subject: `${specification.id}:gate:${packageName}:${script}`,
        path: observation.id,
        message: `Gate script is reused by more than one evidence role: ${packageName}#${script}.`
      })
    );
  }
  for (const [role] of gates) {
    const observed = observation.gates[role];
    if (observed === undefined || !observed.packageExists || !observed.scriptExists) {
      diagnostics.push(
        diagnostic({
          rule: EXECUTABLE_SPECIFICATION_RULES.gateMissing,
          subject: `${specification.id}:gate:${role}`,
          path: observed?.manifestPath ?? observation.id,
          message:
            observed?.packageExists === true
              ? `Gate ${role} binds a missing package script: ${observed.packageName}#${observed.script}.`
              : `Gate ${role} binds a missing workspace package: ${observed?.packageName ?? "unknown"}.`
        })
      );
    }
  }
  return diagnostics;
}

function evaluateSpecification(
  specification: ExecutableSpecification,
  observation: ExecutableSpecificationObservation
): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  for (const path of observation.missingArtifactPaths) {
    diagnostics.push(
      diagnostic({
        rule: EXECUTABLE_SPECIFICATION_RULES.artifactMissing,
        subject: `${specification.id}:artifact:${path}`,
        path,
        message: `Declared executable specification artifact is missing: ${path}.`,
        evidence: [{ kind: "artifact-corpus-digest", value: observation.artifactDigest }]
      })
    );
  }
  for (const result of observation.jsonSchemas.fixtureResults) {
    if (!result.matched) {
      const document = specification.documents[Number(result.id.split(".").at(-1))];
      diagnostics.push(
        diagnostic({
          rule: EXECUTABLE_SPECIFICATION_RULES.documentInvalid,
          subject: `${specification.id}:document:${document?.path ?? result.id}`,
          path: document?.path ?? result.id,
          message: "JSON specification document does not conform to its declared schema.",
          evidence: [
            { kind: "schema-set-digest", value: observation.jsonSchemas.schemaSetDigest },
            { kind: "document-corpus-digest", value: observation.jsonSchemas.fixtureCorpusDigest }
          ]
        })
      );
    }
  }
  for (const collision of duplicateValues(generatedAndModelPaths(specification))) {
    diagnostics.push(
      diagnostic({
        rule: EXECUTABLE_SPECIFICATION_RULES.pathCollision,
        subject: `${specification.id}:path:${collision}`,
        path: collision,
        message: `Executable or generated artifact path is assigned more than once: ${collision}.`
      })
    );
  }
  for (const collision of duplicateValues(
    specification.documents.map((document) => document.path)
  )) {
    diagnostics.push(
      diagnostic({
        rule: EXECUTABLE_SPECIFICATION_RULES.pathCollision,
        subject: `${specification.id}:document-path:${collision}`,
        path: collision,
        message: `Specification document path is bound more than once: ${collision}.`
      })
    );
  }
  diagnostics.push(...evaluateBindings(specification, observation));
  diagnostics.push(...evaluateGates(specification, observation));
  return diagnostics;
}

export function evaluateExecutableSpecifications(
  catalog: ExecutableSpecificationCatalog,
  observations: readonly ExecutableSpecificationObservation[]
): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  for (const id of duplicateValues(catalog.specifications.map((specification) => specification.id))) {
    diagnostics.push(
      diagnostic({
        rule: EXECUTABLE_SPECIFICATION_RULES.specificationIdDuplicate,
        subject: `specification:${id}`,
        path: catalog.catalogPath,
        message: `Executable specification ID is declared more than once: ${id}.`
      })
    );
  }
  for (const [index, specification] of catalog.specifications.entries()) {
    const observation = observations[index];
    if (observation !== undefined) {
      diagnostics.push(...evaluateSpecification(specification, observation));
    }
  }
  for (const collision of duplicateValues(
    catalog.specifications.flatMap(generatedAndModelPaths)
  )) {
    diagnostics.push(
      diagnostic({
        rule: EXECUTABLE_SPECIFICATION_RULES.pathCollision,
        subject: `catalog-path:${collision}`,
        path: collision,
        message: `Generated or executable artifact path collides across specifications: ${collision}.`
      })
    );
  }
  return diagnostics;
}
