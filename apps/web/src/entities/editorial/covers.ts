// Browser captures of the bundled editorial edition; unknown or renamed items use no cover.
const covers: Record<string, { title: string; url: string }> = {
  "fractions": {
    "title": "Доли без зубрёжки",
    "url": "/editorial-covers/fractions.jpg"
  },
  "city-observation": {
    "title": "Город глазами наблюдателя",
    "url": "/editorial-covers/city-observation.jpg"
  },
  "week-allocation": {
    "title": "Куда уходит неделя",
    "url": "/editorial-covers/week-allocation.jpg"
  },
  "data-literacy": {
    "title": "Среднее не всегда рассказывает всё",
    "url": "/editorial-covers/data-literacy.jpg"
  },
  "packing-checklist": {
    "title": "Рюкзак на день",
    "url": "/editorial-covers/packing-checklist.jpg"
  },
  "contrast-explorer": {
    "title": "Контраст в руках",
    "url": "/editorial-covers/contrast-explorer.jpg"
  },
  "meal-plan": {
    "title": "Неделя на столе",
    "url": "/editorial-covers/meal-plan.jpg"
  },
  "sorting-explainer": {
    "title": "Как числа находят порядок",
    "url": "/editorial-covers/sorting-explainer.jpg"
  },
  "reading-session": {
    "title": "Читательская сессия",
    "url": "/editorial-covers/reading-session.jpg"
  },
  "tile-pattern": {
    "title": "Мастерская узоров",
    "url": "/editorial-covers/tile-pattern.jpg"
  },
  "probability-lab": {
    "title": "Лаборатория вероятностей",
    "url": "/editorial-covers/probability-lab.jpg"
  },
  "decision-matrix": {
    "title": "Матрица решений",
    "url": "/editorial-covers/decision-matrix.jpg"
  }
};
export function editorialCover(slug: string, title: string): string | undefined {
  const cover = covers[slug];
  return cover?.title === title ? cover.url : undefined;
}
