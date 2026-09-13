/** Demo repository only. Never use its in-memory decisions as authorization. */
export const folders = ['Команда', 'Проекты', 'Для вдохновения'];
export const accessLabels = { private: 'Только я', invited: 'Приглашённые', link: 'По ссылке' };
export const typeLabels = { report: 'HTML-отчёт', prototype: 'Прототип', presentation: 'Презентация', page: 'Мини-сайт', notes: 'Заметки' };

const seeds = [
  { id: 'pulse', name: 'Пульс команды · сентябрь', kind: 'report', folder: 'Команда', version: 3, published: 2, access: 'link', fav: true, changed: 5 },
  { id: 'launch', name: 'Запуск нового сервиса', kind: 'prototype', folder: 'Проекты', version: 1, fav: false, changed: 4 },
  { id: 'cities', name: 'Города, которые нас изменили', kind: 'presentation', folder: 'Для вдохновения', version: 2, fav: true, changed: 3 },
  { id: 'handbook', name: 'Как мы работаем', kind: 'page', folder: 'Команда', version: 1, fav: false, changed: 2 },
  { id: 'notes', name: 'Идеи для следующего запуска', kind: 'notes', folder: 'Проекты', version: 2, fav: false, changed: 1 },
];

export function linkStatus(work) {
  if (work.access === 'private' || !work.published) return 'none';
  if (work.revoked) return 'revoked';
  return work.version > work.published ? 'behind' : 'live';
}
export function demoLink(work) {
  return ['live', 'behind'].includes(linkStatus(work))
    ? `https://polka.example/s/demo-${work.id}-${work.generation}` : null;
}
export function pluralWorks(count) {
  const rest = count % 100;
  return `${count} ${rest >= 11 && rest <= 14 ? 'работ' : count % 10 === 1 ? 'работа' : count % 10 >= 2 && count % 10 <= 4 ? 'работы' : 'работ'}`;
}

export function createDemoRepository() {
  let works = [], counter = 5;
  const copy = value => structuredClone(value);
  const find = id => {
    const work = works.find(item => item.id === id);
    if (!work) throw new Error('Работа не найдена');
    return work;
  };
  const touch = work => { work.changed = ++counter; };
  const defaults = {
    access: 'private', published: 0, generation: 1, revoked: false,
    pinned: false, expiry: 'Без срока', copy: false, download: true,
    previewCover: false, invites: [], fav: false,
  };
  const repository = {
    reset(empty = false) {
      counter = 5;
      works = empty ? [] : seeds.map(work => ({ ...copy(defaults), ...work }));
    },
    get(id) { return copy(find(id)); },
    all() { return copy(works); },
    list({ folder = '', query = '', filter = 'all', kind = 'all', sort = 'changed' } = {}) {
      let result = works.filter(work => (!folder || work.folder === folder)
        && (filter !== 'favorites' || work.fav)
        && (kind === 'all' || work.kind === kind)
        && work.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')));
      result.sort(sort === 'name'
        ? (a, b) => a.name.localeCompare(b.name, 'ru')
        : (a, b) => b.changed - a.changed);
      if (filter === 'recent') result = result.slice(0, 3);
      return copy(result);
    },
    toggleFavorite(id) { const work = find(id); work.fav = !work.fav; return copy(work); },
    add({ name, folder = folders[0], kind = 'report' }) {
      const work = { ...copy(defaults), id: `new-${++counter}`, name: name.trim() || 'Новая работа', folder, kind, version: 1, changed: counter };
      works.unshift(work);
      return copy(work);
    },
    addVersion(id) { const work = find(id); work.version++; touch(work); return copy(work); },
    saveOptions(id, options) {
      const work = find(id);
      // Changing options must never re-enable a revoked link or publish a draft.
      for (const key of ['pinned', 'expiry', 'copy', 'download', 'previewCover', 'invites']) {
        if (key in options) work[key] = copy(options[key]);
      }
      return copy(work);
    },
    enableLink(id, access = 'link') {
      if (!['link', 'invited'].includes(access)) throw new Error('Выберите аудиторию');
      const work = find(id);
      if (work.revoked || work.access === 'private') work.generation++;
      work.access = access;
      work.revoked = false;
      if (!work.published) work.published = work.version;
      return copy(work);
    },
    makePrivate(id) {
      const work = find(id);
      work.access = 'private';
      work.revoked = true;
      return copy(work);
    },
    revoke(id) { const work = find(id); work.revoked = true; return copy(work); },
    publish(id, expectedPublished) {
      const work = find(id);
      if (!demoLink(work)) throw new Error('Сначала откройте доступ');
      if (work.pinned) throw new Error('Эта ссылка закреплена на версии');
      if (expectedPublished !== work.published) throw new Error('Версия по ссылке уже изменилась. Проверьте её снова.');
      work.published = work.version;
      return copy(work);
    },
  };
  repository.reset();
  return repository;
}
