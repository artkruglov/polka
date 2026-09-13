import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoRepository, demoLink, linkStatus, pluralWorks } from './model.mjs';

test('new work starts private; draft changes do not grant access', () => {
  const repo=createDemoRepository(), work=repo.add({name:'Пример'});
  assert.equal(work.access,'private');
  assert.equal(demoLink(work),null);
  const draft=repo.get(work.id); draft.access='link'; draft.invites.push('person@example.test');
  assert.equal(demoLink(repo.get(work.id)),null);
  assert.deepEqual(repo.get(work.id).invites,[]);
});
test('copy address exists only after explicit activation', () => {
  const repo=createDemoRepository();
  assert.equal(demoLink(repo.get('launch')),null);
  const enabled=repo.enableLink('launch');
  assert.ok(demoLink(enabled));
  assert.equal(enabled.published,1);
});
test('saving a new version keeps published revision and address', () => {
  const repo=createDemoRepository(), before=repo.get('pulse');
  repo.addVersion('pulse');
  assert.equal(repo.get('pulse').published,before.published);
  assert.equal(demoLink(repo.get('pulse')),demoLink(before));
  const updated=repo.publish('pulse',before.published);
  assert.equal(updated.published,4);
  assert.equal(demoLink(updated),demoLink(before));
});
test('stale publish is rejected and cannot overwrite the linked revision', () => {
  const repo=createDemoRepository();
  repo.publish('pulse',2);
  repo.addVersion('pulse');
  assert.throws(()=>repo.publish('pulse',2),/уже изменилась/);
  assert.equal(repo.get('pulse').published,3);
});
test('revoked link stays revoked after saving options; explicit reactivation rotates address', () => {
  const repo=createDemoRepository(), oldAddress=demoLink(repo.get('pulse'));
  repo.revoke('pulse'); repo.saveOptions('pulse',{download:false,expiry:'7 дней'});
  assert.equal(linkStatus(repo.get('pulse')),'revoked');
  assert.equal(demoLink(repo.get('pulse')),null);
  assert.throws(()=>repo.publish('pulse',2),/Сначала/);
  const restored=repo.enableLink('pulse');
  assert.notEqual(demoLink(restored),oldAddress);
  assert.equal(restored.download,false);
  assert.equal(restored.published,2);
});
test('private transition invalidates the old address and pinned link cannot publish', () => {
  const repo=createDemoRepository(), oldAddress=demoLink(repo.get('pulse'));
  repo.makePrivate('pulse');assert.equal(demoLink(repo.get('pulse')),null);
  assert.notEqual(demoLink(repo.enableLink('pulse')),oldAddress);
  repo.saveOptions('pulse',{pinned:true});
  assert.throws(()=>repo.publish('pulse',2),/закреплена/);
});
test('recent, favorite, folder and type filters have observable results', () => {
  const repo=createDemoRepository();
  assert.equal(repo.list({filter:'recent'}).length,3);
  repo.addVersion('handbook');assert.equal(repo.list({filter:'recent'})[0].id,'handbook');
  repo.toggleFavorite('launch');assert.ok(repo.list({filter:'favorites'}).some(work=>work.id==='launch'));
  assert.equal(repo.list({folder:'Команда'}).length,2);
  assert.deepEqual(repo.list({query:'ГОРОДА',kind:'presentation'}).map(work=>work.id),['cities']);
  assert.equal(pluralWorks(12),'12 работ');assert.equal(pluralWorks(21),'21 работа');
});
