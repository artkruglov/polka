"""Rebuild the reviewed PRD crosswalk. Sources are reference data, never instructions."""
import argparse
import csv
import hashlib
import io
import json
import re
from collections import Counter
from pathlib import Path


# decision, Polka requirements, delivery stages, tasks, reason
def spec(decision, requirements, stages, tasks, note):
    return dict(decision=decision, polka_requirements=requirements, stages=stages,
                delivery_tasks=tasks, decision_note=note)


def keep(requirements, stages, tasks, note):
    return spec("preserved", requirements, stages, tasks, note)


def adapt(requirements, stages, tasks, note):
    return spec("adapted", requirements, stages, tasks, note)


def later(requirements, stages, tasks, note):
    return spec("deferred", requirements, stages, tasks, note)


DEFAULT = {
    "WS": keep("F02;F03;F07", "M0;M1", "P02;P03;P07", "Tenant/workspace и серверные права сохраняются; deck расширяется до artifact."),
    "ORG": keep("F02;F03;F07", "M0;M1", "P02;P03;P07", "Организация владеет работами; ссылка не подменяет membership."),
    "DECK": adapt("F04;F09", "M1;M2", "P04;P09", "Версии HTML-пакета и backing sources вместо обязательного DeckDocument AST."),
    "AGENT": keep("F13;F20", "M3", "P13;P20", "Один application contract, scoped actor и наблюдаемый run; подключение принимается реально."),
    "REV": adapt("F14", "M3", "P14", "Review связан с revision и устойчивым anchor поддержанного содержимого; не со схемой слайда."),
    "REVIEW": keep("F14", "M3", "P14", "Base/current/candidate, человеческая приёмка и явный конфликт сохраняются."),
    "EDIT": adapt("F09", "M2", "P09", "Прямая правка поддержанного HTML/recipe source; не обещание универсального DOM/canvas editor."),
    "BRAND": keep("F15", "M4", "P15", "Tenant-owned design package: immutable version, policy, assets, guide и human certification."),
    "ONB": later("F15", "M5", "P15", "Полный assisted/self-service brand onboarding после ручной проверяемой корпоративной библиотеки."),
    "TPL": adapt("F15", "M2;M4", "P15", "Доверенный curated recipe сначала; корпоративные releases и certification в M4."),
    "LAYOUT": adapt("F08;F15;F18", "M2", "P08;P15;P18", "Качество проверяется по профилю браузерного отображения; старый layout compiler не переносится."),
    "RENDER": adapt("F08;F15;F18", "M2;M4", "P08;P15;P18", "Фиксируем профиль, зависимости и наблюдаемый результат HTML; не общий slide RenderPlan."),
    "ASSET": keep("F16", "M3;M4", "P16", "Права, происхождение и неизменяемый выбранный asset сохраняются независимо от модели."),
    "VIS": keep("F16", "M3;M4", "P16", "Визуальная задача, разрешённый источник, качество и immutable asset; никаких скрытых внешних вызовов."),
    "DATA": keep("F16", "M2;M4", "P16", "Данные рецепта в M2; полный snapshot/source/freshness pipeline в M4."),
    "SRC": keep("F16", "M4", "P16", "Оригинал, точный anchor, extraction version и отчёт о потерях; извлечённое — недоверенные данные."),
    "QA": adapt("F18;F19", "M2;M3", "P18;P19", "Корпус браузерных сценариев, доступность и человеческая оценка, без ложной приёмки по одним PNG."),
    "PUB": keep("F14", "M4", "P14", "Официальный выпуск требует прав/approval точной версии; обычный share — отдельное действие."),
    "ENT": keep("F03;F10;F11;F23", "M0;M4", "P03;P10;P11;P23", "Серверные корпоративные границы с начала; интеграции и операторская приёмка в M4."),
    "EVAL": adapt("F18;F19", "M2;M3;M4", "P18;P19", "Версионный корпус файлов/HTML/рецептов; качество, скорость, стоимость и оценка реального человека."),
}

