import { createDemoRepository, folders, accessLabels, typeLabels, pluralWorks, demoLink, linkStatus } from './model.mjs';
import { esc, icon, button, brand } from './common.mjs';
import { cover, preview } from './previews.mjs';

const repository = createDemoRepository();
const initialUI = { view: 'shelf', selected: 'pulse', folder: '', query: '', filter: 'all', kind: 'all', sort: 'changed', layout: 'grid', slide: 0, period: 'week', tasks: [], focus: false, viewedVersion: null, invitedScenario: false, recipientMode: null, signedIn: false };
let state = { ...initialUI }, draft = null, uploadMode = 'new', uploadDraft = null, toastTimer, opener = null;
const root = document.getElementById('app');
const getWork = () => repository.get(state.selected);
const accessIcon = { private: 'lock', invited: 'people', link: 'link' };

function notify(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.textContent = '', 5000);
}
function go(view, options = {}) {
  document.getElementById('navigation-dialog')?.close();
  state = { ...state, ...options, view };
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function accessChip(work, pill = false) {
  const label = work.access==='private' ? 'Только я' : work.revoked ? 'Ссылка отключена' : accessLabels[work.access];
  return `<span class="tag ${pill?'pill':''} ${work.access==='link'&&!work.revoked?'external':''}">${icon(work.revoked?'lock':accessIcon[work.access])}${label}</span>`;
}
function sidebar() {
  return `<aside class="sidebar">${brand()}<div class="space-label">${icon('folder')}<div>Личная полка<small>Ваше пространство</small></div></div><nav class="nav" aria-label="Основная навигация">${[
    ['home','grid','Моя полка',state.filter==='all'&&state.view==='shelf'],
    ['recent','clock','Недавние',state.filter==='recent'],
    ['favorites','star','Избранное',state.filter==='favorites']
  ].map(([action, glyph, text, active])=>`<button data-action="${action}" class="${active?'active':''}" ${active?'aria-current="page"':''}>${icon(glyph)}${text}${action==='home'?`<span class="count">${repository.all().length}</span>`:''}</button>`).join('')}</nav><div><div class="nav-heading">Папки</div><nav class="nav" aria-label="Папки">${folders.map((folder,index)=>`<button data-action="folder" data-folder="${esc(folder)}" class="${state.view==='folder'&&state.folder===folder?'active':''}"><span class="folder-dot f${index}"></span>${esc(folder)}</button>`).join('')}</nav></div><div class="side-foot"><span class="avatar">АК</span><div><p>Артём</p><small>Демонстрационный профиль</small></div></div></aside>`;
}
function topbar() {
  return `<header class="topbar">${button('navigation',icon('menu'),'square quiet mobile-menu','aria-label="Открыть навигацию"')}<span class="location">Личное пространство</span><div class="grow"></div><label class="search">${icon('search')}<input type="search" id="search" aria-label="Найти на полке" placeholder="Найти работу…" value="${esc(state.query)}"><kbd aria-hidden="true">/</kbd></label><span class="avatar" aria-label="Профиль: пример">АК</span></header>`;
}
function actionsFor(work, row = false) {
  return `<div class="${row?'row-actions':'card-actions'}"><button data-action="favorite" data-id="${work.id}" aria-label="${work.fav?'Убрать из избранного':'В избранное'}: ${esc(work.name)}" aria-pressed="${work.fav}">${icon('star')}</button><button data-action="share" data-id="${work.id}" aria-label="Поделиться: ${esc(work.name)}">${icon('link')}</button></div>`;
}
function artifactCard(work) {
  return `<article class="artifact"><button class="artifact-open" data-action="open" data-id="${work.id}" aria-label="Открыть ${esc(work.name)}">${cover(work)}<div class="artifact-details"><h3 class="artifact-title" title="${esc(work.name)}">${esc(work.name)}</h3><div class="artifact-subline"><span>${typeLabels[work.kind]}</span><span>·</span><span>v${work.version}</span><span>·</span>${accessChip(work)}</div></div></button>${actionsFor(work)}</article>`;
}
function fileRow(work) {
  return `<div class="file-row"><button class="file-name" data-action="open" data-id="${work.id}" aria-label="Открыть ${esc(work.name)}">${cover(work)}<span title="${esc(work.name)}">${esc(work.name)}</span></button><span class="muted file-type">${typeLabels[work.kind]}</span>${accessChip(work)}${actionsFor(work,true)}</div>`;
}
function emptyState() {
  const filtered = state.query || state.filter === 'favorites' || state.kind !== 'all';
  return `<div class="empty">${icon(filtered?'search':'folder')}<h2>${filtered?'Пока ничего не найдено':'Положите первую работу'}</h2><p>${filtered?'Попробуйте другое название или снимите фильтры.':'Результат из чата, отчёт или прототип — теперь всё в одном месте.'}</p>${button(filtered?'clear-filters':'upload',filtered?'Сбросить фильтры':'Добавить пример','primary')}</div>`;
}
function cards() {
  const items = repository.list({ ...state, folder: state.view==='folder'?state.folder:'' });
  if (!items.length) return emptyState();
  if (state.layout === 'list') return `<div class="list-header"><span>Название</span><span class="file-type">Тип</span><span>Доступ</span><span class="sr-only">Действия</span></div>${items.map(fileRow).join('')}`;
  return items.map(artifactCard).join('') + (!state.query && state.filter==='all' && state.kind==='all'
    ? `<button class="add-card" data-action="upload"><span class="plus-ring">${icon('plus')}</span><b>Следующая хорошая идея</b><p>Положите сюда результат из чата или свою работу.</p></button>` : '');
}
function shelf() {
  const title = state.view==='folder'?state.folder:state.filter==='favorites'?'Избранное':state.filter==='recent'?'Недавние работы':'Моя полка';
  const total = repository.list({ folder: state.view==='folder'?state.folder:'', filter: state.filter }).length;
  return `${state.view==='folder'?`<div class="crumb"><button data-action="home">Моя полка</button>${icon('chevron')}<span>${esc(state.folder)}</span></div>`:''}<div class="intro"><div><h1>${esc(title)}</h1><p>${state.view==='folder'?pluralWorks(total):state.filter==='all'?'Всё, что стоит сохранить. И показать другим.':state.filter==='recent'?'Три последние изменённые работы.':'Хорошие работы всегда под рукой.'}</p></div>${button('upload',icon('plus')+'Добавить работу','primary')}</div>${state.view==='shelf'&&state.filter==='all'?`<div class="folder-strip" aria-label="Быстрый переход в папки">${folders.map(folder=>`<button class="folder-chip" data-action="folder" data-folder="${esc(folder)}">${icon('folder')}${esc(folder)}<span class="count">${repository.list({folder}).length}</span></button>`).join('')}</div>`:''}<div class="toolbar"><div class="tabs" aria-label="Тип работы">${[['all','Все работы'],['report','Отчёты'],['presentation','Презентации'],['prototype','Прототипы']].map(([value,text])=>`<button data-action="filter-kind" data-kind="${value}" aria-pressed="${state.kind===value}">${text}</button>`).join('')}</div><div class="grow"></div><select id="sort" class="sort" aria-label="Сортировка"><option value="changed" ${state.sort==='changed'?'selected':''}>По изменению</option><option value="name" ${state.sort==='name'?'selected':''}>По названию</option></select><div class="view-switch" aria-label="Вид списка"><button data-action="layout" data-layout="grid" aria-pressed="${state.layout==='grid'}" aria-label="Карточки">${icon('grid')}</button><button data-action="layout" data-layout="list" aria-pressed="${state.layout==='list'}" aria-label="Список">${icon('list')}</button></div></div><div id="cards" class="${state.layout==='grid'?'grid':'list-view'}">${cards()}</div><p class="shelf-note">${icon('lock')}Новые работы видны только вам. Вы сами выбираете, чем поделиться.</p>`;
}
function workHeader(work) {
  return `<header class="workbar">${button('return-shelf',icon('back'),'square quiet back-control','aria-label="Вернуться на полку"')}${brand()}<div class="workbar-title"><h1>${esc(work.name)}</h1><div class="small"><span>${esc(work.folder)}</span><span>·</span><span>Сохранено v${work.version}</span><span>·</span>${accessChip(work)}</div></div><div class="workbar-actions">${state.focus?button('focus','Выйти из фокуса','quiet'):''}${button('new-version',icon('upload')+'Новая версия','quiet')}${button('share',icon('link')+'Поделиться','primary')}</div></header>`;
}
function workView() {
  const work = getWork(), viewingOld = state.viewedVersion !== null && state.viewedVersion !== work.version;
  const version = state.viewedVersion ?? work.version;
  return `<div class="work-tabs"><div class="tabs">${button('work','Просмотр','quiet','aria-pressed="true"')}${button('versions','Версии','quiet')}</div><div class="grow"></div>${button('recipient',icon('eye')+'Вид получателя','quiet')}${button('focus',icon('expand'), 'square quiet',`aria-label="${state.focus?'Обычный режим':'Режим фокуса'}" aria-pressed="${state.focus}"`)}</div>${viewingOld?`<div class="version-notice"><span>Вы смотрите <b>версию ${version}</b>. Последняя сохранённая — ${work.version}.</span>${button('work','К текущей версии')}</div>`:linkStatus(work)==='behind'?`<div class="version-notice"><span>${icon('link')} По ссылке — <b>v${work.published}</b>. На полке есть новая <b>v${work.version}</b>.</span>${work.pinned?'<span class="small">Закреплённая версия</span>':button('publish-update','Обновить по ссылке '+icon('arrow'),'',`data-published="${work.published}"`)}</div>`:''}<div id="artifact-stage">${preview(work,version,state)}</div><div class="viewer-foot"><span>${typeLabels[work.kind]} · демонстрационный пример</span><span>${work.kind==='prototype'?'Попробуйте переключить период и отметить задачи':work.kind==='presentation'?'Три слайда · листайте стрелками':'Исходник и история остаются у автора'}</span></div>`;
}
function versionsView() {
  const work = getWork();
  return `<div class="crumb"><button data-action="work">К работе</button>${icon('chevron')}Версии</div><div class="history-heading"><h2>Можно вернуться к любой версии</h2><p class="small muted">Добавление версии не меняет результат по отправленной ссылке.</p></div><div class="version-list">${Array.from({length:work.version},(_,index)=>work.version-index).map(version=>`<div class="version-row"><span class="version-number">v${version}</span><div class="grow"><h3>Версия ${version}</h3><p class="small muted">${version===work.version?'Последняя сохранённая':'Предыдущая версия'}</p></div>${version===work.published&&demoLink(work)?`<span class="tag pill">${icon('link')}Сейчас по ссылке</span>`:''}${button('view-version','Посмотреть','',`data-version="${version}"`)}</div>`).join('')}</div>`;
}
function recipientView() {
  const work = getWork(), mode = state.recipientMode || work.access;
  const allowed = !work.revoked && (mode==='link' || mode==='invited'&&state.signedIn);
  return `<div class="reader-shell"><header class="reader-top">${brand()}${button('work','Вернуться к автору')}</header>${allowed?`<div class="reader-label"><h1>${esc(work.name)}</h1><span class="tag pill">${icon(accessIcon[mode])}${mode==='invited'?'Пример после входа':'Просмотр по ссылке'}</span></div><div id="artifact-stage">${preview(work,work.published||work.version,state)}</div><div class="viewer-foot"><span>Читатель видит только выбранную работу</span><span>Пример · версия ${work.published||work.version}</span></div>`:`<main class="denied">${icon('lock')}<h1>${work.revoked?'Ссылка больше не работает':'Чтобы открыть работу, нужен доступ'}</h1><p>${work.revoked?'Автор отключил ссылку. Попросите его поделиться новой.':mode==='invited'?'Нужно войти под учётной записью, которую пригласил автор.':'Пересланная ссылка не даёт доступа к закрытой работе.'}</p>${mode==='invited'&&!work.revoked?button('simulate-login','Показать пример после входа','primary'):button('work','Вернуться к автору')}<p class="small" style="margin-top:22px">Демонстрация. Настоящего входа здесь нет.</p></main>`}</div>`;
}
function render() {
  if (state.view==='recipient') root.innerHTML=recipientView();
  else if (state.view==='work'||state.view==='versions') root.innerHTML=`<div class="work-shell ${state.focus?'focus-mode':''}">${workHeader(getWork())}<main class="work-content">${state.view==='versions'?versionsView():workView()}</main></div>`;
  else root.innerHTML=`<div class="app">${sidebar()}<div class="workspace">${topbar()}<main class="content">${shelf()}</main></div></div>`;
}
function showDialog(id) {
  const element=document.activeElement;
  opener={element, action:element?.dataset?.action, id:element?.dataset?.id};
  document.getElementById(id).showModal();
}
function restoreFocus() {
  if(opener?.element?.isConnected) opener.element.focus();
  else if(opener?.action) Array.from(document.querySelectorAll('button[data-action]')).find(el=>el.dataset.action===opener.action&&el.dataset.id===opener.id)?.focus();
}
function closeDialog(id) {document.getElementById(id).close();queueMicrotask(restoreFocus);}
function focusAction(action, scope=document, fallback=null) {
  const target=Array.from(scope.querySelectorAll('button[data-action]')).find(el=>el.dataset.action===action&&!el.disabled&&el.getClientRects().length);
  if(target) target.focus();
  else if(fallback) focusAction(fallback,scope);
}
function confirmClose(privateMode) {
  const panel=document.getElementById('share-dialog');
  panel.innerHTML=panelHead(privateMode?'Оставить доступ только вам?':'Отключить ссылку?','share-title','back-share')+`<div class="sheet-body"><p class="access-explain">Новые открытия будут недоступны. Уже полученные копии отозвать нельзя. Повторное открытие доступа создаст новый адрес.</p><p class="field-note">Макет. Настоящие сроки отзыва проверяются отдельно на сервере.</p></div><div class="sheet-footer">${button('back-share','Оставить как есть','quiet')}${button(privateMode?'make-private':'revoke',privateMode?'Только я':'Отключить ссылку','primary')}</div>`;
  focusAction('back-share',panel);
}
function panelHead(title, id, close, subtitle='') {
  return `<div class="sheet-head"><div><h2 id="${id}">${title}</h2>${subtitle?`<p>${esc(subtitle)}</p>`:''}</div>${button(close,icon('close'),'square quiet','aria-label="Закрыть окно"')}</div>`;
}

function openShare() {
  draft = structuredClone(getWork());
  drawShare();
  showDialog('share-dialog');
}
function drawShare() {
  const work=getWork(), status=linkStatus(work), active=Boolean(demoLink(work));
  const audienceChanged=draft.access!==work.access;
  const canCopy=active&&!audienceChanged;
  const optionsChanged=['expiry','pinned','copy','download','previewCover','invites'].some(key=>JSON.stringify(draft[key])!==JSON.stringify(work[key]));
  let mainAction='copy-link', mainText='Скопировать ссылку';
  if(draft.access==='private'){mainAction='save-share';mainText=work.access!=='private'?'Закрыть доступ':'Готово';}
  else if(!active||audienceChanged){mainAction='enable-link';mainText=status==='revoked'?'Создать новую ссылку':draft.access==='invited'?'Сохранить пример приглашений':'Открыть доступ по ссылке';}
  else if(optionsChanged){mainAction='save-share';mainText='Сохранить настройки';}
  const explain=draft.access==='private'?'Открыть можете только вы. Передача адреса не откроет работу другому человеку.':draft.access==='invited'?'Только добавленные люди после входа. Это будущий сценарий: настоящих приглашений в макете нет.':'Откроет любой, кому передадут ссылку. Её можно переслать дальше.';
  document.getElementById('share-dialog').innerHTML=panelHead('Поделиться','share-title','close-share',work.name)+`<div class="sheet-body"><div class="share-summary">${icon(status==='revoked'?'lock':active?'link':'lock')}<div><strong>${status==='revoked'?'Ссылка отключена':active?`По ссылке показывается версия ${work.published}`:'Сейчас работа видна только вам'}</strong><small>${status==='revoked'?'Повторное открытие создаст новый адрес.':active?`На полке сохранена версия ${work.version}.`:'Адрес для других появится после открытия доступа.'}</small>${canCopy&&status==='behind'&&!work.pinned?button('publish-share',`Обновить до v${work.version}`,'quiet',`data-published="${work.published}"`):''}</div></div><label class="field" for="access-mode">Кто сможет открыть<select id="access-mode" class="access-select"><option value="private" ${draft.access==='private'?'selected':''}>Только я</option><option value="link" ${draft.access==='link'?'selected':''}>Все, у кого есть ссылка</option>${state.invitedScenario?`<option value="invited" ${draft.access==='invited'?'selected':''}>Приглашённые · будущий сценарий</option>`:''}</select></label><p class="access-explain">${explain}</p>${draft.access==='invited'?`<div class="field"><label for="invite-email">Добавить в пример</label><div class="row"><input type="email" id="invite-email" placeholder="name@company.ru">${button('invite','Добавить')}</div><p id="invite-error" class="error" role="alert"></p></div><div>${draft.invites.map((email,index)=>`<div class="invite-line"><span class="avatar">П</span><span class="grow">${esc(email)}</span>${button('remove-invite',icon('close'),'square quiet',`data-index="${index}" aria-label="Удалить ${esc(email)}"`)}</div>`).join('')}</div>`:''}${canCopy?`<label class="small" for="share-url">Активная ссылка · пример</label><div class="link-field"><input id="share-url" readonly value="${demoLink(work)}"></div>`:''}${draft.access==='link'?`<div class="discovery-note">${icon('eye')}<span>Просим поисковики не показывать работу. Это не защита от доступа.</span></div>`:''}<details class="advanced"><summary>Настройки ссылки</summary><div class="field"><label for="link-expiry">Срок доступа · пример</label><select id="link-expiry">${['Без срока','7 дней','30 дней'].map(text=>`<option ${draft.expiry===text?'selected':''}>${text}</option>`).join('')}</select></div><div class="field"><label for="link-version">Версия</label><select id="link-version"><option value="live" ${!draft.pinned?'selected':''}>Обновлять по моему действию</option><option value="pinned" ${draft.pinned?'selected':''}>Закрепить текущую версию по ссылке</option></select></div><div class="checks">${[['copy','Разрешить копию в свою полку'],['download','Показывать скачивание оригинала'],['previewCover','Показывать обложку в мессенджере']].map(([key,label])=>`<label><input type="checkbox" data-option="${key}" ${draft[key]?'checked':''}>${label}</label>`).join('')}</div><p class="field-note" style="margin-top:15px">Уже полученные копии нельзя отозвать. Выключенная кнопка скачивания не запрещает снимок экрана. Здесь настройки показывают будущий сценарий, а не ограничивают файлы.</p></details>${status==='revoked'?button('save-options','Сохранить только настройки','quiet'):''}<p class="field-note" style="margin-top:15px">Макет: адрес на polka.example не публикует работу.</p></div><div class="sheet-footer">${active?button('confirm-revoke','Отключить ссылку','quiet danger'):button('close-share','Отмена','quiet')}${button(mainAction,mainText,'primary')}</div>`;
}
function refreshShare(preserveDetails=false) {
  const wasOpen=preserveDetails&&document.querySelector('#share-dialog details')?.open;
  const focused=document.activeElement;
  const id=focused?.id, option=focused?.dataset?.option;
  drawShare();
  if(wasOpen) document.querySelector('#share-dialog details').open=true;
  if(id) document.getElementById(id)?.focus();
  else if(option) document.querySelector(`[data-option="${option}"]`)?.focus();
}
function openUpload(mode='new', tab='file') {
  if(!document.getElementById('upload-dialog').open || uploadMode!==mode) uploadDraft={title:'Мой новый отчёт',folder:state.folder||folders[0],html:''};
  uploadMode=mode;
  const existing=mode==='version'?getWork():null;
  document.getElementById('upload-dialog').innerHTML=panelHead(existing?'Новая версия':'Положить на полку','upload-title','close-upload',existing?existing.name:'Сначала только вам. Доступ выберете потом.')+`<div class="sheet-body"><div class="formtabs">${button('upload-file-tab','Файл',tab==='file'?'active':'')}${button('upload-paste-tab','Вставить HTML',tab==='html'?'active':'')}</div>${tab==='html'?`<div class="field"><label for="html-code">HTML-код</label><textarea id="html-code" placeholder="Вставьте код работы…" spellcheck="false">${esc(uploadDraft.html)}</textarea></div>`:`<div class="upload-drop">${icon('upload')}<h3>Результат из чата — на вашей полке</h3><p>В этом макете добавляется готовый пример.</p><p>Настоящую загрузку подключим на следующем этапе.</p></div>`}<div class="example-preview">${cover(existing||repository.all()[0]||{kind:'report'})}<div><p>Пример HTML-отчёта</p><small>Код не исполняется, файлы не отправляются</small></div></div>${!existing?`<div class="field"><label for="new-title">Название</label><input id="new-title" maxlength="140" value="${esc(uploadDraft.title)}"></div><div class="field"><label for="new-folder">Папка</label><select id="new-folder">${folders.map(folder=>`<option ${uploadDraft.folder===folder?'selected':''}>${esc(folder)}</option>`).join('')}</select></div>`:''}<p class="field-note">${existing?'Добавится демонстрационная версия. Получатель по ссылке продолжит видеть прежнюю, пока вы явно её не обновите.':'После перезагрузки примеры вернутся к исходному состоянию.'}</p></div><div class="sheet-footer">${button('close-upload','Отмена','quiet')}${button('add-demo',existing?'Добавить пример версии':'Добавить пример','primary')}</div>`;
  if(!document.getElementById('upload-dialog').open) showDialog('upload-dialog');
}
function scenarioPanel() {
  document.getElementById('scenario-dialog').innerHTML=panelHead('Проверить сценарий','scenario-title','close-scenario','Все изменения сохраняются только в памяти вкладки.')+`<div class="sheet-body"><div class="field">${button('scenario-filled','Полка с примерами')}${button('scenario-empty','Первый вход: пустая полка')}${button('scenario-invites','Приглашения: будущий сценарий')}</div><p class="field-note">Модель данных и интерфейс отделены от будущей авторизации и хранения. Эти кнопки не переключают рабочие аккаунты.</p></div>`;
  showDialog('scenario-dialog');
}

document.addEventListener('input',event=>{
  if(uploadDraft&&event.target.id==='new-title')uploadDraft.title=event.target.value;
  if(uploadDraft&&event.target.id==='html-code')uploadDraft.html=event.target.value;
  if(event.target.id==='search') {
    state.query=event.target.value;
    document.getElementById('cards').innerHTML=cards();
  }
});
document.addEventListener('change',event=>{
  const element=event.target;
  if(uploadDraft&&element.id==='new-folder')uploadDraft.folder=element.value;
  if(element.id==='sort'){state.sort=element.value;render();document.getElementById('sort').focus();}
  if(element.id==='access-mode'){draft.access=element.value;refreshShare();}
  if(element.id==='link-expiry'){draft.expiry=element.value;refreshShare(true);}
  if(element.id==='link-version'){draft.pinned=element.value==='pinned';refreshShare(true);}
  if(element.dataset.option){draft[element.dataset.option]=element.checked;refreshShare(true);}
  if(element.id==='demo-period'){state.period=element.value;render();document.getElementById('demo-period')?.focus();}
  if(element.dataset.demoTask!==undefined){const index=Number(element.dataset.demoTask);state.tasks=element.checked?[...state.tasks,index]:state.tasks.filter(item=>item!==index);}
});
document.addEventListener('keydown',event=>{
  const typing=event.target.matches('input,textarea,select,[contenteditable=true]');
  if(['ArrowLeft','ArrowRight'].includes(event.key)&&!typing&&!document.querySelector('dialog[open]')&&['work','recipient'].includes(state.view)&&getWork().kind==='presentation'){event.preventDefault();state.slide=Math.max(0,Math.min(2,state.slide+(event.key==='ArrowRight'?1:-1)));render();focusAction(event.key==='ArrowRight'?'next-slide':'previous-slide',document,event.key==='ArrowRight'?'previous-slide':'next-slide');}
  if(event.key==='/'&&!typing&&!document.querySelector('dialog[open]')&&document.getElementById('search')){event.preventDefault();document.getElementById('search').focus();}
});
document.addEventListener('click',async event=>{
  const control=event.target.closest('[data-action]');
  if(!control||control.disabled)return;
  const action=control.dataset.action;
  try {
    switch(action) {
      case 'reset': repository.reset();state={...initialUI};document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());render();break;
      case 'home':go('shelf',{folder:'',filter:'all',query:'',kind:'all',focus:false});break;
      case 'return-shelf':go(state.folder?'folder':'shelf',{query:'',kind:'all',focus:false});break;
      case 'recent':go('shelf',{filter:'recent',folder:'',query:'',kind:'all'});break;
      case 'favorites':go('shelf',{filter:'favorites',folder:'',query:'',kind:'all'});break;
      case 'folder':go('folder',{folder:control.dataset.folder,filter:'all',query:'',kind:'all'});break;
      case 'open':go('work',{selected:control.dataset.id,viewedVersion:null,slide:0,period:'week',tasks:[],recipientMode:null,signedIn:false,focus:false});break;
      case 'work':go('work',{viewedVersion:null,recipientMode:null,signedIn:false});break;
      case 'versions':go('versions',{focus:false});break;
      case 'view-version':go('work',{viewedVersion:Number(control.dataset.version)});break;
      case 'filter-kind':state.kind=control.dataset.kind;render();Array.from(root.querySelectorAll('[data-action="filter-kind"]')).find(el=>el.dataset.kind===state.kind)?.focus();break;
      case 'layout':state.layout=control.dataset.layout;render();root.querySelector(`[data-layout="${state.layout}"]`)?.focus();break;
      case 'clear-filters':go(state.view,{filter:'all',query:'',kind:'all'});break;
      case 'favorite':repository.toggleFavorite(control.dataset.id);render();Array.from(root.querySelectorAll('[data-action="favorite"]')).find(el=>el.dataset.id===control.dataset.id)?.focus();break;
      case 'share':if(control.dataset.id)state.selected=control.dataset.id;openShare();break;
      case 'close-share':closeDialog('share-dialog');draft=null;break;
      case 'close-upload':closeDialog('upload-dialog');break;
      case 'close-scenario':closeDialog('scenario-dialog');break;
      case 'upload':openUpload();break;
      case 'new-version':openUpload('version');break;
      case 'upload-file-tab':openUpload(uploadMode,'file');break;
      case 'upload-paste-tab':openUpload(uploadMode,'html');break;
      case 'add-demo': {
        const work=uploadMode==='version'?repository.addVersion(state.selected):repository.add({name:document.getElementById('new-title').value,folder:document.getElementById('new-folder').value});
        closeDialog('upload-dialog');go('work',{selected:work.id,viewedVersion:null});notify(uploadMode==='version'?'Пример версии сохранён. Отправленная ссылка не изменилась.':'Пример на полке. Доступ пока только вам.');break;
      }
      case 'enable-link':repository.saveOptions(state.selected,draft);repository.enableLink(state.selected,draft.access);draft=structuredClone(getWork());render();drawShare();document.querySelector('#share-dialog [data-action="copy-link"]')?.focus();notify('Доступ изменён в макете. Теперь можно скопировать пример ссылки.');break;
      case 'save-share': {
        if(draft.access==='private'&&getWork().access!=='private'){confirmClose(true);break;}
        repository.saveOptions(state.selected,draft);
        closeDialog('share-dialog');render();notify('Настройки сохранены только в макете.');break;
      }
      case 'save-options':repository.saveOptions(state.selected,draft);draft=structuredClone(getWork());drawShare();focusAction('save-options',document.getElementById('share-dialog'));notify('Настройки сохранены. Отключённая ссылка осталась отключённой.');break;
      case 'copy-link': {
        const link=demoLink(getWork());
        if(!link||draft&&draft.access!==getWork().access)throw new Error('Сначала сохраните выбранный доступ');
        try{await navigator.clipboard.writeText(link);notify('Пример адреса скопирован. Это не опубликованная работа.');}
        catch{document.getElementById('share-url')?.select();notify('Скопируйте выделенный пример адреса.');}
        break;
      }
      case 'confirm-revoke':confirmClose(false);break;
      case 'make-private':repository.saveOptions(state.selected,draft);repository.makePrivate(state.selected);closeDialog('share-dialog');render();notify('Работа теперь только для вас. Старый адрес не откроется.');break;
      case 'back-share':draft=structuredClone(getWork());drawShare();focusAction('close-share',document.getElementById('share-dialog'));break;
      case 'revoke':repository.revoke(state.selected);draft=structuredClone(getWork());render();drawShare();focusAction('close-share',document.getElementById('share-dialog'));notify('Ссылка в макете отключена. Настройки не включат её обратно.');break;
      case 'invite': {
        const input=document.getElementById('invite-email');
        if(!input.value||!input.checkValidity()){document.getElementById('invite-error').textContent='Укажите корректный email для примера.';break;}
        if(!draft.invites.includes(input.value.trim()))draft.invites.push(input.value.trim());
        refreshShare();document.getElementById('invite-email')?.focus();break;
      }
      case 'remove-invite':draft.invites.splice(Number(control.dataset.index),1);refreshShare();break;
      case 'publish-share':repository.publish(state.selected,Number(control.dataset.published));render();drawShare();focusAction('copy-link',document.getElementById('share-dialog'));notify('По прежнему адресу теперь новая версия примера.');break;
      case 'publish-update':repository.publish(state.selected,Number(control.dataset.published));render();focusAction('share');notify('В макете по прежнему адресу теперь новая версия.');break;
      case 'recipient':go('recipient',{recipientMode:getWork().access,signedIn:false,slide:0});break;
      case 'simulate-login':state.signedIn=true;render();notify('Будущий сценарий после входа приглашённого. Реальная авторизация не выполнялась.');break;
      case 'focus':state.focus=!state.focus;render();focusAction('focus');break;
      case 'previous-slide':state.slide=Math.max(0,state.slide-1);render();focusAction('previous-slide',document,'next-slide');break;
      case 'next-slide':state.slide=Math.min(2,state.slide+1);render();focusAction('next-slide',document,'previous-slide');break;
      case 'scenario':scenarioPanel();break;
      case 'navigation':document.getElementById('navigation-dialog').innerHTML=panelHead('Моя полка','navigation-title','close-navigation')+`<div class="sheet-body"><nav class="nav" aria-label="Разделы полки">${button('home',icon('grid')+'Все работы','quiet')}${button('recent',icon('clock')+'Недавние','quiet')}${button('favorites',icon('star')+'Избранное','quiet')}${folders.map(folder=>button('folder',icon('folder')+esc(folder),'quiet',`data-folder="${esc(folder)}"`)).join('')}</nav></div>`;showDialog('navigation-dialog');break;
      case 'close-navigation':closeDialog('navigation-dialog');break;
      case 'scenario-filled':case 'scenario-empty':case 'scenario-invites': {
        repository.reset(action==='scenario-empty');state={...initialUI,invitedScenario:action==='scenario-invites'};closeDialog('scenario-dialog');render();
        if(action==='scenario-invites'){repository.enableLink('pulse','invited');go('work');openShare();}
        break;
      }
    }
  } catch(error) {notify(error.message||'Не получилось выполнить действие.');}
});
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('close',()=>queueMicrotask(restoreFocus)));
render();
