import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,realpathSync,writeFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
export interface CapturedInput {readonly bytes:Buffer;readonly sha256:string;}
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
export function captureInput(path:string,expected:string):CapturedInput {
  if(!isAbsolute(path)||realpathSync(path)!==path||!/^[a-f0-9]{64}$/.test(expected))throw Error('INPUT_PATH_OR_DIGEST');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=fstatSync(fd,{bigint:true});if(!before.isFile()||before.nlink!==1n||before.size<=0||before.size>32n*1024n*1024n)throw Error('INPUT_FILE_BOUND');
    const buffer=Buffer.alloc(Number(before.size)+1);let count=0;
    while(count<buffer.length){const n=readSync(fd,buffer,count,buffer.length-count,count);if(n===0)break;count+=n;}
    const after=fstatSync(fd,{bigint:true}),named=lstatSync(path,{bigint:true});
    for(const k of ['dev','ino','size','mtimeNs','ctimeNs','nlink'] as const)if(before[k]!==after[k]||before[k]!==named[k])throw Error('INPUT_CHANGED');
    const bytes=Buffer.from(buffer.subarray(0,count));if(count!==Number(before.size)||hash(bytes)!==expected)throw Error('INPUT_BYTES');
    return{bytes,sha256:expected};
  }finally{closeSync(fd);}
}
export function writeCapturedInput(input:CapturedInput,path:string):void {
  if(hash(input.bytes)!==input.sha256)throw Error('CAPTURE_CHANGED');
  writeFileSync(path,input.bytes,{flag:'wx',mode:0o600});
}