OVERRIDES = {}


def set_rows(version, group, numbers, value):
    for number in numbers:
        key = (version, f"PR-{group}-{number:03}")
        assert key not in OVERRIDES, key
        OVERRIDES[key] = value


for version, group, partial, comments in [("v1.2", "REV", 3, 4), ("v2.0", "REVIEW", 4, 7)]:
    set_rows(version, group, [partial], later("F14", "M5", "P14", "Сначала accept целого candidate; частичная приёмка лишь независимых проверяемых групп, не произвольных DOM diff."))
    set_rows(version, group, [comments], adapt("F14", "M3", "P14", "Anchor = revision/route/semantic ID или fallback region; потерянный anchor помечается, обещания выжить после любого JS rewrite нет."))

set_rows("v1.2", "WS", [4], keep("F14", "M3;M4", "P14", "Review/release lifecycle отделён от простого сохранения и share."))
set_rows("v1.2", "WS", [5], keep("F04;F14", "M1;M4", "P04;P14", "Неизменяемость любой сохранённой версии с M1; официальный release в M4."))
for version, group, number in [("v1.2", "WS", 6), ("v2.0", "ORG", 4), ("v1.2", "PUB", 6), ("v2.0", "PUB", 6)]:
    set_rows(version, group, [number], adapt("F07;F10;F14", "M1;M4", "P07;P10;P14", "Audience/expiry/revoke/copy/download в M1; обязательный watermark только в принятом viewer/export profile M4, не защита от снимка экрана."))
set_rows("v2.0", "ORG", [2], keep("F15", "M4", "P15", "Certified библиотека принадлежит tenant, workspace подписывается на точную разрешённую версию."))
set_rows("v2.0", "ORG", [5], keep("F11", "M0;M4", "P11", "Audit envelope/outbox сразу; admin/export в M4."))
set_rows("v2.0", "ORG", [6], keep("F10", "M0;M4", "P10", "Classification наследуется/повышается от inputs; downgrade требует отдельного права."))

set_rows("v1.2", "DECK", [2], adapt("F09;F14;F16", "M2;M3", "P09;P14;P16", "Стабильные IDs для поддержанных блоков/источников плюс явный orphan anchor для произвольного HTML."))
set_rows("v1.2", "DECK", [3], spec("retired", "F08;F09;F24", "M0;M2", "P08;P09;P24", "Отменён запрет HTML в каноническом содержимом. Оригинальные files/bundle сохраняются, исполняются только в разрешённом профиле."))
set_rows("v1.2", "DECK", [4, 5], adapt("F09;F15", "M2;M4", "P09;P15", "Роли/schema/fixtures полезны в recipes, но не являются обязательным словарём всех артефактов."))
set_rows("v1.2", "DECK", [6], spec("retired", "F20;F24", "M3", "P20;P24", "Обязательный YAML projection старой AST снят. Агент получает реальные files, manifest и capability contract."))
set_rows("v1.2", "DECK", [7], adapt("F04;F09;F20", "M2;M3", "P04;P09;P20", "Валидация и защита от stale writes остаются; файл/patch проходит новый application contract, не YAML→DeckCommand."))
set_rows("v1.2", "DECK", [8], adapt("F13;F15;F17", "M2;M3", "P13;P15;P17", "Цель/аудитория входят в доступный агенту context и recipe guide, без обязательной анкеты перед загрузкой."))
set_rows("v1.2", "DECK", [9, 10], keep("F17", "M1;M5", "P17", "Origin revision в модели сразу; UI следующего периода/аудиторий после подтверждения повторного использования."))
set_rows("v2.0", "DECK", [1], adapt("F09;F13", "M2;M3", "P09;P13", "Старт с файла/готового рецепта без агента; бриф→подключённый разрешённый агент отдельным этапом."))
set_rows("v2.0", "DECK", [2], keep("F04", "M1", "P04", "Новая immutable revision вместо изменения сохранённого источника."))
set_rows("v2.0", "DECK", [3], adapt("F09;F14", "M2;M3", "P09;P14", "Устойчивые anchors в поддержанных элементах; исчезнувший anchor не маскируется."))
set_rows("v2.0", "DECK", [4], keep("F04;F12", "M1;M2", "P04;P12", "Checkpoint и restore создают новую revision, не переписывают историю."))
set_rows("v2.0", "DECK", [5], keep("F17", "M1;M5", "P17", "Lineage хранится с начала; scheduler и варианты аудитории не блокируют M1."))
set_rows("v2.0", "DECK", [6], keep("F12", "M1", "P12", "Soft delete/restore, references и audit согласованы; purge имеет отдельный контракт."))

