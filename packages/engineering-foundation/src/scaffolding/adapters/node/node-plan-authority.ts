import type { ScaffoldSchemaValidator } from "../schema-validation.js";
import type {
  AuthorityScaffoldPlan,
  ScaffoldAuthorityAssessment
} from "../../application/model/scaffold-compilation.js";
import type { ScaffoldDefinitionRegistry } from "../../kernel/definition-registry.js";
import { compileAuthorityScaffoldPlan } from "../../kernel/authority-compiler.js";
import { installedFoundationVersion } from "./installed-foundation-version.js";
import { ScaffoldAuthorityStaleError } from "./node-authority-error.js";
import {
  loadAuthorityScaffoldCompilationInputFromIntent,
  type ScaffoldAuthorityInputFaultInjector
} from "./node-authority-input-loader.js";

async function assertPlanMatchesConsumerAuthority(
  consumerRoot: string,
  plan: AuthorityScaffoldPlan,
  assertSchema: ScaffoldSchemaValidator,
  createRegistry: () => ScaffoldDefinitionRegistry,
  authorityFaultInjector?: ScaffoldAuthorityInputFaultInjector
): Promise<void> {
  const input = await loadAuthorityScaffoldCompilationInputFromIntent({
    consumerRoot,
    configPath: plan.authority.configPath,
    foundationVersion: await installedFoundationVersion(),
    intent: plan.intent,
    ...(authorityFaultInjector === undefined
      ? {}
      : { faultInjector: authorityFaultInjector })
  }, assertSchema);
  const expected = compileAuthorityScaffoldPlan(
    input,
    createRegistry()
  );
  if (expected.planDigest !== plan.planDigest) {
    throw new ScaffoldAuthorityStaleError(
      "Scaffolding Plan was not produced by the closed compiler from current consumer authority."
    );
  }
}

/**
 * A source-bound authority change is stale only when the closed compiler can prove it.
 * Input, parser, and filesystem failures are deliberately kept unverifiable.
 */
export async function assessScaffoldPlanAuthority(
  consumerRoot: string,
  plan: AuthorityScaffoldPlan,
  assertSchema: ScaffoldSchemaValidator,
  createRegistry: () => ScaffoldDefinitionRegistry,
  faultInjector?: ScaffoldAuthorityInputFaultInjector
): Promise<ScaffoldAuthorityAssessment> {
  try {
    await assertPlanMatchesConsumerAuthority(
      consumerRoot,
      plan,
      assertSchema,
      createRegistry,
      faultInjector
    );
    return { state: "current" };
  } catch (error) {
    if (
      error instanceof ScaffoldAuthorityStaleError
    ) {
      return { state: "stale" };
    }
    return { state: "unverifiable" };
  }
}
