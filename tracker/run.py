"""The daily pipeline.

    uv run python -m tracker.run              # fetch, build, status, issue
    uv run python -m tracker.run --no-issue   # same, without the GitHub Issue
    uv run python -m tracker.run --if-missing # backup run: skip if today already has raw files

Steps: call every source and save its reply (gzipped, in its own format) under
data/raw/<date>/, record every source's result in data/runs/<date>.json, rebuild
data/history.csv from all raw files, write data/status.json, then open/update the
day's GitHub Issue. The workflow commits the data afterwards.
"""

from __future__ import annotations

import argparse
import json
import shutil
import traceback
from datetime import datetime, timezone
from pathlib import Path

from . import history as H
from .issues import issue_body, publish_issue, site_url
from .moves import appeared_gone, top_moves
from .sources import SOURCES, SourceError, convert

STATUS_PATH = H.DATA_DIR / "status.json"
RUNS_DIR = H.DATA_DIR / "runs"


def fetch_source(name: str, date: str, raw_dir: Path) -> dict:
    """Call one source and save its raw reply. Never raises: returns the result."""
    result = {"name": name, "format": SOURCES[name][0], "ok": False, "count": 0, "error": ""}
    try:
        raw = SOURCES[name][1]()
        rows = convert(name, raw, date)  # prove the reply is usable before saving it
        if not rows:
            raise SourceError("reply held none of the tracked items")
        H.write_raw(raw_dir, date, name, raw)
        result.update(ok=True, count=len(rows))
    except Exception as exc:  # one source failing must not stop the run
        result["error"] = f"{type(exc).__name__}: {exc}"[:300]
        traceback.print_exc()
    print(f"{'ok  ' if result['ok'] else 'FAIL'} {name:<10} {result['count']:>4}  {result['error']}")
    return result


def fetch_all(date: str, raw_dir: Path = H.RAW_DIR) -> list[dict]:
    day_dir = raw_dir / date
    if day_dir.exists():  # a second run on the same day replaces that day's raw files
        shutil.rmtree(day_dir)
    return [fetch_source(name, date, raw_dir) for name in SOURCES]


def make_status(rows: list[dict], results: list[dict], run_time: str, date: str, raw_dir: Path = H.RAW_DIR) -> dict:
    dates = list(H.raw_index(raw_dir))
    appeared, gone = appeared_gone(rows, date)
    return {
        "run_time": run_time,
        "run_date": date,
        "first_run_date": dates[0] if dates else None,
        "days_with_success": len(dates),
        "items": sum(r["date"] == date for r in rows),
        "new_today": appeared,
        "gone_today": gone,
        "sources": [{k: res[k] for k in ("name", "format", "ok", "count", "error")} for res in results],
    }


def run(date: str, run_time: str, raw_dir: Path = H.RAW_DIR, history_path: Path = H.HISTORY_PATH,
        status_path: Path = STATUS_PATH, runs_dir: Path = RUNS_DIR, issue: bool = True) -> dict:
    results = fetch_all(date, raw_dir)
    runs_dir.mkdir(parents=True, exist_ok=True)
    (runs_dir / f"{date}.json").write_text(json.dumps({"run_time": run_time, "sources": results}, indent=2) + "\n")

    rows = H.build_history(raw_dir)
    H.write_history(rows, history_path)
    status = make_status(rows, results, run_time, date, raw_dir)
    status_path.write_text(json.dumps(status, indent=2) + "\n")
    print(f"status: items={status['items']} new={len(status['new_today'])} gone={len(status['gone_today'])} "
          f"days={status['days_with_success']}")

    if issue:
        names = {r["item_id"]: r["item"] for r in rows}
        try:
            publish_issue(date, issue_body(date, status, top_moves(rows, date), names, site_url()))
        except Exception:
            traceback.print_exc()  # the issue failing must not lose the day's data
    return status


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-issue", action="store_true", help="do not open a GitHub Issue")
    parser.add_argument("--if-missing", action="store_true", help="do nothing if today already has raw files")
    args = parser.parse_args(argv)

    now = datetime.now(timezone.utc)
    run_time, date = now.strftime("%Y-%m-%dT%H:%M:%SZ"), now.strftime("%Y-%m-%d")
    if args.if_missing and H.raw_index().get(date):
        print(f"{date} already has a run; nothing to do")
        return 0
    run(date, run_time, issue=not args.no_issue)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
