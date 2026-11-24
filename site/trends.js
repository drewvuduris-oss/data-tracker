/* Trends page: a chart of every numeric value over the days, and six findings
 * computed in the browser from data/history.csv.
 *
 * Definitions (all from history.csv; "move" is the same rule as the daily issue):
 *  move        for an item on day d: (price_d - price_prev) / price_prev * 100, where
 *              price_prev is the item's latest earlier row with a price
 *  1 return    per item: (last price / first price - 1) * 100, first and last rows with a price
 *  2 active    per day after the first: mean |move| over all items with a move that day,
 *              and separately over crypto and over stocks & ETFs
 *  3 volatile  per item: mean |move| over all of its days with a move
 *  4 spread    per day: largest move minus smallest move
 *  5 dominance per day: Bitcoin market_cap_usd / sum of market_cap_usd over crypto rows * 100
 *  6 52-week   latest row per stock/ETF: (price - low_52w) / (high_52w - low_52w) * 100
 */
(async function () {
  "use strict";
  const { esc, money, signed, shortDate, cssVar, mean, formatValue, LABELS, NUMERIC } = DT;
  const $ = id => document.getElementById(id);

  let rows;
  try {
    rows = await DT.loadHistory();
  } catch (err) {
    DT.showError(err);
    return;
  }
  if (!rows.length) {
    $("sections").innerHTML = '<div class="empty">The history is empty: the first run has not happened yet.</div>';
    return;
  }

  const days = DT.dates(rows);
  const first = days[0], last = days[days.length - 1];
  const itemsById = new Map();
  for (const r of rows) itemsById.set(r.item_id, r);  // rows are sorted by date: the latest row wins
  const items = [...itemsById.values()].sort((a, b) => a.asset_class.localeCompare(b.asset_class) || a.item.localeCompare(b.item));
  const name = id => itemsById.get(id)?.item ?? id;
  const isCrypto = id => itemsById.get(id)?.asset_class === "Crypto";
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  $("intro").insertAdjacentHTML("beforeend",
    ` The history covers <strong>${plural(days.length, "day")}</strong> (${first} to ${last}), <strong>${items.length}</strong> items and <strong>${rows.length.toLocaleString()}</strong> rows.`);

  // moves for every day after the first
  const movesByDay = new Map(days.slice(1).map(d => [d, DT.movesOn(rows, d).filter(m => m.move_pct != null)]));
  const moveDays = days.slice(1);

  // ------------------------------------------------------------------ chart setup
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = cssVar("--text-2");
  Chart.defaults.borderColor = cssVar("--grid");
  Chart.defaults.plugins.legend.display = false;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.animation = false;
  Chart.defaults.plugins.tooltip.mode = "index";
  Chart.defaults.plugins.tooltip.intersect = false;

  const SERIES = [1, 2, 3, 4, 5, 6, 7, 8].map(i => cssVar(`--series-${i}`));
  const POS = cssVar("--pos"), NEG = cssVar("--neg");
  const C_STOCK = SERIES[0], C_CRYPTO = SERIES[1];
  const grid = { color: cssVar("--grid") };
  const bar = color => ({ backgroundColor: color, hoverBackgroundColor: color, borderRadius: 4, borderSkipped: "start", maxBarThickness: 28 });
  const line = color => ({ borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, tension: 0, spanGaps: true });
  const pctAxis = title => ({ title: { display: true, text: title }, grid, ticks: { callback: v => `${v}%` } });

  function htmlTable(headers, data) {
    return `<table><thead><tr>${headers.map((h, i) => `<th${i ? ' class="r"' : ""}>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${data.map(r => `<tr>${r.map((c, i) => `<td${i ? ' class="r"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }
  const legendHtml = entries => entries.map(([label, color]) => `<span><span class="key" style="background:${color}"></span>${esc(label)}</span>`).join("");

  let n = 0;
  function section({ heading, text, table, empty, legend, tall }) {
    n += 1;
    const el = document.createElement("section");
    el.className = "card finding";
    el.innerHTML = `
      <div class="kicker">Finding ${n}</div>
      <h2>${heading}</h2>
      <p>${text}</p>
      ${empty ? `<div class="empty">${empty}</div>` : `
        ${legend ? `<div class="legend">${legendHtml(legend)}</div>` : ""}
        <div class="chart-box${tall ? " tall" : ""}"><canvas role="img" aria-label="${esc(heading.replace(/<[^>]+>/g, ""))}"></canvas></div>
        <details class="data"><summary>Show the numbers</summary><div class="table-wrap">${table}</div></details>`}`;
    $("sections").appendChild(el);
    return el.querySelector("canvas");
  }
  const NEED_TWO = "This finding needs at least two runs. It fills in after the second day.";
  const f2 = x => (x == null ? "–" : x.toFixed(2));

  // ------------------------------------------------------------------ explorer: each value over the days
  {
    const sel = $("metric");
    sel.add(new Option("Price, indexed to 100 on the item's first day", "price_index"));
    for (const k of NUMERIC) sel.add(new Option(LABELS[k], k));
    const byItem = new Map();
    for (const r of rows) {
      if (!byItem.has(r.item_id)) byItem.set(r.item_id, new Map());
      byItem.get(r.item_id).set(r.date, r);
    }
    const base = new Map();
    for (const [id, m] of byItem) {
      const firstRow = [...m.values()].find(r => r.price_usd);
      if (firstRow) base.set(id, firstRow.price_usd);
    }
    const value = (id, d, metric) => {
      const r = byItem.get(id).get(d);
      if (!r) return null;
      if (metric === "price_index") return r.price_usd != null && base.get(id) ? r.price_usd / base.get(id) * 100 : null;
      return r[metric];
    };

    const MAX = 8;
    const slots = new Map();  // item_id -> palette slot; an item keeps its color while it stays picked
    const pick = id => {
      if (slots.has(id) || slots.size >= MAX || !byItem.has(id)) return;
      const used = new Set(slots.values());
      slots.set(id, [...Array(MAX).keys()].find(i => !used.has(i)));
    };
    ["coingecko:bitcoin", "coingecko:ethereum", "yahoo:SPY", "yahoo:NVDA", "yahoo:TSN"].forEach(pick);

    const chart = new Chart($("explorer-chart"), {
      type: "line",
      data: { labels: days.map(shortDate), datasets: [] },
      options: {
        interaction: { mode: "index", intersect: false },
        scales: { x: { grid: { display: false } }, y: { grid } },
        plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmtMetric(c.parsed.y)}` } } },
      },
    });
    const fmtMetric = v => (v == null ? "–" : sel.value === "price_index" ? v.toFixed(1) : formatValue(sel.value, v));

    function draw() {
      const metric = sel.value;
      const picked = [...slots.entries()];
      chart.data.datasets = picked.map(([id, slot]) => ({
        label: name(id), data: days.map(d => value(id, d, metric)), ...line(SERIES[slot]),
      }));
      chart.options.scales.y.title = { display: true, text: metric === "price_index" ? "Index (first day = 100)" : LABELS[metric] };
      chart.options.scales.y.ticks = { callback: v => (metric === "price_index" ? v : formatValue(metric, v)) };
      chart.update();

      $("chips").innerHTML = items.map(r => {
        const on = slots.has(r.item_id);
        return `<button type="button" class="chip" data-id="${esc(r.item_id)}" aria-pressed="${on}" ${!on && slots.size >= MAX ? "disabled" : ""}>` +
          `<span class="key" style="background:${on ? SERIES[slots.get(r.item_id)] : "transparent"}"></span>${esc(r.symbol)}</button>`;
      }).join("");
      $("chips").querySelectorAll(".chip").forEach(b => b.addEventListener("click", () => {
        const id = b.dataset.id;
        if (slots.has(id)) slots.delete(id); else pick(id);
        draw();
      }));
      $("legend").innerHTML = picked.length ? legendHtml(picked.map(([id, slot]) => [name(id), SERIES[slot]])) : '<span class="muted">Pick an item below the menus.</span>';
      $("picker-help").textContent = `Pick up to ${MAX} items to show (${slots.size} picked). Each item keeps its color while it stays picked.`;
      $("explorer-table").innerHTML = htmlTable(["Date", ...picked.map(([id]) => name(id))],
        days.map(d => [d, ...picked.map(([id]) => fmtMetric(value(id, d, metric)))]));
    }
    sel.addEventListener("input", draw);
    $("preset").addEventListener("input", e => {
      const v = e.target.value;
      if (!v) return;
      slots.clear();
      const saved = DT.shortlist.all();
      items.filter(r => (v === "__starred" ? r.item_id in saved : r.asset_class === v)).forEach(r => pick(r.item_id));
      e.target.value = "";
      draw();
    });
    $("clear").addEventListener("click", () => { slots.clear(); draw(); });
    draw();
  }

  // ------------------------------------------------------------------ 1. return since the first run
  {
    const firstRow = new Map(), lastRow = new Map();
    for (const r of rows) {
      if (r.price_usd == null) continue;
      if (!firstRow.has(r.item_id)) firstRow.set(r.item_id, r);
      lastRow.set(r.item_id, r);
    }
    const ret = [...firstRow.keys()]
      .filter(id => lastRow.get(id).date > firstRow.get(id).date)
      .map(id => ({ id, a: firstRow.get(id), b: lastRow.get(id), pct: (lastRow.get(id).price_usd / firstRow.get(id).price_usd - 1) * 100 }))
      .sort((x, y) => y.pct - x.pct);
    if (!ret.length) {
      section({ heading: "Return since the first run", text: "The change in each item's price from its first row to its latest row.", empty: NEED_TWO });
    } else {
      const best = ret[0], worst = ret[ret.length - 1];
      const up = ret.filter(x => x.pct > 0).length;
      const cv = section({
        heading: `${esc(name(best.id))} rose the most since the first run (${signed(best.pct)}); ${esc(name(worst.id))} fell the most (${signed(worst.pct)})`,
        text: `For each item, the return is its latest price divided by its first price in the history, minus one. ` +
          `${esc(name(best.id))} went from ${money(best.a.price_usd)} on ${best.a.date} to ${money(best.b.price_usd)} on ${best.b.date}; ` +
          `${esc(name(worst.id))} went from ${money(worst.a.price_usd)} to ${money(worst.b.price_usd)}. ` +
          `${up} of ${ret.length} items are up, and the median return is ${signed(DT.median(ret.map(x => x.pct)))}.`,
        table: htmlTable(["Item", "First date", "First price", "Latest date", "Latest price", "Return"],
          ret.map(x => [name(x.id), x.a.date, money(x.a.price_usd), x.b.date, money(x.b.price_usd), signed(x.pct)])),
        legend: [["Up", POS], ["Down", NEG]],
        tall: true,
      });
      new Chart(cv, {
        type: "bar",
        data: { labels: ret.map(x => itemsById.get(x.id).symbol), datasets: [{
          label: "Return since first run", data: ret.map(x => x.pct), ...bar(POS),
          backgroundColor: ret.map(x => (x.pct >= 0 ? POS : NEG)), hoverBackgroundColor: ret.map(x => (x.pct >= 0 ? POS : NEG)),
        }] },
        options: {
          indexAxis: "y",
          scales: { x: pctAxis("Return since first run (%)"), y: { grid: { display: false }, ticks: { autoSkip: false, font: { size: 11 } } } },
          plugins: { tooltip: { callbacks: { title: c => name(ret[c[0].dataIndex].id), label: c => signed(c.parsed.x) } } },
        },
      });
    }
  }

  // ------------------------------------------------------------------ 2. the most active day
  {
    const stats = moveDays.map(d => {
      const ms = movesByDay.get(d);
      const abs = ms => mean(ms.map(m => Math.abs(m.move_pct)));
      return { d, all: abs(ms), crypto: abs(ms.filter(m => isCrypto(m.row.item_id))), stock: abs(ms.filter(m => !isCrypto(m.row.item_id))), n: ms.length };
    }).filter(s => s.n);
    if (!stats.length) {
      section({ heading: "The most active day", text: "The average size of the day's moves, across all items.", empty: NEED_TWO });
    } else {
      const top = stats.reduce((a, b) => (b.all > a.all ? b : a));
      const cv = section({
        heading: `${shortDate(top.d)} was the most active day: the average item moved ${top.all.toFixed(2)}%`,
        text: `For each day after the first, this is the mean of the absolute moves (|move|) of every item that has a move that day, ` +
          `where a move is the percent change from the item's previous row. On ${top.d}, crypto moved ${top.crypto == null ? "n/a (no crypto rows)" : f2(top.crypto) + "%"} on average and stocks & ETFs ${top.stock == null ? "n/a (no stock rows that day)" : f2(top.stock) + "%"}. ` +
          `Across all ${plural(stats.length, "day")}, the average day saw a ${mean(stats.map(s => s.all)).toFixed(2)}% move. ` +
          `Stock prices do not change on weekends and market holidays, so those days pull the stock average down.`,
        table: htmlTable(["Day", "All items (%)", "Crypto (%)", "Stocks & ETFs (%)", "Items"],
          stats.map(s => [s.d, f2(s.all), f2(s.crypto), f2(s.stock), s.n])),
        legend: [["Stocks & ETFs", C_STOCK], ["Crypto", C_CRYPTO]],
      });
      new Chart(cv, {
        type: "bar",
        data: { labels: stats.map(s => shortDate(s.d)), datasets: [
          { label: "Stocks & ETFs", data: stats.map(s => s.stock), ...bar(C_STOCK) },
          { label: "Crypto", data: stats.map(s => s.crypto), ...bar(C_CRYPTO) },
        ] },
        options: {
          scales: { x: { grid: { display: false } }, y: { ...pctAxis("Mean |move| (%)"), beginAtZero: true } },
          plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${f2(c.parsed.y)}%` } } },
        },
      });
    }
  }

  // ------------------------------------------------------------------ 3. which items move the most
  {
    const per = new Map();
    for (const ms of movesByDay.values()) for (const m of ms) {
      if (!per.has(m.row.item_id)) per.set(m.row.item_id, []);
      per.get(m.row.item_id).push(Math.abs(m.move_pct));
    }
    const vol = [...per.entries()].map(([id, xs]) => ({ id, v: mean(xs), n: xs.length })).sort((a, b) => b.v - a.v);
    if (!vol.length) {
      section({ heading: "Which items move the most", text: "Each item's average absolute move per run.", empty: NEED_TWO });
    } else {
      const c = mean(vol.filter(x => isCrypto(x.id)).map(x => x.v)), s = mean(vol.filter(x => !isCrypto(x.id)).map(x => x.v));
      const ratio = c != null && s ? c / s : null;
      const cv = section({
        heading: ratio
          ? `Crypto moves ${ratio.toFixed(1)}× as much as stocks and ETFs: ${c.toFixed(2)}% a run against ${s.toFixed(2)}%`
          : `${esc(name(vol[0].id))} moves the most: ${vol[0].v.toFixed(2)}% a run`,
        text: `For each item, this is the mean of its absolute moves over every day it has a move. The crypto and stock & ETF figures are the averages of those item means. ` +
          `The most volatile item is ${esc(name(vol[0].id))} (${vol[0].v.toFixed(2)}% over ${plural(vol[0].n, "move")}); ` +
          `the calmest is ${esc(name(vol[vol.length - 1].id))} (${vol[vol.length - 1].v.toFixed(2)}%).`,
        table: htmlTable(["Item", "Class", "Mean |move| (%)", "Moves"], vol.map(x => [name(x.id), itemsById.get(x.id).asset_class, f2(x.v), x.n])),
        legend: [["Stocks & ETFs", C_STOCK], ["Crypto", C_CRYPTO]],
        tall: true,
      });
      const colors = vol.map(x => (isCrypto(x.id) ? C_CRYPTO : C_STOCK));
      new Chart(cv, {
        type: "bar",
        data: { labels: vol.map(x => itemsById.get(x.id).symbol), datasets: [{ label: "Mean |move|", data: vol.map(x => x.v), ...bar(C_STOCK), backgroundColor: colors, hoverBackgroundColor: colors }] },
        options: {
          indexAxis: "y",
          scales: { x: { ...pctAxis("Mean |move| per run (%)"), beginAtZero: true }, y: { grid: { display: false }, ticks: { autoSkip: false, font: { size: 11 } } } },
          plugins: { tooltip: { callbacks: { title: c => name(vol[c[0].dataIndex].id), label: c => `${f2(c.parsed.x)}%` } } },
        },
      });
    }
  }

  // ------------------------------------------------------------------ 4. how far apart the items are
  {
    const spread = moveDays.map(d => {
      const ms = movesByDay.get(d);
      if (!ms.length) return null;
      const hi = ms.reduce((a, b) => (b.move_pct > a.move_pct ? b : a)), lo = ms.reduce((a, b) => (b.move_pct < a.move_pct ? b : a));
      return { d, hi, lo, gap: hi.move_pct - lo.move_pct };
    }).filter(Boolean);
    if (!spread.length) {
      section({ heading: "How far apart the items are", text: "The gap between the best and the worst move each day.", empty: NEED_TWO });
    } else {
      const w = spread.reduce((a, b) => (b.gap > a.gap ? b : a));
      const cv = section({
        heading: `The items were furthest apart on ${shortDate(w.d)}: a ${w.gap.toFixed(2)}-point gap between ${esc(w.hi.row.item)} and ${esc(w.lo.row.item)}`,
        text: `For each day after the first, the spread is the largest move minus the smallest move across all items. ` +
          `On ${w.d}, ${esc(w.hi.row.item)} moved ${signed(w.hi.move_pct)} and ${esc(w.lo.row.item)} moved ${signed(w.lo.move_pct)}. ` +
          `The median spread is ${DT.median(spread.map(s => s.gap)).toFixed(2)} points.`,
        table: htmlTable(["Day", "Best", "Best move", "Worst", "Worst move", "Spread (points)"],
          spread.map(s => [s.d, s.hi.row.item, signed(s.hi.move_pct), s.lo.row.item, signed(s.lo.move_pct), f2(s.gap)])),
      });
      new Chart(cv, {
        type: "line",
        data: { labels: spread.map(s => shortDate(s.d)), datasets: [{ label: "Spread", data: spread.map(s => s.gap), ...line(SERIES[0]) }] },
        options: {
          scales: { x: { grid: { display: false } }, y: { title: { display: true, text: "Best move − worst move (points)" }, grid, beginAtZero: true } },
          plugins: { tooltip: { callbacks: { label: c => { const s = spread[c.dataIndex]; return [`Spread: ${f2(s.gap)} points`, `Best: ${s.hi.row.item} ${signed(s.hi.move_pct)}`, `Worst: ${s.lo.row.item} ${signed(s.lo.move_pct)}`]; } } } },
        },
      });
    }
  }

  // ------------------------------------------------------------------ 5. Bitcoin's share of the crypto market cap
  {
    const dom = days.map(d => {
      const cr = rows.filter(r => r.date === d && r.asset_class === "Crypto" && r.market_cap_usd != null);
      const btc = cr.find(r => r.item_id === "coingecko:bitcoin");
      const total = cr.reduce((a, r) => a + r.market_cap_usd, 0);
      return btc && total ? { d, share: btc.market_cap_usd / total * 100, btc: btc.market_cap_usd, total, n: cr.length } : null;
    }).filter(Boolean);
    if (!dom.length) {
      section({ heading: "Bitcoin's share of the tracked crypto market", text: "Bitcoin's market cap as a share of the 15 tracked coins.", empty: "No crypto rows with a market cap yet." });
    } else {
      const a = dom[0], b = dom[dom.length - 1], diff = b.share - a.share;
      const cv = section({
        heading: `Bitcoin is ${b.share.toFixed(1)}% of the tracked crypto market cap` +
          (dom.length > 1 ? `, ${diff >= 0 ? "up" : "down"} ${Math.abs(diff).toFixed(2)} points since ${shortDate(a.d)}` : ""),
        text: `For each day, Bitcoin's market_cap_usd divided by the sum of market_cap_usd over all crypto rows that day. ` +
          `On ${b.d} that is ${DT.compact(b.btc)} of ${DT.compact(b.total)} across ${b.n} coins. ` +
          (dom.length > 1 ? `On ${a.d} it was ${a.share.toFixed(2)}%. A rising share means money is moving toward Bitcoin and away from the other coins.` : "The line grows as runs are added."),
        table: htmlTable(["Day", "Bitcoin market cap", "Tracked crypto market cap", "Bitcoin share (%)"], dom.map(x => [x.d, DT.compact(x.btc), DT.compact(x.total), f2(x.share)])),
      });
      new Chart(cv, {
        type: "line",
        data: { labels: dom.map(x => shortDate(x.d)), datasets: [{ label: "Bitcoin share", data: dom.map(x => x.share), ...line(SERIES[1]) }] },
        options: {
          scales: { x: { grid: { display: false } }, y: pctAxis("Bitcoin share of tracked crypto market cap (%)") },
          plugins: { tooltip: { callbacks: { label: c => `Bitcoin share: ${f2(c.parsed.y)}%` } } },
        },
      });
    }
  }

  // ------------------------------------------------------------------ 6. where stocks sit in their 52-week range
  {
    const pos = items
      .filter(r => r.date === last && r.price_usd != null && r.high_52w_usd != null && r.low_52w_usd != null && r.high_52w_usd > r.low_52w_usd)
      .map(r => ({ r, p: (r.price_usd - r.low_52w_usd) / (r.high_52w_usd - r.low_52w_usd) * 100 }))
      .sort((a, b) => b.p - a.p);
    if (!pos.length) {
      section({ heading: "Where stocks sit in their 52-week range", text: "Price relative to the 52-week low and high.", empty: "No stock or ETF rows on the latest day." });
    } else {
      const hi = pos[0], lo = pos[pos.length - 1];
      const cv = section({
        heading: `${esc(hi.r.item)} trades closest to its 52-week high (${hi.p.toFixed(0)}% of its range); ${esc(lo.r.item)} sits closest to its low (${lo.p.toFixed(0)}%)`,
        text: `For each stock and ETF on the latest day (${last}), the position is (price − 52-week low) ÷ (52-week high − 52-week low) × 100: 0% is the low and 100% the high. ` +
          `${esc(hi.r.item)} is at ${money(hi.r.price_usd)} in a ${money(hi.r.low_52w_usd)}–${money(hi.r.high_52w_usd)} range; ` +
          `${esc(lo.r.item)} is at ${money(lo.r.price_usd)} in a ${money(lo.r.low_52w_usd)}–${money(lo.r.high_52w_usd)} range. ` +
          `${pos.filter(x => x.p >= 50).length} of ${pos.length} sit in the upper half of their range.`,
        table: htmlTable(["Item", "Price", "52-week low", "52-week high", "Position (%)"],
          pos.map(x => [x.r.item, money(x.r.price_usd), money(x.r.low_52w_usd), money(x.r.high_52w_usd), x.p.toFixed(1)])),
        tall: true,
      });
      new Chart(cv, {
        type: "bar",
        data: { labels: pos.map(x => x.r.symbol), datasets: [{ label: "Position in 52-week range", data: pos.map(x => x.p), ...bar(SERIES[0]) }] },
        options: {
          indexAxis: "y",
          scales: { x: { ...pctAxis("Position in 52-week range (0% = low, 100% = high)"), min: 0, max: 100 }, y: { grid: { display: false }, ticks: { autoSkip: false, font: { size: 11 } } } },
          plugins: { tooltip: { callbacks: { title: c => pos[c[0].dataIndex].r.item, label: c => `${c.parsed.x.toFixed(1)}% of range` } } },
        },
      });
    }
  }
})();