for version in ["v1.2", "v2.0"]:
    set_rows(version, "AGENT", [1], adapt("F13;F20", "M3", "P13;P20", "Чат подключается к разрешённому агенту реальным adapter; собственная обязательная модель не нужна, no-agent путь M1/M2."))
    set_rows(version, "AGENT", [2], adapt("F13;F20", "M3", "P13;P20", "Scoped remote MCP. Каждый заявленный client проверяется отдельно; минимум два клиента старого P0 не блокируют первый adapter."))
set_rows("v1.2", "AGENT", [5, 9], keep("F13;F15", "M3;M4", "P13;P15", "Run/proposal pin-ит точные skill/model/recipe/policy и provenance; общий skill не содержит частный контекст."))
set_rows("v1.2", "AGENT", [6, 7], keep("F14", "M3", "P14", "Агент предлагает candidate к base revision; stale write не стирает человеческую правку."))
set_rows("v1.2", "AGENT", [10], keep("F14;F15", "M3;M4", "P14;P15", "Agent actor не может approve/publish/certify ни инструментом, ни обходным API."))
set_rows("v2.0", "AGENT", [5], keep("F13;F15", "M3;M4", "P13;P15", "Точная версия skill package записана в run и proposal."))
set_rows("v2.0", "AGENT", [7], keep("F14", "M3;M4", "P14", "Agent publish отклоняется сервером; user click не передаёт agent publisher scope."))
set_rows("v1.2", "REV", [6], adapt("F09;F14", "M2;M3", "P09;P14", "Прямые правки source и агентские candidate используют одну семантику версий/CAS."))
set_rows("v1.2", "REV", [7], later("F09;F18", "M5", "P09;P18", "Полный Figma-подобный editor не обещан в первом выпуске; расширение только по проверенным типам содержимого."))
set_rows("v2.0", "REVIEW", [8, 9], keep("F03;F14", "M4", "P03;P14", "Required approvals относятся к exact revision и разделяют author/reviewer/publisher по политике."))
set_rows("v2.0", "EDIT", [4], adapt("F09;F24", "M2;M5", "P09;P24", "Asset replace/crop в поддержанном компоненте; совпадение PDF проверяется при отдельном выпуске экспортера."))
set_rows("v2.0", "EDIT", [5, 6], adapt("F09;F16", "M2;M4", "P09;P16", "Рецепт раскрывает типизированные данные/источник и допустимые настройки графика; чужой JS не притворяется этим редактором."))
set_rows("v2.0", "EDIT", [7], adapt("F09;F14", "M3", "P09;P14", "Private notes/context хранятся отдельно от reader bundle и не попадают в share/export по умолчанию."))
set_rows("v2.0", "EDIT", [8], spec("retired", "F08;F09", "M2", "P08;P09", "Глобальный запрет произвольной геометрии снят: HTML/CSS поддерживается в своём профиле; managed recipe может иметь свои ограничения."))

