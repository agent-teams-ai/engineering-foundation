import { compilePortableBootstrap as compile, applyPortableBootstrap as apply } from "../application/portable-bootstrap.js";
import { nodeBootstrapRepository } from "../adapters/outbound/node-bootstrap-repository.js";
import { nodeBootstrapTransactions } from "../adapters/outbound/node-bootstrap-transactions.js";
import type { PortableBootstrapInput, ApplyPortableBootstrapInput } from "../application/bootstrap-model.js";

export const bootstrapPorts = { repository: nodeBootstrapRepository, transactions: nodeBootstrapTransactions };
export const compilePortableBootstrap = (input: PortableBootstrapInput) => compile(input, bootstrapPorts);
export const applyPortableBootstrap = (input: ApplyPortableBootstrapInput) => apply(input, bootstrapPorts);
export const inspectPortableBootstrap = (input: { readonly consumerRoot: string }) => nodeBootstrapTransactions.inspect(input);
export const recoverPortableBootstrap = (input: { readonly consumerRoot: string }) => nodeBootstrapTransactions.recover(input);
