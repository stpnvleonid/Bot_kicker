/**
 * Предметы и ключевые слова для сопоставления событий календаря с топиками.
 * См. docs/SUBJECTS_TOPICS_MAPPING.md
 */

export const SUBJECT_TOPIC_NAMES: Record<string, string> = {
  math: 'Математика (100 баллов)',
  math_profile: 'Математика (профиль)',
  math_base: 'Математика (база)',
  informatics: 'Информатика',
  physics: 'Физика',
  society: 'Общество',
  russian: 'Русский',
  english: 'Английский',
};

/** Ключевые фразы в title/description (нижний регистр) → subject_key. Один и тот же текст может относиться к разным предметам — проверяем по порядку и собираем все совпадения. */
export const SUBJECT_KEYWORDS: Record<string, string[]> = {
  math: [
    // Общие слова про математику — пойдут в оба «старших» потока (math и math_profile),
    // кроме специальных случаев (вебинары, пробники/тесты), которые обрабатываем отдельно.
    'математика',
    'математике',
    'математике',
    'матем',
    'мат.',
    'егэ математика',
    'егэ по математике',
    'егэ матем',
    'алгебра',
    'геометрия',
    'подготовка к егэ математика',
    'подготовка к егэ по математике',
    'разбор егэ математика',
  ],
  // Для math_profile и math_base особые кейсы обрабатываем вручную в detectSubjectsFromEventText.
  informatics: [
    'информатика', 'инфо', 'инф.', 'егэ информатика', 'егэ по информатике', 'егэ инфо',
    'икт', 'программирование',
    'подготовка к егэ информатика', 'подготовка к егэ по информатике', 'разбор егэ информатика',
    'пробник информатика', 'пробник инфо',
  ],
  physics: [
    'физика', 'физике', 'физ.', 'егэ физика', 'егэ по физике',
    'подготовка к егэ физика', 'подготовка к егэ по физике', 'разбор егэ физика',
    'пробник физика', 'пробник физ',
  ],
  society: [
    'обществознание', 'общество', 'обществ.', 'обществознан',
    'егэ обществознание', 'егэ по обществознанию', 'егэ общество',
    'подготовка к егэ обществознание', 'подготовка к егэ по обществознанию', 'разбор егэ обществознание',
    'пробник обществознание', 'пробник общество',
  ],
  russian: [
    'русский', 'русскому', 'русский язык', 'ря', 'русс.',
    'егэ русский', 'егэ по русскому', 'егэ русский язык', 'егэ по русскому языку', 'егэ ря',
    'подготовка к егэ русский', 'подготовка к егэ по русскому', 'подготовка к егэ русский язык',
    'разбор егэ русский', 'пробник русский', 'пробник ря',
    'сочинение', 'изложение', 'итоговое сочинение',
  ],
  english: [
    'английский', 'английский язык', 'ая', 'англ.', 'англ',
    'егэ английский', 'егэ по английскому', 'егэ английский язык', 'егэ по английскому языку', 'егэ ая',
    'подготовка к егэ английский', 'подготовка к егэ по английскому', 'подготовка к егэ английский язык',
    'разбор егэ английский', 'пробник английский', 'пробник ая',
    'english', 'егэ english',
  ],
};

/**
 * По тексту события (название + описание) возвращает список subject_key, которым соответствует событие.
 * Проверка без учёта регистра; при нескольких совпадениях возвращаются все подходящие предметы.
 */
export function detectSubjectsFromEventText(title: string | null, description: string | null): string[] {
  const text = `${title ?? ''} ${description ?? ''}`.toLowerCase();
  const found = new Set<string>();

  // Специальные кейсы для потоков математики:
  const hasMathWord =
    text.includes('математика') ||
    text.includes('математике') ||
    text.includes('математик ');

  const isMathProfileWebinar = text.includes('вебинар по математике, профиль');
  const isMathWebinarGeneric = !isMathProfileWebinar && text.includes('вебинар по математике');

  // Пробники и тесты по математике → строго профильный поток
  const isMathProbOrTest =
    (hasMathWord &&
      (text.includes('пробник по математике') ||
        text.includes('пробник математика') ||
        text.includes('пробник матем'))) ||
    (hasMathWord &&
      (text.includes('тестирование по математике') ||
        text.includes('тест по математике') ||
        text.includes('тестирование математики')));

  // Базовая математика: два слова одновременно «математика» и «база»/«базовая»
  const hasBaseMarker =
    text.includes('базовая математика') ||
    (hasMathWord && (text.includes('базовая') || text.includes('база ')));
  const isMathBase = hasMathWord && hasBaseMarker;

  if (isMathProfileWebinar) {
    // Строго профильный поток
    found.add('math_profile');
  } else if (isMathWebinarGeneric) {
    // Строго поток 100 баллов
    found.add('math');
  }

  // Общие ключевые слова: математика и др. → оба «старших» потока (100 баллов и профиль)
  for (const [subjectKey, keywords] of Object.entries(SUBJECT_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw))) {
      if (subjectKey === 'math') {
        // любые общие мат-термины → оба потока
        found.add('math');
        found.add('math_profile');
      } else {
        found.add(subjectKey);
      }
    }
  }

  // Базовая математика
  if (isMathBase) {
    found.add('math_base');
  }

  // Пробники и тесты по математике: только профильный поток
  if (isMathProbOrTest) {
    found.delete('math');
    found.delete('math_base');
    found.add('math_profile');
  }

  // Финальная коррекция для вебинаров:
  // - «вебинар по математике, профиль» → только math_profile
  // - «вебинар по математике» (без «профиль») → только math
  if (isMathProfileWebinar) {
    found.delete('math');
    found.delete('math_base');
    found.add('math_profile');
  } else if (isMathWebinarGeneric) {
    found.delete('math_profile');
    found.delete('math_base');
    found.add('math');
  }

  return Array.from(found);
}
