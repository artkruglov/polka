import {CopyText} from "../../shared/ui/CopyText.tsx";
import {ActionMenu} from "../../shared/ui/ActionMenu.tsx";
import { Tabs } from "../../shared/ui/Tabs.tsx";
import { TrashArtifactPanel } from "../../features/trash-artifact/index.tsx";
import { ReworkArtifactPanel } from "../../features/rework-artifact/index.tsx";
import React, { useState, useRef } from "react";
import {
  Badge,
  Button,
  LinkButton,
  TextField,
  TextAreaField,
  EmptyState,
  StatusPanel,
  SelectField,
  Notice,
} from "../../shared/ui/controls.tsx";
import { Dialog, ErrorNotice } from "../../shared/ui/index.tsx";
import "./styles.css";
export function ComponentCatalog() {
  const [copyVersion,setCopyVersion]=useState(1),[copyWaiting,setCopyWaiting]=useState(false);
  const finishCopy=useRef<(()=>void)|null>(null);
  const [exampleTab,setExampleTab] = useState("first");
  const [featureDialog,setFeatureDialog] = useState<"trash"|"rework"|null>(null);
  const [trashError,setTrashError] = useState("");
  const [notice, setNotice] = useState(true);
  const [folder, setFolder] = useState("personal");
  const [dialog, setDialog] = useState(false);
  const [value, setValue] = useState("Отчёт команды");
  return (
    <main className="component-catalog">
      <header>
        <p>Полка · инструменты разработки</p>
        <h1>Общие компоненты</h1>
        <p>
          Те же компоненты, что используются в продукте. Проверяйте Tab, Escape,
          масштаб и узкий экран.
        </p>
      </header>
      <section>
        <h2>Метки состояния</h2>
        <div className="component-samples"><Badge>Только вы</Badge><Badge tone="success">Работает</Badge><Badge tone="warning">Демо</Badge><Badge tone="danger">Не поддерживается</Badge></div>
      </section>
      <section>
        <h2>Многострочный ввод</h2>
        <TextAreaField label="Правила шаблона" hint="Оформление и ограничения для агента" rows={3} />
        <TextAreaField label="Поле с ошибкой" error="Добавьте правила использования" required rows={2} />
        <TextAreaField label="Недоступное поле" value="Сохранение…" disabled rows={2} />
      </section>
      <section>
        <h2>Копирование при смене контекста</h2>
        <p>Тестовая операция завершится только по кнопке. Реальный буфер не меняется.</p>
        <CopyText value={`Контекст версии ${copyVersion}`} label="Контекст отложенного копирования" writeText={()=>new Promise<void>(resolve=>{finishCopy.current=resolve;setCopyWaiting(true);})}/>
        <Button onClick={()=>setCopyVersion(x=>x+1)}>Сменить версию контекста</Button>
        <Button disabled={!copyWaiting} onClick={()=>{finishCopy.current?.();finishCopy.current=null;setCopyWaiting(false);}}>Завершить старое копирование</Button>
      </section>
      <section>
        <h2>Копирование без разрешения браузера</h2>
        <p>Тестовый адаптер намеренно отклоняет запись. Он не обращается к буферу обмена.</p>
        <CopyText value="Материал: отчёт команды. Версия: v1. Приложите исходники к чату." label="Контекст при отказе копирования" collapsible writeText={async()=>{throw new Error("Simulated clipboard rejection");}}/>
      </section>
      <section>
        <h2>Вкладки</h2>
        <Tabs label="Пример вкладок" value={exampleTab} onChange={setExampleTab} items={[{id:"first",label:"Обзор"},{id:"second",label:"История"}]}><p>{exampleTab==="first"?"Содержимое обзора":"Сохранённые версии"}</p></Tabs>
      </section>
      <section>
        <h2>Сценарии материала</h2>
        <div className="component-samples"><Button onClick={()=>{setTrashError("");setFeatureDialog("trash");}}>Диалог корзины</Button><Button onClick={()=>setFeatureDialog("rework")}>Диалог агента</Button></div>
        {featureDialog==="trash"&&<TrashArtifactPanel busy={false} error={trashError} onClose={()=>setFeatureDialog(null)} onConfirm={async()=>setTrashError("Материал изменился. Данные обновлены, проверьте их и повторите перемещение.")}/>}
        {featureDialog==="rework"&&<ReworkArtifactPanel title="Отчёт команды" onClose={()=>setFeatureDialog(null)} onUpload={()=>setFeatureDialog(null)}/>}
      </section>
      <section>
        <h2>Действия</h2>
        <ActionMenu label="Действия материала" items={[
          {id:"first",label:"Открыть диалог",onSelect:()=>setDialog(true)},
          {id:"disabled",label:"Недоступное действие",disabled:true,onSelect:()=>{}},
          {id:"last",label:"Показать уведомление",onSelect:()=>setNotice(true)},
        ]}/>

        <div className="component-samples">
          <Button variant="primary">Сохранить</Button>
          <Button>Новая версия</Button>
          <Button variant="quiet">Отменить</Button>
          <Button disabled>Недоступно</Button>
          <Button busy>Сохраняем</Button>
          <LinkButton href="#fields">
            Перейти к полям
          </LinkButton>
        </div>
      </section>
      <section id="fields">
        <h2>Поля</h2>
        <div className="component-fields">
          <SelectField
            label="Папка"
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
            hint="Выберите, где сохранить материал."
          >
            <option value="personal">Личная полка</option>
            <option value="research">Исследования</option>
          </SelectField>
          <TextField
            label="Название"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            hint="Будет видно на вашей Полке."
          />
          <TextField
            label="Ссылка с ошибкой"
            defaultValue="example"
            error="Укажите полную HTTPS-ссылку."
          />
          <TextField
            label="Недоступное поле"
            disabled
            defaultValue="Вычислено автоматически"
          />
        </div>
      </section>
      <section>
        <h2>Состояния</h2>
        {notice ? (
          <Notice onDismiss={() => setNotice(false)}>
            Материал сохранён. Выбранная папка:{" "}
            {folder === "personal" ? "Личная полка" : "Исследования"}.
          </Notice>
        ) : (
          <Button onClick={() => setNotice(true)}>Показать уведомление</Button>
        )}
        <StatusPanel
          title="Копия сохранена"
          action={<Button>Открыть материал</Button>}
        >
          Просмотр готов. Копия доступна только вам.
        </StatusPanel>
        <StatusPanel title="Компактная карточка" compact>
          Сохранённая версия материала.
        </StatusPanel>
        <EmptyState
          title="На полке пока пусто"
          action={<Button variant="primary">Сохранить первый материал</Button>}
        >
          Добавьте файл или страницу по ссылке.
        </EmptyState>
        <ErrorNotice error="Пример ошибки: не удалось выполнить запрос." />
      </section>
      <section>
        <h2>Диалог</h2>
        <Button onClick={() => setDialog(true)}>Открыть диалог</Button>
        {dialog && (
          <Dialog title="Создать папку" onClose={() => setDialog(false)}>
            <TextField
              label="Название папки"
              placeholder="Например, Исследования"
            />
            <div className="component-samples">
              <Button onClick={() => setDialog(false)}>Отменить</Button>
              <Button variant="primary" onClick={() => setDialog(false)}>
                Создать
              </Button>
            </div>
          </Dialog>
        )}
      </section>
    </main>
  );
}
