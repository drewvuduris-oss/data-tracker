"""Conversion of each source's raw reply to the common columns."""

import json
from pathlib import Path

import pytest

from tracker.sources import COMMON_COLUMNS, NUMERIC_COLUMNS, convert, convert_coingecko, convert_yahoo

FIX = Path(__file__).parent / "fixtures"
DATE = "2026-11-24"


def raw(name: str) -> bytes:
    return (FIX / name).read_bytes()


@pytest.mark.parametrize("source,fixture", [("coingecko", "coingecko.json"), ("yahoo", "yahoo.json")])
def test_rows_have_exactly_the_common_columns(source, fixture):
    rows = convert(source, raw(fixture), DATE)
    assert rows
    for r in rows:
        assert list(r) == COMMON_COLUMNS
        assert r["date"] == DATE
        assert r["source"] == source
        assert r["item_id"].startswith(source + ":")
        for col in NUMERIC_COLUMNS:
            assert r[col] is None or isinstance(r[col], (int, float))
    assert [r["item_id"] for r in rows] == sorted(r["item_id"] for r in rows)


def test_coingecko_values():
    rows = {r["item_id"]: r for r in convert_coingecko(raw("coingecko.json"), DATE)}
    assert set(rows) == {"coingecko:bitcoin", "coingecko:ethereum", "coingecko:solana"}
    btc = rows["coingecko:bitcoin"]
    src = next(c for c in json.loads(raw("coingecko.json")) if c["id"] == "bitcoin")
    assert btc["item"] == "Bitcoin" and btc["symbol"] == "BTC"
    assert btc["asset_class"] == "Crypto" and btc["sector"] == "Store of value"
    assert btc["price_usd"] == src["current_price"]
    assert btc["market_cap_usd"] == src["market_cap"]
    assert btc["volume_usd"] == src["total_volume"]
    assert btc["change_pct"] == round(src["price_change_percentage_24h"], 4)
    assert btc["high_52w_usd"] is None  # not reported by CoinGecko -> left empty
    assert btc["quote_time"].endswith("Z") and "." not in btc["quote_time"]


def test_coingecko_drops_untracked_and_priceless_coins():
    reply = [
        {"id": "bitcoin", "symbol": "btc", "name": "Bitcoin", "current_price": 100.0},
        {"id": "some-new-coin", "symbol": "snc", "name": "New", "current_price": 1.0},
        {"id": "ethereum", "symbol": "eth", "name": "Ethereum", "current_price": None},
    ]
    rows = convert_coingecko(json.dumps(reply).encode(), DATE)
    assert [r["item_id"] for r in rows] == ["coingecko:bitcoin"]
    assert rows[0]["market_cap_usd"] is None


def test_yahoo_values():
    rows = {r["item_id"]: r for r in convert_yahoo(raw("yahoo.json"), DATE)}
    assert set(rows) == {"yahoo:AAPL", "yahoo:SPY", "yahoo:TSN"}
    doc = json.loads(raw("yahoo.json"))
    meta = next(x for x in doc["spark"]["result"] if x["symbol"] == "AAPL")["response"][0]["meta"]
    aapl = rows["yahoo:AAPL"]
    assert aapl["asset_class"] == "Stock" and aapl["sector"] == "Technology"
    assert aapl["price_usd"] == meta["regularMarketPrice"]
    assert aapl["volume_usd"] == round(meta["regularMarketVolume"] * meta["regularMarketPrice"])
    assert aapl["high_52w_usd"] == meta["fiftyTwoWeekHigh"]
    assert aapl["market_cap_usd"] is None
    assert rows["yahoo:SPY"]["asset_class"] == "ETF"


def test_yahoo_change_falls_back_to_previous_close():
    reply = {"spark": {"result": [
        {"symbol": "AAPL", "response": [{"meta": {"regularMarketPrice": 110, "chartPreviousClose": 100}}]},
        {"symbol": "ZZZZ", "response": [{"meta": {"regularMarketPrice": 5}}]},  # not tracked
        {"symbol": "MSFT", "response": []},  # no data
    ]}}
    rows = convert_yahoo(json.dumps(reply).encode(), DATE)
    assert len(rows) == 1
    assert rows[0]["change_pct"] == pytest.approx(10.0)
    assert rows[0]["volume_usd"] is None


def test_bad_reply_raises():
    with pytest.raises(ValueError):
        convert("yahoo", b"<html>blocked</html>", DATE)
