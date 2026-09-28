import React from "react";
import { AbsoluteFill } from "remotion";
import type { ReactNode } from "react";
import { ArrowUp, Check, Copy, Globe, Link as LinkIcon, LockKeyhole, X } from "lucide-react";
import "../../brand/polka.css";
import "../../brand/fonts";
import { TextCover } from "../../../../apps/web/src/widgets/artifact-preview/TextCover.tsx";
import { AgentMark } from "../../brand/AgentMark";
import { MarkLayer, WaveBand } from "../../brand/Scaffold";
import { C, FONT, MONO } from "../../brand/tokens";
import { AppWindow } from "../../twins/AppWindow";
import { cursorAt, UserCursor, type CursorKey } from "../../kit/cursor";
import { move, swapIn, type Rect } from "../../kit/move";
import { Punchlines, type Card } from "../../kit/punchlines";
import { clamp01, progress, useTime } from "../../kit/time";
import { TargetLog } from "../../kit/debug";
import { camera, cut, ink, press, stream, typed, type Shot } from "../../kit/motion";
import { CUES as Q, DURATION, b } from "./cues";

// One window geometry for every app scene: the app drawn at 990×660 and
// scaled 1.4 for 1080p (app body 14 px → 19.6 px, titles 16+ → 22+).
const WIN = { x: 264, y: 40, w: 990, h: 660, s: 1.4 };
const TOP = WIN.y + 44 * WIN.s; // content origin on screen
const scr = (r: Rect): Rect => ({ x: WIN.x + r.x * WIN.s, y: TOP + r.y * WIN.s, w: r.w * WIN.s, h: r.h * WIN.s });

const WORK = { id: "trip-budget-karelia", title: "Бюджет поездки", eyebrow: "Страница" };
const LINK = "polochka.app/s#Vt3qK9…";

// Rects in app coordinates.
const CHAT_CARD: Rect = { x: 76, y: 150, w: 360, h: 225 };
const SHELF_COL = (990 - 80 - 48) / 3;
const SHELF_COVER = (i: number): Rect => ({ x: 40 + (i % 3) * (SHELF_COL + 24), y: 112 + Math.floor(i / 3) * (SHELF_COL * 10 / 16 + 108), w: SHELF_COL, h: SHELF_COL * 10 / 16 });
// Measured with --debug stills (TargetLog), screen px.
const LINK_TEXT: Rect = { x: 617, y: 699, w: 300, h: 28 }; // the link inside «Ссылка на работу»
const POST = { x: 480, y: 280, w: 960 };
const POST_TEXT = "Посчитали поездку в Карелию на двоих — всё по дням:";
const POST_LINK: Rect = { x: 529, y: 458, w: 300, h: 44 }; // post-link, left edge
const AT = { input: { x: 1300, y: 947 }, send: { x: 1565, y: 947 }, byLink: { x: 1180, y: 556 }, enable: { x: 1140, y: 797 }, copy: { x: 1180, y: 802 } };

const words = (list: readonly string[], times: readonly number[], accent: number[] = []) =>
  list.map((text, i) => ({ text, at: times[i], accent: accent.includes(i) }));

const CARDS: Card[] = [
  { lines: [words(["Сделали", "с", "агентом."], Q.line1)], out: Q.line1Out, y: 580, size: 140 },
  { lines: [words(["Одна", "ссылка."], Q.line2, [1])], out: Q.line2Out, y: 540, size: 150 },
  { lines: [words(["Открывается"], Q.line3.slice(0, 1)), words(["без", "регистрации."], Q.line3.slice(1))], out: Q.line3Out, y: 540, size: 130 },
  { lines: [words(["Покажите", "другим."], Q.line4, [1])], out: Q.line4Out, y: 580, size: 150 },
];

