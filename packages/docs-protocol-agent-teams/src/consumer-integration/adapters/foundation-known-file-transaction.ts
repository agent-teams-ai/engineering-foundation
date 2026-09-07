import type {
  ConsumerIntegrationTransactionPort
} from "../application-api.js";

export function createFoundationKnownFileTransaction(
  operations: ConsumerIntegrationTransactionPort
): ConsumerIntegrationTransactionPort {
  return Object.freeze<ConsumerIntegrationTransactionPort>({
    async inspect(options: { readonly consumerRoot: string }) {
      const observation = await operations.inspect(options);
      return observation.state === "idle"
        ? Object.freeze({ state: "idle" as const })
        : Object.freeze({
            state: "recovery-required" as const,
            code: observation.code,
            message: observation.message
          });
    },
    apply(options) { return operations.apply(options); },
    recover(options) { return operations.recover(options); }
  });
}
