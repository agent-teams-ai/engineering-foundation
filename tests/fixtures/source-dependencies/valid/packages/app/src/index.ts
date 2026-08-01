import { execute } from "./application/execute.js";
import { createAdapter } from "./infrastructure/adapter.js";

export const start = () => execute(createAdapter());
