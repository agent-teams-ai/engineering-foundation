// Private Linux TEST Host policy, adapted from Foundation14753 NodeProcessRunner POSIX group algorithm.
// NOB owns completion/capture; these PUBLIC paired hooks own this ordinary inherited POSIX group.
// No setsid escape or arbitrary descendant containment claim. Only ESRCH proves group absence.
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {publicToolExports} from './tool-bootstrap.ts';
import type {ProcessRuntimeFacts,ProcessRunResult} from 'node-or-bun';
export interface GroupFacts {scope:'owned-inherited-posix-group';pgid:number|null;cause:string|null;termRequested:boolean;killRequested:boolean;settled:boolean;debt:string|null;}
export interface OwnedResult extends ProcessRunResult {readonly group:GroupFacts;}
export class OwnedRunError extends Error {
  readonly code:string;readonly facts:ProcessRuntimeFacts|null;readonly output:{stdout:string;stderr:string}|null;readonly group:GroupFacts;
  constructor(code:string,facts:ProcessRuntimeFacts|null,output:{stdout:string;stderr:string}|null,group:GroupFacts){super(code);this.code=code;this.facts=facts;this.output=output;this.group={...group};}
}
export async function createOwnedExecutor(prefix:string){
  if(process.platform!=='linux')throw Error('LINUX_GROUP_QUALIFICATION_REQUIRED');
  const entries=publicToolExports(prefix);
  const runtime:typeof import('node-or-bun')=await import(pathToFileURL(entries.root).href);
  const node:typeof import('node-or-bun/node')=await import(pathToFileURL(entries.node).href);
  let retainedDebt=false;
  return{async run(command:string,args:readonly string[],cwd:string,environment:NodeJS.ProcessEnv,timeoutMs=900000):Promise<OwnedResult>{
    if(retainedDebt)throw Error('RETAINED_PROCESS_CUSTODY_DEBT_NO_REPLAY');
    const group:GroupFacts={scope:'owned-inherited-posix-group',pgid:null,cause:null,termRequested:false,killRequested:false,settled:false,debt:null};
    const absent=()=>{try{process.kill(-group.pgid!,0);return false;}catch(e){if(e instanceof Error&&'code'in e&&e.code==='ESRCH')return true;throw Error('GROUP_OBSERVATION_DENIED');}};
    const signal=(name:NodeJS.Signals)=>{try{process.kill(-group.pgid!,name);}catch(e){if(!(e instanceof Error&&'code'in e&&e.code==='ESRCH'))throw Error('GROUP_SIGNAL_DENIED');}};
    const wait=async(ms:number)=>{const end=performance.now()+ms;do{if(absent())return true;await delay(10);}while(performance.now()<end);return absent();};
    const executor=runtime.createProcessExecutor(node.createNodeProcessAdapter({
      acquire(request,retain){const child=spawn(request.command,[...request.args],{cwd:request.cwd,env:{...request.environment},detached:true,shell:false,stdio:['ignore','pipe','pipe'],windowsHide:true});retain(child);group.pgid=child.pid??null;},
      async cleanup(_child,cause){group.cause=cause;
        try{if(group.pgid===null){group.settled=true;return;}if(absent()){group.settled=true;return;}
          group.termRequested=true;signal('SIGTERM');if(await wait(200)){group.settled=true;return;}
          group.killRequested=true;signal('SIGKILL');if(await wait(400)){group.settled=true;return;}
          throw Error('GROUP_SETTLEMENT_UNPROVEN');
        }catch(e){group.debt=e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'GROUP_CLEANUP_FAILED';retainedDebt=true;throw e;}
      },
    }));
    const env=Object.fromEntries(Object.entries(environment).filter((v):v is [string,string]=>v[1]!==undefined));
    try{const result=await executor.run({command,args,cwd,environment:env,timeoutMs,strictUtf8:true});
      if(result.facts.incompleteCustody||!group.settled||group.debt||result.facts.lateFailureCodes.length||!result.facts.outputBounded||result.facts.observedExit===null){retainedDebt=true;group.debt??='INCOMPLETE_PROCESS_FACTS';throw new OwnedRunError('INCOMPLETE_PROCESS_FACTS',result.facts,{stdout:result.stdout,stderr:result.stderr},group);}
      return{...result,group:{...group}};
    }catch(error){if(error instanceof OwnedRunError)throw error;
      if(runtime.isProcessRuntimeError(error)){if(error.facts.incompleteCustody||!group.settled||group.debt){retainedDebt=true;group.debt??='NOB_GROUP_SETTLEMENT_UNPROVEN';}throw new OwnedRunError('NOB_'+error.code.replaceAll('-','_').toUpperCase(),error.facts,error.output,group);}
      retainedDebt=true;throw new OwnedRunError('HOST_PROCESS_FAILURE',null,null,group);
    }
  }};
}
