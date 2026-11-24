"""The sources the tracker calls, and how each one's raw reply becomes rows.

Every source has a ``fetch()`` that returns the reply bytes exactly as they came
(they are saved untouched, gzipped) and a ``convert()`` that turns those bytes
into one row per tracked item with the common columns below.

Only the tracked items are requested (the ticker and coin lists below), and only
the fields in COMMON_COLUMNS are kept from each reply.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone

import requests

COMMON_COLUMNS = [
    "date",            # UTC date of the run, YYYY-MM-DD
    "item_id",         # stable key: "<source>:<symbol or coin id>"
    "item",            # display name
    "source",          # coingecko | yahoo
    "symbol",          # ticker or coin symbol, upper case
    "asset_class",     # Stock | ETF | Crypto
    "sector",          # our own grouping (see STOCKS / COINS)
    "price_usd",       # last price, USD
    "change_pct",      # source-reported change, % (stocks: vs previous close; crypto: last 24 h)
    "day_high_usd",    # high of the session (stocks) or of the last 24 h (crypto), USD
    "day_low_usd",     # low of the session (stocks) or of the last 24 h (crypto), USD
    "volume_usd",      # traded value, USD (stocks: shares x price; crypto: 24 h volume)
    "market_cap_usd",  # crypto only, USD
    "high_52w_usd",    # stocks only, 52-week high, USD
    "low_52w_usd",     # stocks only, 52-week low, USD
    "quote_time",      # UTC time the source stamped on the quote
]

NUMERIC_COLUMNS = [
    "price_usd", "change_pct", "day_high_usd", "day_low_usd",
    "volume_usd", "market_cap_usd", "high_52w_usd", "low_52w_usd",
]

# symbol -> (asset_class, sector). TSN and WMT are Arkansas companies.
STOCKS: dict[str, tuple[str, str]] = {
    "AAPL": ("Stock", "Technology"),
    "MSFT": ("Stock", "Technology"),
    "NVDA": ("Stock", "Technology"),
    "GOOGL": ("Stock", "Communication"),
    "META": ("Stock", "Communication"),
    "AMZN": ("Stock", "Consumer"),
    "TSLA": ("Stock", "Consumer"),
    "WMT": ("Stock", "Consumer"),
    "TSN": ("Stock", "Consumer"),
    "KO": ("Stock", "Consumer"),
    "JPM": ("Stock", "Financials"),
    "GS": ("Stock", "Financials"),
    "BAC": ("Stock", "Financials"),
    "V": ("Stock", "Financials"),
    "XOM": ("Stock", "Energy"),
    "SPY": ("ETF", "Index fund"),
    "QQQ": ("ETF", "Index fund"),
    "DIA": ("ETF", "Index fund"),
    "IWM": ("ETF", "Index fund"),
    "TLT": ("ETF", "Bond fund"),
}

# CoinGecko id -> sector
COINS: dict[str, str] = {
    "bitcoin": "Store of value",
    "litecoin": "Store of value",
    "bitcoin-cash": "Store of value",
    "ethereum": "Smart-contract platform",
    "solana": "Smart-contract platform",
    "cardano": "Smart-contract platform",
    "avalanche-2": "Smart-contract platform",
    "polkadot": "Smart-contract platform",
    "tron": "Smart-contract platform",
    "binancecoin": "Exchange token",
    "ripple": "Payments",
    "stellar": "Payments",
    "dogecoin": "Meme",
    "chainlink": "DeFi",
    "uniswap": "DeFi",
}

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; data-tracker/1.0)", "Accept": "application/json"}


class SourceError(RuntimeError):
    pass


def _get(urls: list[str], params: dict, tries: int = 3) -> bytes:
    """GET the first URL that answers 200, retrying with backoff."""
    last = ""
    for attempt in range(tries):
        for url in urls:
            try:
                resp = requests.get(url, params=params, headers=HEADERS, timeout=30)
                if resp.status_code == 200 and resp.content:
                    return resp.content
                last = f"{url}: HTTP {resp.status_code}"
            except requests.RequestException as exc:
                last = f"{url}: {type(exc).__name__}: {exc}"
        time.sleep(3 * (attempt + 1))
    raise SourceError(last)


def _num(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return x if x == x else None  # drop NaN


def _round(value, digits: int):
    x = _num(value)
    if x is None:
        return None
    x = round(x, digits)
    return int(x) if digits == 0 else x


def _utc(ts) -> str:
    if ts in (None, ""):
        return ""
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # CoinGecko: "2026-11-24T15:12:01.123Z"
    return str(ts).split(".")[0].rstrip("Z") + "Z"


# --------------------------------------------------------------------------- Yahoo Finance

YAHOO_URLS = [
    "https://query1.finance.yahoo.com/v7/finance/spark",
    "https://query2.finance.yahoo.com/v7/finance/spark",
]


def fetch_yahoo() -> bytes:
    return _get(YAHOO_URLS, {"symbols": ",".join(STOCKS), "range": "1d", "interval": "1d"})


def convert_yahoo(raw: bytes, date: str) -> list[dict]:
    doc = json.loads(raw)
    rows = []
    for result in (doc.get("spark") or {}).get("result") or []:
        symbol = (result.get("symbol") or "").upper()
        if symbol not in STOCKS or not result.get("response"):
            continue
        meta = result["response"][0].get("meta") or {}
        price = _num(meta.get("regularMarketPrice"))
        if price is None:
            continue
        prev = _num(meta.get("chartPreviousClose")) or _num(meta.get("previousClose"))
        change = meta.get("regularMarketChangePercent")
        if change is None and prev:
            change = (price - prev) / prev * 100
        volume = _num(meta.get("regularMarketVolume"))
        asset_class, sector = STOCKS[symbol]
        rows.append({
            "date": date,
            "item_id": f"yahoo:{symbol}",
            "item": meta.get("shortName") or meta.get("longName") or symbol,
            "source": "yahoo",
            "symbol": symbol,
            "asset_class": asset_class,
            "sector": sector,
            "price_usd": _round(price, 4),
            "change_pct": _round(change, 4),
            "day_high_usd": _round(meta.get("regularMarketDayHigh"), 4),
            "day_low_usd": _round(meta.get("regularMarketDayLow"), 4),
            "volume_usd": _round(volume * price, 0) if volume is not None else None,
            "market_cap_usd": None,
            "high_52w_usd": _round(meta.get("fiftyTwoWeekHigh"), 4),
            "low_52w_usd": _round(meta.get("fiftyTwoWeekLow"), 4),
            "quote_time": _utc(meta.get("regularMarketTime")),
        })
    return rows


# --------------------------------------------------------------------------- CoinGecko

COINGECKO_URLS = ["https://api.coingecko.com/api/v3/coins/markets"]


def fetch_coingecko() -> bytes:
    return _get(COINGECKO_URLS, {
        "vs_currency": "usd",
        "ids": ",".join(COINS),
        "order": "market_cap_desc",
        "per_page": 250,
        "page": 1,
        "price_change_percentage": "24h",
    })


def convert_coingecko(raw: bytes, date: str) -> list[dict]:
    rows = []
    for coin in json.loads(raw):
        cid = coin.get("id")
        if cid not in COINS or _num(coin.get("current_price")) is None:
            continue
        rows.append({
            "date": date,
            "item_id": f"coingecko:{cid}",
            "item": coin.get("name") or cid,
            "source": "coingecko",
            "symbol": (coin.get("symbol") or "").upper(),
            "asset_class": "Crypto",
            "sector": COINS[cid],
            "price_usd": _round(coin.get("current_price"), 8),
            "change_pct": _round(coin.get("price_change_percentage_24h"), 4),
            "day_high_usd": _round(coin.get("high_24h"), 8),
            "day_low_usd": _round(coin.get("low_24h"), 8),
            "volume_usd": _round(coin.get("total_volume"), 0),
            "market_cap_usd": _round(coin.get("market_cap"), 0),
            "high_52w_usd": None,
            "low_52w_usd": None,
            "quote_time": _utc(coin.get("last_updated")),
        })
    return rows


# --------------------------------------------------------------------------- registry

SOURCES = {
    # name: (format of the raw reply, fetch, convert)
    "coingecko": ("json", fetch_coingecko, convert_coingecko),
    "yahoo": ("json", fetch_yahoo, convert_yahoo),
}


def convert(source: str, raw: bytes, date: str) -> list[dict]:
    rows = SOURCES[source][2](raw, date)
    return sorted(rows, key=lambda r: r["item_id"])
