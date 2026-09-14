import React, { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  Check,
  ChevronRight,
  Compass,
  ExternalLink,
  FileText,
  Heart,
  Image,
  LayoutDashboard,
  LockKeyhole,
  MonitorPlay,
  MousePointer2,
  Plus,
  Search,
  Sparkles,
  WandSparkles,
} from "lucide-react";

type Demo = {
  id: string;
  title: string;
  kind: string;
  description: string;
  byline: string;
  accent: string;
  icon: React.ComponentType<{ size?: number }>;
  motif: "editorial" | "report" | "dashboard" | "prototype" | "story" | "site";
  tag: string;
};

const demos: Demo[] = [
  {
    id: "cities",
    title: "Города, которые нас изменили",
    kind: "Презентация",
    description: "История цивилизаций через места, письмо и связи между людьми.",
    byline: "Полка / редакция",
    accent: "#d8c4a0",
    icon: BookOpen,
    motif: "editorial",
    tag: "рассказать",
  },
  {
    id: "pulse",
    title: "Пульс команды",
    kind: "Отчёт",
    description: "Четыре сигнала, которые помогают команде выбрать следующий шаг.",
    byline: "Полка / редакция",
    accent: "#bed3c5",
    icon: BarChart3,
    motif: "report",
    tag: "объяснить",
  },
  {
    id: "economy",
    title: "Экономика продукта",
    kind: "Дашборд",
    description: "Сценарии роста, метрики и пояснения без лишнего шума.",
    byline: "Полка / редакция",
    accent: "#b7c6df",
    icon: LayoutDashboard,
    motif: "dashboard",
    tag: "решить",
  },
  {
    id: "welcome",
    title: "Первое знакомство",
    kind: "Прототип",
    description: "Путь нового сотрудника от первого вопроса до полезного результата.",
    byline: "Полка / редакция",
    accent: "#d8b8bd",
    icon: MousePointer2,
    motif: "prototype",
    tag: "проверить",
  },
  {
    id: "idea",
    title: "Как появилась идея",
    kind: "Визуальная история",
    description: "Таймлайн решения с изображениями, поворотами и тихой анимацией.",
    byline: "Полка / редакция",
    accent: "#c4b7d9",
    icon: Image,
    motif: "story",
    tag: "показать",
  },
  {
    id: "launch",
    title: "Запускаем новое",
    kind: "Мини-сайт",
    description: "Лендинг продукта с историей, сравнением и живым демо.",
    byline: "Полка / редакция",
    accent: "#c6c9a9",
    icon: Sparkles,
    motif: "site",
    tag: "запустить",
  },
];

function BrandLink() {
  return (
    <a className="brand public-brand" href="/discover" aria-label="Полка — витрина">
      <span className="brand-mark"><i /><i /><i /></span>
      полка<span className="alpha">open</span>
    </a>
  );
}

function DemoArt({ demo, large = false }: { demo: Demo; large?: boolean }) {
  const Icon = demo.icon;
  return (
    <div className={`demo-art demo-art-${demo.motif} ${large ? "large" : ""}`} style={{ "--demo-accent": demo.accent } as React.CSSProperties}>
      <div className="demo-art-top"><span>полка / пример</span><Icon size={large ? 21 : 16} /></div>
      {demo.motif === "editorial" && <><div className="art-number">01</div><div className="art-lines"><i /><i /><i /></div><div className="art-sun" /></>}
      {demo.motif === "report" && <><div className="art-kicker">WEEKLY SIGNALS</div><div className="art-bars"><i /><i /><i /><i /><i /></div><div className="art-caption">ясность вместо отчётности</div></>}
      {demo.motif === "dashboard" && <><div className="art-dashboard-value">+24<span>%</span></div><div className="art-chart"><i /><i /><i /><i /><i /><i /></div><div className="art-chip-row"><i /><i /><i /></div></>}
      {demo.motif === "prototype" && <><div className="art-window"><span /><span /><span /><b>Добро пожаловать</b><small>Начать с одной понятной задачи</small><em>Продолжить</em></div><div className="art-cursor"><MousePointer2 size={large ? 25 : 18} /></div></>}
      {demo.motif === "story" && <><div className="art-orbit" /><div className="art-story-copy">Идеи<br /><strong>двигаются</strong></div><div className="art-dot" /></>}
      {demo.motif === "site" && <><div className="art-site-title">новый<br /><strong>ритм</strong></div><div className="art-site-card"><span /><span /><span /></div><div className="art-site-button">узнать больше <ArrowUpRight size={large ? 15 : 12} /></div></>}
      <div className="demo-art-footer"><span>{demo.kind}</span><span>2026</span></div>
    </div>
  );
}

