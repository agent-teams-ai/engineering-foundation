import { CapabilityInputError } from "../../../capability-runtime.js";

const PROPERTY_ID = /^[a-z][a-z0-9.-]{1,159}$/u;
const REPLAY_PATH = /^[0-9:._-]{1,1024}$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MIN_SEED = -2_147_483_648;
const MAX_SEED = 2_147_483_647;

export interface DeterministicSeedBank {
  readonly schemaVersion: number;
  readonly propertyId: string;
  readonly numRuns: number;
  readonly seeds: readonly number[];
}

export interface PropertyReplayEvidence {
  readonly schemaVersion: number;
  readonly propertyId: string;
  readonly seed: number;
  readonly numRuns: number;
  readonly path?: string;
  readonly counterexampleDigest?: `sha256:${string}`;
}

export interface FastCheckParameters {
  readonly seed: number;
  readonly numRuns: number;
  readonly path?: string;
}

function inputError(message: string): never {
  throw new CapabilityInputError({
    code: "PROPERTY_TESTING_EVIDENCE_INVALID",
    message,
    phase: "property-testing-standard",
    retryable: false
  });
}

function assertPropertyId(value: string): void {
  if (!PROPERTY_ID.test(value)) {
    inputError("Property IDs must be normalized stable identifiers.");
  }
}

function assertSeed(value: unknown, field: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_SEED ||
    value > MAX_SEED
  ) {
    inputError(`${field} must be a signed 32-bit integer.`);
  }
}

function assertNumRuns(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000) {
    inputError(`${field} must be an integer between 1 and 1000000.`);
  }
}

export function normalizeDeterministicSeedBank(
  input: DeterministicSeedBank
): DeterministicSeedBank {
  if (input.schemaVersion !== 1) {
    inputError("Seed bank schemaVersion is unsupported.");
  }
  assertPropertyId(input.propertyId);
  assertNumRuns(input.numRuns, "seed bank numRuns");
  if (!Array.isArray(input.seeds) || input.seeds.length === 0 || input.seeds.length > 256) {
    inputError("Seed bank must contain between one and 256 seeds.");
  }
  const candidates: readonly unknown[] = input.seeds;
  const seeds = candidates
    .map((seed, index) => {
      assertSeed(seed, `seed bank seeds[${index}]`);
      return seed;
    })
    .toSorted((left, right) => left - right);
  if (new Set(seeds).size !== seeds.length) {
    inputError("Seed bank cannot contain duplicate seeds.");
  }
  return Object.freeze({
    schemaVersion: 1,
    propertyId: input.propertyId,
    numRuns: input.numRuns,
    seeds: Object.freeze(seeds)
  });
}

export function normalizePropertyReplayEvidence(
  input: PropertyReplayEvidence
): PropertyReplayEvidence {
  if (input.schemaVersion !== 1) {
    inputError("Replay evidence schemaVersion is unsupported.");
  }
  assertPropertyId(input.propertyId);
  assertSeed(input.seed, "replay seed");
  assertNumRuns(input.numRuns, "replay numRuns");
  if (input.path !== undefined && !REPLAY_PATH.test(input.path)) {
    inputError("Replay path contains unsupported characters.");
  }
  if (
    input.counterexampleDigest !== undefined &&
    !SHA256_DIGEST.test(input.counterexampleDigest)
  ) {
    inputError("Counterexample digest must be a lowercase sha256 digest.");
  }
  return Object.freeze({
    schemaVersion: 1,
    propertyId: input.propertyId,
    seed: input.seed,
    numRuns: input.numRuns,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.counterexampleDigest === undefined
      ? {}
      : { counterexampleDigest: input.counterexampleDigest })
  });
}

export function createFastCheckParameters(
  bank: DeterministicSeedBank,
  seed: number,
  replay?: PropertyReplayEvidence
): FastCheckParameters {
  const normalizedBank = normalizeDeterministicSeedBank(bank);
  assertSeed(seed, "selected seed");
  if (!normalizedBank.seeds.includes(seed)) {
    inputError("Selected seed is not part of the declared seed bank.");
  }
  if (replay === undefined) {
    return Object.freeze({ seed, numRuns: normalizedBank.numRuns });
  }
  const normalizedReplay = normalizePropertyReplayEvidence(replay);
  if (
    normalizedReplay.propertyId !== normalizedBank.propertyId ||
    normalizedReplay.seed !== seed ||
    normalizedReplay.numRuns !== normalizedBank.numRuns
  ) {
    inputError("Replay evidence must bind to the same property, seed, and numRuns.");
  }
  return Object.freeze({
    seed,
    numRuns: normalizedBank.numRuns,
    ...(normalizedReplay.path === undefined ? {} : { path: normalizedReplay.path })
  });
}