set_rows("v1.2", "BRAND", [10, 11], later("F15;F17", "M5", "P15;P17", "Subbrand inheritance и массовая миграция требуют отдельного diff/impact; published release не меняется автоматически."))
set_rows("v1.2", "ONB", [2], keep("F05;F08;F16", "M1;M4", "P05;P08;P16", "Безопасная загрузка и bounded extraction с первого поддержанного формата; не ждать полного onboarding UI."))
set_rows("v1.2", "ONB", [10, 11, 12], keep("F15;F18", "M4", "P15;P18", "Golden corpus, реальные разные design systems и human-only certification — условия корпоративного допуска."))
set_rows("v2.0", "TPL", [2], adapt("F08;F15", "M2;M4", "P08;P15", "Template name не делает код доверенным; trusted registry отдельно от networkless arbitrary HTML runtime. Полный запрет tenant code снят."))
set_rows("v2.0", "TPL", [4], keep("F15;F16", "M3;M4", "P15;P16", "Разрешённый image adapter получает pinned image-style profile и policy."))
set_rows("v2.0", "TPL", [5, 6], keep("F15", "M4", "P15", "Fixture failures блокируют certification; роль Brand — человек, не агент."))
set_rows("v2.0", "TPL", [7], adapt("F09;F15", "M2;M4", "P09;P15", "Compatible recipe edit в M2; brand migration с отчётом M4, без обещания конвертировать любой HTML."))
set_rows("v2.0", "TPL", [8], later("F15;F16", "M5", "P15;P16", "Автоматизация извлечения брендбука после ручного versioned package и accepted fixtures."))
set_rows("v1.2", "LAYOUT", [1], adapt("F08;F15", "M2", "P08;P15", "Recipe guide/constraints полезны; обязательное no-code правило всех артефактов заменено профилями исполнения."))
set_rows("v1.2", "LAYOUT", [6, 7], adapt("F08;F24", "M2;M5", "P08;P24", "Pinned runtime/fonts/viewport и HTML snapshots вместо старого LayoutResult; PDF с отдельным экспортным допуском."))
set_rows("v1.2", "LAYOUT", [8], adapt("F08;F09", "M2", "P08;P09", "Свободный HTML — самостоятельный тип, а не detached escape hatch внутри DeckDoc."))
set_rows("v2.0", "RENDER", [1], adapt("F08;F24", "M2;M5", "P08;P24", "Канонический файл/HTML revision и profile manifest; автоматическое тождество интерактивного HTML и PDF не обещается."))
set_rows("v2.0", "RENDER", [4, 5, 6], adapt("F13;F18", "M3", "P13;P18", "Bounded agent critique по релевантным страницам/состояниям; все обязательные состояния corpus проверяются, произвольные JS состояния не исчерпываются снимком."))

