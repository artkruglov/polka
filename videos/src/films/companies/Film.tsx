import React from "react";
import { AbsoluteFill } from "remotion";
import type { CSSProperties, ReactNode } from "react";
import { Check, FileText, Folder, Link as LinkIcon, LockKeyhole, Pin, Search, Terminal, UserMinus } from "lucide-react";
import "../../brand/polka.css";
import "../../brand/fonts";
import { TextCover } from "../../../../apps/web/src/widgets/artifact-preview/TextCover.tsx";
import { AgentMark } from "../../brand/AgentMark";
import { MarkLayer, WaveBand } from "../../brand/Scaffold";
import { C, FONT, MONO, type AgentId } from "../../brand/tokens";
import { TargetLog } from "../../kit/debug";
import { cut, out, press, typed } from "../../kit/motion";
import { swapIn } from "../../kit/move";
import { Punchlines, type Card } from "../../kit/punchlines";
import { beatLength, clamp01, useTime } from "../../kit/time";
import { CUES as Q, DURATION, FEATURES, GRID, feature } from "./cues";

const BEAT = beatLength(GRID);

type Work = { id: string; title: string; eyebrow: string; agent: AgentId; team: string; ask: string };
const WORKS: Work[] = [
  { id: "sales-discounts", title: "Расчёт скидок на IV квартал", eyebrow: "Страница", agent: "claude", team: "Продажи", ask: "Посчитай скидки для постоянных клиентов" },
  { id: "market-rivals", title: "Разбор конкурентов", eyebrow: "Отчёт", agent: "chatgpt", team: "Маркетинг", ask: "Сравни нас с тремя конкурентами" },
  { id: "legal-supply", title: "Черновик договора поставки", eyebrow: "Текст", agent: "gemini", team: "Юристы", ask: "Набросай договор поставки" },
  { id: "finance-budget", title: "Бюджет отдела на квартал", eyebrow: "Страница", agent: "claude", team: "Финансы", ask: "Сведи бюджет отдела" },
  { id: "hr-onboarding", title: "План адаптации новичка", eyebrow: "Страница", agent: "perplexity", team: "HR", ask: "План первой недели для новичка" },
  { id: "team-quarter", title: "Отчёт команды за квартал", eyebrow: "Отчёт", agent: "chatgpt", team: "Разработка", ask: "Собери отчёт за квартал" },
];

const words = (list: readonly string[], times: readonly number[], accent: number[] = []) =>
  list.map((text, i) => ({ text, at: times[i], accent: accent.includes(i) }));
const CARDS: Card[] = [
  { lines: [words(["Агенты", "работают"], Q.line1.slice(0, 2)), words(["в", "каждом", "отделе."], [Q.line1[2], Q.line1[3], Q.line1[3] + BEAT / 2])], out: Q.line1Out, y: 620, size: 128 },
  { lines: [words(["Работа", "теряется"], Q.line2.slice(0, 2), [1]), words(["в", "чатах."], Q.line2.slice(2))], out: Q.line2Out, y: 540, size: 132 },
  { lines: [words(["Соберите", "всё"], Q.line3.slice(0, 2)), words(["на", "Полке."], Q.line3.slice(2), [1])], out: Q.line3Out, y: 540, size: 140 },
  { lines: [words(["Полка", "для", "компаний."], Q.line5, [0])], out: Q.line5Out, y: 580, size: 140 },
];

const RAIL = [
  "Агенты сохраняют сами",
  "Полки отделов и роли",
  "Поиск по тексту",
  "Проект из папки",
  "Библиотека шаблонов",
  "Ссылки только для сотрудников",
  "Журнал агентов и SIEM",
  "Уход сотрудника за один шаг",
  "Своя установка и вход через IdP",
];
const COMMERCIAL = new Set([5, 6]);

