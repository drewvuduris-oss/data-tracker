# Data Tracker

[![Tests](https://github.com/drewvuduris-oss/data-tracker/actions/workflows/tests.yml/badge.svg)](https://github.com/drewvuduris-oss/data-tracker/actions/workflows/tests.yml)
[![Daily run](https://github.com/drewvuduris-oss/data-tracker/actions/workflows/daily.yml/badge.svg)](https://github.com/drewvuduris-oss/data-tracker/actions/workflows/daily.yml)

A tool that tracks **market prices for 35 items**: 15 stocks, 5 ETFs and 15 cryptocurrencies.
Once a day GitHub Actions downloads the latest quotes, adds them to a history with one row
per item per day, opens a GitHub Issue listing what moved the most, and publishes the result
to a website.

**Site:** https://drewvuduris-oss.github.io/data-tracker/

## Sources

Both sources are public JSON endpoints that need no login and no API key.

| Source | Format | Raw file | Endpoint | What is requested and kept |
|---|---|---|---|---|
| `yahoo` | JSON | `data/raw/<date>/yahoo.json.gz` | `query1.finance.yahoo.com/v7/finance/spark` (falls back to `query2`) | Only the 20 tracked tickers are requested (`symbols=AAPL,MSFT,…`, `range=1d`). From each quote the build keeps the last price, change %, day high/low, volume, 52-week high/low and quote time. |
| `coingecko` | JSON | `data/raw/<date>/coingecko.json.gz` | `api.coingecko.com/api/v3/coins/markets` | Only the 15 tracked coins are requested (`ids=bitcoin,ethereum,…`, `vs_currency=usd`). From each coin the build keeps price, 24 h change %, 24 h high/low, 24 h volume, market cap and last-updated time. |

The raw file is the reply exactly as it arrived, gzipped. Anything in a reply that is not a
tracked item is ignored by the build.

**Tracked items** (the lists live in `tracker/sources.py`, with our own sector labels):

* **Stocks (15):** AAPL, MSFT, NVDA, GOOGL, META, AMZN, TSLA, WMT, TSN, KO, JPM, GS, BAC, V, XOM
  (Walmart and Tyson Foods are Arkansas companies)
* **ETFs (5):** SPY, QQQ, DIA, IWM (stock index funds), TLT (20+ year Treasury bond fund)
* **Crypto (15):** Bitcoin, Ethereum, Solana, XRP, BNB, Cardano, Dogecoin, TRON, Chainlink,
  Avalanche, Litecoin, Polkadot, Bitcoin Cash, Stellar, Uniswap

Stock and ETF prices do not change on weekends and US market holidays; crypto trades every day.
The daily run is at 21:40 UTC, after the 21:00 UTC US market close (4 p.m. Eastern, standard time),
so stock rows hold the day's closing price.

## History file: `data/history.csv`

One row per item per day, sorted by `date`, then `item_id`. A value a source does not report
for an item is left empty.

| Column | Meaning | Unit |
|---|---|---|
| `date` | UTC date of the run that fetched the row | `YYYY-MM-DD` |
| `item_id` | Key that identifies the item from day to day: `<source>:<ticker or coin id>`, e.g. `yahoo:AAPL`, `coingecko:bitcoin` | text |
| `item` | Item name as the source gives it | text |
| `source` | `yahoo` or `coingecko` | text |
| `symbol` | Ticker or coin symbol, upper case | text |
| `asset_class` | `Stock`, `ETF` or `Crypto` | text |
| `sector` | Our grouping: Technology, Communication, Consumer, Financials, Energy, Index fund, Bond fund; for crypto Store of value, Smart-contract platform, Payments, Exchange token, DeFi, Meme | text |
| `price_usd` | Last price (stocks: regular-market price; crypto: current price) | US dollars |
| `change_pct` | Change reported by the source: stocks vs. the previous close, crypto over the last 24 hours | percent |
| `day_high_usd` | Highest price of the session (stocks) or of the last 24 hours (crypto) | US dollars |
| `day_low_usd` | Lowest price of the session (stocks) or of the last 24 hours (crypto) | US dollars |
| `volume_usd` | Value traded: stocks = shares traded × price; crypto = 24-hour volume | US dollars |
| `market_cap_usd` | Market capitalization (crypto only; empty for stocks and ETFs) | US dollars |
| `high_52w_usd` | 52-week high (stocks and ETFs only; empty for crypto) | US dollars |
| `low_52w_usd` | 52-week low (stocks and ETFs only; empty for crypto) | US dollars |
| `quote_time` | Time the source stamped on the quote | UTC, ISO 8601 |

### Building the history from the raw files

```
uv run python -m tracker.history
```

The build reads nothing but `data/raw/`. Day by day, it converts each day's raw files into
one row per item with the columns above, then adds those rows to the history; a day with no
raw file for a source has no rows from that source. Running it again produces a
byte-identical file, and every daily run checks this (`cmp`) before committing.

## Status file: `data/status.json`

| Key | Meaning |
|---|---|
| `run_time` | UTC time of the latest run |
| `run_date` | UTC date of the latest run |
| `first_run_date` | Date of the earliest raw file |
| `days_with_success` | Number of different dates with a raw file |
| `items` | Number of items (history rows) on the latest run date |
| `new_today` | `item_id`s that appeared: in the latest run but not in the previous run date |
| `gone_today` | `item_id`s that disappeared: in the previous run date but not in the latest run |
| `sources` | One entry per source: `name`, `format`, `ok` (true/false), `count` (items converted), `error` |

## Move rule

For each item on the run date, the **move** is the percent change in `price_usd` from the
item's most recent earlier row in `data/history.csv` (normally the previous day; older if the
item was missing in between):

```
move_pct = (new price - old price) / old price * 100
```

Items are ranked by the **absolute** move, largest first (ties by `item_id`). The daily issue
lists the **top 10**, with old and new prices, plus every item that appeared or disappeared
since the previous run date. Items with no earlier row (the first run, or a newly added item)
have no move. The rule is in `tracker/moves.py`, and the site uses the same rule in `site/common.js`.

## Daily run

`.github/workflows/daily.yml` runs every day at 21:40 UTC (a backup at 23:50 UTC runs only if
the main one did not produce raw files that day). Each run:

1. Calls every source and saves its reply to `data/raw/<date>/<source>.json.gz`. A source
   that fails (network error, HTTP error, unusable reply) writes no raw file, and the run
   goes on. Every source's result is recorded in `data/runs/<date>.json` and in `status.json`.
2. Rebuilds `data/history.csv` from all raw files.
3. Writes `data/status.json`.
4. Opens a GitHub Issue titled with the date (label `daily-report`) listing the biggest moves
   and the items that appeared or disappeared, and closes the previous day's issue. The issue
   is opened every day, even when nothing changed.
5. Commits `data/` and deploys the site.

A second run on the same UTC day deletes that day's raw files before fetching, rebuilds the
history, and updates that day's issue instead of opening another, so each day counts once.

Run it locally (no issue is opened without `GITHUB_TOKEN`):

```
uv run python -m tracker.run --no-issue
```

## Site

The site is in `site/` and is published by GitHub Pages together with the two data files.
Each page loads `data/history.csv` and `data/status.json` in the browser and computes
everything there.

* **Today** (`index.html`): time of the last run, status of every source, counts from the
  status file, latest value of every item with its change since the previous run, and the
  10 biggest moves.
* **Browse** (`browse.html`): latest values with filters (asset class, sector, source,
  direction of change), a name search, sorting on every numeric column up and down, and a
  star on every item that saves it to a shortlist in `localStorage`.
* **Trends** (`trends.html`): a chart of every numeric value over the days with an item
  picker (or price indexed to 100), and six findings, each computed from the history:
  return since the first run, the most active day, which items move the most, how far apart
  the items are each day, Bitcoin's share of the tracked crypto market cap, and where each
  stock sits in its 52-week range. Each finding states how its numbers are computed and has
  a "Show the numbers" table.

The site is an installable app (`manifest.webmanifest` + `sw.js`). The service worker fetches
from the network first and saves a copy, so offline the site still opens with the last data it
loaded.

## Files

| Path | What it does |
|---|---|
| `tracker/sources.py` | Tracked tickers and coins, the two fetchers, and the conversion of each raw reply to the common columns |
| `tracker/history.py` | Raw-file read/write, the day-by-day history build, CSV writing; `python -m tracker.history` rebuilds the history |
| `tracker/moves.py` | The move rule, top-10 ranking, and appeared/gone items |
| `tracker/issues.py` | Builds the daily issue text and opens/updates/closes issues through the GitHub API |
| `tracker/run.py` | The daily pipeline: fetch, record results, build, status, issue |
| `tests/test_sources.py` | Conversion of each source to the common columns |
| `tests/test_moves.py` | The move rule and the issue text |
| `tests/test_history.py` | History build, reproducibility, a failed source, and a second run on the same day |
| `tests/fixtures/` | Saved real replies from both sources |
| `data/raw/<date>/` | Raw replies, gzipped, one file per source that answered that day |
| `data/runs/<date>.json` | The result of every source (ok or failed, with the error) for each run |
| `data/history.csv` | The history (one row per item per day) |
| `data/status.json` | Description of the latest run |
| `site/index.html`, `site/today.js` | Today page |
| `site/browse.html`, `site/browse.js` | Browse page |
| `site/trends.html`, `site/trends.js` | Trends page |
| `site/common.js` | Shared navigation bar, data loading, move rule, formatting and shortlist |
| `site/styles.css` | One set of fonts and colors for every page (light and dark) |
| `site/manifest.webmanifest`, `site/sw.js`, `site/icons/` | Web app manifest, service worker and icons |
| `site/vendor/` | Papa Parse (CSV parsing) and Chart.js (charts) |
| `.github/workflows/daily.yml` | Daily schedule: tests, pipeline, rebuild check, commit, deploy |
| `.github/workflows/tests.yml` | Runs the tests on every push |
| `.github/workflows/pages.yml` | Deploys `site/` plus the data files to GitHub Pages |
| `pyproject.toml`, `uv.lock`, `.python-version` | Python project and locked dependencies (managed by uv) |
| `.gitattributes` | LF line endings, so builds compare equal across operating systems |

## Development

```
uv sync
uv run pytest
```