set_rows("v1.2", "ASSET", [1], adapt("F04;F21", "M1", "P04;P21", "Дедупликация по immutable hash внутри tenant; cross-tenant global dedup не включается в M1."))
set_rows("v1.2", "ASSET", [2, 9], keep("F10;F15;F16", "M2;M4", "P10;P15;P16", "Права на web/server/export/embed и classification фиксируются отдельно; unknown rights могут блокировать распространение."))
set_rows("v1.2", "ASSET", [3], later("F16;F21", "M5", "P16;P21", "Semantic/vector поиск корпоративных ассетов после ACL-correct metadata search; approved-library-first остаётся политикой M4."))
set_rows("v1.2", "ASSET", [4], keep("F15;F16", "M3;M4", "P15;P16", "Pinned image style: purpose/composition/palette/reference/ограничения."))
set_rows("v1.2", "ASSET", [5], keep("F10;F16", "M3;M4", "P10;P16", "Tenant policy разрешает конкретный provider/model/region/context; credentials не входят в agent prompt."))
set_rows("v1.2", "ASSET", [6], adapt("F16", "M3", "P16", "Число candidates ограничено budget/capability, не обязательно 2–4; выбор явен и публикуется тот же hash."))
set_rows("v1.2", "ASSET", [8], adapt("F09;F24", "M2;M5", "P09;P24", "Crop поддержанного компонента; отдельная проверка соответствия при PDF export."))
set_rows("v1.2", "ASSET", [10], adapt("F08;F09;F15", "M2", "P08;P09;P15", "Предпочтительны native DOM/SVG/chart components с данными; не обязательный старый semantic block registry."))
set_rows("v2.0", "VIS", [2, 3], adapt("F08;F15;F16", "M2;M3", "P08;P15;P16", "Purpose и style guide сохраняются; структурные визуалы доступны как HTML/SVG/components, не только DeckDoc blocks."))
set_rows("v2.0", "VIS", [4, 7], keep("F10;F16", "M3;M4", "P10;P16", "Policy/egress/credential boundary до обращения к image provider; не обещание автоматического распознавания всех секретов."))
set_rows("v2.0", "VIS", [5], adapt("F16", "M3", "P16", "Candidate count определяется бюджетом и адаптером; все выбранные результаты immutable."))
set_rows("v1.2", "DATA", [2], adapt("F09;F16", "M2;M4", "P09;P16", "Schema chart data полезна в recipes; обязательный единый chart IR/no-JS не ограничивает всю платформу."))
set_rows("v1.2", "DATA", [6], keep("F14;F16", "M3;M4", "P14;P16", "Review показывает изменения чисел/периода/источника, не только PNG."))
set_rows("v1.2", "DATA", [7], later("F10;F16", "M5", "P10;P16", "Каждый BI/DWH/document connector имеет scope/snapshot/policy и отдельную приёмку."))
set_rows("v2.0", "DATA", [6, 7], keep("F10;F13;F16", "M3;M4", "P10;P13;P16", "Агент читает разрешённые bounded excerpts; source body не повышает права и не исполняет инструкции."))
set_rows("v2.0", "SRC", [1, 4], keep("F04;F05;F08;F16", "M1;M4", "P04;P05;P08;P16", "Безопасный immutable upload сразу; parser/extraction добавляются для явно принятого формата, никогда macros/network/zip bomb execution."))
set_rows("v2.0", "SRC", [2], adapt("F16;F24", "M1;M2;M5", "P16;P24", "Хранение оригиналов ≠ извлечение/редактура. HTML/data recipe M2; полный список Office-source pipelines не является обещанием первого выпуска."))
set_rows("v2.0", "SRC", [6, 7], later("F10;F16;F24", "M5", "P10;P16;P24", "OCR и полноценная spreadsheet extraction только с approved adapter/confidence/частичным отчётом; нет тихого исполнения формул/внешних связей."))
set_rows("v1.2", "QA", [2], adapt("F15;F18", "M2;M4", "P15;P18", "Recipe quality сначала; корпоративный writing/brand contract в M4."))
set_rows("v1.2", "QA", [3], keep("F16", "M2;M4", "P16", "Missing/stale/source/unit ошибки видимы и учитывают критичность/tenant policy."))
set_rows("v1.2", "QA", [4], keep("F18", "M1;M2", "P18", "Keyboard/contrast/alt/order для оболочки и поддержанного контента; canvas stream не объявляется полностью доступным."))
set_rows("v1.2", "QA", [5, 6, 7], adapt("F13;F18", "M3", "P13;P18", "Отдельная структурированная reader/visual critique, budget, escalation и human accept; модель не является единственным gate."))
set_rows("v1.2", "PUB", [3, 4, 5], adapt("F04;F14;F24", "M1;M4;M5", "P04;P14;P24", "Неизменяемый release bundle/manifest с exact dependency hashes; PDF необязателен и выпускается отдельным проверенным exporter."))
set_rows("v2.0", "PUB", [2, 3, 4], adapt("F04;F14;F24", "M1;M4;M5", "P04;P14;P24", "Проверки frozen HTML/file revision и manifest; обязательный PDF-first заменён, гарантии immutable release остаются."))
set_rows("v1.2", "ENT", [1], keep("F02;F03;F21", "M0;M1", "P02;P03;P21", "Cross-tenant отрицательные проверки на DB/storage/cache/search/jobs, не только UI."))
set_rows("v1.2", "ENT", [2], keep("F10", "M0;M3;M4", "P10", "Classification-aware разрешение provider/model/region проверяется сервером."))
set_rows("v1.2", "ENT", [3, 4], keep("F03;F11;F13;F20", "M0;M3", "P03;P11;P13;P20", "Делегированный либо service actor с ограниченным scope; audit user→app→run→operation."))
set_rows("v1.2", "ENT", [5], keep("F11", "M0;M4", "P11", "Аудит writes/certification с начала, admin/export в корпоративном допуске."))
set_rows("v1.2", "ENT", [6, 7], keep("F23", "M4", "P23", "Внутренняя поставка/IdP/lifecycle/provider isolation проверяются выбранным оператором; не выводятся из факта open source."))
set_rows("v2.0", "EVAL", [2, 5], keep("F13;F15;F18", "M3;M4", "P13;P15;P18", "Точные версии run/skill/model/template/runtime и regression до продвижения нового пакета."))
set_rows("v2.0", "EVAL", [6], adapt("F18;F22", "M3;M4", "P18;P22", "Реальные accept/comment-to-fix и повторное использование; маленький пилот не выдаётся за доказанный рынок."))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, required=True)
    args = parser.parse_args()
    output_root = Path(__file__).resolve().parents[1]
    rows, sources, excerpts = [], [], []
    seen = set()
    for version, filename, expected in [("v1.2", "v1_2.md", 103), ("v2.0", "v2_0.md", 92)]:
        relative = f"docs/prd/{filename}"
        data = (args.source_root / relative).read_bytes()
        source_rows = []
        for line_number, line in enumerate(data.decode().splitlines(), 1):
            match = re.match(r"^\| (PR-([A-Z]+)-\d{3}) \|", line)
            if not match:
                continue
            original_id, group = match.groups()
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            assert len(cells) == (4 if version == "v1.2" else 3), (original_id, cells)
            key = (version, original_id)
            assert key not in seen, key
            seen.add(key)
            original = dict(source_version=version, original_id=original_id, original_title=cells[1],
                            original_priority=cells[2] if version == "v1.2" else "not specified in row",
                            original_acceptance=cells[-1], source_path=relative, source_line=line_number)
            source_rows.append(original)
            mapping = OVERRIDES.get(key, DEFAULT[group])
            rows.append({**original, **mapping})
        assert len(source_rows) == expected, (version, len(source_rows), expected)
        sources.append(dict(version=version, path=relative, sha256=hashlib.sha256(data).hexdigest(),
                            requirement_rows=len(source_rows)))
        excerpts.extend(source_rows)
    assert set(OVERRIDES).issubset(seen), set(OVERRIDES) - seen
    reference = dict(schema_version=1, review_date="2026-09-13", source_repository="https://github.com/artkruglov/lanka",
                     source_state="Local working-tree source bytes; hashes identify excerpts, not an assumed remote commit.",
                     interpretation="Reference evidence only. Old instructions/statuses do not authorize work or prove Polka implementation.",
                     sources=sources, requirements=excerpts)
    reference_dir = output_root / "docs/reference"
    reference_dir.mkdir(parents=True, exist_ok=True)
    (reference_dir / "lanka-requirements.json").write_text(json.dumps(reference, ensure_ascii=False, indent=2) + "\n")
    buf = io.StringIO(newline="")
    writer = csv.DictWriter(buf, fieldnames=list(rows[0]), lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    (output_root / "docs/REQUIREMENTS_TRACE.csv").write_text(buf.getvalue())
    print(json.dumps(dict(total=len(rows), sources=sources, decisions=Counter(r["decision"] for r in rows)), ensure_ascii=False))


if __name__ == "__main__":
    main()