const CURSOR: CursorKey[] = [
  { t: 0, x: 1500, y: 1180 },
  { t: Q.typeStart - 0.6, x: 1500, y: 1180 },
  { t: Q.typeStart, ...AT.input, click: true },
  { t: Q.send, ...AT.send, click: true },
  { t: Q.saved + 0.4, x: 1450, y: 1010 },
  { t: Q.shareIn + 0.3, x: 1450, y: 900 },
  { t: Q.pickLink, ...AT.byLink, click: true },
  { t: Q.enable, ...AT.enable, click: true },
  { t: Q.copy, ...AT.copy, click: true },
  { t: Q.shareOut, x: 1500, y: 1180 },
];

// The camera (ui-focus-zoom): push in on each payoff, back out before the next move.
const CAMERA: Shot[] = [
  [0, 960, 540, 1],
  [Q.answer + 1.3, 700, 520, 1.16],
  [Q.typeStart - 0.3, 960, 560, 1],
  [Q.landed + 0.15, 620, 470, 1.12],
  [Q.shelfOut - 0.4, 960, 540, 1],
  [Q.linkReady + 0.2, 960, 700, 1.22],
  [Q.linkFly, 960, 540, 1],
];

export function PeopleFilm({ debug = false }: { debug?: boolean }) {
  const t = useTime();
  const cursor = cursorAt(t, CURSOR, (x, y) => ({ x, y }));
  // Never over the big words: hidden from «Одна ссылка.» until «Поделиться».
  const cursorShown = t > Q.typeStart - 0.7 && t < Q.shareOut && !(t > Q.line2[0] - 0.3 && t < Q.shareIn + 0.1);
  return (
    <AbsoluteFill style={{ background: C.canvas, fontFamily: FONT, color: C.ink }}>
      <WaveBand t={t} duration={DURATION} words={[[Q.line1[0], Q.line1Out], [Q.line2[0], Q.line2Out], [Q.line3[0], Q.line3Out], [Q.line4[0], Q.line4Out]]} />
      <AbsoluteFill style={camera(t, CAMERA)}>
        <Chat t={t} />
        <Shelf t={t} />
        <Share t={t} />
        <Post t={t} />
        <Traveler t={t} />
        <LinkTraveler t={t} />
        {cursorShown && <div style={{ position: "absolute", left: cursor.x, top: cursor.y, scale: "1.5", transformOrigin: "0 0" }}><UserCursor x={0} y={0} squash={cursor.squash} /></div>}
      </AbsoluteFill>
      <Phone t={t} />
      <MarkLayer t={t} draw={Q.markDraw} firstWord={Q.line1[0]} firstOut={Q.line1Out} end={Q.markEnd} />
      <Punchlines t={t} cards={CARDS} theme={{ font: FONT, color: C.ink, accent: C.accent, weight: 600 }} />
      {debug && <TargetLog />}
    </AbsoluteFill>
  );
}

