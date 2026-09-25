import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ArtifactReader,readerTabFromSearch,withReaderTab,workMenu} from '../apps/web/src/widgets/artifact-reader/index.tsx';
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
test('the reader is one bar: version, tabs, details, share and «…»; the work fills the rest',()=>{
 const html=render({...work,share:null},latest);
 assert.match(html,/class="work-bar"/);
 assert.match(html,/<h1 class="work-bar-title" title="Отчёт">Отчёт<\/h1>/);
 assert.match(html,/aria-label="Версия 2 из 2: выбрать версию"/);
 assert.match(html,/aria-label="О работе"/);
 assert.match(html,/aria-label="Поделиться"/);
 assert.match(html,/aria-label="Ещё действия"/);
 // Under «Версии» the stage stays mounted (a running page keeps its state), hidden.
 assert.match(html,/<section class="stage" hidden=""/);
 assert.doesNotMatch(html,/Скопировать для агента|Новая версия|work-heading|work-foot/);
});
test('«…» holds every other action; a trashed work only downloads',()=>{
 const labels=(artifact:Artifact,shown=latest)=>workMenu({work:artifact,shown,setPanel:()=>{},onDownload:()=>{},onCopyForAgent:()=>{}}).map((item)=>item.label);
 assert.deepEqual(labels(work),['Скопировать для агента','Подробный контекст для агента','Новая версия','Переработать с агентом','Скачать оригинал','Название и папка','В корзину']);
 assert.deepEqual(labels({...work,trashedAt:first.createdAt}),['Скачать оригинал']);
 assert.deepEqual(labels({...work,trashedAt:first.createdAt},{...latest,storageKind:'bundle'}),['Скачать весь пакет']);
});
test('the reader tab lives in the address: ?tab=versions survives a reload, «work» leaves no trace',()=>{
 assert.equal(readerTabFromSearch('?tab=versions'),'versions');
 assert.equal(readerTabFromSearch('?tab=other'),'work');
 assert.equal(readerTabFromSearch(''),'work');
 assert.equal(withReaderTab('https://polochka.app/works/a','versions'),'/works/a?tab=versions');
 assert.equal(withReaderTab('https://polochka.app/works/a?revision=r1&tab=versions#c','work'),'/works/a?revision=r1#c');
 assert.equal(withReaderTab('https://polochka.app/works/a?revision=r1','versions'),'/works/a?revision=r1&tab=versions');
});
