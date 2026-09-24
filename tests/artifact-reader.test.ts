import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ArtifactReader} from '../apps/web/src/widgets/artifact-reader/index.tsx';
import type {Artifact,Revision} from '../packages/contracts/index.ts';
const first:Revision={id:'r1',number:1,filename:'first.html',mime:'text/html',size:30,totalSize:30,sha256:'a'.repeat(64),storageKind:'single',htmlProfile:'static',inlineBuild:null,createdAt:'2026-09-01T00:00:00Z'};
const latest:Revision={...first,id:'r2',number:2,filename:'second.html'};
const work:Artifact={id:'a',title:'Отчёт',folderId:null,updatedAt:first.createdAt,trashedAt:null,lifecycleVersion:1,revision:latest,share:{id:'s',revisionId:first.id,number:1,status:'behind',url:null,expiresAt:first.createdAt}};
function render(artifact:Artifact,shown=first){return renderToStaticMarkup(React.createElement(ArtifactReader,{work:artifact,shelfUrl:'https://polochka.app/works/a',shown,revisions:[latest,first],viewed:shown,folderName:'Исследования',history:true,setHistory:()=>{},setViewed:()=>{},setPanel:()=>{},preview:React.createElement('div',{'data-testid':'isolated-preview'},'Saved content'),onDownload:()=>{}}));}
test('reader distinguishes historical selection, current version and shared revision',()=>{
 const html=render(work);
 assert.match(html,/role="tablist" aria-label="Работа и версии"/);
 assert.match(html,/role="tabpanel"/);
 assert.match(html,/aria-selected="true"[^>]*>.*?Версии/);
 assert.match(html,/Вы смотрите версию 1/);
 assert.match(html,/К текущей версии/);
 assert.match(html,/По ссылке · v1/);
 assert.match(html,/first.html/);
 assert.doesNotMatch(html,/second.html/);
 assert.match(html,/data-testid="isolated-preview"/);
});
test('trashed reader keeps history/download while suppressing preview and mutation controls',()=>{
 const html=render({...work,trashedAt:first.createdAt});
 assert.doesNotMatch(html,/data-testid="isolated-preview"|Поделиться|Новая версия|Название и папка|Переработать с агентом/);
 assert.match(html,/Версии/);
 assert.match(html,/Скачать оригинал/);
 assert.match(html,/Просмотр отключён/);
});
test('reader profile describes the version on screen, not the latest one',()=>{
 const limited:Revision={...latest,htmlProfile:'limited'};
 const html=renderToStaticMarkup(React.createElement(ArtifactReader,{work:{...work,revision:limited},shelfUrl:'https://polochka.app/works/a',shown:first,revisions:[limited,first],viewed:first,folderName:'Исследования',history:false,setHistory:()=>{},setViewed:()=>{},setPanel:()=>{},preview:null,onDownload:()=>{}}));
 assert.match(html,/Страница · без скриптов/);
 assert.doesNotMatch(html,/ограниченный просмотр/);
});
