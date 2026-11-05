import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { LocalPackageLifecyclePorts } from "../../application/ports.js";
import type { ProcessRunner } from "../../application/model.js";
import { createNodeLocalLinkStateStore, type LocalStateDirectory } from "./local-state-store.js";
import { createNodeRegistryLinks } from "./registry-links.js";
import { localCustodyFailure } from "../../application/inspection-failures.js";
import { settleLocalOperation } from "../../application/settle-local-operation.js";

type LocalCoordinator = Awaited<ReturnType<LocalPackageLifecyclePorts["coordinator"]>>;
type LocalLease = Awaited<ReturnType<LocalCoordinator["acquire"]>>;

/** Private resources are scoped to the concrete operation lease, not a service lifetime. */
export function createNodeLocalOperationCustody(
  durability: LocalStateDirectory,
  runner: ProcessRunner,
) {
  const create = () => ({
    state: createNodeLocalLinkStateStore(durability),
    links: createNodeRegistryLinks(runner, (path) => durability.sync(path)),
  });
  const active = new Map<string, ReturnType<typeof create>>();
  return {
    current(root: string) {
      const operation = active.get(root);
      if (operation === undefined) {
        throw localCustodyFailure("Local filesystem mutation requires its active operation lease.");
      }
      return operation;
    },
    async acquire(path: string, acquire: () => Promise<LocalLease>): Promise<LocalLease> {
      const root = await realpath(resolve(path));
      const lease = await acquire();
      if (active.has(root)) {
        const failure = localCustodyFailure(
          "The local operation lease did not exclude an existing owner.",
        );
        return settleLocalOperation(
          async () => {
            throw failure;
          },
          async () => {
            await lease.release({ retainTransactionBarrier: true });
          },
        );
      }
      const operation = create();
      active.set(root, operation);
      let released = false;
      return {
        status: lease.status,
        async release(options) {
          if (released) {
            return;
          }
          released = true;
          try {
            await lease.release(options);
          } finally {
            if (active.get(root) === operation) {
              active.delete(root);
            }
          }
        },
      };
    },
  };
}
