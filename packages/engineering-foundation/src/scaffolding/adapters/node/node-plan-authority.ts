import type { ScaffoldSchemaValidator } from "../schema-validation.js";
import type {
  AuthorityScaffoldPlan,
  ScaffoldAuthorityAssessment
} from "../../application/model/scaffold-compilation.js";
import { compileAuthorityScaffoldPlan } from "../../kernel/authority-compiler.js";
import type { ScaffoldAuthorityDependencies } from "./scaffold-authority-dependencies.js";
import { ScaffoldAuthorityStaleError } from "./node-authority-error.js";
import {
  loadAuthorityScaffoldCompilationInputFromIntent,
  type ScaffoldAuthorityInputFaultInjector
} from "./node-authority-input-loader.js";

async function assertPlanMatchesConsumerAuthority(
  consumerRoot: string,
  plan: AuthorityScaffoldPlan,
  assertSchema: ScaffoldSchemaValidator,
  dependencies: ScaffoldAuthorityDependencies,
  authorityFaultInjector?: ScaffoldAuthorityInputFaultInjector
): Promise<void> {
  const input = await loadAuthorityScaffoldCompilationInputFromIntent({
    consumerRoot,
    configPath: plan.authority.configPath,
    foundationVersion: await dependencies.installedVersion(),
    intent: plan.intent,
    ...(authorityFaultInjector === undefined
      ? {}
      : { faultInjector: authorityFaultInjector })
  }, assertSchema, dependencies.observation);
  const expected = compileAuthorityScaffoldPlan(
    input,
    dependencies.createRegistry()
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
  dependencies: ScaffoldAuthorityDependencies,
  faultInjector?: ScaffoldAuthorityInputFaultInjector
): Promise<ScaffoldAuthorityAssessment> {
  try {
    await assertPlanMatchesConsumerAuthority(
      consumerRoot,
      plan,
      assertSchema,
      dependencies,
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
