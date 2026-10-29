// Exact public control asset only; no registry install, SDK, private implementation or credentials.
import {gunzipSync} from 'node:zlib';
import {mkdirSync,existsSync,writeFileSync,readFileSync,lstatSync,readdirSync,realpathSync} from 'node:fs';
import {join,dirname,resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {captureInput} from './inputs.ts';
const SHA='1ce3f9bf3e9ff9028207c52edde4039a5687e85fc6e5713a827dd59eb5e53ecb';
const SRI='sha512-oPk7oyOqj+5TUPVsmq9cpCBNobD/DEFiKHdhXyt9n0Ncr0cFcrQEO56dro8yK+DREog7mk4FULojIi8joTWp7w==';
export function bootstrapTool(archive:string,prefix:string):void {
  const bytes=captureInput(archive,SHA).bytes;
  if(bytes.length!==35491||'sha512-'+createHash('sha512').update(bytes).digest('base64')!==SRI)throw Error('TOOL_ARCHIVE_SRI');
  const tar=gunzipSync(bytes,{maxOutputLength:2*1024*1024}),files=new Map<string,Buffer>();let total=0;
  for(let at=0;at+512<=tar.length;){const head=tar.subarray(at,at+512);if(head.every(v=>v===0))break;
    const name=head.subarray(0,100).toString().split('\0')[0]!,prefixField=head.subarray(345,500).toString().split('\0')[0]!;
    const sizeText=head.subarray(124,136).toString().replace(/\0/g,'').trim(),sumText=head.subarray(148,156).toString().replace(/\0/g,'').trim();
    if(prefixField||!/^package\/(?:LICENSE|README\.md|CHANGELOG\.md|package\.json|dist\/[A-Za-z0-9_./-]+)$/.test(name)||name.split('/').includes('..')||!['0','\0'].includes(String.fromCharCode(head[156]!))||!/^[0-7]+$/.test(sizeText)||!/^[0-7]+$/.test(sumText))throw Error('TOOL_TAR_MEMBER');
    const copy=Buffer.from(head);copy.fill(32,148,156);if(copy.reduce((a,b)=>a+b,0)!==parseInt(sumText,8))throw Error('TOOL_TAR_CHECKSUM');
    const length=parseInt(sizeText,8),relative=name.slice(8);total+=length;if(length>262144||total>2*1024*1024||files.size>=256||files.has(relative)||at+512+length>tar.length)throw Error('TOOL_TAR_BOUND');
    files.set(relative,Buffer.from(tar.subarray(at+512,at+512+length)));at+=512+Math.ceil(length/512)*512;
  }
  const manifest=JSON.parse(files.get('package.json')?.toString()??'null');if(manifest?.name!=='node-or-bun'||manifest.version!=='0.2.5'||!files.has('LICENSE'))throw Error('TOOL_PACKAGE');
  if(!isAbsolute(prefix)||resolve(prefix)!==prefix||realpathSync(dirname(prefix))!==dirname(prefix))throw Error('TOOL_PREFIX');
  const destination=join(prefix,'node_modules/node-or-bun');
  if(existsSync(prefix)){
    if(JSON.stringify(readdirSync(prefix).sort())!==JSON.stringify(['node_modules'])||JSON.stringify(readdirSync(join(prefix,'node_modules')).sort())!==JSON.stringify(['node-or-bun']))throw Error('TOOL_PREFIX_INVENTORY');
    for(const directory of [prefix,join(prefix,'node_modules'),destination])if(realpathSync(directory)!==directory||lstatSync(directory).isSymbolicLink()||!lstatSync(directory).isDirectory())throw Error('TOOL_PREFIX_ALIAS');
    const seen:string[]=[];const walk=(p:string,relative='')=>{for(const n of readdirSync(p)){const rel=relative?relative+'/'+n:n,path=join(p,n),s=lstatSync(path);if(s.isSymbolicLink())throw Error('TOOL_ALIAS');if(s.isDirectory())walk(path,rel);else{if(!s.isFile()||s.nlink!==1)throw Error('TOOL_FILE');seen.push(rel);}}};
    walk(destination);if(seen.length!==files.size||seen.some(n=>!files.has(n)||!readFileSync(join(destination,n)).equals(files.get(n)!)))throw Error('TOOL_PREFIX_DRIFT');return;
  }
  mkdirSync(destination,{recursive:true,mode:0o700});
  for(const [name,data]of files){const path=join(destination,name);mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,data,{flag:'wx',mode:0o400});}
}
// Resolve only the two declared public ESM import exports; package intentionally has no require condition.
export function publicToolExports(prefix:string):{root:string;node:string}{
  const root=join(prefix,'node_modules/node-or-bun'),manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  const entry=(key:'.'|'./node')=>{const path=manifest.exports?.[key]?.import;if(typeof path!=='string'||!path.startsWith('./'))throw Error('TOOL_PUBLIC_EXPORT');const file=resolve(root,path);if(!file.startsWith(root+'/')||realpathSync(file)!==file)throw Error('TOOL_PUBLIC_EXPORT_ESCAPE');return file;};
  return{root:entry('.'),node:entry('./node')};
}
