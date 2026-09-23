import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSync } from 'rolldown/utils';
const layers=['shared','entities','features','widgets','pages','app'];
const inside=(parent,file)=>{const rel=relative(parent,file);return rel===''||(!rel.startsWith(`..${sep}`)&&rel!=='..'&&!rel.startsWith(sep));};

export function checkSource(file,source,root){
 const [layer,slice]=relative(root,file).split(sep);
 if(!layers.includes(layer))return [];
 const failures=[];
 const contracts=resolve(root,'../../../packages/contracts'),editorial=resolve(root,'../../../packages/editorial.ts'),legal=resolve(root,'../../../docs/legal');
 const fail=message=>failures.push(`${relative(root,file)}: ${message}`);
 let parsed;
 try{parsed=parseSync(file,source);}catch{fail('Cannot parse module');return failures;}
 if(parsed.errors.length){fail('Invalid module syntax');return failures;}
 function dependency(node){
  const specifier=node?.type==='Literal'&&typeof node.value==='string'?node.value:node?.type==='TemplateLiteral'&&node.expressions.length===0?node.quasis[0].value.cooked:null;
  if(specifier===null){fail('Computed module path cannot be checked; use literal imports');return;}
  if(!specifier.startsWith('.')){
   if(specifier.startsWith('/')||specifier.startsWith('node:')||specifier.startsWith('#'))fail(`Unsupported module path ${specifier}`);
   return;
  }
  const target=resolve(dirname(file),specifier.split(/[?#]/)[0]);
  if(!inside(root,target)){
   // Legal texts are reviewed as Markdown in docs/legal and bundled as raw strings.
   const legalText=inside(legal,target)&&target.endsWith('.md')&&specifier.endsWith('?raw');
   if(!inside(contracts,target)&&target!==editorial&&!legalText)fail(`Outside frontend contracts: ${specifier}`);
   return;
  }
  const [to,toSlice]=relative(root,target).split(sep);
  if(!layers.includes(to)||layers.indexOf(to)>layers.indexOf(layer)||(to===layer&&to!=='shared'&&to!=='app'&&toSlice!==slice))fail(`Invalid dependency → ${relative(root,target)}`);
 }
 function visit(node){
  if(!node||typeof node!=='object')return;
  if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration','ImportExpression'].includes(node.type)&&node.source)dependency(node.source);
  if(node.type==='TSImportType')dependency(node.argument);
  if(node.type==='TSExternalModuleReference')dependency(node.expression);
  if(node.type==='CallExpression'&&node.callee?.type==='Identifier'&&node.callee.name==='require')dependency(node.arguments[0]);
  for(const [key,value] of Object.entries(node)){if(['comments','tokens'].includes(key))continue;if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}
 }
 visit(parsed.program);return failures;
}
export function checkTree(root){
 let checked=0;const failures=[];
 function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const file=resolve(dir,entry.name);if(entry.isDirectory())walk(file);else if(/\.(tsx?|mjs|jsx?)$/.test(entry.name)){if(layers.includes(relative(root,file).split(sep)[0])){checked++;failures.push(...checkSource(file,readFileSync(file,'utf8'),root));}else if(!['main.tsx','component-catalog-entry.tsx','vite-env.d.ts'].includes(relative(root,file)))failures.push(`${relative(root,file)}: Module must belong to a frontend layer`);}}}
 walk(root);return {checked,failures};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const {checked,failures}=checkTree(resolve('apps/web/src'));
 if(failures.length){console.error('Invalid frontend layer dependencies:\n'+failures.join('\n'));process.exitCode=1;}
 else console.log(`Frontend layers: ${checked} migrated modules checked (syntax, static/dynamic/type imports). Only mount/dev entries and Vite declarations are allowed outside layers.`);
}
