import argparse
import csv
import os
import sqlite3
import sys
from collections import defaultdict
from dataclasses import dataclass
from typing import Dict, Iterable, List, Tuple


def _ensure_utf8_stdout() -> None:
    """
    PowerShell/Windows sometimes prints UTF-8 as mojibake.
    Force UTF-8 for stdout/stderr when possible (Python 3.7+).
    """
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
        if name.lower().endswith(".csv"):
            paths.append(os.path.join(input_path, name))
    paths.sort()
    return paths


def safe_get(row: Dict[str, str], key: str) -> str:
    v = row.get(key, "") or ""
    return v.strip()


def kind_label(kind: str) -> str:
    k = (kind or "").strip().lower()
    if k == "lesson":
        return "Уроки"
    if k == "homework":
        return "ДЗ"
    return k or "unknown"


def pct(confirmed: int, expected: int) -> str:
    if expected <= 0:
        return "—"
    return f"{round(confirmed * 100 / expected)}%"


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
        full = " ".join([x for x in [(last_name or "").strip(), (first_name or "").strip()] if x]).strip()
        if full:
            mapping[sid_s] = full
    return mapping


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
    args = ap.parse_args()

    paths = iter_csv_paths(args.input)
    if not paths:
        print("No CSV files found.")
        return 0

    # Aggregations:
    # per_student[(student_id, subject_key, kind)] = Counters
    per_student: Dict[Tuple[str, str, str], Counters] = {}
    # per_subject[(subject_key, kind)] = Counters
    per_subject: Dict[Tuple[str, str], Counters] = {}

    weeks_seen = set()

    # Name resolution
    if args.db:
        student_name_by_id = load_student_map_from_sqlite(args.db)
        student_name_source = f"sqlite:{args.db}"
    else:
        student_name_by_id = load_student_map_csv(args.student_map)
        student_name_source = f"csv:{args.student_map}"

    for row in read_rows(paths):
        week_start = safe_get(row, "week_start")
        week_end = safe_get(row, "week_end")
        if week_start:
            weeks_seen.add((week_start, week_end))
        if args.only_week and week_start != args.only_week:
            continue

        student_id = safe_get(row, "student_id")
        student_label = student_name_by_id.get(student_id, "")
        student_key = student_label or (student_id or "unknown")
        subject_key = safe_get(row, "subject_key") or "unknown"
        kind = safe_get(row, "kind")
        status = safe_get(row, "status").lower()

        # Expected = pending+confirmed (CSV already contains only these statuses, but keep a guard).
        if status not in ("pending", "confirmed"):
            continue

        is_confirmed = status == "confirmed"

        k_student = (student_key, subject_key, kind or "unknown")
        k_subject = (subject_key, kind or "unknown")

        per_student[k_student] = per_student.get(k_student, Counters()).add(is_confirmed)
        per_subject[k_subject] = per_subject.get(k_subject, Counters()).add(is_confirmed)

    weeks_list = sorted(list(weeks_seen))
    if weeks_list and not args.only_week:
        joined = ", ".join([f"{ws}..{we}" for (ws, we) in weeks_list[:8]])
        more = "" if len(weeks_list) <= 8 else f" (+{len(weeks_list) - 8} more)"
        print(f"Weeks in input: {joined}{more}")
        print("Tip: use --only-week YYYY-MM-DD to filter one week_start")
        print()

    # Report 1: per student, grouped by student_id then subject.
    print("=== По студентам (пройдено = confirmed; expected = pending+confirmed) ===")
    if student_name_by_id:
        print(f"(Имена студентов: {student_name_source})")
    # Build a nested structure: student -> subject -> kind -> Counters
    nested: Dict[str, Dict[str, Dict[str, Counters]]] = defaultdict(lambda: defaultdict(dict))
    for (student_id, subject_key, kind), c in per_student.items():
        nested[student_id][subject_key][kind] = c

    for student_id in sorted(nested.keys()):
        print(f"\n{student_id}")
        subjects = nested[student_id]
        for subject_key in sorted(subjects.keys()):
            kinds = subjects[subject_key]
            lesson = kinds.get("lesson", Counters())
            hw = kinds.get("homework", Counters())
            print(
                f"  {subject_key}: "
                f"Уроки {lesson.confirmed}/{lesson.expected} ({pct(lesson.confirmed, lesson.expected)}), "
                f"ДЗ {hw.confirmed}/{hw.expected} ({pct(hw.confirmed, hw.expected)})"
            )

    # Report 2: per subject (all students).
    print("\n\n=== По предметам (суммарно по всем студентам) ===")
    # subject -> Counters lesson/hw
    subject_totals: Dict[str, Dict[str, Counters]] = defaultdict(dict)
    for (subject_key, kind), c in per_subject.items():
        subject_totals[subject_key][kind] = c

    for subject_key in sorted(subject_totals.keys()):
        kinds = subject_totals[subject_key]
        lesson = kinds.get("lesson", Counters())
        hw = kinds.get("homework", Counters())
        print(
            f"{subject_key}: "
            f"Уроки {lesson.confirmed}/{lesson.expected} ({pct(lesson.confirmed, lesson.expected)}), "
            f"ДЗ {hw.confirmed}/{hw.expected} ({pct(hw.confirmed, hw.expected)})"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

