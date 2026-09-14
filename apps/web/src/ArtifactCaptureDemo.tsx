import React, { useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Globe2,
  Link2,
  LockKeyhole,
  ShieldCheck,
  Upload as UploadIcon,
} from "lucide-react";
import { Brand } from "./ui.tsx";

type CaptureState = "idle" | "checking" | "ready" | "saved" | "unsupported" | "private";
type InputMode = "link" | "file";

const examples = {
  public: "https://claude.ai/artifacts/quarterly-report",
  unsupported: "https://claude.ai/artifacts/dynamic-dashboard-js",
  private: "https://claude.ai/workspaces/acme/report",
};

export function ArtifactCaptureDemo() {
  const [mode, setMode] = useState<InputMode>("link");
  const [value, setValue] = useState("");
  const [state, setState] = useState<CaptureState>("idle");
  const [showReceiver, setShowReceiver] = useState(false);

  const inspect = () => {
    if (!value.trim()) return;
    setState("checking");
    window.setTimeout(() => {
      const lower = value.toLowerCase();
      if (lower.includes("workspaces") || lower.includes("private") || lower.includes("login")) setState("private");
      else if (lower.includes("dynamic") || lower.includes("javascript") || lower.includes("-js")) setState("unsupported");
      else setState("ready");
    }, 420);
  };

  const save = () => {
    setState("saved");
    setShowReceiver(false);
  };

  const reset = () => {
    setState("idle");
    setShowReceiver(false);
  };

  return (
    <div className="capture-page">
      <header className="capture-header">
        <Brand />
        <div className="capture-header-links">
          <a href="/discover">Посмотреть примеры</a>
          <a className="capture-login" href="/">Войти</a>
        </div>
      </header>
      <main className="capture-main">
        <section className="capture-hero">
          <div className="capture-copy">
            <span className="eyebrow">АРТЕФАКТЫ ИЗ ЛЮБЫХ АГЕНТОВ</span>
            <h1>Ссылка из Claude.<br /><em>Своя копия на Полке.</em></h1>
            <p>Сохраните работу, созданную агентом, и отправьте ссылку, которая откроется у получателя без исходного сервиса и его логина.</p>
            <div className="capture-proof-list">
              <div><span className="proof-icon"><ShieldCheck /></span><span><strong>Получатель открывает копию</strong><small>Без VPN и обращения к Claude</small></span></div>
              <div><span className="proof-icon"><LockKeyhole /></span><span><strong>Сначала только вы</strong><small>Публикуете и отключаете доступ сами</small></span></div>
              <div><span className="proof-icon"><Bot /></span><span><strong>Можно попросить агента</strong><small>«Положи этот отчёт на Полку» через MCP</small></span></div>
            </div>
          </div>
          <section className="capture-card" aria-label="Сохранить артефакт">
            <div className="capture-card-head">
              <div><span className="eyebrow">БЫСТРЫЙ ВХОД</span><h2>Принести работу</h2></div>
              <span className="capture-time">около 5 минут</span>
            </div>
            <div className="capture-tabs" role="tablist">
              <button className={mode === "link" ? "active" : ""} onClick={() => { setMode("link"); reset(); }} role="tab" aria-selected={mode === "link"}><Link2 /> Вставить ссылку</button>
              <button className={mode === "file" ? "active" : ""} onClick={() => { setMode("file"); reset(); }} role="tab" aria-selected={mode === "file"}><UploadIcon /> Загрузить файл</button>
            </div>
            {mode === "link" ? (
              <label className="capture-input-label">Публичная ссылка на работу<input value={value} onChange={(e) => { setValue(e.target.value); reset(); }} onKeyDown={(e) => e.key === "Enter" && inspect()} placeholder="https://claude.ai/artifacts/..." autoFocus /></label>
            ) : (
              <label className="capture-file-drop"><UploadIcon /><strong>{value || "Перетащите файл сюда"}</strong><small>HTML, ZIP, PDF, PPTX, изображение или TXT</small><input type="file" accept=".html,.zip,.pdf,.pptx,image/png,image/jpeg,image/webp,text/plain" onChange={(e) => { const file = e.target.files?.[0]; if (file) { setValue(file.name); setState("ready"); } }} /></label>
            )}
            <div className="capture-examples"><span>Попробовать:</span><button onClick={() => { setValue(examples.public); setMode("link"); reset(); }}>публичный Claude</button><button onClick={() => { setValue(examples.unsupported); setMode("link"); reset(); }}>сборка на JS</button><button onClick={() => { setValue(examples.private); setMode("link"); reset(); }}>закрытая ссылка</button></div>
            {state === "idle" && <button className="primary capture-cta" onClick={inspect} disabled={!value.trim()}>Проверить и показать копию <ArrowUpRight /></button>}
            {state === "checking" && <div className="capture-status capture-checking" role="status"><span className="spinner" /> Проверяем, что можно сохранить…</div>}
            {state === "ready" && <ReadyState sourceLabel={mode === "file" ? "загруженный файл" : "Claude"} onSave={save} onReset={reset} />}
            {state === "saved" && <SavedState onReset={reset} showReceiver={showReceiver} onReceiver={() => setShowReceiver(true)} />}
            {state === "unsupported" && <UnsupportedState onReset={reset} onFile={() => { setMode("file"); setValue(""); setState("idle"); }} />}
            {state === "private" && <PrivateState onReset={reset} onFile={() => { setMode("file"); setValue(""); setState("idle"); }} />}
            <p className="capture-note"><Globe2 /> Интерфейсный прототип · ссылка сохраняется как копия, а не как прокси на исходный сервис.</p>
          </section>
        </section>

        <section className="capture-agent-strip">
          <div className="agent-strip-icon"><Bot /></div>
          <div><span className="eyebrow">ТОТ ЖЕ ПУТЬ ЧЕРЕЗ АГЕНТА</span><h2>Скажите в чате: «Положи это на Полку»</h2><p>Разрешённый MCP сохранит приватную версию и вернёт receipt. Агент не публикует работу вместо вас.</p></div>
          <div className="agent-receipt"><span className="receipt-dot"><Check /></span><span><strong>Сохранено на Полку</strong><small>Только вы · версия 1</small></span><ChevronRight /></div>
        </section>

        <section className="capture-steps" aria-label="Как это работает">
          <div><span>01</span><strong>Вставьте ссылку или файл</strong><p>Без выбора формата и папки на первом шаге.</p></div>
          <div><span>02</span><strong>Получите свою копию</strong><p>Мы показываем источник, дату и ограничения до сохранения.</p></div>
          <div><span>03</span><strong>Поделитесь, когда готовы</strong><p>«Только я» и «По ссылке» видны рядом с каждой версией.</p></div>
        </section>
      </main>
      <footer className="capture-footer"><span>Полка / быстрый вход для артефактов</span><a href="/discover">Открыть витрину <ExternalLink /></a></footer>
    </div>
  );
}

