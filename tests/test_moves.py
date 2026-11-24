"""The move rule."""

import pytest

from tracker.moves import appeared_gone, moves, previous_date, top_moves


def row(date, item_id, price):
    return {"date": date, "item_id": item_id, "item": item_id.upper(), "symbol": item_id.upper(),
            "asset_class": "Stock", "price_usd": price}


ROWS = [
    row("2026-11-20", "a", 100.0), row("2026-11-20", "b", 50.0), row("2026-11-20", "c", 10.0),
    row("2026-11-21", "a", 110.0), row("2026-11-21", "b", 45.0), row("2026-11-21", "d", 1.0),
    row("2026-11-22", "a", 99.0), row("2026-11-22", "c", 10.5), row("2026-11-22", "d", None),
]


def test_move_is_percent_change_from_previous_row():
    m = {x["item_id"]: x for x in moves(ROWS, "2026-11-21")}
    assert m["a"]["move_pct"] == pytest.approx(10.0)
    assert m["b"]["move_pct"] == pytest.approx(-10.0)
    assert m["a"]["old"] == 100.0 and m["a"]["new"] == 110.0 and m["a"]["old_date"] == "2026-11-20"
    assert "d" not in m  # first appearance: nothing to compare with


def test_ranked_by_absolute_move_ties_by_item_id():
    assert [x["item_id"] for x in moves(ROWS, "2026-11-21")] == ["a", "b"]  # |10| == |-10| -> by id


def test_previous_row_may_be_older_than_previous_date():
    # c is missing on 11-21, so its move on 11-22 is measured against 11-20
    m = {x["item_id"]: x for x in moves(ROWS, "2026-11-22")}
    assert m["c"]["old_date"] == "2026-11-20"
    assert m["c"]["move_pct"] == pytest.approx(5.0)
    assert m["a"]["move_pct"] == pytest.approx(-10.0)
    assert "d" not in m  # empty price today


def test_top_n():
    assert len(top_moves(ROWS, "2026-11-22", n=1)) == 1
    assert top_moves(ROWS, "2026-11-22", n=1)[0]["item_id"] == "a"


def test_first_day_has_no_moves():
    assert moves(ROWS, "2026-11-20") == []
    assert appeared_gone(ROWS, "2026-11-20") == ([], [])


def test_appeared_and_gone_against_previous_run_date():
    assert previous_date(ROWS, "2026-11-22") == "2026-11-21"
    assert appeared_gone(ROWS, "2026-11-21") == (["d"], ["c"])
    assert appeared_gone(ROWS, "2026-11-22") == (["c"], ["b"])


def test_issue_body_lists_moves_and_changes():
    from tracker.issues import issue_body
    status = {"run_time": "2026-11-22T21:40:00Z", "items": 3, "days_with_success": 3, "first_run_date": "2026-11-20",
              "new_today": ["c"], "gone_today": ["b"],
              "sources": [{"name": "yahoo", "ok": True}, {"name": "coingecko", "ok": False}]}
    body = issue_body("2026-11-22", status, top_moves(ROWS, "2026-11-22"), {"b": "B", "c": "C"})
    assert "failed: coingecko" in body
    assert "-10.00%" in body and "+5.00%" in body
    assert "## Appeared (1)" in body and "- C (`c`)" in body
    assert "## Disappeared (1)" in body and "- B (`b`)" in body


def test_issue_body_on_a_quiet_day():
    from tracker.issues import issue_body
    status = {"run_time": "t", "items": 0, "days_with_success": 1, "first_run_date": "2026-11-20",
              "new_today": [], "gone_today": [], "sources": []}
    body = issue_body("2026-11-20", status, [], {})
    assert "No earlier run" in body and body.count("_None._") == 2
