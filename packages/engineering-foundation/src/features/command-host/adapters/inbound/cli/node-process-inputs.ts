export function readNodeProcessInputs() {
  return {
    environment: { ...process.env },
    entrypointUrl: new URL("../../../../../cli.js", import.meta.url).href,
    args: process.argv.slice(2)
  };
}
