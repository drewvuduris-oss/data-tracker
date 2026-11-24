/* Shared by every page: navigation bar, data loading, the move rule, formatting,
 * the shortlist, and the service worker. */
(function () {
  "use strict";

  const PAGES = [
    { href: "index.html", label: "Today" },
    { href: "browse.html", label: "Browse" },
    { href: "trends.html", label: "Trends" },
  ];

  const NUMERIC = [
    "price_usd", "change_pct", "day_high_usd", "day_low_usd",
    "volume_usd", "market_cap_usd", "high_52w_usd", "low_52w_usd",
  ];
  const LABELS = {
    price_usd: "Price (USD)", change_pct: "Source change (%)", day_high_usd: "Day high (USD)",
    day_low_usd: "Day low (USD)", volume_usd: "Volume (USD)", market_cap_usd: "Market cap (USD)",
    high_52w_usd: "52-week high (USD)", low_52w_usd: "52-week low (USD)",
  };

  function renderNav() {
    const here = location.pathname.split("/").pop() || "index.html";
    const nav = document.createElement("nav");
    nav.className = "nav";
    nav.innerHTML = `
      <div class="nav-inner">
        <a class="brand" href="index.html"><img src="icons/icon.svg" alt=""><span>Data Tracker</span></a>
        <div class="nav-links">
          ${PAGES.map(p => `<a href="${p.href}"${p.href === here ? ' aria-current="page"' : ""}>${p.label}</a>`).join("")}
        </div>
        <div class="nav-status" id="net-status"></div>
      </div>`;
    document.body.prepend(nav);
    const status = nav.querySelector("#net-status");
    const update = () => {
      status.textContent = navigator.onLine ? "" : "Offline – showing saved data";
      status.classList.toggle("offline", !navigator.onLine);
    };
    addEventListener("online", update);
    addEventListener("offline", update);
    update();
  }

  // ------------------------------------------------------------------ data
  async function fetchText(path) {
    // The service worker answers from the network when online and from its cache offline.
    const resp = await fetch(path, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
    return resp.text();
  }

  async function loadStatus() {
    return JSON.parse(await fetchText("data/status.json"));
  }

  /** data/history.csv with numeric columns as numbers (empty cell -> null). */
  async function loadHistory() {
    const text = await fetchText("data/history.csv");
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    return parsed.data.map(r => {
      for (const c of NUMERIC) r[c] = r[c] === "" || r[c] == null ? null : Number(r[c]);
      return r;
    });
  }

  const dates = rows => [...new Set(rows.map(r => r.date))].sort();
  const lastDate = rows => rows.reduce((m, r) => (r.date > m ? r.date : m), "");

  // ------------------------------------------------------------------ move rule (same as tracker/moves.py)
  /** For every item on `date`: its previous row (latest earlier row with a price) and
   *  move_pct = (new - old) / old * 100. Sorted by |move_pct| desc, then item_id. */
  function movesOn(rows, date) {
    const prev = new Map();
    for (const r of rows) {
      if (r.date < date && r.price_usd != null) {
        const p = prev.get(r.item_id);
        if (!p || r.date > p.date) prev.set(r.item_id, r);
      }
    }
    const out = [];
    for (const r of rows) {
      if (r.date !== date) continue;
      const p = prev.get(r.item_id);
      const move = p && r.price_usd != null && p.price_usd !== 0 ? (r.price_usd - p.price_usd) / p.price_usd * 100 : null;
      out.push({ row: r, prev: p || null, move_pct: move });
    }
    return out.sort((a, b) =>
      (b.move_pct == null ? -1 : Math.abs(b.move_pct)) - (a.move_pct == null ? -1 : Math.abs(a.move_pct)) ||
      (a.row.item_id < b.row.item_id ? -1 : 1));
  }

  // ------------------------------------------------------------------ formatting
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function money(x) {
    if (x == null) return "–";
    const a = Math.abs(x);
    const digits = a >= 100 ? 2 : a >= 1 ? 4 : 6;
    return "$" + x.toLocaleString("en-US", { minimumFractionDigits: a >= 100 ? 2 : 0, maximumFractionDigits: digits });
  }
  function compact(x) {
    if (x == null) return "–";
    return "$" + Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(x);
  }
  const signed = (x, d = 2) => (x == null ? "–" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(d)}%`);
  const dirClass = x => (x == null || x === 0 ? "flat" : x > 0 ? "up" : "down");
  const arrow = x => (x == null || x === 0 ? "" : x > 0 ? "▲ " : "▼ ");
  function formatValue(col, x) {
    if (col === "change_pct") return signed(x);
    if (col === "volume_usd" || col === "market_cap_usd") return compact(x);
    return money(x);
  }
  const shortDate = d => new Date(d + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const when = iso => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // ------------------------------------------------------------------ stats
  const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  function stdev(xs) {  // sample standard deviation
    if (xs.length < 2) return null;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  }
  const median = xs => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  function showError(err) {
    console.error(err);
    const div = document.createElement("div");
    div.className = "banner";
    div.textContent = `Could not load the data (${err.message}). If you are offline, open this page once while online so it can be saved.`;
    document.querySelector("main").prepend(div);
  }

  // ------------------------------------------------------------------ shortlist (localStorage)
  const SHORTLIST_KEY = "datatracker.shortlist";
  const shortlist = {
    all() {
      try { return JSON.parse(localStorage.getItem(SHORTLIST_KEY)) || {}; } catch { return {}; }
    },
    has(id) { return id in this.all(); },
    toggle(row) {
      const all = this.all();
      if (row.item_id in all) delete all[row.item_id];
      else all[row.item_id] = { item: row.item, symbol: row.symbol, saved: new Date().toISOString() };
      try { localStorage.setItem(SHORTLIST_KEY, JSON.stringify(all)); } catch { /* storage blocked */ }
      return row.item_id in all;
    },
  };

  // ------------------------------------------------------------------ service worker
  if ("serviceWorker" in navigator) {
    addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW", e)));
  }
  document.addEventListener("DOMContentLoaded", renderNav);

  window.DT = {
    NUMERIC, LABELS, loadStatus, loadHistory, dates, lastDate, movesOn,
    esc, money, compact, signed, dirClass, arrow, formatValue, shortDate, when, cssVar,
    mean, stdev, median, showError, shortlist,
  };
})();
