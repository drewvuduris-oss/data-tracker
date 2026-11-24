/* Today page: last run, source status, counts, latest values and biggest moves. */
(async function () {
  "use strict";
  const { esc, money, compact, signed, dirClass, arrow, when, shortDate } = DT;
  const $ = id => document.getElementById(id);

  let status, rows;
  try {
    [status, rows] = await Promise.all([DT.loadStatus(), DT.loadHistory()]);
  } catch (err) {
    DT.showError(err);
    return;
  }

  const date = DT.lastDate(rows);
  const okCount = status.sources.filter(s => s.ok).length;
  $("run-line").textContent = `Last run ${when(status.run_time)} (${status.run_time.replace("T", " ").replace("Z", " UTC")}). ` +
    `Values are for ${date || "–"}, compared with each item's previous row in the history.`;

  $("t-items").textContent = status.items;
  $("t-items-sub").textContent = "rows in the latest run";
  $("t-days").textContent = status.days_with_success;
  $("t-days-sub").textContent = status.first_run_date ? `since ${status.first_run_date}` : "";
  $("t-sources").textContent = `${okCount} / ${status.sources.length}`;
  $("t-sources-sub").textContent = okCount === status.sources.length ? "all sources answered" : "a source failed";
  $("t-new").textContent = status.new_today.length;
  $("t-gone").textContent = status.gone_today.length;
  $("t-new-sub").textContent = $("t-gone-sub").textContent = "vs the previous run";

  // sources
  $("sources").innerHTML = status.sources.map(s => `
    <tr>
      <td><strong>${esc(s.name)}</strong></td>
      <td><code>.${esc(s.format)}.gz</code></td>
      <td><span class="badge ${s.ok ? "ok" : "fail"}">${s.ok ? "✓ OK" : "✕ Failed"}</span></td>
      <td class="r">${s.count}</td>
      <td class="small muted">${esc(s.error)}</td>
    </tr>`).join("");
  $("sources-line").textContent = `${okCount} of ${status.sources.length} sources answered in the run of ${status.run_date}.`;

  const names = new Map(rows.map(r => [r.item_id, r.item]));
  const list = ids => ids.map(id => esc(names.get(id) || id)).join(", ");
  $("changes").innerHTML =
    `<strong>Appeared:</strong> ${status.new_today.length ? list(status.new_today) : "none"}<br>` +
    `<strong>Gone:</strong> ${status.gone_today.length ? list(status.gone_today) : "none"}`;

  // moves + latest values
  const moves = DT.movesOn(rows, date);
  const ranked = moves.filter(m => m.move_pct != null).slice(0, 10);
  $("moves").innerHTML = ranked.length ? ranked.map(m => `
    <li>
      <span><span class="item-name">${esc(m.row.item)}</span> <span class="item-sub">${esc(m.row.symbol)}</span><br>
        <span class="item-sub">${money(m.prev.price_usd)} (${shortDate(m.prev.date)}) → ${money(m.row.price_usd)}</span></span>
      <span class="pct ${dirClass(m.move_pct)}">${arrow(m.move_pct)}${signed(m.move_pct)}</span>
    </li>`).join("") : `<div class="empty">Only one run so far, so there is nothing to compare with yet.</div>`;

  $("latest-date").textContent = date ? `as of ${date}` : "";
  const byName = [...moves].sort((a, b) =>
    a.row.asset_class.localeCompare(b.row.asset_class) || a.row.item.localeCompare(b.row.item));
  $("latest").innerHTML = byName.map(m => `
    <tr>
      <td><span class="item-name">${esc(m.row.item)}</span> <span class="item-sub">${esc(m.row.symbol)}</span></td>
      <td><span class="tag">${esc(m.row.asset_class)}</span></td>
      <td class="r">${money(m.row.price_usd)}</td>
      <td class="r muted">${m.prev ? money(m.prev.price_usd) : "–"}</td>
      <td class="r ${dirClass(m.move_pct)}">${arrow(m.move_pct)}${signed(m.move_pct)}</td>
      <td class="r ${dirClass(m.row.change_pct)}">${signed(m.row.change_pct)}</td>
      <td class="r">${compact(m.row.volume_usd)}</td>
    </tr>`).join("");
})();