export function CompaniesFilm({ debug = false }: { debug?: boolean }) {
  const t = useTime();
  const shots = [AgentsShot, RolesShot, SearchShot, ProjectShot, TemplatesShot, LinksShot, JournalShot, OffboardShot, InstallShot];
  return (
    <AbsoluteFill style={{ background: C.canvas, fontFamily: FONT, color: C.ink }}>
      <WaveBand t={t} duration={DURATION} words={[[Q.line1[0], Q.line1Out], [Q.line2[0], Q.line3Out], [Q.line5[0], Q.line5Out]]} />
      <Chats t={t} />
      {shots.map((Shot, i) => {
        const v = cut(t, feature(i), i === FEATURES - 1 ? Q.featuresOut - 0.34 : feature(i + 1) - 0.2);
        if (!v) return null;
        return (
          <div key={i} style={{ position: "absolute", left: 70, top: 170, width: 1230, height: 820, ...v }}>
            <ShotHeader i={i} />
            <div style={{ position: "absolute", left: 0, right: 0, top: 150, bottom: 0 }}><Shot lt={t - feature(i)} /></div>
          </div>
        );
      })}
      <Rail t={t} />
      <MarkLayer t={t} draw={Q.markDraw} firstWord={Q.line1[0]} firstOut={Q.line1Out} end={Q.markEnd} />
      <Punchlines t={t} cards={CARDS} theme={{ font: FONT, color: C.ink, accent: C.accent, weight: 600 }} />
      {debug && <TargetLog />}
    </AbsoluteFill>
  );
}

function ShotHeader({ i }: { i: number }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 16, color: C.accent, font: `600 22px/1 ${FONT}`, letterSpacing: ".12em" }}>
        {String(i + 1).padStart(2, "0")}
        {COMMERCIAL.has(i) && <span style={{ padding: "6px 12px", borderRadius: 999, background: C.accentSoft, color: C.accentInk, letterSpacing: 0, fontSize: 18, fontWeight: 500 }}>Коммерческая редакция</span>}
      </div>
      <div style={{ marginTop: 14, font: `600 56px/1.05 ${FONT}`, letterSpacing: "-.035em" }}>{RAIL[i]}</div>
    </div>
  );
}

