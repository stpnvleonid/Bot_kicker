import argparse
import csv
import os
import sqlite3


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Export student_id -> LastName FirstName mapping from local bot.sqlite"
    )
    ap.add_argument(
        "--db",
        default=os.path.join("data", "bot.sqlite"),
        help="Path to SQLite DB (default: data/bot.sqlite)",
    )
    ap.add_argument(
        "--out",
        default=os.path.join("analytic_data", "student_map.csv"),
        help="Output CSV path (default: analytic_data/student_map.csv)",
    )
    args = ap.parse_args()

    if not os.path.exists(args.db):
        raise SystemExit(f"DB not found: {args.db}")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)

    con = sqlite3.connect(args.db)
    try:
        cur = con.cursor()
        cur.execute(
            "SELECT id, last_name, first_name FROM students ORDER BY last_name, first_name, id"
        )
        rows = cur.fetchall()
    finally:
        con.close()

    with open(args.out, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["student_id", "last_name", "first_name"])
        for sid, last_name, first_name in rows:
            w.writerow([sid, (last_name or "").strip(), (first_name or "").strip()])

    print(f"Wrote {len(rows)} rows to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

