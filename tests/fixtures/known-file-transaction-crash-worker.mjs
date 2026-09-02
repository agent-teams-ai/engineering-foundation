import { compileKnownFileTransactionPlan } from "../../packages/repository-mutation/dist/index.js";
import { applyKnownFileTransaction, recoverKnownFileTransaction } from "../../packages/repository-mutation/dist/qualification/index.js";

const [root, checkpoint, action = "apply"] = process.argv.slice(2);
const plan = compileKnownFileTransactionPlan({ operations: [{
  path: "managed/existing.txt",
  precondition: {
    state: "known-file",
    acceptedPreimages: [{ bytes: Buffer.from("old\n"), mode: 0o640 }]
  },
  postimage: { bytes: Buffer.from("new\n"), mode: 0o640 }
}] });

const crash = async (point) => {
  if (point.phase !== checkpoint) {return;}
  process.stdout.write(`${checkpoint}\n`);
  await new Promise(() => {setInterval(() => {}, 60_000);});
};

if (action === "recover") {
  await recoverKnownFileTransaction({ consumerRoot: root, faultInjector: crash });
} else {
  await applyKnownFileTransaction({
  consumerRoot: root,
  plan,
  faultInjector: crash
  });
}
