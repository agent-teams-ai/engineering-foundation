import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Bytes, sha256Json } from "@agent-teams/repository-mutation";
import { packageRoot } from "./consumer-upgrade-e2e-fixtures.mjs";
import { restorationJson } from "../dist/consumer-integration/application/policies/consumer-restoration-proof.js";

export async function restorationSnapshot(root, prefix = "") {
  const result = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if ([".git", ".agent-teams-local", "node_modules"].includes(entry.name)) {continue;}
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {Object.assign(result, await restorationSnapshot(root, path)); continue;}
    result[path] = { bytes: (await readFile(join(root, path))).toString("base64"), mode: (await lstat(join(root, path))).mode & 0o777 };
  }
  return result;
}

// Recompute ALL candidate integrity bindings to exercise semantic scope, not a stale hash refusal.
export function resealRestorationProof(proof, path) {
  proof.proofPath = path;
  const body = { schemaVersion: 1, protocol: proof.plan.protocol, planDigest: proof.plan.planDigest, outcome: "applied",
    operations: proof.plan.operations.map(({ path: operationPath, postimage }) => ({ path: operationPath, outcome: "replaced", resultDigest: postimage.digest })) };
  proof.receipt = { ...body, receiptDigest: sha256Json({ domain: "agent-teams.repository-mutation.known-file-receipt/v1", body }) };
  proof.originalReceipt = proof.receipt;
  const { receipt: _receipt, originalReceipt: _original, activation: _activation, preparationDigest: _digest, proofPath: _path, ...intent } = proof;
  proof.preparationDigest = sha256Bytes(Buffer.from(`${restorationJson({ ...intent, protocol: "agent-teams.managed-v1-restoration-preparation/v1" })}\n`));
  return Buffer.from(`${restorationJson(proof)}\n`);
}

export function restorationArgs(fixture, command, selection, proofPath = fixture.proofPath) {
  const forward = command !== "restore";
  return [command, "--consumer", fixture.consumerRoot, "--source-generation", forward ? "1" : "2", "--target-generation", forward ? "2" : "1",
    "--from", forward ? fixture.origin.cohortId : fixture.target.cohortId, "--to", forward ? fixture.target.cohortId : fixture.origin.cohortId,
    ...(forward ? ["--preparation", selection.path] : []), "--proof", proofPath, "--expect", selection.digest, "--json"];
}

// Only fixture catalog and central authority are injected. The production router, strict serializer,
// public kernel, actual pinned Corepack install and installed fixture checks execute in this child.
const uri = (path) => pathToFileURL(join(packageRoot, path)).href;
let evidenceSequence = 0;

export async function restorationCli(fixture, argv, options = {}) {
  const script = `
import {execFileSync} from 'node:child_process';
import {chmod,readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {registerHooks} from 'node:module';
const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
const input=JSON.parse(Buffer.concat(chunks));
const catalog=input.catalog;
for(const bundle of catalog.directTargetBundles) for(const key of ['skill','callerWorkflow']) bundle[key]=Buffer.from(bundle[key].data);
registerHooks({load(url,context,next){
 if(url===${JSON.stringify(uri("dist/consumer-integration/adapters/package-consumer-asset-catalog.js"))}) return {format:'module',shortCircuit:true,source:'export const packageConsumerAssetCatalogReader={read:async()=>globalThis.__restorationTestCatalog};'};
 const loaded=next(url,context);
 if(input.fault==='before-receipt' && url===${JSON.stringify(uri("dist/consumer-integration/adapters/node-consumer-restoration-evidence.js"))}) {
  return {...loaded,source:Buffer.from(loaded.source).toString().replace('export async function retainRestorationProof(path, proof) {',
   "export async function retainRestorationProof(path, proof) { if(path.endsWith('.receipt')) {process.stderr.write('TEST boundary: after public CAS, before receipt retention\\\\n');process.kill(process.pid,'SIGKILL');}")};
 }
 return loaded;
}});
globalThis.__restorationTestCatalog=catalog;
const {GitHubCohortAuthorityReader}=await import(${JSON.stringify(uri("dist/consumer-integration/adapters/github-cohort-authority-reader.js"))});
const projection=cohort=>({repository:'agent-teams-ai/.github',path:'governance/docs-qualified-cohorts.json',revision:'8'.repeat(40),cohort});
GitHubCohortAuthorityReader.prototype.read=async()=>projection(input.target);
GitHubCohortAuthorityReader.prototype.readRestoration=async()=>({source:projection(input.target),target:projection(input.origin)});
const {NodeConsumerUpgradeSandbox}=await import(${JSON.stringify(uri("dist/consumer-integration/adapters/node-consumer-upgrade-sandbox.js"))});
const activate=NodeConsumerUpgradeSandbox.prototype.activateAndVerifyV2;
NodeConsumerUpgradeSandbox.prototype.activateAndVerifyV2=async function(args){
 if(input.fault==='after-cas') {process.stderr.write('TEST boundary: after public CAS, before activation\\n');process.kill(process.pid,'SIGKILL');}
 await activate.call(this,args);
 process.stderr.write('TEST observation: real target activation passed\\n');
 if(input.fault==='after-activation') process.kill(process.pid,'SIGKILL');
 if(input.fault==='efbig') {process.on('SIGXFSZ',()=>{});const size=(await readFile(input.preparationPath)).length;execFileSync('prlimit',['--pid',String(process.pid),'--fsize='+size+':']);}
 if(input.fault==='eacces') await chmod(dirname(input.proofPath),0o500);
};
const {managedConsumerCommand:runManagedConsumerCommand}=await import(${JSON.stringify(uri("dist/consumer-integration/composition/managed-command.js"))});
process.exitCode=await runManagedConsumerCommand(input.argv);
`;
  const payload = { argv, catalog: fixture.fixtureCatalog, target: options.target ?? fixture.target, origin: options.origin ?? fixture.origin,
    fault: options.fault, proofPath: options.proofPath ?? fixture.proofPath, preparationPath: options.preparationPath ?? `${fixture.proofPath}.prepared` };
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fixture.consumerRoot, env: { ...process.env, ...options.env,
        ...(options.fault === "during-activation" ? { MANAGED_RESTORATION_KILL_CONTROLLER: "1" } : {}) },
      stdio: ["pipe", options.fault === "lost-output" ? "ignore" : "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout?.on("data", (data) => {stdout += data;}); child.stderr.on("data", (data) => {stderr += data;});
    child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
  const directory = process.env.MANAGED_RESTORATION_EVIDENCE_DIR;
  if (directory) {
    await mkdir(directory, { recursive: true });
    const name = `${String(++evidenceSequence).padStart(3, "0")}-${options.label ?? argv[0]}`;
    await writeFile(join(directory, `${name}.json`), `${JSON.stringify({ argv, fault: options.fault, ...result }, null, 2)}\n`, { flag: "wx" });
  }
  if (result.stdout.trim()) {result.execution = JSON.parse(result.stdout);}
  return result;
}

export function assertCliSuccess(result, outcome) {
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.execution?.outcome, outcome, JSON.stringify(result));
  return result.execution;
}