function Chat({ t }: { t: number }) {
  const v = cut(t, Q.chatIn - 0.3, Q.chatOut);
  if (!v) return null;
  const line = typed("Сохрани это на Полку", t, Q.typeStart + 0.1, 18);
  const n = line.length;
  const sent = t >= Q.send;
  const reply = stream("Готово: бюджет по дням и итог.", Q.answer, 1.2);
  // The work appears after the reply has streamed, a beat of stillness before it.
  const answer = swapIn(t, reply[reply.length - 1].at + 0.25, Infinity);
  const saved = swapIn(t, Q.saved - 0.18, Infinity);
  const flying = t >= Q.fly;
  return (
    <AppWindow x={WIN.x} y={WIN.y} width={WIN.w} height={WIN.h} scale={WIN.s} address="Чат с агентом" style={v}>
      <div style={{ position: "absolute", inset: 0, padding: 32, fontSize: 16, lineHeight: 1.5 }}>
        <Bubble y={24}>Посчитай бюджет поездки в Карелию на 5 дней на двоих</Bubble>
        <div style={{ position: "absolute", left: 32, top: 100, display: "flex", gap: 12, alignItems: "center", opacity: clamp01((t - Q.answer + 0.2) / 0.2) }}>
          <AgentMark agent="claude" size={32} />
          <span>{reply.map((w) => (
            <span key={w.at} style={{ color: ink(t, w.at) >= 1 ? C.ink2 : "#767676", opacity: ink(t, w.at) > 0 ? 0.35 + 0.65 * ink(t, w.at) : 0 }}>{w.word} </span>
          ))}</span>
        </div>
        <div data-target="chat-card" style={{ position: "absolute", left: CHAT_CARD.x, top: CHAT_CARD.y, width: CHAT_CARD.w, height: CHAT_CARD.h, borderRadius: 10,
          border: `1px solid ${C.line}`, overflow: "hidden", opacity: flying ? 0 : answer.opacity, filter: answer.filter }}>
          <TextCover id={WORK.id} title={WORK.title} eyebrow={WORK.eyebrow} note="42 000 ₽ на двоих" />
        </div>
        {sent && <Bubble y={410}>Сохрани это на Полку</Bubble>}
        <div style={{ position: "absolute", left: 32, top: 470, display: "flex", gap: 12, alignItems: "center", opacity: saved.opacity, filter: saved.filter }}>
          <AgentMark agent="claude" size={32} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 999, background: C.successSoft, color: C.success, fontWeight: 500 }}>
            <Check size={16} /> Сохранено на Полку
          </span>
          <span style={{ color: C.muted, font: `400 14px ${MONO}` }}>polochka.app/works/7f3c…</span>
        </div>
        <div data-target="chat-input" style={{ position: "absolute", left: 32, right: 32, bottom: 32, height: 52, display: "flex", alignItems: "center", gap: 12, padding: "0 10px 0 18px",
          borderRadius: 12, border: `1px solid ${t >= Q.typeStart && !sent ? C.accent : C.lineStrong}`, boxShadow: t >= Q.typeStart && !sent ? `0 0 0 3px ${C.accentSoft}` : undefined }}>
          <span style={{ flex: 1, color: n && !sent ? C.ink : C.muted }}>{n && !sent ? line : "Сообщение агенту"}</span>
          <span data-target="send" style={{ scale: String(press(t, Q.send)), display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 999, background: n && !sent ? C.accent : C.soft2, color: "#fff" }}>
            <ArrowUp size={18} />
          </span>
        </div>
      </div>
    </AppWindow>
  );
}

function Bubble({ y, children }: { y: number; children: string }) {
  return (
    <div style={{ position: "absolute", right: 32, top: y, maxWidth: 560, padding: "12px 16px", borderRadius: 16, background: C.soft, color: C.ink }}>{children}</div>
  );
}

const SHELF_WORKS = [
  WORK,
  { id: "how-sleep-works", title: "Как устроен сон", eyebrow: "Страница" },
  { id: "week-plan", title: "План на неделю", eyebrow: "Страница" },
  { id: "contractors", title: "Сравнение подрядчиков", eyebrow: "Страница" },
  { id: "team-quarter", title: "Отчёт команды за квартал", eyebrow: "Отчёт" },
  { id: "meeting-notes", title: "Заметки со встречи 18 сентября", eyebrow: "Текст" },
];

