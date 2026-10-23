import { join } from "node:path";
import { parseStrictJson } from "@agent-teams/repository-mutation/serialization";
import {
  hasNoManagedChild,
  hasSettledManagedChild,
  permitsDisposableProject,
} from "../application/managed-runtime-policy.js";
import { sameRuntimeTuple } from "../application/policies/managed-runtime-observation.js";
import {
  type ManagedPnpmInstallInput,
  type ManagedPnpmInstallResult,
  type ProcessFacts,
  type RuntimeDebt,
  type RuntimeRefusalCode,
} from "../application/ports/managed-runtime.js";
import { observeRuntimeImage } from "./node-managed-runtime-identity.js";
import { runManagedProbe } from "./node-managed-runtime-process.js";
import {
  empty,
  uncertain,
  hex,
  type RefusedInstall,
  type DirectoryBinding,
  type InstallationOwner,
  refused,
  validInstallMode,
  absent,
  bindDirectory,
  sameDirectory,
  boundedBytes,
  yamlValue,
  sha256,
  fileDigest,
  verifyDirectTarballs,
  verifyLocalTarballs,
  observation,
} from "./managed-install-support.js";
export class ManagedPnpmInstallation {
  private installed = false;
  private store: DirectoryBinding | null = null;
  private modules: DirectoryBinding | null = null;
  private facts: ProcessFacts = empty;
  private uncertainProcess = false;

  constructor(private readonly owner: InstallationOwner) {}

  private hasUncertainProcess(): boolean {
    return this.uncertainProcess;
  }

  private debt(): RuntimeDebt {
    return Object.freeze({
      code: "liveness-uncertain",
      attemptId: this.owner.attempt.token,
      evidencePath: this.owner.attempt.evidencePath,
      facts: Object.freeze({ ...this.facts }),
    });
  }

  private async verifyDirectories(root: string): Promise<RuntimeRefusalCode | null> {
    const storePath = join(root, ".managed-pnpm-store");
    if (!(await absent(storePath))) {
      if (this.store === null) {
        return "invalid-selection";
      }
      if (!sameDirectory(await bindDirectory(storePath), this.store)) {
        return "identity-changed";
      }
    }
    const modulesPath = join(root, "node_modules");
    if (!(await absent(modulesPath))) {
      if (!this.installed || this.modules === null) {
        return "invalid-selection";
      }
      if (!sameDirectory(await bindDirectory(modulesPath), this.modules)) {
        return "identity-changed";
      }
      await bindDirectory(join(modulesPath, ".pnpm"));
    }
    return null;
  }