/** Everything Полка does for a company, checked off as each shot plays. */
function Rail({ t }: { t: number }) {
  const v = cut(t, Q.featuresIn - 0.1, Q.featuresOut - 0.34, 120);
  if (!v) return null;
  return (
    <div style={{ position: "absolute", left: 1380, top: 176, width: 480, ...v }}>
      <div style={{ color: C.muted, font: `600 18px/1 ${FONT}`, letterSpacing: ".12em", textTransform: "uppercase" }}>Полка для компании</div>
      <div style={{ marginTop: 24, display: "grid", gap: 6 }}>
        {RAIL.map((label, i) => {
          const start = feature(i);
          const current = t >= start && t < feature(i + 1);
          const done = t >= feature(i + 1) - 0.2 || (i === FEATURES - 1 && t >= Q.featuresOut - 0.5);
          const on = clamp01((t - start) / 0.25);
          return (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 14, height: 70, padding: "0 18px", borderRadius: 12,
              background: current ? C.accentSoft : "transparent", color: current ? C.accentInk : done ? C.ink : C.muted,
              opacity: current || done ? 1 : 0.5, font: `${current ? 600 : 500} 23px/1.2 ${FONT}` }}>
              <span style={{ display: "grid", placeItems: "center", width: 30, height: 30, flex: "none", borderRadius: 999,
                background: done ? C.accent : current ? C.canvas : C.soft2, color: "#fff", border: current ? `2px solid ${C.accent}` : undefined, scale: String(done ? 1 : 0.9 + 0.1 * on) }}>
                {done ? <Check size={18} strokeWidth={3} /> : null}
              </span>
              {label}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Six department chats; each work streams in, then the chats close and the works fade to ghosts. */
function Chats({ t }: { t: number }) {
  if (t < Q.windowsIn[0] - 0.2 || t > Q.windowsOut + 0.3) return null;
  return (
    <>
      {WORKS.map((w, i) => {
        const x = 110 + (i % 3) * 580, y = 170 + Math.floor(i / 3) * 400;
        const v = swapIn(t, Q.windowsIn[i] - 0.18, Q.windowsOut + 0.1);
        const close = clamp01((t - Q.closing[i]) / 0.3);
        const cover = clamp01((t - Q.windowsIn[i] - 0.35) / 0.25);
        return (
          <div key={w.id} style={{ position: "absolute", left: x, top: y, width: 540, height: 360, opacity: v.opacity, filter: v.filter,
            translate: `${(1 - out(clamp01((t - Q.windowsIn[i]) / 0.4))) * 60}px 0` }}>
            <div style={{ position: "absolute", inset: 0, borderRadius: 16, border: `1px solid ${C.lineStrong}`, background: C.canvas, boxShadow: "0 8px 22px rgb(22 36 67/8%)", opacity: 1 - close * 0.85 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 20px", borderBottom: `1px solid ${C.line}` }}>
                <AgentMark agent={w.agent} size={32} />
                <span style={{ fontSize: 20, fontWeight: 600 }}>{w.team}</span>
              </div>
              <div style={{ margin: "14px 20px 0", padding: "8px 14px", borderRadius: 12, background: C.soft, fontSize: 18, color: C.ink2, width: "fit-content" }}>{w.ask}</div>
            </div>
            <div style={{ position: "absolute", left: 24, top: 132, width: 320, height: 200, borderRadius: 10, overflow: "hidden", border: `1px solid ${C.line}`,
              opacity: cover * (1 - close * 0.8), filter: close ? `grayscale(${close}) blur(${close * 2}px)` : cover < 1 ? `blur(${(1 - cover) * 8}px)` : undefined }}>
              <TextCover id={w.id} title={w.title} eyebrow={w.eyebrow} />
            </div>
          </div>
        );
      })}
    </>
  );
}

// ——— Feature shots. `lt` is seconds since the shot began; a bar is 1.82 s. ———

const appear = (lt: number, at: number): CSSProperties => {
  const u = out(clamp01((lt - at) / 0.35));
  return { opacity: u, translate: `${(1 - u) * 40}px 0`, filter: u < 1 ? `blur(${(1 - u) * 6}px)` : undefined };
};
const panel: CSSProperties = { borderRadius: 16, border: `1px solid ${C.line}`, background: C.canvas, boxShadow: "0 8px 22px rgb(22 36 67/8%)" };

const Cover = ({ w, width, style }: { w: Work; width: number; style?: CSSProperties }) => (
  <div style={{ width, height: width * 10 / 16, borderRadius: 10, overflow: "hidden", border: `1px solid ${C.line}`, flex: "none", ...style }}>
    <TextCover id={w.id} title={w.title} eyebrow={w.eyebrow} compact={width < 200} />
  </div>
);

const Mono = ({ children }: { children: ReactNode }) => (
  <span style={{ display: "inline-grid", placeItems: "center", width: 44, height: 44, borderRadius: 12, background: C.ink, color: "#fff", font: `600 18px/1 ${FONT}`, flex: "none" }}>{children}</span>
);

function AgentsShot({ lt }: { lt: number }) {
  const sources: [ReactNode, string, string][] = [
    [<AgentMark agent="claude" size={44} />, "Claude.ai", "коннектор MCP"],
    [<AgentMark agent="chatgpt" size={44} />, "ChatGPT", "коннектор MCP"],
    [<AgentMark agent="claude" size={44} />, "Claude Code", "одна команда"],
    [<Mono>Cx</Mono>, "Codex", "одна команда"],
    [<Mono><Terminal size={22} /></Mono>, "Скрипты", "HTTP API"],
  ];
  const count = Math.min(6, Math.max(0, Math.floor((lt - 0.45) / 0.14) + 1));
  return (
    <div style={{ display: "flex", gap: 60, alignItems: "flex-start" }}>
      <div style={{ display: "grid", gap: 14, width: 440 }}>
        {sources.map(([icon, name, how], i) => (
          <div key={name} style={{ display: "flex", alignItems: "center", gap: 16, height: 86, padding: "0 22px", ...panel, ...appear(lt, 0.1 + i * 0.12) }}>
            {icon}
            <div><div style={{ fontSize: 26, fontWeight: 600 }}>{name}</div><div style={{ fontSize: 20, color: C.muted }}>{how}</div></div>
          </div>
        ))}
      </div>
      <div style={{ ...panel, width: 700, padding: 28, ...appear(lt, 0.3) }}>
        <div style={{ fontSize: 26, fontWeight: 600 }}>Продажи · полка отдела</div>
        <div style={{ marginTop: 20, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          {WORKS.map((w, i) => (
            <div key={w.id} style={{ opacity: clamp01((lt - 0.45 - i * 0.14) / 0.2), scale: String(0.9 + 0.1 * out(clamp01((lt - 0.45 - i * 0.14) / 0.3))) }}>
              <Cover w={w} width={200} />
            </div>
          ))}
        </div>
        <div style={{ marginTop: 18, fontSize: 22, color: C.muted, fontVariantNumeric: "tabular-nums" }}>{count} работ · сохранили агенты сотрудников</div>
      </div>
    </div>
  );
}

function RolesShot({ lt }: { lt: number }) {
  const people: [string, string, string][] = [["АК", "Анна", "Администратор"], ["ИС", "Илья", "Куратор"], ["МВ", "Мария", "Автор"], ["ОП", "Олег", "Читатель"]];
  return (
    <div style={{ ...panel, padding: 32 }}>
      <div style={{ display: "flex", gap: 18 }}>
        {people.map(([ini, name, role], i) => (
          <div key={name} style={{ flex: 1, display: "flex", alignItems: "center", gap: 14, padding: 18, borderRadius: 12, background: C.soft3, border: `1px solid ${C.line}`, ...appear(lt, 0.1 + i * 0.12) }}>
            <span style={{ display: "grid", placeItems: "center", width: 52, height: 52, borderRadius: 999, background: C.accentSoft, color: C.accentInk, fontWeight: 600, fontSize: 20 }}>{ini}</span>
            <div><div style={{ fontSize: 24, fontWeight: 600 }}>{name}</div>
              <span style={{ display: "inline-block", marginTop: 4, padding: "3px 10px", borderRadius: 999, background: i === 0 ? C.accent : C.soft2, color: i === 0 ? "#fff" : C.ink2, fontSize: 18 }}>{role}</span></div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 28, display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 14, ...appear(lt, 0.55) }}>
        {WORKS.map((w) => <Cover key={w.id} w={w} width={176} />)}
      </div>
      <div style={{ marginTop: 22, fontSize: 24, color: C.ink2, ...appear(lt, 0.8) }}>Работы принадлежат отделу: сотрудник уходит — они остаются.</div>
    </div>
  );
}

function SearchShot({ lt }: { lt: number }) {
  const q = typed("скидки", lt, 0.15, 14);
  const found = clamp01((lt - 0.95) / 0.28);
  return (
    <div style={{ ...panel, padding: 32 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, height: 64, padding: "0 20px", borderRadius: 12, border: `2px solid ${C.accent}`, boxShadow: `0 0 0 4px ${C.accentSoft}`, fontSize: 28 }}>
        <Search size={26} color={C.muted} />
        <span style={{ color: q ? C.ink : C.muted }}>{q || "Поиск по названию и тексту"}</span>
      </div>
      <div style={{ marginTop: 28, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24 }}>
        {WORKS.map((w, i) => (
          <div key={w.id} style={{ opacity: i === 0 ? 1 : 1 - found * 0.88 }}>
            <Cover w={w} width={352} />
            <div style={{ marginTop: 10, fontSize: 22, fontWeight: 600 }}>{w.title}</div>
            {i === 0 && <div style={{ marginTop: 4, fontSize: 20, color: C.muted, opacity: found }}>…персональные <mark style={{ background: C.accentSoft, color: C.ink, padding: "0 4px", borderRadius: 4 }}>скидки</mark> для постоянных клиентов…</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProjectShot({ lt }: { lt: number }) {
  const files: [number, string, boolean][] = [[0, "README.md", false], [0, "01-market", true], [1, "overview.md", false], [0, "02-users", true], [1, "stories.md", false], [0, "screens", true], [1, "index.html", false], [1, "shared/ui.css", false], [1, "shot.png", false]];
  const active = Math.min(files.length - 1, Math.max(0, Math.floor((lt - 0.3) / 0.14)));
  const pick = lt > 1.2 ? 4 : active;
  return (
    <div style={{ display: "flex", gap: 24 }}>
      <div style={{ ...panel, width: 360, padding: "22px 14px", ...appear(lt, 0.05) }}>
        <div style={{ padding: "0 12px 14px", fontSize: 20, color: C.muted }}>Исследование · 107 файлов</div>
        {files.map(([depth, name, dir], i) => (
          <div key={name} style={{ display: "flex", alignItems: "center", gap: 10, height: 50, paddingLeft: 12 + depth * 26, borderRadius: 8, fontSize: 22,
            background: i === pick ? C.accentSoft : undefined, color: i === pick ? C.accentInk : C.ink2, opacity: clamp01((lt - 0.1 - i * 0.05) / 0.2) }}>
            {dir ? <Folder size={20} /> : <FileText size={20} />}{name}
          </div>
        ))}
      </div>
      <div style={{ ...panel, flex: 1, padding: 40, ...appear(lt, 0.25) }}>
        <div style={{ color: C.muted, font: `400 18px ${MONO}` }}>02-users / stories.md</div>
        <div style={{ marginTop: 16, font: `600 44px/1.1 ${FONT}`, letterSpacing: "-.03em" }}>Истории пользователей</div>
        <p style={{ marginTop: 18, fontSize: 24, lineHeight: 1.55, color: C.ink2 }}>Менеджер готовит коммерческое предложение для клиента. Подробности — в <span style={{ color: C.accent }}>01-market/overview.md</span>, экраны — в <span style={{ color: C.accent }}>screens/index.html</span>.</p>
        <div style={{ marginTop: 22, fontSize: 22, color: C.muted, ...appear(lt, 0.7) }}>Папка до 400 файлов — одной работой, ссылки между страницами работают.</div>
      </div>
    </div>
  );
}

function TemplatesShot({ lt }: { lt: number }) {
  const tmpl: Work = { ...WORKS[5], id: "tmpl-team-report", title: "Отчёт команды" };
  const made: Work = { ...WORKS[5], id: "sept-report", title: "Отчёт за сентябрь" };
  const reading = clamp01((lt - 0.45) / 0.3);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
      <div style={{ ...panel, padding: 26, ...appear(lt, 0.05) }}>
        <Cover w={tmpl} width={360} />
        <div style={{ marginTop: 14, fontSize: 26, fontWeight: 600 }}>Отчёт команды</div>
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, fontSize: 20, color: C.accentInk }}><Pin size={18} /> Шаблон · версия 2 · библиотека команды</div>
      </div>
      <div style={{ display: "grid", justifyItems: "center", gap: 10, opacity: reading }}>
        <AgentMark agent="claude" size={56} />
        <div style={{ fontSize: 20, color: C.muted, textAlign: "center" }}>агент читает<br />шаблон v2</div>
        <svg width="120" height="20"><line x1="0" y1="10" x2={120 * reading} y2="10" stroke={C.accent} strokeWidth="3" strokeDasharray="8 8" /></svg>
      </div>
      <div style={{ ...panel, padding: 26, ...appear(lt, 0.8) }}>
        <Cover w={made} width={360} />
        <div style={{ marginTop: 14, fontSize: 26, fontWeight: 600 }}>Отчёт за сентябрь</div>
        <div style={{ marginTop: 6, fontSize: 20, color: C.muted }}>Шаблон «Отчёт команды», версия 2</div>
      </div>
    </div>
  );
}

function Toggle({ label, note, on, at, click }: { label: string; note: string; on: boolean; at: number; click: number }) {
  const u = out(clamp01((at - click) / 0.2));
  return (
    <div style={{ marginTop: 22, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, padding: "16px 18px", borderRadius: 12, border: `1px solid ${on ? C.accent : C.line}`, background: on ? C.accentSoft : C.canvas, scale: String(press(at, click)) }}>
      <div><div style={{ fontSize: 24, fontWeight: 600 }}>{label}</div><div style={{ fontSize: 19, color: C.muted }}>{note}</div></div>
      <span style={{ position: "relative", width: 60, height: 34, borderRadius: 99, background: on ? C.accent : C.lineStrong, flex: "none" }}>
        <i style={{ position: "absolute", top: 4, left: 4 + 26 * u, width: 26, height: 26, borderRadius: 99, background: "#fff" }} />
      </span>
    </div>
  );
}

function LinksShot({ lt }: { lt: number }) {
  return (
    <div style={{ display: "flex", gap: 30, alignItems: "flex-start" }}>
      <div style={{ ...panel, width: 620, padding: 30, ...appear(lt, 0.05) }}>
        <div style={{ fontSize: 26, fontWeight: 600 }}>Поделиться · Разбор конкурентов</div>
        <Toggle label="Только для сотрудников" note="Откроется после входа в Полку компании" on={lt > 0.5} at={lt} click={0.5} />
        <Toggle label="Предельный срок" note="Не дольше 7 дней для всей компании" on={lt > 0.75} at={lt} click={0.75} />
        <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 10, height: 54, padding: "0 16px", borderRadius: 10, background: C.soft, font: `400 20px ${MONO}`, color: C.ink2 }}>
          <LinkIcon size={18} /> polka.intranet/s#k2Q…
        </div>
      </div>
      <div style={{ ...panel, flex: 1, padding: 34, textAlign: "center", ...appear(lt, 1.0) }}>
        <div style={{ display: "inline-grid", placeItems: "center", width: 76, height: 76, borderRadius: 18, background: C.accentSoft, color: C.accent }}><LockKeyhole size={36} /></div>
        <div style={{ marginTop: 18, fontSize: 28, fontWeight: 600 }}>Ссылка для сотрудников</div>
        <div style={{ marginTop: 8, fontSize: 22, color: C.muted }}>Войдите в Полку компании, чтобы открыть работу</div>
        <div style={{ marginTop: 22, display: "inline-flex", height: 52, alignItems: "center", padding: "0 26px", borderRadius: 10, background: C.accent, color: "#fff", fontSize: 22, fontWeight: 600 }}>Войти</div>
      </div>
    </div>
  );
}

const Chip = ({ children, accent = false }: { children: ReactNode; accent?: boolean }) => (
  <span style={{ display: "inline-flex", alignItems: "center", height: 48, padding: "0 20px", borderRadius: 999, fontSize: 22, fontWeight: 500,
    background: accent ? C.accent : C.soft2, color: accent ? "#fff" : C.ink2 }}>{children}</span>
);

function JournalShot({ lt }: { lt: number }) {
  const rows: [string, AgentId, string, string][] = [
    ["10:02", "claude", "Продажи", "сохранил «Расчёт скидок на IV квартал»"],
    ["10:05", "chatgpt", "Маркетинг", "новая версия «Разбора конкурентов»"],
    ["10:09", "gemini", "Юристы", "перенёс «Договор поставки» в папку «На согласовании»"],
    ["10:14", "claude", "Продажи", "выпустил ссылку на 7 дней"],
  ];
  return (
    <div style={{ ...panel, padding: "18px 30px 26px" }}>
      {rows.map(([time, agent, shelf, what], i) => (
        <div key={time} style={{ display: "flex", alignItems: "center", gap: 18, height: 96, borderBottom: `1px solid ${C.line}`, fontSize: 24, ...appear(lt, 0.1 + i * 0.2) }}>
          <span style={{ width: 80, color: C.muted, font: `400 22px ${MONO}` }}>{time}</span>
          <AgentMark agent={agent} size={40} />
          <span style={{ width: 150, color: C.muted }}>{shelf}</span>
          <span>{what}</span>
        </div>
      ))}
      <div style={{ marginTop: 22, display: "flex", gap: 14, ...appear(lt, 1.0) }}>
        <Chip>Отбор по сроку и сотруднику</Chip><Chip accent>Выгрузка в SIEM · JSON Lines</Chip>
      </div>
    </div>
  );
}

function OffboardShot({ lt }: { lt: number }) {
  const click = 0.6;
  const done = clamp01((lt - click - 0.35) / 0.25);
  const rows = ["Снята с полок «Продажи» и «Маркетинг»", "Подключения агентов отозваны", "Работы остались у отделов"];
  return (
    <div style={{ ...panel, padding: 34 }}>
      <div style={{ fontSize: 22, color: C.muted }}>Полки компании · администратор</div>
      <div style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 18, padding: 20, borderRadius: 12, border: `1px solid ${C.line}`, background: C.soft3, ...appear(lt, 0.05) }}>
        <span style={{ display: "grid", placeItems: "center", width: 60, height: 60, borderRadius: 999, background: C.accentSoft, color: C.accentInk, fontWeight: 600, fontSize: 22 }}>МВ</span>
        <div style={{ flex: 1 }}><div style={{ fontSize: 26, fontWeight: 600, textDecoration: done ? "line-through" : undefined, color: done ? C.muted : C.ink }}>Мария · уходит из компании</div>
          <div style={{ fontSize: 20, color: C.muted }}>2 полки отделов · 2 агента</div></div>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10, height: 56, padding: "0 22px", borderRadius: 10, background: "#b3261e", color: "#fff", fontSize: 22, fontWeight: 600, scale: String(press(lt, click)), opacity: 1 - done * 0.5 }}>
          <UserMinus size={22} /> Убрать со всех полок
        </span>
      </div>
      <div style={{ marginTop: 22, display: "grid", gap: 12 }}>
        {rows.map((r, i) => (
          <div key={r} style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 24, ...appear(lt, click + 0.4 + i * 0.14) }}>
            <span style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: 99, background: C.successSoft, color: C.success }}><Check size={18} strokeWidth={3} /></span>{r}
          </div>
        ))}
      </div>
    </div>
  );
}

function InstallShot({ lt }: { lt: number }) {
  const layers: [string, string][] = [
    ["Docker-образ", "на ваших серверах или в российском облаке"],
    ["PostgreSQL и S3-хранилище", "MinIO или Yandex Object Storage, все версии работ"],
    ["Вход через IdP компании", "OpenID Connect: Keycloak, Avanpost, ADFS; Яндекс ID"],
    ["Песочница для страниц", "отдельный домен, без сети и без cookie Полки"],
  ];
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {layers.map(([title, note], i) => (
        <div key={title} style={{ display: "flex", alignItems: "center", gap: 22, height: 132, padding: "0 32px", ...panel, ...appear(lt, 0.1 + i * 0.16) }}>
          <span style={{ width: 16, height: 70, borderRadius: 8, background: i === 2 ? C.accent : C.accentSoft, flex: "none" }} />
          <div><div style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-.02em" }}>{title}</div><div style={{ marginTop: 4, fontSize: 22, color: C.muted }}>{note}</div></div>
        </div>
      ))}
    </div>
  );
}

export const COMPANIES_DURATION = DURATION;