function Shelf({ t }: { t: number }) {
  const v = cut(t, Q.shelfIn - 0.3, Q.shelfOut - 0.2);
  if (!v) return null;
  const landed = t >= Q.landed;
  return (
    <AppWindow x={WIN.x} y={WIN.y} width={WIN.w} height={WIN.h} scale={WIN.s} address="polochka.app" style={v}>
      <div style={{ position: "absolute", inset: 0, padding: "30px 40px" }}>
        <h1 style={{ fontSize: 28, letterSpacing: "-.03em" }}>Моя полка</h1>
        <div className="shelf-gallery" style={{ position: "absolute", left: 40, right: 40, top: 112 }}>
          {SHELF_WORKS.map((w, i) => (
            <div className="shelf-card" key={w.id}>
              <div className="shelf-cover" data-target={`shelf-cover-${i}`} style={{ opacity: i === 0 && !landed ? 0 : 1 }}>
                <TextCover id={w.id} title={w.title} eyebrow={w.eyebrow} />
              </div>
              <div className="shelf-card-body" style={{ opacity: i === 0 && !landed ? 0 : 1 }}>
                <h3>{w.title}</h3>
                <p className="shelf-card-meta"><span>{i === 0 ? "Только что · через агента" : "Страница · на этой неделе"}</span></p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppWindow>
  );
}

/** The work itself travels: from the agent's answer to its slot on «Моя полка». */
function Traveler({ t }: { t: number }) {
  if (t < Q.fly || t > Q.landed + 0.05) return null;
  const r = move(t, Q.fly, scr(CHAT_CARD), scr(SHELF_COVER(0)));
  return (
    <div style={{ position: "absolute", left: r.x, top: r.y, width: CHAT_CARD.w, height: CHAT_CARD.h, scale: String(r.w / CHAT_CARD.w), transformOrigin: "0 0",
      borderRadius: 10, overflow: "hidden", border: `1px solid ${C.line}`, boxShadow: "0 20px 60px rgb(22 36 67/16%)", background: C.canvas }}>
      <TextCover id={WORK.id} title={WORK.title} eyebrow={WORK.eyebrow} note="42 000 ₽ на двоих" />
    </div>
  );
}

/** The work's own page, as the recipient sees it: the document first. */
function BudgetPage({ scale = 1 }: { scale?: number }) {
  const rows: [string, string][] = [["Дорога", "8 400 ₽"], ["Жильё, 4 ночи", "18 000 ₽"], ["Еда", "9 600 ₽"], ["Экскурсии", "6 000 ₽"]];
  return (
    <div style={{ padding: 24 * scale, fontSize: 15 * scale, lineHeight: 1.5 }}>
      <div style={{ color: C.muted, fontSize: 12 * scale, fontWeight: 600, letterSpacing: ".12em", textTransform: "uppercase" }}>Карелия · 5 дней · двое</div>
      <h1 style={{ fontSize: 30 * scale, lineHeight: 1.1, letterSpacing: "-.04em", marginTop: 6 * scale }}>Бюджет поездки</h1>
      <div style={{ marginTop: 18 * scale, borderTop: `1px solid ${C.line}` }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: `${10 * scale}px 0`, borderBottom: `1px solid ${C.line}` }}>
            <span style={{ color: C.ink2 }}>{k}</span><span>{v}</span>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", padding: `${12 * scale}px 0`, fontWeight: 600 }}>
          <span>Итого</span><span style={{ color: C.accent }}>42 000 ₽</span>
        </div>
      </div>
      <div style={{ marginTop: 22 * scale, color: C.muted, fontSize: 12 * scale, fontWeight: 600, letterSpacing: ".12em", textTransform: "uppercase" }}>По дням</div>
      {["Петрозаводск, набережная", "Кижи и Онежское озеро", "Рускеала, мраморный каньон", "Водопад Кивач", "Обратно"].map((d, i) => (
        <div key={d} style={{ display: "flex", gap: 12 * scale, padding: `${8 * scale}px 0`, borderBottom: `1px solid ${C.line}`, color: C.ink2 }}>
          <span style={{ color: C.accent, fontWeight: 600, width: 18 * scale }}>{i + 1}</span>{d}
        </div>
      ))}
      <div style={{ display: "flex", gap: 6 * scale, alignItems: "flex-end", height: 70 * scale, marginTop: 16 * scale }}>
        {[8.4, 18, 9.6, 6].map((v, i) => <i key={i} style={{ flex: 1, height: `${(v / 18) * 100}%`, borderRadius: 6 * scale, background: i === 1 ? C.accent : C.accentSoft }} />)}
      </div>
    </div>
  );
}

function Share({ t }: { t: number }) {
  const v = cut(t, Q.shareIn - 0.3, Q.shareOut);
  if (!v) return null;
  const dialog = clamp01((t - Q.shareIn) / 0.28);
  const link = t >= Q.pickLink;
  const busy = t >= Q.enable && t < Q.linkReady;
  const ready = t >= Q.linkReady;
  const copied = t >= Q.copy;
  const spin = ((t - Q.enable) * 360) % 360;
  return (
    <AppWindow x={WIN.x} y={WIN.y} width={WIN.w} height={WIN.h} scale={WIN.s} address="polochka.app/works/7f3c…" style={v}>
      <div style={{ position: "absolute", inset: 0, padding: "18px 160px" }}><BudgetPage /></div>
      <div style={{ position: "absolute", inset: 0, background: "rgb(15 20 32 / 36%)", opacity: dialog }} />
      <div className="ui-dialog" style={{ position: "absolute", left: 215, top: 16, width: 560, opacity: dialog, translate: `0 ${(1 - dialog) * 8}px` }}>
        <div className="dialog-head">
          <div className="dialog-title"><h2>Поделиться</h2></div>
          <span style={{ color: C.muted, display: "grid", placeItems: "center", width: 36, height: 36 }}><X size={18} /></span>
        </div>
        <div className="dialog-body share-panel">
          <div className="share-material">
            <span className="share-material-icon">{ready ? <LinkIcon /> : <LockKeyhole />}</span>
            <div><strong>{WORK.title}</strong><span>Страница · v1 · 14 КБ</span></div>
          </div>
          <fieldset className="share-choices">
            <legend>Кто может открыть</legend>
            <div className="ui-choice-list">
              <Choice icon={<LockKeyhole />} title="Только я" note="Видно только вам" selected={!link} />
              <Choice pressed={press(t, Q.pickLink)} target="choice-link" icon={<LinkIcon />} title="По ссылке" note="Откроет любой, у кого есть ссылка" selected={link} />
              {!ready && <Choice icon={<Globe />} title="Опубликовать" note="В «Ленте» после проверки редакцией Полки" disabled />}
            </div>
          </fieldset>
          {ready && (
            <div className="share-step">
              <span className="share-label">Ссылка на работу</span>
              <div className="ui-link-field" data-target="link-field"><code style={{ opacity: t >= Q.linkFly ? 0.25 : 1 }}>https://{LINK}</code><span style={{ width: 20 }} /></div>
              <button className="ui-button ui-button--primary ui-button--lg share-copy" data-target="copy" type="button" style={{ scale: String(press(t, Q.copy)) }}>
                {copied ? <Check /> : <Copy />}{copied ? "Скопировано" : "Скопировать ссылку"}
              </button>
            </div>
          )}
        </div>
        {!ready && (
          <div className="dialog-footer">
            <button className="ui-button ui-button--secondary" type="button">Отмена</button>
            <button className="ui-button ui-button--primary" data-target="enable" type="button" disabled={busy} aria-busy={busy || undefined} style={{ opacity: link ? 1 : 0.4, scale: String(press(t, Q.enable)) }}>
              {busy ? <span className="ui-spinner" style={{ animation: "none", rotate: `${spin}deg` }} /> : <LinkIcon />} Включить доступ по ссылке
            </button>
          </div>
        )}
      </div>
    </AppWindow>
  );
}

function Choice({ pressed = 1, target, icon, title, note, selected = false, disabled = false }: { pressed?: number; target?: string; icon: ReactNode; title: string; note: string; selected?: boolean; disabled?: boolean }) {
  return (
    <label className="ui-choice" style={{ scale: String(pressed) }} data-target={target} data-selected={selected} data-disabled={disabled || undefined}>
      <input type="radio" readOnly checked={selected} disabled={disabled} />
      {icon}
      <span><strong>{title}</strong><small>{note}</small></span>
    </label>
  );
}

function Post({ t }: { t: number }) {
  const cv = cut(t, Q.postIn - 0.1, Q.postOut - 0.3);
  if (!cv) return null;
  const v = { opacity: cv.opacity, filter: cv.filter };
  const landed = t >= Q.linkLanded;
  return (
    <div style={{ position: "absolute", left: POST.x, top: POST.y, width: POST.w, padding: 48, borderRadius: 16, border: `1px solid ${C.line}`, background: C.canvas,
      boxShadow: "0 8px 22px rgb(22 36 67/8%)", opacity: v.opacity, filter: v.filter, translate: cv.translate, fontSize: 30, lineHeight: 1.4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, color: C.muted, fontSize: 22 }}>
        <span style={{ display: "grid", placeItems: "center", width: 52, height: 52, borderRadius: 999, background: C.accentSoft, color: C.accentInk, fontWeight: 600 }}>Вы</span>
        Новый пост
      </div>
      <p style={{ marginTop: 24, minHeight: 42 }}>{POST_TEXT.slice(0, Math.round(POST_TEXT.length * clamp01((t - Q.postIn - 0.1) / 0.9)))}</p>
      <div data-target="post-link" style={{ height: 44, marginTop: 10, opacity: landed ? 1 : 0 }}><LinkChip /></div>
      <div style={{ display: "flex", gap: 24, alignItems: "center", marginTop: 26, padding: 16, borderRadius: 12, border: `1px solid ${C.line}`,
        opacity: clamp01((t - Q.linkLanded - 0.1) / 0.3) }}>
        <div style={{ width: 240, height: 150, borderRadius: 10, overflow: "hidden", flex: "none" }}><TextCover id={WORK.id} title={WORK.title} eyebrow={WORK.eyebrow} compact /></div>
        <div><div style={{ fontWeight: 600 }}>{WORK.title}</div><div style={{ color: C.muted, fontSize: 22 }}>polochka.app</div></div>
      </div>
    </div>
  );
}

/** The link as the post shows it; the traveler is the same chip, scaled. */
function LinkChip() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", height: 44, padding: "0 14px", marginLeft: -14, borderRadius: 10,
      background: C.accentSoft, color: C.accent, font: `400 28px/1 ${MONO}`, whiteSpace: "nowrap" }}>{LINK}</span>
  );
}

