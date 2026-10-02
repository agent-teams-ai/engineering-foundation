// A public CLI child starts its own runner; Node's worker marker is not user configuration.
export function isolateNodeTestCliContext(): void {
  if (process.env.NODE_TEST_CONTEXT === "child-v8") {
    delete process.env.NODE_TEST_CONTEXT;
  }
}

export function readNodeProcessInputs() {
  return {
    environment: { ...process.env },
    entrypointUrl: new URL("../../../../../cli.js", import.meta.url).href,
    args: process.argv.slice(2)
  };
}
