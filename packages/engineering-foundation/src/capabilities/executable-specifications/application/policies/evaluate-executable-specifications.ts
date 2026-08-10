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
import {
  executableSpecificationPathDeclarations,
  portableExecutableSpecificationPathIdentity,
  portableExecutableSpecificationPathProblem
} from "./portable-executable-specification-path.js";

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

function duplicatePaths(paths: readonly string[]): readonly string[] {
  const firstByIdentity = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const path of paths) {
    const identity = portableExecutableSpecificationPathIdentity(path);
    const first = firstByIdentity.get(identity);
    if (first === undefined) {
      firstByIdentity.set(identity, path);
    } else {
      duplicates.add(first);
    }
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
    ...(specification.gateBindings.typeGeneration === undefined
      ? []
      : ([['typeGeneration', specification.gateBindings.typeGeneration]] as const)),
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

function duplicatePathDiagnostics(
  paths: readonly string[],
  description: string
): readonly FoundationDiagnostic[] {
  return duplicatePaths(paths).map((path) =>
    diagnostic({
      rule: EXECUTABLE_SPECIFICATION_RULES.pathCollision,
      subject: `catalog-path:${path}`,
      path,
      message: `${description}: ${path}.`
    })
  );
}

function evaluateSpecificationTopology(
  specification: ExecutableSpecification,
  catalogPath: string
): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const hasGeneratedTypes = specification.generatedTypes.length > 0;
  const hasTypeGenerationGate = specification.gateBindings.typeGeneration !== undefined;
  if (hasGeneratedTypes !== hasTypeGenerationGate) {
    diagnostics.push(
      diagnostic({
        rule: EXECUTABLE_SPECIFICATION_RULES.generatedTypeGateMismatch,
        subject: `${specification.id}:gate:typeGeneration`,
        path: catalogPath,
        message: hasGeneratedTypes
          ? "Generated type outputs require a type-generation gate binding."
          : "A data-only specification must not declare a type-generation gate binding."
      })
    );
  }
  for (const schemaId of duplicateValues(
    specification.generatedTypes.map((binding) => binding.schemaId)
  )) {
    diagnostics.push(
      diagnostic({
        rule: EXECUTABLE_SPECIFICATION_RULES.generatedTypeBindingDuplicate,
        subject: `${specification.id}:schema:${schemaId}`,
        path: specification.generatedTypes[0]?.outputPath ?? catalogPath,
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
  for (const duplicate of duplicateValues(
    specificationGates(specification).map(([, binding]) => gateKey(binding))
  )) {
    const [packageName = "", script = ""] = duplicate.split("\u0000");
    diagnostics.push(
      diagnostic({
        rule: EXECUTABLE_SPECIFICATION_RULES.gateNotDistinct,
        subject: `${specification.id}:gate:${packageName}:${script}`,
        path: catalogPath,
        message: `Gate script is reused by more than one evidence role: ${packageName}#${script}.`
      })
    );
  }
  return diagnostics;
}

/** Pure topology validation. It must run before any consumer artifact inspection. */
export function evaluateExecutableSpecificationTopology(
  catalog: ExecutableSpecificationCatalog
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
  for (const specification of catalog.specifications) {
    diagnostics.push(...evaluateSpecificationTopology(specification, catalog.catalogPath));
  }
  const pathDeclarations = executableSpecificationPathDeclarations(catalog);
  for (const declaration of pathDeclarations) {
    const portabilityProblem = portableExecutableSpecificationPathProblem(declaration.path);
    if (portabilityProblem !== undefined) {
      diagnostics.push(
        diagnostic({
          rule: EXECUTABLE_SPECIFICATION_RULES.pathCollision,
          subject: `catalog-path:${declaration.path}`,
          path: declaration.path,
          message: `Executable specification path is not portable: ${declaration.path} (${portabilityProblem}).`
        })
      );
    }
  }
  const firstDeclarationByIdentity = new Map<
    string,
    (typeof pathDeclarations)[number]
  >();
  for (const declaration of pathDeclarations) {
    const identity = portableExecutableSpecificationPathIdentity(declaration.path);
    const first = firstDeclarationByIdentity.get(identity);
    if (first === undefined) {
      firstDeclarationByIdentity.set(identity, declaration);
      continue;
    }
    const shareableExactEvidence =
      first.path === declaration.path &&
      first.role === declaration.role &&
      (first.role === "owner" || first.role === "adr");
    if (!shareableExactEvidence) {
      diagnostics.push(
        diagnostic({
          rule: EXECUTABLE_SPECIFICATION_RULES.pathCollision,
          subject: `catalog-path:${declaration.path}`,
          path: declaration.path,
          message: `Executable specification path roles collide: ${first.role}:${first.path} and ${declaration.role}:${declaration.path}.`
        })
      );
    }
  }
  const schemaPaths = catalog.specifications.flatMap((specification) => specification.schemaPaths);
  const documentPaths = catalog.specifications.flatMap((specification) =>
    specification.documents.map((document) => document.path)
  );
  const generatedModelPaths = catalog.specifications.flatMap(generatedAndModelPaths);
  const sourcePaths = catalog.specifications.flatMap((specification) => [
    "foundation.config.yaml",
    catalog.configPath,
    catalog.catalogPath,
    "package.json",
    "pnpm-workspace.yaml",
    ...specification.ownerDocs,
    ...specification.adrRefs,
    ...specification.schemaPaths,
    ...specification.documents.map((document) => document.path)
  ]);
  diagnostics.push(
    ...duplicatePathDiagnostics(
      schemaPaths,
      "Schema path is declared more than once"
    ),
    ...duplicatePathDiagnostics(
      documentPaths,
      "Document path is declared more than once"
    ),
    ...duplicatePathDiagnostics(
      generatedModelPaths,
      "Generated or executable artifact path is assigned more than once"
    )
  );
  const sourcePathSet = new Set(
    sourcePaths.map(portableExecutableSpecificationPathIdentity)
  );
  for (const path of [...new Set(generatedModelPaths)].toSorted()) {
    if (
      sourcePathSet.has(portableExecutableSpecificationPathIdentity(path)) ||
      portableExecutableSpecificationPathIdentity(path).endsWith("/package.json")
    ) {
      diagnostics.push(
        diagnostic({
          rule: EXECUTABLE_SPECIFICATION_RULES.pathCollision,
          subject: `catalog-path:${path}`,
          path,
          message: `Generated or executable artifact collides with a source, owner, ADR, schema, or document path: ${path}.`
        })
      );
    }
  }
  return diagnostics;
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
  return diagnostics;
}

function evaluateGates(
  specification: ExecutableSpecification,
  observation: ExecutableSpecificationObservation
): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  const gates = specificationGates(specification);
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
  diagnostics.push(...evaluateBindings(specification, observation));
  diagnostics.push(...evaluateGates(specification, observation));
  return diagnostics;
}

export function evaluateExecutableSpecifications(
  catalog: ExecutableSpecificationCatalog,
  observations: readonly ExecutableSpecificationObservation[]
): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  for (const [index, specification] of catalog.specifications.entries()) {
    const observation = observations[index];
    if (observation !== undefined) {
      diagnostics.push(...evaluateSpecification(specification, observation));
    }
  }
  return diagnostics;
}
