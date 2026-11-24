"""The move rule.

A move is the percent change in ``price_usd`` between an item's row on the run
date and its most recent earlier row in the history (the previous run in which
the item appeared):

    move_pct = (new_price - old_price) / old_price * 100

Items are ranked by the absolute move, largest first (ties by item_id), and the
daily issue lists the top TOP_N. An item *appeared* if it has a row on the run
date but none on the previous run date; it *disappeared* if it had a row on the
previous run date but none on the run date.
"""

from __future__ import annotations

TOP_N = 10


def _price(row: dict):
    value = row.get("price_usd")
    if value in (None, ""):
        return None
    return float(value)


def previous_date(rows: list[dict], date: str) -> str | None:
    earlier = [r["date"] for r in rows if r["date"] < date]
    return max(earlier) if earlier else None


def moves(rows: list[dict], date: str) -> list[dict]:
    """Every item on ``date`` with a usable earlier price, ranked by |move_pct|."""
    last: dict[str, dict] = {}  # item_id -> latest row before `date`
    for r in rows:
        if r["date"] < date and _price(r) is not None:
            if r["item_id"] not in last or r["date"] > last[r["item_id"]]["date"]:
                last[r["item_id"]] = r
    out = []
    for r in rows:
        if r["date"] != date:
            continue
        old_row, new = last.get(r["item_id"]), _price(r)
        if old_row is None or new is None or _price(old_row) == 0:
            continue
        old = _price(old_row)
        out.append({
            "item_id": r["item_id"], "item": r["item"], "symbol": r.get("symbol", ""),
            "asset_class": r.get("asset_class", ""), "old_date": old_row["date"],
            "old": old, "new": new, "move_pct": (new - old) / old * 100,
        })
    out.sort(key=lambda m: (-abs(m["move_pct"]), m["item_id"]))
    return out


def top_moves(rows: list[dict], date: str, n: int = TOP_N) -> list[dict]:
    return moves(rows, date)[:n]


def appeared_gone(rows: list[dict], date: str) -> tuple[list[str], list[str]]:
    """(appeared, gone) item_ids on ``date`` compared with the previous run date.
    On the first run there is nothing to compare with, so both are empty."""
    prev = previous_date(rows, date)
    if prev is None:
        return [], []
    today = {r["item_id"] for r in rows if r["date"] == date}
    before = {r["item_id"] for r in rows if r["date"] == prev}
    return sorted(today - before), sorted(before - today)
