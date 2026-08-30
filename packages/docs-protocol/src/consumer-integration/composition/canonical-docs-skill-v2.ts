/**
 * Compatibility-only facade for the released Agent Teams managed root exports.
 *
 * Keep this module re-export-only so managed behavior retains one authority and
 * can move without changing the existing root import names.
 */
export * as consumerIntegration from "../index.js";
export { CANONICAL_DOCS_SKILL_V2 } from "../application/policies/consumer-integration-assets.js";
