export const factoryCaseData0 = [
  [
    "module object write",
    "const state={execute:safe}; state.execute=read; function createApi(){return state;}",
  ],
  [
    "module factory reassignment",
    "function createApi(){return {execute:safe};} createApi=()=>({execute:read});",
  ],
  [
    "module alias escape",
    "const state={execute:safe}; const alias=state; function replace(x){x.execute=read;} replace(alias); function createApi(){return state;}",
  ],
  [
    "factory invokes captured module writer",
    "const state={execute:safe}; function createApi(){const ignored=replace(); return state;} function replace(){state.execute=read;}",
  ],
  [
    "module destructured alias escape",
    "const state={execute:safe}; const {alias}={alias:state}; function replace(x){x.execute=read;} replace(alias); function createApi(){return state;}",
  ],
  [
    "module loop assignment",
    "const state={execute:safe}; for(state.execute of [read]){} function createApi(){return state;}",
  ],
  [
    "module captured default write",
    "const state={execute:safe}; function replace(x=(state.execute=read)){} function createApi(){return state;}",
  ],
] as const;
export const factoryCaseData1 = [
  ["default parameter alias", "function replace(alias=state){alias.execute=read;} replace();"],
  [
    "destructured parameter alias",
    "function replace({alias=state}={}){alias.execute=read;} replace();",
  ],
  ["array parameter alias", "function replace([alias=state]=[]){alias.execute=read;} replace();"],
  [
    "default before body alias shadow",
    "function replace(alias=state){var state={}; alias.execute=read;} replace();",
  ],
  ["for-of declaration alias", "for(const alias of [state]){alias.execute=read;}"],
  ["for-of destructured alias", "for(const {alias} of [{alias:state}]){alias.execute=read;}"],
  ["for-of var alias", "for(var alias of [state]){alias.execute=read;}"],
  ["temporary returned property write", "function expose(){return state;} expose().execute=read;"],
  [
    "temporary returned destructuring target",
    "function expose(){return state;} ({value:expose().execute}={value:read});",
  ],
  [
    "temporary returned loop target",
    "function expose(){return state;} for(expose().execute of [read]){}",
  ],
  ["temporary IIFE target", "(()=>state)().execute=read;"],
  ["temporary returned update", "function expose(){return state;} expose().execute++;"],
  ["temporary returned delete", "function expose(){return state;} delete expose().execute;"],
  [
    "generator yield alias",
    "function* expose(){yield state;} const {value:alias}=expose().next(); alias.execute=read;",
  ],
  [
    "generator delegation alias",
    "function* expose(){yield* [state];} const {value:alias}=expose().next(); alias.execute=read;",
  ],
  [
    "generator returned alias",
    "function* expose(){return state;} const {value:alias}=expose().next(); alias.execute=read;",
  ],
  [
    "async then alias",
    "async function expose(){return state;} await expose().then(alias=>{alias.execute=read;});",
  ],
  ["async IIFE then alias", "await (async()=>state)().then(alias=>{alias.execute=read;});"],
  [
    "async generator yielded alias",
    "async function* expose(){yield state;} for await(const alias of expose()){alias.execute=read;}",
  ],
  ["throw catch alias", "try{throw state;}catch(alias){alias.execute=read;}"],
  [
    "throw constructor returned alias",
    "class Expose{constructor(){return state;}} try{throw new Expose();}catch(alias){alias.execute=read;}",
  ],
  [
    "throw returned alias",
    "function expose(){return state;} try{throw expose();}catch(alias){alias.execute=read;}",
  ],
  [
    "returned alias write",
    "function expose(){return state;} const alias=expose(); alias.execute=read;",
  ],
  [
    "arrow returned alias write",
    "const expose=()=>state; const alias=expose(); alias.execute=read;",
  ],
  [
    "block arrow returned alias write",
    "const expose=()=>{return state;}; const alias=expose(); alias.execute=read;",
  ],
  [
    "returned alias chain write",
    "function expose(){return state;} const first=expose(); const alias=first; alias.execute=read;",
  ],
  [
    "returned object alias write",
    "function expose(){return {value:state};} const holder=expose(); holder.value.execute=read;",
  ],
  ["binding default execution", "const {value=(state.execute=read)}={};"],
  ["array binding default execution", "const [value=(state.execute=read)]=[];"],
  ["binding computed key execution", "const {[state.execute=read]:value}={};"],
  ["nested binding default execution", "const {nested:{value=(state.execute=read)}}={nested:{}};"],
  ["for initializer binding execution", "for(const {value=(state.execute=read)}={};false;){}"],
  ["switch discriminant outer binding", "switch(state.execute=read){default: const state={};}"],
] as const;
export const factoryCaseData2 = [
  ["factory default alias", "function change(alias=api){alias.execute=provided;}"],
  [
    "factory destructured default alias",
    "function change({alias=api}={}){alias.execute=provided;}",
  ],
  ["factory loop alias", "function change(){for(const alias of [api]){alias.execute=provided;}}"],
  ["factory temporary IIFE target", "function change(){(()=>api)().execute=provided;}"],
  [
    "factory async wrapper alias",
    "function change(){return (async()=>api)().then(alias=>{alias.execute=provided;});}",
  ],
  [
    "factory thrown alias",
    "function change(){try{throw api;}catch(alias){alias.execute=provided;}}",
  ],
  [
    "factory returned alias",
    "function change(){function expose(){return api;} const alias=expose(); alias.execute=provided;}",
  ],
  ["factory binding execution", "function change(){const {value=(api.execute=provided)}={};}"],
  [
    "factory switch discriminant",
    "function change(){switch(api.execute=provided){default:const api={};}}",
  ],
] as const;
export const factoryCaseData3 = [
  ["unused returned alias", "function expose(){return state;} const alias=expose();"],
  ["unused arrow returned alias", "const expose=()=>state; const alias=expose();"],
  [
    "alias binding reassignment",
    "function expose(){return state;} let alias=expose(); alias={execute:read};",
  ],
  ["returned primitive", "function expose(){return 1;} const alias=expose();"],
  [
    "parameter alias of inner shadow",
    "function replace(state,alias=state){alias.execute=read;} replace({});",
  ],
  ["block binding initializer shadow", "{const state={}; const {value=(state.execute=read)}={};}"],
  ["switch case local binding", "switch(1){default:const state={}; state.execute=read;}"],
  [
    "switch test local binding",
    "switch(1){case (state.execute=read): break; default:const state={};}",
  ],
  ["for-of loop binding shadow", "for(const state of [{}]){state.execute=read;}"],
] as const;
export const factoryCaseData4 = [
  ["default parameter captured write", "function change(value=(api.execute=provided)){}"],
  [
    "default parameter body var does not shadow",
    "function change(value=(api.execute=provided)){var api;}",
  ],
  [
    "default parameter body function does not shadow",
    "function change(value=(api.execute=provided)){function api(){}}",
  ],
  ["destructured default captured write", "function change({value=(api.execute=provided)}={}){}"],
  ["computed parameter captured write", "function change({[api.execute=provided]:value}={}){}"],
  ["for-of captured target", "function change(){for(api.execute of [provided]){}}"],
  ["for-in captured target", "function change(){for(api.execute in {a:provided}){}}"],
  [
    "destructured for-of captured target",
    "function change(){for({value:api.execute} of [{value:provided}]){}}",
  ],
  ["ordinary captured write", "function change(){api.execute=provided;}"],
] as const;
export const factoryCaseData5 = [
  [
    "dynamic receiver access",
    'function make(){return {execute:safe,change(){eval("this.execute=read");}};} const api=make(); api.change();',
  ],
  [
    "receiver mutation",
    "function make(){return {execute:safe,change(){this.execute=read;}};} const api=make(); api.change();",
  ],
  [
    "receiver escape",
    "function make(){return {execute:safe,change(){replace(this);}};} function replace(api){api.execute=read;} const api=make(); api.change();",
  ],
  [
    "unknown receiver method",
    "function make(){return {execute:safe,change:opaque};} const api=make(); api.change();",
  ],
] as const;
