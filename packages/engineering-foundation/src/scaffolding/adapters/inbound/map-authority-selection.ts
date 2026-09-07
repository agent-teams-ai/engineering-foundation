import type {
  AuthorityScaffoldingConfig,
  ScaffoldRenderingIntent,
  ScaffoldAuthorityVerifierV1
} from "../../application/model/scaffold-compilation.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { mapAuthorityCatalog } from "./map-authority-catalog.js";

function requireExactlyOne<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
  message: string
): T {
  const matches = values.filter(predicate);
  if (matches.length !== 1) {
    throw new ScaffoldError("SCAFFOLD_INPUT_INVALID", message);
  }
  return matches[0] as T;
}

/** Maps schema-validated input without filesystem or schema assembly dependencies. */
export function mapAuthoritySelection(
  config: AuthorityScaffoldingConfig,
  catalogValue: unknown,
  intentValue: unknown
): {
  readonly intent: ScaffoldRenderingIntent;
  readonly target: ReturnType<typeof mapAuthorityCatalog>["packages"][number];
  readonly verifier: ScaffoldAuthorityVerifierV1;
} {
  const unresolvedCatalog = mapAuthorityCatalog(catalogValue);
  const intent = intentValue as ScaffoldRenderingIntent;
  const composition = requireExactlyOne(
    config.compositions,
    (candidate) => candidate.id === intent.compositionId,
    `Composition must exist exactly once: ${intent.compositionId}.`
  );
  const target = requireExactlyOne(
    unresolvedCatalog.packages,
    (candidate) => candidate.id === intent.targetRef,
    `Scaffold target must exist exactly once: ${intent.targetRef}.`
  );
  const authorityVerifiers = composition.authorityVerifiers as readonly ScaffoldAuthorityVerifierV1[];
  if (authorityVerifiers.length !== 1) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "The selected Composition must contain exactly one authority verifier."
    );
  }
  const verifier = authorityVerifiers[0];
  if (verifier === undefined) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "The selected Composition must admit exactly one supported authority verifier."
    );
  }
  return { intent, target, verifier };
}