  private async preflight(input: ManagedPnpmInstallInput): Promise<RuntimeRefusalCode | null> {
    const root = this.owner.attempt.ownedRoot;
    if (!(await this.owner.attempt.verifyOwnedRoot())) {
      return "identity-changed";
    }
    for (const name of [
      ".npmrc",
      "user.npmrc",
      "global.npmrc",
      ".pnpmfile.cjs",
      "pnpmfile.cjs",
      ".pnpmfile.mjs",
    ]) {
      if (!(await absent(join(root, name)))) {
        return "invalid-selection";
      }
    }
    if (input.mode === "prepare" && !(await absent(join(root, "pnpm-lock.yaml")))) {
      return "invalid-selection";
    }
    const directories = await this.verifyDirectories(root);
    if (directories) {
      return directories;
    }
    const manifest = await boundedBytes(join(root, "package.json"));
    const workspace = await boundedBytes(join(root, "pnpm-workspace.yaml"));
    if (
      sha256(manifest) !== input.expectedManifestDigest ||
      sha256(workspace) !== input.expectedWorkspaceDigest
    ) {
      return "identity-changed";
    }
    const project: unknown = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(manifest),
    );
    if (!permitsDisposableProject(project, yamlValue(workspace))) {
      return "invalid-selection";
    }
    if (input.mode === "frozen-offline") {
      const locked = await this.preflightLock(input);
      if (locked) {
        return locked;
      }
    }
    try {
      await verifyDirectTarballs(root, project);
    } catch {
      return "invalid-selection";
    }
    return null;
  }

  private async preflightLock(input: ManagedPnpmInstallInput): Promise<RuntimeRefusalCode | null> {
    const root = this.owner.attempt.ownedRoot;
    const virtual = join(root, "node_modules/.pnpm/lock.yaml");
    if (
      (await fileDigest(join(root, "pnpm-lock.yaml"))) !== input.expectedLockDigest ||
      (!(await absent(virtual)) && (await fileDigest(virtual)) !== input.expectedLockDigest)
    ) {
      return "identity-changed";
    }
    await verifyLocalTarballs(root);
    return null;
  }

  private async captureStore(): Promise<void> {
    const path = join(this.owner.attempt.ownedRoot, ".managed-pnpm-store");
    if (!(await absent(path))) {
      const current = await bindDirectory(path);
      if (this.store !== null && !sameDirectory(current, this.store)) {
        throw new Error("installation-store-substituted");
      }
      this.store = current;
    }
  }

  private async stage(
    input: ManagedPnpmInstallInput,
    kind: "pnpm-install-prepare" | "pnpm-install-frozen-offline" | "pnpm-peers-check",
  ): Promise<RefusedInstall | null> {
    const { attempt, image, selection } = this.owner;
    await observeRuntimeImage(selection, image);
    let reserved = false;
    const wasReserved = (): boolean => reserved;
    const result = await runManagedProbe({
      image,
      expected: selection.expected,
      cwd: attempt.ownedRoot,
      kind,
      signal: input.signal,
      lifecycle: {
        spawning: async () => {
          reserved = true;
          this.uncertainProcess = true;
          this.facts = uncertain;
          await attempt.transition("spawning", empty);
        },
        running: async (child) => {
          await attempt.transition("running", { ...uncertain, spawned: true }, child);
        },
        stopping: async () => {
          await attempt.transition("stopping", { ...uncertain, spawned: true });
        },
      },
    });
    this.facts = result.facts;
    const noChild = hasNoManagedChild(this.facts);
    const clean = noChild || hasSettledManagedChild(this.facts);
    if (wasReserved()) {
      if (noChild) {
        await attempt.transition("stopping", this.facts);
      }
      await attempt.transition(clean ? "terminated" : "debt", this.facts);
    }
    this.uncertainProcess = !clean;
    if (!clean) {
      return refused(result.code ?? "liveness-uncertain", this.facts, this.debt());
    }
    await this.captureStore();
    if (result.code) {
      return {
        ...refused(result.code, this.facts),
        ...(result.diagnosticTailBase64 === undefined
          ? {}
          : { diagnosticTailBase64: result.diagnosticTailBase64 }),
      };
    }
    if (noChild || !result.handshake || !sameRuntimeTuple(result.handshake, selection.expected)) {
      return refused("runtime-mismatch", this.facts);
    }
    return input.signal.aborted ? refused("cancelled", { ...this.facts, cancelled: true }) : null;
  }

  private async finish(input: ManagedPnpmInstallInput): Promise<ManagedPnpmInstallResult> {
    const { attempt, image, selection } = this.owner;
    const root = attempt.ownedRoot;
    await observeRuntimeImage(selection, image);
    if (
      !(await attempt.verifyOwnedRoot()) ||
      (await fileDigest(join(root, "package.json"))) !== input.expectedManifestDigest ||
      (await fileDigest(join(root, "pnpm-workspace.yaml"))) !== input.expectedWorkspaceDigest
    ) {
      return refused("identity-changed", this.facts);
    }
    const modules = await bindDirectory(join(root, "node_modules"));
    await bindDirectory(join(root, "node_modules/.pnpm"));
    const lockDigest = await fileDigest(join(root, "pnpm-lock.yaml"));
    const virtualStoreLockDigest = await fileDigest(join(root, "node_modules/.pnpm/lock.yaml"));
    if (
      lockDigest !== virtualStoreLockDigest ||
      (input.mode === "frozen-offline" && lockDigest !== input.expectedLockDigest)
    ) {
      return refused("identity-changed", this.facts);
    }
    await verifyLocalTarballs(root);
    if (input.signal.aborted) {
      return refused("cancelled", { ...this.facts, cancelled: true });
    }
    this.modules = modules;
    this.installed = true;
    return {
      outcome: "installed",
      facts: this.facts,
      runtime: observation(this.owner),
      lockDigest,
      virtualStoreLockDigest,
    };
  }

  async install(input: ManagedPnpmInstallInput): Promise<ManagedPnpmInstallResult> {
    if (
      !hex(input.expectedManifestDigest) ||
      !hex(input.expectedWorkspaceDigest) ||
      (input.mode === "prepare"
        ? input.expectedLockDigest !== null
        : !hex(input.expectedLockDigest)) ||
      !validInstallMode(input.mode)
    ) {
      return refused("invalid-selection");
    }
    if (this.hasUncertainProcess()) {
      return refused("liveness-uncertain", this.facts, this.debt());
    }
    this.facts = empty;
    if (input.signal.aborted) {
      return refused("cancelled", { ...empty, cancelled: true });
    }
    // The process adapter replaces the child environment; the fixed probe enforces install flags.
    // Preflight still refuses effective project configuration and executable hooks.
    try {
      const rejected = await this.preflight(input);
      if (rejected) {
        return refused(rejected);
      }
      const installed = await this.stage(
        input,
        input.mode === "prepare" ? "pnpm-install-prepare" : "pnpm-install-frozen-offline",
      );
      if (installed) {
        return installed;
      }
      if (input.mode === "frozen-offline") {
        const peers = await this.stage(input, "pnpm-peers-check");
        if (peers) {
          return peers;
        }
      }
      return await this.finish(input);
    } catch {
      const unconfirmed = this.hasUncertainProcess();
      return refused(
        unconfirmed ? "liveness-uncertain" : "identity-changed",
        this.facts,
        unconfirmed ? this.debt() : null,
      );
    }
  }
}
