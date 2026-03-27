import argparse
import base64
import csv
import json
import os
import sqlite3
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from typing import Dict, Iterable, List, Tuple


def _ensure_utf8_stdout() -> None:
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


@dataclass(frozen=True)
class Counters:
    expected: int = 0
    confirmed: int = 0

    def add(self, is_confirmed: bool) -> "Counters":
        return Counters(
            expected=self.expected + 1,
            confirmed=self.confirmed + (1 if is_confirmed else 0),
        )


def iter_csv_paths(input_path: str) -> List[str]:
    if os.path.isfile(input_path) and input_path.lower().endswith(".csv"):
        return [input_path]
    if not os.path.isdir(input_path):
        raise SystemExit(f"Input path not found: {input_path}")
    paths: List[str] = []
    for name in os.listdir(input_path):
        if not name.lower().endswith(".csv"):
            continue
        # Mapping file is auxiliary and should not be treated as exams source.
        if name.lower() == "student_map.csv":
            continue
        paths.append(os.path.join(input_path, name))
    paths.sort()
    return paths


def safe_get(row: Dict[str, str], key: str) -> str:
    v = row.get(key, "") or ""
    return v.strip()


def pct(confirmed: int, expected: int) -> str:
    if expected <= 0:
        return "—"
    return f"{round(confirmed * 100 / expected)}%"


def pct_num(confirmed: int, expected: int) -> float:
    if expected <= 0:
        return 0.0
    return round(confirmed * 100.0 / expected, 2)


