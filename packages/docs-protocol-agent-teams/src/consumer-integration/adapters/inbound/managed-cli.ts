import { managedDocsHelp } from "./consumer-integration-cli.js";

function managedHelp(): string {
  return managedDocsHelp().replace("\nOptions:", "  qualify                       Run managed qualification in a disposable copy\n\nOptions:");
}

export function createManagedDocsCli(commands: {
  readonly consumer: (values: readonly string[]) => Promise<number>;
  readonly qualification: (values: readonly string[]) => Promise<number>;
}) {
  return async function runManagedDocsCli(argv: readonly string[]): Promise<number> {
    const values = argv[0] === "--" ? argv.slice(1) : argv;
    if (values.length === 0 || (values.length === 1 && ["--help", "help"].includes(values[0] ?? ""))) {
      process.stdout.write(managedHelp());
      return 0;
    }
    if (values[0] === "qualify") {
      return commands.qualification(values.slice(1));
    }
    return commands.consumer(values);
  };
}
