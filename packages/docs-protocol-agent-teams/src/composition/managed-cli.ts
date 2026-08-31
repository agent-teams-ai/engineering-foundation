import {
  managedDocsHelp,
  runManagedConsumerCommand
} from "../consumer-integration/composition/consumer-integration-cli.js";
import { runQualificationCli } from "./qualification-cli.js";

export function managedHelp(): string {
  return `${managedDocsHelp().replace("\nOptions:", "  qualify                       Run managed qualification in a disposable copy\n\nOptions:")}`;
}

export async function runManagedDocsCli(argv: readonly string[]): Promise<number> {
  const values = argv[0] === "--" ? argv.slice(1) : argv;
  if (values.length === 0 || (values.length === 1 && ["--help", "help"].includes(values[0] ?? ""))) {
    process.stdout.write(managedHelp());
    return 0;
  }
  if (values[0] === "qualify") {
    return runQualificationCli(values.slice(1));
  }
  return runManagedConsumerCommand(values);
}