def read_rows(paths: Iterable[str]) -> Iterable[Dict[str, str]]:
    for p in paths:
        with open(p, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                yield row


def load_student_map_csv(path: str) -> Dict[str, str]:
    if not os.path.exists(path):
        return {}
    mapping: Dict[str, str] = {}
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            sid = (row.get("student_id") or "").strip()
            last_name = (row.get("last_name") or "").strip()
            first_name = (row.get("first_name") or "").strip()
            if not sid:
                continue
            full = " ".join([x for x in [last_name, first_name] if x]).strip()
            if full:
                mapping[sid] = full
    return mapping


def load_student_map_from_sqlite(db_path: str) -> Dict[str, str]:
    if not db_path:
        return {}
    if not os.path.exists(db_path):
        raise SystemExit(f"DB not found: {db_path}")
    con = sqlite3.connect(db_path)
    try:
        cur = con.cursor()
        cur.execute("SELECT id, last_name, first_name FROM students")
        rows = cur.fetchall()
    finally:
        con.close()
    mapping: Dict[str, str] = {}
    for sid, last_name, first_name in rows:
        sid_s = str(sid)
        full = " ".join(
            [x for x in [(last_name or "").strip(), (first_name or "").strip()] if x]
        ).strip()
        if full:
            mapping[sid_s] = full
    return mapping


def write_csv(path: str, header: List[str], rows: Iterable[List[str]]) -> None:
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        for row in rows:
            w.writerow(row)


def maybe_make_subject_chart(subject_rows: List[Dict[str, str]]) -> str:
    """
    Returns base64 PNG (data) for subject chart, or empty string if matplotlib unavailable.
    """
    try:
        import matplotlib.pyplot as plt  # type: ignore
    except Exception:
        return ""

    labels = [f"{r['subject_key']} ({r['kind']})" for r in subject_rows]
    rates = [float(r["rate_percent"]) for r in subject_rows]

    fig = plt.figure(figsize=(max(8, len(labels) * 0.7), 4.5))
    ax = fig.add_subplot(111)
    bars = ax.bar(labels, rates)
    ax.set_ylim(0, 100)
    ax.set_ylabel("Rate %")
    ax.set_title("Confirmed / Expected by Subject and Kind")
    ax.grid(axis="y", alpha=0.25)
    for b, v in zip(bars, rates):
        ax.text(b.get_x() + b.get_width() / 2.0, min(99, v + 1), f"{v:.1f}%", ha="center", va="bottom", fontsize=8)
    plt.xticks(rotation=30, ha="right")
    plt.tight_layout()
    buf = BytesIO()
    fig.savefig(buf, format="png", dpi=120)
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def render_dashboard_html(
    out_path: str,
    generated_at: str,
    weeks: List[Tuple[str, str]],
    only_week: str,
    source_files: List[str],
    diagnostics: Dict[str, Dict[str, int]],
    student_rows: List[Dict[str, str]],
    subject_rows: List[Dict[str, str]],
    chart_b64: str,
) -> None:
    weeks_str = ", ".join([f"{ws}..{we}" for ws, we in weeks]) if weeks else "—"

    def rows_to_html(rows: List[Dict[str, str]], cols: List[str]) -> str:
        body = []
        for r in rows:
            tds = "".join([f"<td>{r.get(c,'')}</td>" for c in cols])
            body.append(f"<tr>{tds}</tr>")
        if not body:
            body.append(f"<tr><td colspan='{len(cols)}'>Нет данных</td></tr>")
        head = "".join([f"<th>{c}</th>" for c in cols])
        return f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table>"

    diag_lines = []
    for subject, status_map in sorted(diagnostics.items()):
        parts = ", ".join([f"{k}={v}" for k, v in sorted(status_map.items())])
        diag_lines.append(f"<li><b>{subject}</b>: {parts}</li>")
    if not diag_lines:
        diag_lines.append("<li>Нет данных</li>")

    chart_html = (
        f"<img alt='chart' src='data:image/png;base64,{chart_b64}' />"
        if chart_b64
        else "<p><i>График не построен: matplotlib не установлен.</i></p>"
    )

    html = f"""<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>Exams analytics dashboard</title>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 20px; color: #222; }}
    h1, h2 {{ margin: 0 0 12px 0; }}
    .meta {{ margin: 0 0 16px 0; color: #555; }}
    .card {{ border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin-bottom: 14px; }}
    table {{ border-collapse: collapse; width: 100%; margin-top: 8px; }}
    th, td {{ border: 1px solid #ddd; padding: 6px 8px; font-size: 13px; }}
    th {{ background: #f7f7f7; text-align: left; }}
    ul {{ margin: 8px 0 0 18px; }}
    img {{ max-width: 100%; border: 1px solid #ddd; border-radius: 6px; }}
  </style>
</head>
<body>
  <h1>Exams analytics dashboard</h1>
  <p class="meta">Сгенерировано: {generated_at}<br/>Недели во входе: {weeks_str}<br/>Фильтр --only-week: {only_week or "нет"}</p>

  <div class="card">
    <h2>Диагностика входных данных (subject_key x status)</h2>
    <p>Если какого-то предмета (например, informatics) нет в этом блоке, его нет во входных CSV.</p>
    <ul>{''.join(diag_lines)}</ul>
    <p><b>Source files:</b> {', '.join([os.path.basename(x) for x in source_files]) if source_files else '—'}</p>
  </div>

  <div class="card">
    <h2>Итог по предметам</h2>
    {rows_to_html(subject_rows, ["subject_key","kind","expected","confirmed","rate_percent"])}
    {chart_html}
  </div>

  <div class="card">
    <h2>Итог по студентам и предметам</h2>
    {rows_to_html(student_rows, ["student","subject_key","lessons","homeworks"])}
  </div>
</body>
</html>"""

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)


