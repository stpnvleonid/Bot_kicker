/**
 * Скрипт для распределения конкретных студентов по потокам математики:
 * - math (Математика 100 баллов)
 * - math_profile (Математика профиль)
 * - math_base (Математика база)
 *
 * Для каждого пользователя по username задаётся целевой поток,
 * при этом все старые записи math/math_profile/math_base очищаются.
 *
 * Запуск: npm run move-math-students
 */

import { getDb } from '../src/db';

type TargetMathStream = 'math' | 'math_profile' | 'math_base';

const USERS: Array<{ username: string; target: TargetMathStream }> = [
  // Ранее перечисленные: все → профиль
  { username: 'filkirill', target: 'math_profile' },
  { username: 'sim_ely', target: 'math_profile' },
  { username: 'hakeee163', target: 'math_profile' },
  { username: 'ksufenko', target: 'math_profile' },
  { username: 'gnom_uii', target: 'math_profile' },
  { username: 'purepurr', target: 'math_profile' },
  { username: 'irik_yurik', target: 'math_profile' },

  // Новые распределения
  { username: 'Ssserpentine', target: 'math_base' }, // George
  { username: 'PewXDPew', target: 'math_profile' },   // Nikita K.
  { username: 'Ggggeeegvcf', target: 'math_profile' },// Vladimir
  { username: 'col3we', target: 'math_base' },        // col3we
  { username: 'cuteryif', target: 'math_profile' },   // sasha
  { username: 'ra1nfallgod', target: 'math_base' },   // Георгий
  { username: 'olezhka_mohnat', target: 'math_profile' }, // Олег
  { username: 'alestary', target: 'math_base' },      // сашулька иванова

  // Математика 100 баллов (math)
  { username: 'xxilway', target: 'math' },            // lessi (Liza)
  { username: 'Ivanova_katt', target: 'math' },       // Yuriko^^
];

function main(): void {
  const db = getDb();

  try {
    db.prepare('SELECT 1 FROM student_subjects LIMIT 1').get();
  } catch {
    console.error('Таблица student_subjects не найдена. Выполните миграции: npm run migrate:dev');
    process.exit(1);
  }

  const selectStudent = db.prepare(
    "SELECT id, telegram_username, first_name, last_name FROM students WHERE lower(telegram_username) = lower(?)"
  );
  const deleteAllMathStreams = db.prepare(
    "DELETE FROM student_subjects WHERE student_id = ? AND subject_key IN ('math','math_profile','math_base')"
  );
  const insertStream = db.prepare(
    'INSERT OR IGNORE INTO student_subjects (student_id, subject_key) VALUES (?, ?)'
  );

  let moved = 0;
  let notFound: string[] = [];

  for (const u of USERS) {
    const row = selectStudent.get(u.username) as
      | { id: number; telegram_username: string | null; first_name: string; last_name: string }
      | undefined;
    if (!row) {
      console.warn(`Пользователь с username @${u.username} не найден в таблице students.`);
      notFound.push(u.username);
      continue;
    }

    deleteAllMathStreams.run(row.id);
    insertStream.run(row.id, u.target);
    console.log(
      `Студент id=${row.id}, username=@${row.telegram_username ?? ''}, ФИО="${row.first_name} ${
        row.last_name
      }" переведён в поток ${u.target}.`
    );
    moved += 1;
  }

  console.log(`Готово. Перераспределено студентов по потокам математики: ${moved}.`);
  if (notFound.length) {
    console.log(
      'Не найдены в students (проверь username в БД / Telegram):',
      notFound.map((u) => '@' + u).join(', ')
    );
  }
}

main();

