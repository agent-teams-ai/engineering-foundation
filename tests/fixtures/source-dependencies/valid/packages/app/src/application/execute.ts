import { coreValue } from "@fixture/core";
import { tool } from "@fixture/core/features/tool";

import type { AgentId } from "../domain/agent-id.js";

export function execute(id: AgentId): string {
  void tool;
  return `${id.value}:${coreValue}`;
}
