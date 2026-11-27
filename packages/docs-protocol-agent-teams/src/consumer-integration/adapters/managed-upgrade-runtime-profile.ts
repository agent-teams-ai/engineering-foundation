/** Physical executables for the current retained transition, not historical pin images. */
export const MANAGED_CONTROLLER_NODE_VERSION = "24.22.3";
export const MANAGED_TARGET_NODE_VERSION = "26.12.1";

/** Host-owned source images stay byte-exact through admission and original restoration. */
export function isPreservedManagedNode26Pin(value: string): value is "26.11.1\n" | "26.12.1\n" {
  return value === "26.11.1\n" || value === "26.12.1\n";
}
