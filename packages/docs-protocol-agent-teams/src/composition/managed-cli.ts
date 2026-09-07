import {
  createManagedDocsCli,
  managedConsumerCommand
} from "../consumer-integration/composition/managed-command.js";
import { managedQualificationCommand } from "../qualification/composition/managed-command.js";

const commands = {
  runManagedDocsCli: createManagedDocsCli({
    consumer: managedConsumerCommand,
    qualification: managedQualificationCommand
  })
};

export function runManagedDocsCli(argv: readonly string[]): Promise<number> {
  return commands.runManagedDocsCli(argv);
}
