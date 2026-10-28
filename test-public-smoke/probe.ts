import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFeatureModule, STANDARD } from '@agent-teams/feature-module-standard';
import { conformanceCases } from '@agent-teams/feature-module-standard/fixtures';
import { checkFeatureModuleOnDisk } from '@agent-teams/feature-module-standard/node';
import { parseFoundationPackageSelfCheck } from '@agent-teams/engineering-foundation';
import type { upgradeConsumerIntegration } from '@agent-teams/docs-protocol-agent-teams';
// A compile-only probe: calls are never executed and no authority is fabricated.
type Upgrade = Parameters<typeof upgradeConsumerIntegration>[0];
const accepted: Upgrade = { consumerRoot: '.', to: 'smoke', targetGeneration: 3 };
// @ts-expect-error target generation is required in the public API.
const missing: Upgrade = { consumerRoot: '.', to: 'smoke' };
// @ts-expect-error generation 4 is outside the public contract.
const invalid: Upgrade = { consumerRoot: '.', to: 'smoke', targetGeneration: 4 };
void accepted; void missing; void invalid;
const selfPath=process.argv[3];assert.ok(selfPath);parseFoundationPackageSelfCheck(JSON.parse(readFileSync(selfPath,'utf8')));
for (const id of ['module-conforms','lateral-cycle']) {
  const fixture = conformanceCases.find(item => item.id === id); assert.ok(fixture);
  const report = checkFeatureModule(fixture.input);
  assert.equal(report.ok, fixture.ok);
  assert.deepEqual(report.diagnostics.map(item => item.code).sort(), [...fixture.expect].sort());
}
const root = process.argv[2]; assert.ok(root);
for (const feature of ['one','two']) {
  const path = join(root,'src/features',feature,'domain'); mkdirSync(path,{recursive:true});
  writeFileSync(join(path,'value.ts'), 'export const value = 1;\n',{flag:'wx'});
}
const options = {consumerRoot:root,sourceRoots:['src'],structure:{featuresRoot:'src/features',roleDirectories:{domain:'domain' as const}},surfaces:{public:[]}};
const positive = await checkFeatureModuleOnDisk(options); assert.equal(positive.ok,true);
writeFileSync(join(root,'src/features/one/domain/value.ts'),"import '../../two/domain/value.js';\nexport const value = 1;\n");
const negative = await checkFeatureModuleOnDisk(options); assert.equal(negative.ok,false);
assert.ok(negative.diagnostics.some(item => item.code === 'deep-import'));
process.stdout.write(JSON.stringify({kind:'public-consumer-probe/v1',standard:STANDARD,fixtures:['module-conforms','lateral-cycle'],nodeRunner:{positive:positive.ok,negative:negative.ok,codes:negative.diagnostics.map(item=>item.code)}})+'\n');
