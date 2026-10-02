import type { RuntimeTuple } from "../ports/managed-runtime.js";

const tuple = (value: unknown): value is RuntimeTuple => {
    try {
      if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {return false;}
      const keys = ["nodeVersion", "pnpmVersion", "platform", "architecture"];
      if (Reflect.ownKeys(value).length !== keys.length) {return false;}
      return keys.every((key) => {
        const field = Object.getOwnPropertyDescriptor(value, key);
        return field !== undefined && field.enumerable === true && Object.hasOwn(field, "value");
      });
    } catch { return false; }
};

/** Exact observed tuple comparison; this does not certify how observations were obtained. */
export function sameRuntimeTuple(left: RuntimeTuple, right: RuntimeTuple): boolean {
  if (!tuple(left) || !tuple(right)) {return false;}
  try {
    return left.nodeVersion === right.nodeVersion && left.pnpmVersion === right.pnpmVersion &&
      left.platform === right.platform && left.architecture === right.architecture;
  } catch { return false; }
}
