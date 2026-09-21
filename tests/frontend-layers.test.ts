import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolve} from 'node:path';
// @ts-expect-error Build-time JS checker is deliberately importable without invoking its CLI.
import {checkSource,checkTree} from '../scripts/check-frontend-layers.mjs';
const root=resolve('apps/web/src'),file=resolve(root,'features/example/index.tsx');
const check=(source:string)=>checkSource(file,source,root);
test('layer gate checks static, lazy, re-export and type-only boundaries',()=>{
 for(const source of [
  'import x from "../../pages/bring/index.tsx";',
  'export * from "../../App.tsx";',
  'const x=()=>import("../../widgets/navigation/index.tsx");',
  'type X=import("../../pages/bring/index.tsx").X;',
  'import type {X} from "../another/index.ts";',
  'const x=require("../../App.tsx");',
  'import x = require("../../App.tsx");',
 ])assert.equal(check(source).length,1,source);
});
test('layer gate ignores comment/string decoys and permits lower-layer contracts',()=>{
 assert.deepEqual(check(`// import x from "../../App.tsx";
 const message='import x from "../../App.tsx"';
 import type {X} from '../../../../../packages/contracts/index.ts';
 import type {Y} from '../../../../../packages/editorial.ts';
 import {Button} from '../../shared/ui/controls.tsx';
 const view=()=>import('../../entities/artifact/format.ts');
 const elem=<div>{message}</div>;`),[]);
});
test('layer gate rejects server escape, deceptive prefix, computed import and invalid syntax',()=>{
 for(const source of [
 'import {db} from "../../../../server/db.ts";',
 'import x from "../../../../../packages/contracts-private/index.ts";',
 'const x=import(path);',
 'const x=import(`../../${name}/index.ts`);',
 'import fs from "node:fs";',
 'import x from "/src/App.tsx";',
 'const = ;',
 ])assert(check(source).length>0,source);
});

test('app composes app segments while feature slices stay independent',()=>{
 assert.deepEqual(checkSource(resolve(root,'app/routing/index.tsx'),'import {App} from "../workspace/index.tsx";',root),[]);
 assert.equal(check('import {other} from "../another/index.tsx";').length,1);
});

test('new unlayered modules cannot silently enter the application',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'polka-layer-gate-'));
 try{writeFileSync(resolve(root,'main.tsx'),'');assert.deepEqual(checkTree(root).failures,[]);writeFileSync(resolve(root,'OldGallery.tsx'),'export const Gallery=()=>null;');assert.equal(checkTree(root).failures.length,1);}finally{rmSync(root,{recursive:true});}
});