def main() -> int:
    _ensure_utf8_stdout()
    ap = argparse.ArgumentParser(description="Analyze /export_exams_week CSV files.")
    ap.add_argument(
        "--input",
        default="analytic_data",
        help="Folder with CSV files or path to a single CSV (default: analytic_data)",
    )
    ap.add_argument(
        "--only-week",
        default="",
        help="Optional filter by week_start (YYYY-MM-DD) to analyze only one week",
    )
    ap.add_argument(
        "--student-map",
        default=os.path.join("analytic_data", "student_map.csv"),
        help="CSV mapping student_id -> last_name/first_name (default: analytic_data/student_map.csv)",
    )
    ap.add_argument(
        "--db",
        default="",
        help="Optional path to local SQLite DB to auto-resolve student_id -> name (e.g. data/bot.sqlite). Overrides --student-map.",
    )
    ap.add_argument(
        "--out-dir",
        default=os.path.join("analytic_data", "output"),
        help="Directory for generated reports/dashboard (default: analytic_data/output)",
    )
    args = ap.parse_args()

    paths = iter_csv_paths(args.input)
    if not paths:
        print("No exams CSV files found.")
        return 0

    os.makedirs(args.out_dir, exist_ok=True)

    # Name resolution
    if args.db:
        student_name_by_id = load_student_map_from_sqlite(args.db)
        student_name_source = f"sqlite:{args.db}"
    else:
        student_name_by_id = load_student_map_csv(args.student_map)
        student_name_source = f"csv:{args.student_map}"

    per_student: Dict[Tuple[str, str, str], Counters] = {}
    per_subject: Dict[Tuple[str, str], Counters] = {}
    weeks_seen = set()
    subject_status_counter: Counter = Counter()
    total_rows = 0

    for row in read_rows(paths):
        week_start = safe_get(row, "week_start")
        week_end = safe_get(row, "week_end")
        if week_start:
            weeks_seen.add((week_start, week_end))
        if args.only_week and week_start != args.only_week:
            continue

        student_id = safe_get(row, "student_id")
        subject_key = safe_get(row, "subject_key") or "unknown"
        kind = safe_get(row, "kind") or "unknown"
        status = safe_get(row, "status").lower()
        subject_status_counter[(subject_key, status)] += 1

        if status not in ("pending", "confirmed"):
            continue

        total_rows += 1
        is_confirmed = status == "confirmed"

        student_label = student_name_by_id.get(student_id, "")
        student_key = student_label or (student_id or "unknown")

        k_student = (student_key, subject_key, kind)
        k_subject = (subject_key, kind)
        per_student[k_student] = per_student.get(k_student, Counters()).add(is_confirmed)
        per_subject[k_subject] = per_subject.get(k_subject, Counters()).add(is_confirmed)

    weeks_list = sorted(list(weeks_seen))
    if weeks_list and not args.only_week:
        joined = ", ".join([f"{ws}..{we}" for (ws, we) in weeks_list[:8]])
        more = "" if len(weeks_list) <= 8 else f" (+{len(weeks_list) - 8} more)"
        print(f"Weeks in input: {joined}{more}")
        print("Tip: use --only-week YYYY-MM-DD to filter one week_start")
        print()

    # Diagnostics for potentially missing subjects.
    print("=== Диагностика входных данных (subject_key x status) ===")
    subject_diag: Dict[str, Dict[str, int]] = defaultdict(dict)
    for (subj, status), cnt in sorted(subject_status_counter.items()):
        subject_diag[subj][status] = cnt
    if not subject_diag:
        print("Нет данных после фильтра.")
    else:
        for subj in sorted(subject_diag.keys()):
            parts = ", ".join([f"{k}={v}" for k, v in sorted(subject_diag[subj].items())])
            print(f"- {subj}: {parts}")
    if "informatics" not in subject_diag:
        print("WARNING: subject_key='informatics' отсутствует во входных CSV за выбранный фильтр.")
    print()

    # Report 1: per student
    print("=== По студентам (пройдено = confirmed; expected = pending+confirmed) ===")
    if student_name_by_id:
        print(f"(Имена студентов: {student_name_source})")
    nested: Dict[str, Dict[str, Dict[str, Counters]]] = defaultdict(lambda: defaultdict(dict))
    for (student_id, subject_key, kind), c in per_student.items():
        nested[student_id][subject_key][kind] = c

    student_rows_csv: List[Dict[str, str]] = []
    for student_id in sorted(nested.keys()):
        print(f"\n{student_id}")
        subjects = nested[student_id]
        for subject_key in sorted(subjects.keys()):
            kinds = subjects[subject_key]
            lesson = kinds.get("lesson", Counters())
            hw = kinds.get("homework", Counters())
            lesson_str = f"{lesson.confirmed}/{lesson.expected} ({pct(lesson.confirmed, lesson.expected)})"
            hw_str = f"{hw.confirmed}/{hw.expected} ({pct(hw.confirmed, hw.expected)})"
            print(f"  {subject_key}: Уроки {lesson_str}, ДЗ {hw_str}")
            student_rows_csv.append(
                {
                    "student": student_id,
                    "subject_key": subject_key,
                    "lessons": lesson_str,
                    "homeworks": hw_str,
                }
            )

    # Report 2: per subject (all students)
    print("\n\n=== По предметам (суммарно по всем студентам) ===")
    subject_totals: Dict[str, Dict[str, Counters]] = defaultdict(dict)
    for (subject_key, kind), c in per_subject.items():
        subject_totals[subject_key][kind] = c

    subject_rows_csv: List[Dict[str, str]] = []
    for subject_key in sorted(subject_totals.keys()):
        kinds = subject_totals[subject_key]
        lesson = kinds.get("lesson", Counters())
        hw = kinds.get("homework", Counters())
        print(
            f"{subject_key}: "
            f"Уроки {lesson.confirmed}/{lesson.expected} ({pct(lesson.confirmed, lesson.expected)}), "
            f"ДЗ {hw.confirmed}/{hw.expected} ({pct(hw.confirmed, hw.expected)})"
        )
        subject_rows_csv.append(
            {
                "subject_key": subject_key,
                "kind": "lesson",
                "expected": str(lesson.expected),
                "confirmed": str(lesson.confirmed),
                "rate_percent": f"{pct_num(lesson.confirmed, lesson.expected):.2f}",
            }
        )
        subject_rows_csv.append(
            {
                "subject_key": subject_key,
                "kind": "homework",
                "expected": str(hw.expected),
                "confirmed": str(hw.confirmed),
                "rate_percent": f"{pct_num(hw.confirmed, hw.expected):.2f}",
            }
        )

    # Write files
    student_csv_path = os.path.join(args.out_dir, "student_subject_summary.csv")
    subject_csv_path = os.path.join(args.out_dir, "subject_summary.csv")
    meta_json_path = os.path.join(args.out_dir, "report_meta.json")
    dashboard_html_path = os.path.join(args.out_dir, "dashboard.html")

    write_csv(
        student_csv_path,
        ["student", "subject_key", "lessons", "homeworks"],
        [[r["student"], r["subject_key"], r["lessons"], r["homeworks"]] for r in student_rows_csv],
    )
    write_csv(
        subject_csv_path,
        ["subject_key", "kind", "expected", "confirmed", "rate_percent"],
        [
            [r["subject_key"], r["kind"], r["expected"], r["confirmed"], r["rate_percent"]]
            for r in subject_rows_csv
        ],
    )

    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "input_files": paths,
        "only_week": args.only_week,
        "weeks_seen": [{"week_start": ws, "week_end": we} for ws, we in weeks_list],
        "rows_counted": total_rows,
        "subject_status_counts": {
            subj: dict(status_map) for subj, status_map in subject_diag.items()
        },
    }
    with open(meta_json_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    chart_b64 = maybe_make_subject_chart(subject_rows_csv)
    render_dashboard_html(
        out_path=dashboard_html_path,
        generated_at=meta["generated_at"],
        weeks=weeks_list,
        only_week=args.only_week,
        source_files=paths,
        diagnostics=subject_diag,
        student_rows=student_rows_csv,
        subject_rows=subject_rows_csv,
        chart_b64=chart_b64,
    )

    print("\n=== Файлы отчёта ===")
    print(f"- {student_csv_path}")
    print(f"- {subject_csv_path}")
    print(f"- {meta_json_path}")
    print(f"- {dashboard_html_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

