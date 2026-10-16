import { checkBudgets } from '@agent-teams/engineering-foundation/ratchet';
import { observeSourceGraph } from '@agent-teams/engineering-foundation/source-graph';
import { runFeatureModuleCheck } from '../application/run-feature-module-check.js';
import type { NodeCheckConfig, NodeReport, ObservedGraph } from '../application/run-feature-module-check.js';

// The file graph of the given repository-relative roots, read with the parser and resolver of Engineering Foundation.
const observeFromDisk = (consumerRoot: string) => async (roots: readonly string[]): Promise<ObservedGraph> => {
  const { files, edges, parseFailures } = await observeSourceGraph({ consumerRoot, roots });
  return { files, edges, parseFailures };
};

/** Checks one production module on disk: the file graph of Engineering Foundation, the kernel and the growth budgets. */
export const checkFeatureModuleOnDisk = (config: NodeCheckConfig): Promise<NodeReport> =>
  runFeatureModuleCheck(config, { observe: observeFromDisk(config.consumerRoot), checkBudgets });
