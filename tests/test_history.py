"""History logic: building from raw files, rebuilding, a failed source, and a
second run on the same day."""

import json
from pathlib import Path

import pytest

from tracker import history as H
from tracker import run as R
from tracker import sources as S

FIX = Path(__file__).parent / "fixtures"


def cg(prices: dict[str, float]) -> bytes:
    return json.dumps([{"id": k, "symbol": k[:3], "name": k.title(), "current_price": v} for k, v in prices.items()]).encode()


def yh(prices: dict[str, float]) -> bytes:
    return json.dumps({"spark": {"result": [
        {"symbol": k, "response": [{"meta": {"regularMarketPrice": v, "shortName": k}}]} for k, v in prices.items()
    ]}}).encode()


@pytest.fixture
def dirs(tmp_path):
    return {"raw_dir": tmp_path / "raw", "history_path": tmp_path / "history.csv",
            "status_path": tmp_path / "status.json", "runs_dir": tmp_path / "runs"}


@pytest.fixture
def fake_sources(monkeypatch):
    """Replace the network fetchers with ones whose replies the test sets."""
    replies: dict[str, object] = {}

    def fetcher(name):
        def fetch():
            reply = replies[name]
            if isinstance(reply, Exception):
                raise reply
            return reply
        return fetch

    patched = {name: (fmt, fetcher(name), conv) for name, (fmt, _, conv) in S.SOURCES.items()}
    monkeypatch.setattr(S, "SOURCES", patched)
    monkeypatch.setattr(R, "SOURCES", patched)
    monkeypatch.setattr(H, "SOURCES", patched)
    return replies


def test_raw_file_round_trip_and_deterministic(tmp_path):
    raw = (FIX / "coingecko.json").read_bytes()
    p1 = H.write_raw(tmp_path / "a", "2026-11-24", "coingecko", raw)
    p2 = H.write_raw(tmp_path / "b", "2026-11-24", "coingecko", raw)
    assert p1.name == "coingecko.json.gz"
    assert H.read_raw(p1) == raw
    assert p1.read_bytes() == p2.read_bytes()


def test_build_is_sorted_and_reproducible(tmp_path):
    raw_dir = tmp_path / "raw"
    for date in ("2026-11-21", "2026-11-20"):
        H.write_raw(raw_dir, date, "yahoo", (FIX / "yahoo.json").read_bytes())
        H.write_raw(raw_dir, date, "coingecko", (FIX / "coingecko.json").read_bytes())
    rows = H.build_history(raw_dir)
    assert len(rows) == 12
    assert [(r["date"], r["item_id"]) for r in rows] == sorted((r["date"], r["item_id"]) for r in rows)
    H.write_history(rows, tmp_path / "h1.csv")
    H.write_history(H.build_history(raw_dir), tmp_path / "h2.csv")
    assert (tmp_path / "h1.csv").read_bytes() == (tmp_path / "h2.csv").read_bytes()
    header = (tmp_path / "h1.csv").read_text().splitlines()[0].split(",")
    assert header[:4] == ["date", "item_id", "item", "source"]


def test_empty_values_written_as_empty_cells(tmp_path):
    H.write_raw(tmp_path / "raw", "2026-11-20", "coingecko", cg({"bitcoin": 100.0}))
    H.write_history(H.build_history(tmp_path / "raw"), tmp_path / "h.csv")
    back = H.read_history(tmp_path / "h.csv")
    assert back[0]["price_usd"] == 100.0
    assert back[0]["market_cap_usd"] is None


def test_add_day_replaces_same_date():
    old = [{"date": "2026-11-20", "item_id": "x"}, {"date": "2026-11-21", "item_id": "x"}]
    new = [{"date": "2026-11-21", "item_id": "y"}]
    out = H.add_day(old, "2026-11-21", new)
    assert out == [{"date": "2026-11-20", "item_id": "x"}, {"date": "2026-11-21", "item_id": "y"}]


def test_failed_source_does_not_stop_the_run(dirs, fake_sources):
    fake_sources["coingecko"] = RuntimeError("HTTP 429")
    fake_sources["yahoo"] = yh({"AAPL": 100.0, "MSFT": 200.0})
    status = R.run("2026-11-20", "2026-11-20T21:40:00Z", issue=False, **dirs)
    assert [(s["name"], s["ok"], s["count"]) for s in status["sources"]] == [("coingecko", False, 0), ("yahoo", True, 2)]
    assert "429" in status["sources"][0]["error"]
    assert not (dirs["raw_dir"] / "2026-11-20" / "coingecko.json.gz").exists()
    assert (dirs["raw_dir"] / "2026-11-20" / "yahoo.json.gz").exists()
    assert status["items"] == 2
    runlog = json.loads((dirs["runs_dir"] / "2026-11-20.json").read_text())
    assert [s["ok"] for s in runlog["sources"]] == [False, True]


def test_unusable_reply_is_a_failure(dirs, fake_sources):
    fake_sources["coingecko"] = b"[]"
    fake_sources["yahoo"] = b"not json"
    status = R.run("2026-11-20", "2026-11-20T21:40:00Z", issue=False, **dirs)
    assert not any(s["ok"] for s in status["sources"])
    assert status["days_with_success"] == 0 and status["items"] == 0


def test_daily_runs_and_second_run_same_day(dirs, fake_sources):
    fake_sources["coingecko"] = cg({"bitcoin": 100.0, "ethereum": 10.0})
    fake_sources["yahoo"] = yh({"AAPL": 100.0})
    R.run("2026-11-20", "2026-11-20T21:40:00Z", issue=False, **dirs)

    fake_sources["coingecko"] = cg({"bitcoin": 110.0, "solana": 5.0})  # ethereum gone, solana new
    R.run("2026-11-21", "2026-11-21T21:40:00Z", issue=False, **dirs)

    # second run on 11-21: new prices, and yahoo now fails
    fake_sources["coingecko"] = cg({"bitcoin": 120.0, "solana": 5.0})
    fake_sources["yahoo"] = RuntimeError("timeout")
    status = R.run("2026-11-21", "2026-11-21T23:50:00Z", issue=False, **dirs)

    rows = H.read_history(dirs["history_path"])
    day2 = [r for r in rows if r["date"] == "2026-11-21"]
    assert [r["item_id"] for r in day2] == ["coingecko:bitcoin", "coingecko:solana"]  # replaced, not appended
    assert day2[0]["price_usd"] == 120.0
    assert len(rows) == 5  # 3 on day 1 + 2 on day 2
    assert sorted(p.name for p in (dirs["raw_dir"] / "2026-11-21").iterdir()) == ["coingecko.json.gz"]

    assert status["run_time"] == "2026-11-21T23:50:00Z"
    assert status["first_run_date"] == "2026-11-20"
    assert status["days_with_success"] == 2  # the day counts once
    assert status["items"] == 2
    assert status["new_today"] == ["coingecko:solana"]
    assert status["gone_today"] == ["coingecko:ethereum", "yahoo:AAPL"]
    assert set(json.loads(dirs["status_path"].read_text())) >= {
        "run_time", "first_run_date", "days_with_success", "items", "new_today", "gone_today", "sources"}

    # the committed history equals a fresh build from the raw files
    before = dirs["history_path"].read_bytes()
    H.write_history(H.build_history(dirs["raw_dir"]), dirs["history_path"])
    assert dirs["history_path"].read_bytes() == before
