import type {
  AuthorityScaffoldPlan
} from "../../application/model/scaffold-compilation.js";
import { createAuthorityScaffoldRegistry } from "../../composition/scaffold-registry.js";
import { compileAuthorityScaffoldPlan } from "../../kernel/authority-compiler.js";
import { installedFoundationVersion } from "./installed-foundation-version.js";
import { ScaffoldAuthorityStaleError } from "./node-authority-error.js";
import {
  loadAuthorityScaffoldCompilationInputFromIntent,
  type ScaffoldAuthorityInputFaultInjector
} from "./node-authority-input-loader.js";

export type ScaffoldAuthorityAssessment =
  | { readonly state: "current" }
  | { readonly state: "stale" }
  | { readonly state: "unverifiable" };

async function assertPlanMatchesConsumerAuthority(
  consumerRoot: string,
  plan: AuthorityScaffoldPlan,
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
  });
  const expected = compileAuthorityScaffoldPlan(
    input,
    createAuthorityScaffoldRegistry()
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
  faultInjector?: ScaffoldAuthorityInputFaultInjector
): Promise<ScaffoldAuthorityAssessment> {
  try {
    await assertPlanMatchesConsumerAuthority(
      consumerRoot,
      plan,
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
