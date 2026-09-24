// The operator's metrics page (apps/server/metrics.ts). No libraries, no
// inline code: the app's CSP allows scripts and styles of this origin only.
// The token lives in this tab's sessionStorage and goes only to
// /api/ops/metrics. Every value is written as text, never as HTML.
(() => {
  const KEY = "polka_ops_token";
  const $ = (id) => document.getElementById(id);
  const login = $("login");
  const controls = $("controls");
  const status = $("status");
  const report = $("report");

  const stored = () => {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  };
  const store = (value) => {
    try {
      if (value) sessionStorage.setItem(KEY, value);
      else sessionStorage.removeItem(KEY);
    } catch {
      // Private mode: the token lasts until the page is left.
    }
  };
  let token = stored();

  const say = (text, error = false) => {
    status.textContent = text;
    status.className = error ? "error" : "";
  };
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const percent = (value) =>
    value === null || value === undefined
      ? "—"
      : `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
  const number = (value) =>
    typeof value === "number" ? value.toLocaleString("ru-RU") : (value ?? "—");

  function table(headers, rows) {
    const wrap = el("div", null, "table");
    const t = el("table");
    const head = el("tr");
    for (const header of headers) head.append(el("th", header));
    t.append(el("thead"));
    t.tHead.append(head);
    const body = el("tbody");
    for (const row of rows) {
      const tr = el("tr");
      for (const cell of row) {
        const isRate = typeof cell === "object" && cell !== null && "rate" in cell;
        tr.append(
          el("td", isRate ? percent(cell.rate) : number(cell), isRate ? "rate" : ""),
        );
      }
      body.append(tr);
    }
    if (!rows.length) {
      const tr = el("tr");
      const td = el("td", "Пока нет данных.", "rate");
      td.colSpan = headers.length;
      tr.append(td);
      body.append(tr);
    }
    t.append(body);
    wrap.append(t);
    return wrap;
  }
  const section = (title, note, content) => {
    const s = el("section");
    s.append(el("h2", title));
    if (note) s.append(el("p", note, "note"));
    s.append(content);
    return s;
  };
  const r = (value) => ({ rate: value });

  function render(data) {
    report.replaceChildren();
    $("generated").textContent = `с ${data.since}, обновлено ${new Date(
      data.generatedAt,
    ).toLocaleString("ru-RU")}`;
    const total = data.funnel.total;
    const kpis = el("div", null, "kpis");
    for (const [label, value] of [
      ["Посещения", total.visitors],
      ["Регистрации", total.signups],
      ["Подключили агента", total.agentConnected],
      ["Сохранили", total.firstSave],
      ["Поделились", total.firstShare],
      ["Ссылку открыли", total.shareOpened],
    ]) {
      const kpi = el("div", null, "kpi");
      kpi.append(el("b", number(value)), el("span", label, "muted"));
      kpis.append(kpi);
    }
    report.append(kpis);

    const weeks = [...data.funnel.weeks].reverse();
    report.append(
      section(
        "Воронка по неделям регистрации",
        data.definitions.funnel,
        table(
          [
            "Неделя",
            "Посещения",
            "Регистрации",
            "→ агент",
            "→ сохранение",
            "→ ссылка",
            "→ открыли",
            "Посещ.→рег.",
            "Рег.→агент",
            "Агент→сохр.",
            "Сохр.→ссылка",
            "Ссылка→откр.",
          ],
          [
            ...weeks.map((w) => [
              w.week,
              w.visitors,
              w.signups,
              w.agentConnected,
              w.firstSave,
              w.firstShare,
              w.shareOpened,
              r(w.conversion.visitorToSignup),
              r(w.conversion.signupToAgent),
              r(w.conversion.agentToSave),
              r(w.conversion.saveToShare),
              r(w.conversion.shareToOpened),
            ]),
            [
              "Всего",
              total.visitors,
              total.signups,
              total.agentConnected,
              total.firstSave,
              total.firstShare,
              total.shareOpened,
              r(total.conversion.visitorToSignup),
              r(total.conversion.signupToAgent),
              r(total.conversion.agentToSave),
              r(total.conversion.saveToShare),
              r(total.conversion.shareToOpened),
            ],
          ],
        ),
      ),
    );
    report.append(
      section(
        "Источники",
        data.definitions.sources,
        table(
          ["Источник", "Посещения", "Регистрации", "Конверсия"],
          data.sources.map((s) => [s.source, s.visits, s.signups, r(s.signupRate)]),
        ),
      ),
    );
    report.append(
      section(
        "Агенты",
        data.definitions.agentConnected,
        table(
          ["Клиент", "Подключений", "Аккаунтов"],
          data.agentClients.map((c) => [c.client, c.connections, c.accounts]),
        ),
      ),
    );
    report.append(
      section(
        "Удержание по неделям регистрации",
        data.definitions.retention,
        table(
          ["Неделя", "Когорта", "D1", "из", "D7", "из", "D30", "из"],
          [...data.retention].reverse().map((c) => [
            c.week,
            c.cohort,
            r(c.d1.rate),
            c.d1.eligible,
            r(c.d7.rate),
            c.d7.eligible,
            r(c.d30.rate),
            c.d30.eligible,
          ]),
        ),
      ),
    );
    report.append(
      section(
        "Активность по неделям",
        null,
        table(
          [
            "Неделя",
            "Активных аккаунтов",
            "Посещения",
            "Регистрации",
            "Подключения",
            "Сохранения",
            "Ссылки",
            "Открытия",
            "Заметки",
            "Заявки компаний",
          ],
          [...data.activity].reverse().map((a) => [
            a.week,
            a.activeAccounts,
            a.pageViews,
            a.signups,
            a.agentConnections,
            a.saves,
            a.shares,
            a.sharesOpened,
            a.notes,
            a.enterpriseRequests,
          ]),
        ),
      ),
    );
    report.append(
      section(
        "Страницы и способы входа",
        null,
        table(
          ["Страница или способ", "Число"],
          [
            ...data.pages.map((p) => [p.path, p.visits]),
            ...data.signupMethods.map((m) => [`регистрация: ${m.method}`, m.signups]),
          ],
        ),
      ),
    );
    report.append(
      section(
        "За всё время",
        data.totals.countingSince ? `Счёт с ${data.totals.countingSince}.` : null,
        table(
          ["Событие", "Число"],
          Object.entries(data.totals.allTime).map(([name, value]) => [name, value]),
        ),
      ),
    );
  }

  async function load() {
    if (!token) {
      login.hidden = false;
      controls.hidden = true;
      return;
    }
    say("Загружаю…");
    let answer;
    try {
      answer = await fetch(`/api/ops/metrics?weeks=${encodeURIComponent($("weeks").value)}`, {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
      });
    } catch {
      say("Сервер не ответил. Попробуйте ещё раз.", true);
      return;
    }
    if (answer.status === 404 || answer.status === 401) {
      token = null;
      store(null);
      report.replaceChildren();
      login.hidden = false;
      controls.hidden = true;
      say("Токен не подошёл.", true);
      return;
    }
    if (!answer.ok) {
      say(`Ошибка ${answer.status}.`, true);
      return;
    }
    login.hidden = true;
    controls.hidden = false;
    render(await answer.json());
    say("");
  }

  login.addEventListener("submit", (event) => {
    event.preventDefault();
    token = $("token").value.trim();
    $("token").value = "";
    store(token);
    void load();
  });
  $("refresh").addEventListener("click", () => void load());
  $("weeks").addEventListener("change", () => void load());
  $("logout").addEventListener("click", () => {
    token = null;
    store(null);
    report.replaceChildren();
    $("generated").textContent = "";
    say("Токен забыт.");
    void load();
  });
  void load();
})();
