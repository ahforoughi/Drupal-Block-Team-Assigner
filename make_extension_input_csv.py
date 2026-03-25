import argparse
import csv
import json
import sys
from pathlib import Path


def resolve_team(url: str, title: str, rules_obj: dict, match_title: bool = True) -> str:
    """
    Replicates the extension's getTeamForUrl matching (substring match on lowercased input).
    Additionally matches the pattern against page title when match_title=True.
    """
    rules = rules_obj.get("rules", []) or []
    default_team = rules_obj.get("default_team", "") or ""

    url_l = (url or "").lower()
    title_l = (title or "").lower()

    for r in rules:
        pattern = (r.get("pattern") or "").lower()
        if not pattern:
            continue
        if pattern in url_l:
            return r.get("team_name") or ""
        if match_title and pattern in title_l:
            return r.get("team_name") or ""

    return default_team


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--input",
        required=True,
        help="Input CSV (your filtered_arts_blocks_no_team_gt0.csv)",
    )
    ap.add_argument("--rules", required=True, help="rules_default.json path")
    ap.add_argument("--output", required=True, help="Output CSV path")
    ap.add_argument(
        "--dedupe",
        action="store_true",
        help="Deduplicate by page_url (recommended for large runs)",
    )
    ap.add_argument(
        "--no-match-title",
        action="store_true",
        help="Only match rules against URL (skip title matching)",
    )
    args = ap.parse_args()

    input_path = Path(args.input)
    rules_path = Path(args.rules)
    output_path = Path(args.output)

    if not input_path.exists():
        raise SystemExit(f"Input CSV not found: {input_path}")
    if not rules_path.exists():
        raise SystemExit(f"Rules JSON not found: {rules_path}")

    with rules_path.open("r", encoding="utf-8") as f:
        rules_obj = json.load(f)

    page_url_col = "url location"
    page_title_col = "page title"
    # Your extension expects:
    # - `page_url`
    # - `page_teams` (team name string; first token used)
    out_fieldnames = ["page_url", "page_teams"]

    match_title = not args.no_match_title

    seen = set()
    rows_written = 0
    skipped = 0

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with input_path.open("r", encoding="utf-8", newline="") as f_in, output_path.open(
        "w", encoding="utf-8", newline=""
    ) as f_out:
        reader = csv.DictReader(f_in)
        if page_url_col not in (reader.fieldnames or []):
            raise SystemExit(
                f"Missing column `{page_url_col}`. Found columns: {reader.fieldnames}"
            )

        writer = csv.DictWriter(f_out, fieldnames=out_fieldnames)
        writer.writeheader()

        for row in reader:
            raw_url = (row.get(page_url_col) or "").strip()
            if not raw_url:
                skipped += 1
                continue

            if args.dedupe:
                if raw_url in seen:
                    continue
                seen.add(raw_url)

            title = (
                (row.get(page_title_col) or "").strip()
                if page_title_col in (reader.fieldnames or [])
                else ""
            )

            team = resolve_team(raw_url, title, rules_obj, match_title=match_title)
            writer.writerow({"page_url": raw_url, "page_teams": team})
            rows_written += 1

    print(f"Wrote {rows_written} rows to {output_path}")
    if skipped:
        print(f"Skipped {skipped} rows with empty `{page_url_col}`", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

