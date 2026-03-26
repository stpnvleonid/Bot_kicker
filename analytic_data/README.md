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

## Что считается «пройдено»

- В CSV есть `status=pending|confirmed`.
- «Пройдено» = `status=confirmed`.
- «Ожидалось (expected)» = `pending + confirmed`.

