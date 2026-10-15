import type { LayerRole } from '../../feature-model/domain/model.js';

/** `same-feature` is the dependency direction inside one feature; `other-feature` the one toward a visible curated surface of another. */
export type LayerScope = 'same-feature' | 'other-feature';

const production: readonly LayerRole[] = ['domain', 'application', 'contracts', 'adapters', 'composition'];
const everything: readonly LayerRole[] = [...production, 'testing'];

// FMS v1: domain and application never import contracts; adapters reach sibling features through their own
// application core and composition; composition wires across layers, and a feature's own testing layer stays
// out of its production code, while composition may reach the curated qualification surface of another feature.
const targets: Readonly<Record<LayerScope, Readonly<Record<string, readonly string[]>>>> = {
  'same-feature': {
    domain: ['domain'],
    application: ['domain', 'application'],
    contracts: ['contracts'],
    adapters: ['adapters', 'application', 'domain', 'contracts'],
    composition: production,
    testing: everything,
  },
  'other-feature': {
    domain: ['domain'],
    application: ['domain', 'application'],
    contracts: ['contracts'],
    adapters: [],
    composition: everything,
    testing: everything,
  },
};

export function layerDirectionAllowed(from: LayerRole, to: LayerRole, scope: LayerScope): boolean {
  const table = targets[scope];
  return Object.hasOwn(table, from) && (table[from] ?? []).includes(to);
}