function ReadyState({ sourceLabel, onSave, onReset }: { sourceLabel: string; onSave: () => void; onReset: () => void }) {
  return <div className="capture-result capture-ready"><div className="result-kicker"><Check /> КОПИЮ МОЖНО СОХРАНИТЬ</div><div className="result-preview"><div className="result-art"><span>Q3 / 2026</span><strong>Квартальный<br /><em>отчёт</em></strong><small>полка / снимок из {sourceLabel.toLowerCase()}</small></div><div><h3>Квартальный отчёт</h3><p>Публичный артефакт · {sourceLabel}</p><span className="result-meta"><LockKeyhole /> После сохранения увидите только вы</span></div></div><div className="result-actions"><button onClick={onReset}>Изменить</button><button className="primary" onClick={onSave}>Сохранить копию <ArrowUpRight /></button></div></div>;
}

function SavedState({ onReset, onReceiver, showReceiver }: { onReset: () => void; onReceiver: () => void; showReceiver: boolean }) {
  return <div className="capture-result capture-saved"><div className="saved-head"><span className="saved-check"><Check /></span><div><span className="result-kicker">СНИМОК СОХРАНЁН</span><h3>Квартальный отчёт · версия 1</h3><p>Источник: Claude · 14 сентября 2026, 12:40</p></div></div><div className="saved-link"><span><LockKeyhole /> Сейчас видите только вы</span><code>polka.local/w/quarterly-report</code></div><div className="saved-actions"><button className="primary" onClick={onReceiver}><Globe2 /> Посмотреть глазами получателя</button><button onClick={onReset}>Начать ещё раз</button></div>{showReceiver && <div className="receiver-preview"><div><span className="eyebrow">ЭКРАН ПОЛУЧАТЕЛЯ</span><strong>Квартальный отчёт</strong><small>Копия на Полке · без входа</small></div><span className="receiver-open"><Check /> Открывается</span></div>}</div>;
}

function UnsupportedState({ onReset, onFile }: { onReset: () => void; onFile: () => void }) {
  return <div className="capture-result capture-warning"><div className="warning-title"><CircleAlert /> Страница собирается в браузере</div><p>Полка не запускает чужой код и не сможет забрать содержимое автоматически. Скачайте артефакт из Claude и загрузите файл — так копия будет самостоятельной.</p><div className="result-actions"><button onClick={onReset}>Другая ссылка</button><button className="primary" onClick={onFile}><UploadIcon /> Загрузить файл</button></div></div>;
}

function PrivateState({ onReset, onFile }: { onReset: () => void; onFile: () => void }) {
  return <div className="capture-result capture-warning"><div className="warning-title"><LockKeyhole /> Эта ссылка доступна только после входа</div><p>Мы не просим логин или cookies от Claude и не обходим права рабочего пространства. Скачайте файл вручную или попросите своего агента сохранить его.</p><div className="result-actions"><button onClick={onReset}>Другая ссылка</button><button className="primary" onClick={onFile}><UploadIcon /> Загрузить файл</button></div></div>;
}
