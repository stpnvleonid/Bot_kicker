# analytic_data

Папка для локальной аналитики по CSV, которые бот отдаёт админам командой:

- `/export_exams_week YYYY-MM-DD`

## Как пользоваться

1) Скачай CSV из Telegram и положи файл(ы) в эту папку.

2) Запусти анализ:

```bash
python analytic_data/analyze_exams_csv.py --input analytic_data
```

Если в PowerShell русские буквы отображаются некорректно, можно дополнительно включить UTF‑8:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
setx PYTHONUTF8 1
```

Если хочешь видеть в отчёте **Фамилия Имя**, а не `student_id`:

- Вариант A (автоматически из локальной БД):

```bash
python analytic_data/export_student_map.py --db data/bot.sqlite --out analytic_data/student_map.csv
python analytic_data/analyze_exams_csv.py --input analytic_data --student-map analytic_data/student_map.csv
```

- Вариант B (напрямую из БД без промежуточного CSV):

```bash
python analytic_data/analyze_exams_csv.py --input analytic_data --db data/bot.sqlite
```

По умолчанию скрипт читает все `*.csv` в папке `--input` и печатает 2 отчёта:

- по каждому студенту: сколько **уроков** и **ДЗ** пройдено по предметам
- по каждому предмету: суммарно по всем студентам

Дополнительно скрипт сохраняет файлы в `analytic_data/output/`:

- `student_subject_summary.csv` — отчёт по студентам и предметам
- `subject_summary.csv` — суммарный отчёт по предметам (отдельно lesson/homework)
- `report_meta.json` — метаданные и диагностика входных данных
- `dashboard.html` — локальный HTML-дашборд (таблицы + график, если установлен matplotlib)

Быстрый online-отчет в боте (для админа):

- `/exams_week_summary YYYY-MM-DD [предмет]` — weekly summary в Telegram + CSV.
- `/exams_review_queue [YYYY-MM-DD] [предмет]` — очередь модерации (pending с evidence) без SQL.
- `/exams_review_start [YYYY-MM-DD] [предмет]` — пошаговая модерация очереди в Telegram.

## Что считается «пройдено»

- В CSV есть `status=pending|confirmed`.
- «Пройдено» = `status=confirmed`.
- «Ожидалось (expected)» = `pending + confirmed`.

После фикса exams-приглашений:

- все eligible студенты с `pending/rejected` submissions по дате получают вечерний экран с блоком «Обязательные exams на модерации» (даже если у них нет задач планера на эту дату);
- это повышает шанс перевода `pending → confirmed` и делает итоговые проценты по предметам более репрезентативными.

Новая рассылка по долгам недели:

- `/exams_week_nudge YYYY-MM-DD [предмет]` — ставит в очередь DM-напоминания студентам, у которых за прошедшие дни недели есть `pending/rejected` exams.

## Проверка корректности данных

Скрипт печатает диагностику `subject_key x status`.
Если какой-то предмет (например `informatics`) не виден в статистике, сначала проверь, есть ли он в этом диагностическом блоке:

- если предмета нет в диагностике — его нет во входных CSV выгрузки;
- если предмет есть в диагностике, но не в итоге — это уже проблема агрегации.

