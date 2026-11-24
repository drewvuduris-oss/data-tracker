"""Build data/history.csv from the raw files in data/raw, day by day.

The history depends on the raw files alone: running the build again gives a
byte-identical file, and a change to a conversion rule applies to every day.

    uv run python -m tracker.history
"""

from __future__ import annotations

import csv
import gzip
from pathlib import Path

from .sources import COMMON_COLUMNS, NUMERIC_COLUMNS, SOURCES, convert

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
HISTORY_PATH = DATA_DIR / "history.csv"


# --------------------------------------------------------------------------- raw files

def raw_path(raw_dir: Path, date: str, source: str) -> Path:
    return raw_dir / date / f"{source}.{SOURCES[source][0]}.gz"


def write_raw(raw_dir: Path, date: str, source: str, raw: bytes) -> Path:
    """Save the reply bytes untouched, gzipped (mtime=0 so equal bytes give equal files)."""
    path = raw_path(raw_dir, date, source)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as fh, gzip.GzipFile(filename="", fileobj=fh, mode="wb", mtime=0) as gz:
        gz.write(raw)
    return path


def read_raw(path: Path) -> bytes:
    with gzip.open(path, "rb") as fh:
        return fh.read()


def raw_index(raw_dir: Path = RAW_DIR) -> dict[str, dict[str, Path]]:
    """{date: {source: path}} for every raw file of a known source, dates in order."""
    index: dict[str, dict[str, Path]] = {}
    if not raw_dir.exists():
        return index
    for day in sorted(p for p in raw_dir.iterdir() if p.is_dir()):
        files = {}
        for name in sorted(SOURCES):
            path = raw_path(raw_dir, day.name, name)
            if path.exists():
                files[name] = path
        if files:
            index[day.name] = files
    return index


# --------------------------------------------------------------------------- build

def day_rows(date: str, files: dict[str, Path]) -> list[dict]:
    """Step 1: one day's raw files -> one row per item with the common columns."""
    rows = []
    for source, path in files.items():
        rows += convert(source, read_raw(path), date)
    return rows


def add_day(history: list[dict], date: str, rows: list[dict]) -> list[dict]:
    """Step 2: add a day's rows. Rows already in the history for that date are
    replaced (a second run on the same day counts once), and the result is sorted
    by date, then item_id."""
    kept = [r for r in history if r["date"] != date]
    return sorted(kept + rows, key=lambda r: (r["date"], r["item_id"]))


def build_history(raw_dir: Path = RAW_DIR) -> list[dict]:
    history: list[dict] = []
    for date, files in raw_index(raw_dir).items():
        history = add_day(history, date, day_rows(date, files))
    return history


# --------------------------------------------------------------------------- csv

def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        return repr(int(value)) if value.is_integer() and abs(value) < 1e15 else repr(value)
    return str(value)


def write_history(rows: list[dict], path: Path = HISTORY_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(COMMON_COLUMNS)
        for row in rows:
            writer.writerow([_cell(row.get(col)) for col in COMMON_COLUMNS])


def read_history(path: Path = HISTORY_PATH) -> list[dict]:
    """Read history.csv back, with numeric columns as floats (empty -> None)."""
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    for row in rows:
        for col in NUMERIC_COLUMNS:
            row[col] = float(row[col]) if row[col] != "" else None
    return rows


def main() -> None:
    rows = build_history()
    write_history(rows)
    print(f"history: {len(rows)} rows, {len({r['date'] for r in rows})} days -> {HISTORY_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