function DemoDetail({ demo, onBack }: { demo: Demo; onBack: () => void }) {
  const [started, setStarted] = useState(false);
  return (
    <div className="public-detail">
      <button className="public-back" onClick={onBack}><ArrowLeft size={17} /> Все примеры</button>
      <div className="public-detail-grid">
        <div className="detail-preview"><DemoArt demo={demo} large /></div>
        <div className="detail-copy">
          <span className="eyebrow">{demo.kind.toUpperCase()} · {demo.tag.toUpperCase()}</span>
          <h1>{demo.title}</h1>
          <p className="detail-lead">{demo.description}</p>
          <div className="detail-meta"><span className="avatar">П</span><span>{demo.byline}</span><span>·</span><span>обновлено сегодня</span></div>
          <div className="detail-actions"><button className="primary" onClick={() => setStarted((value) => !value)}><MonitorPlay size={17} /> {started ? "Скрыть демо" : "Открыть демо"}</button><button onClick={() => location.assign("/bring")} aria-label="Принести на Полку"><Heart size={17} /> Принести свою работу</button></div>
          {started && <div className="demo-live" role="status"><div><span className="eyebrow">ДЕМО ОТКРЫТО</span><strong>{demo.motif === "dashboard" ? "Сценарий: базовый" : demo.motif === "report" ? "Период: последние 4 недели" : demo.motif === "prototype" ? "Шаг 1 из 3" : "Сцена 1 из 4"}</strong></div><button onClick={() => setStarted(false)}>{demo.motif === "prototype" ? "Продолжить" : "Следующий экран"} <ChevronRight size={15} /></button></div>}
          <div className="detail-note"><Check size={16} /><span>Проверено редакцией Полки<br /><small>Материал открыт без входа. Исходники автора не публикуются.</small></span></div>
          <div className="detail-section"><span className="eyebrow">Что попробовать</span><p>Откройте материал, найдите главный вывод и поделитесь ссылкой с командой. Скоро любой такой пример можно будет взять за основу.</p></div>
        </div>
      </div>
    </div>
  );
}

export function PublicGallery() {
  const [selected, setSelected] = useState<string | null>(() => location.pathname.split("/")[2] || null);
  const [filter, setFilter] = useState("Все");
  useEffect(() => {
    const pop = () => setSelected(location.pathname.split("/")[2] || null);
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  const open = (id: string | null) => {
    const path = id ? `/discover/${id}` : "/discover";
    history.pushState(null, "", path);
    setSelected(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const demo = demos.find((item) => item.id === selected);
  const visible = filter === "Все" ? demos : demos.filter((item) => item.kind === filter);
  if (demo) return <div className="public-page"><header className="public-header"><BrandLink /><div className="public-header-actions"><a href="/">Войти</a><button className="primary" onClick={() => location.assign("/bring")}><Plus size={16} /> Принести свою работу</button></div></header><DemoDetail demo={demo} onBack={() => open(null)} /></div>;
  return (
    <div className="public-page">
      <header className="public-header"><BrandLink /><nav className="public-nav"><a className="active" href="/discover">Витрина</a><a href="#how">Как это работает</a></nav><div className="public-header-actions"><a href="/">Войти</a><button className="primary" onClick={() => location.assign("/bring")}><Plus size={16} /> Принести свою работу</button></div></header>
      <main className="public-main">
        <section className="public-hero"><div><span className="eyebrow">ПРИМЕРЫ, КОТОРЫЕ ХОЧЕТСЯ ОТКРЫТЬ</span><h1>Хорошие идеи<br /><em>остаются рядом.</em></h1><p>Презентации, отчёты, дашборды и прототипы, созданные людьми и агентами. Откройте пример, сохраните его для себя или принесите свою работу.</p><div className="hero-actions"><button className="primary" onClick={() => open(demos[0].id)}>Посмотреть примеры <ArrowUpRight size={17} /></button><button onClick={() => location.assign("/bring")}>Добавить свою работу</button></div></div><div className="hero-stack"><div className="hero-stack-card hero-stack-back"><span>03</span><strong>новый<br />ритм</strong></div><div className="hero-stack-card hero-stack-mid"><span>02</span><strong>пульс<br />команды</strong></div><div className="hero-stack-card hero-stack-front"><span>01</span><strong>города,<br /><em>которые нас</em><br />изменили</strong><small>полка / пример</small></div></div></section>
        <section className="public-section" id="examples"><div className="section-heading"><div><span className="eyebrow">ОТКРЫТАЯ ВИТРИНА</span><h2>Выберите отправную точку</h2></div><div className="gallery-count"><Compass size={17} /> {demos.length} примеров</div></div><div className="filter-row">{["Все", "Презентация", "Отчёт", "Дашборд", "Прототип", "Визуальная история", "Мини-сайт"].map((name) => <button key={name} className={filter === name ? "active" : ""} onClick={() => setFilter(name)}>{name}</button>)}</div><div className="public-gallery">{visible.map((item) => <button className="public-card" key={item.id} onClick={() => open(item.id)}><DemoArt demo={item} /><div className="public-card-copy"><div className="card-kind"><span>{item.kind}</span><ArrowUpRight size={15} /></div><h3>{item.title}</h3><p>{item.description}</p><div className="card-byline"><span className="mini-avatar">П</span>{item.byline}<span className="card-tag">{item.tag}</span></div></div></button>)}</div></section>
        <section className="public-submit" id="how"><div className="submit-icon"><WandSparkles size={26} /></div><div><span className="eyebrow">СВОЯ РАБОТА</span><h2>Есть исследование или проект?</h2><p>Сохраните его на Полке. В ближайшем пилоте можно будет предложить конкретную версию в общую витрину — после короткой проверки.</p></div><button onClick={() => location.assign("/bring")}>Открыть быстрый вход <ChevronRight size={17} /></button></section>
      </main>
      <footer className="public-footer"><BrandLink /><span>Живые материалы для живой работы.</span><a href="/">Открыть личную полку <ArrowUpRight size={14} /></a></footer>
    </div>
  );
}
