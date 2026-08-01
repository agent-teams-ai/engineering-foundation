import { join } from "node:path";
import { z } from "zod";

import type { AgentId } from "../domain/agent-id.js";

export function createAdapter(): AgentId {
  return { value: z.string().parse(join("agent", "one")) };
}