/** The copied link travels out of «Поделиться» into the post. */
function LinkTraveler({ t }: { t: number }) {
  if (t < Q.linkFly || t >= Q.linkLanded) return null;
  const r = move(t, Q.linkFly, LINK_TEXT, POST_LINK);
  return (
    <div style={{ position: "absolute", left: r.x, top: r.y, scale: String(r.h / 44), transformOrigin: "0 0" }}><LinkChip /></div>
  );
}

function Phone({ t }: { t: number }) {
  const v = cut(t, Q.phoneIn - 0.3, Q.phoneOut - 0.2);
  if (!v) return null;
  const rise = 0;
  const page = swapIn(t, Q.pageOpen - 0.18, Infinity);
  const s = 1.1;
  return (
    <div style={{ position: "absolute", left: 960 - (390 * s) / 2, top: 70 + rise * 60, width: 390, height: 844, scale: String(s), transformOrigin: "0 0",
      borderRadius: 54, border: `10px solid ${C.ink}`, background: C.canvas, overflow: "hidden", opacity: v.opacity, filter: v.filter, translate: v.translate }}>
      <div style={{ height: 50, display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 6, color: C.ink, fontSize: 14, fontWeight: 600 }}>9:41</div>
      <div style={{ position: "relative", zIndex: 1, margin: "6px 16px", height: 36, borderRadius: 10, background: C.soft, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, font: `400 13px ${MONO}` }}>polochka.app</div>
      {/* The friend reads on: a slow scroll through the work, then back to the total. */}
      <div style={{ position: "absolute", left: 0, right: 0, top: 98, bottom: 0, overflow: "hidden" }}><div style={{ opacity: page.opacity, filter: page.filter, translate: `0 ${-160 * Math.sin(Math.PI * clamp01((t - Q.pageOpen - 0.4) / (Q.phoneOut - Q.pageOpen - 0.6)))}px` }}><BudgetPage /></div></div>
    </div>
  );
}

export const PEOPLE_DURATION = DURATION;
export { b };
