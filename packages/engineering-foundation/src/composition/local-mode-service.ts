import { LocalPackageLifecycle } from "../local-mode/api.js";
import type { AttachResult, FoundationDevOnlyStatus, FoundationStatus, FoundationLocalModeServiceOptions } from "../local-mode/api.js";
import { createNodeLocalPackageLifecyclePorts } from "./local-mode-ports.js";

export type { FoundationLocalModeServiceOptions } from "../local-mode/api.js";

/** Supported public constructor; concrete dependencies are selected only here. */
export class FoundationLocalModeService {
  readonly #lifecycle: LocalPackageLifecycle;

  constructor(options: FoundationLocalModeServiceOptions) {
    this.#lifecycle = new LocalPackageLifecycle({ ports: createNodeLocalPackageLifecyclePorts(options.runner), now: options.now });
  }

  async status(consumerPath: string): Promise<FoundationStatus> {
    return this.#lifecycle.status(consumerPath);
  }
  async attach(consumerPath: string, targetPath: string): Promise<AttachResult> {
    return this.#lifecycle.attach(consumerPath, targetPath);
  }
  async detach(consumerPath: string): Promise<FoundationStatus> {
    return this.#lifecycle.detach(consumerPath);
  }
  async assertRegistry(consumerPath: string): Promise<FoundationStatus> {
    return this.#lifecycle.assertRegistry(consumerPath);
  }
  async assertDevOnly(consumerPath: string): Promise<FoundationDevOnlyStatus> {
    return this.#lifecycle.assertDevOnly(consumerPath);
  }
}
