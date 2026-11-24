/* Browse page: latest values with filters, name search, sort on every numeric column, and a shortlist. */
(async function () {
  "use strict";
  const { esc, formatValue, signed, dirClass, arrow, shortlist } = DT;
  const $ = id => document.getElementById(id);

  let rows;
  try {
    rows = await DT.loadHistory();
  } catch (err) {
    DT.showError(err);
    return;
  }

  const date = DT.lastDate(rows);
  // latest rows + change since previous run (move_pct) as an extra numeric column
  const items = DT.movesOn(rows, date).map(m => ({ ...m.row, move_pct: m.move_pct }));

  const COLS = [
    { key: "move_pct", label: "Change since prev. run" },
    ...DT.NUMERIC.map(k => ({ key: k, label: DT.LABELS[k] })),
  ];
  const fmt = (key, v) => (key === "move_pct" ? signed(v) : formatValue(key, v));

  const fill = (sel, key) => {
    for (const v of [...new Set(items.map(r => r[key]))].sort()) sel.add(new Option(v, v));
  };
  fill($("f-class"), "asset_class");
  fill($("f-sector"), "sector");
  fill($("f-source"), "source");

  let sort = { key: "volume_usd", dir: -1 };
  const params = new URLSearchParams(location.search);
  if (params.get("sort")) sort = { key: params.get("sort"), dir: params.get("dir") === "asc" ? 1 : -1 };

  function renderHead() {
    $("head").innerHTML = `<th aria-label="Shortlist"></th><th>Item</th><th>Class · sector</th>` + COLS.map(c => {
      const active = c.key === sort.key;
      const aria = active ? (sort.dir > 0 ? "ascending" : "descending") : "none";
      return `<th class="r sortable" aria-sort="${aria}"><button class="sort" data-key="${c.key}" title="Sort by ${esc(c.label)}">` +
        `${esc(c.label)}<span class="arrow">${active ? (sort.dir > 0 ? "▲" : "▼") : ""}</span></button></th>`;
    }).join("");
    $("head").querySelectorAll("button.sort").forEach(b => b.addEventListener("click", () => {
      const key = b.dataset.key;
      sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: -1 };
      render();
    }));
  }

  function render() {
    renderHead();
    const q = $("q").value.trim().toLowerCase();
    const cls = $("f-class").value, sector = $("f-sector").value, source = $("f-source").value, dir = $("f-dir").value;
    const onlyStarred = $("starred").checked;
    const saved = shortlist.all();
    $("star-count").textContent = `(${Object.keys(saved).length})`;

    const shown = items.filter(r =>
      (!q || r.item.toLowerCase().includes(q) || r.symbol.toLowerCase().includes(q)) &&
      (!cls || r.asset_class === cls) && (!sector || r.sector === sector) && (!source || r.source === source) &&
      (!dir || dirClass(r.move_pct) === dir) &&
      (!onlyStarred || r.item_id in saved));

    // empty values always sort last, whichever the direction
    shown.sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      if (x == null && y == null) return a.item.localeCompare(b.item);
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * sort.dir || a.item.localeCompare(b.item);
    });

    $("count").textContent = `${shown.length} of ${items.length} items · values as of ${date}`;
    $("rows").innerHTML = shown.length ? shown.map(r => `
      <tr>
        <td><button class="star" data-id="${esc(r.item_id)}" aria-pressed="${r.item_id in saved}"
             aria-label="${r.item_id in saved ? "Remove from" : "Add to"} shortlist: ${esc(r.item)}">${r.item_id in saved ? "★" : "☆"}</button></td>
        <td><span class="item-name">${esc(r.item)}</span><br><span class="item-sub">${esc(r.symbol)} · ${esc(r.source)}</span></td>
        <td><span class="tag">${esc(r.asset_class)}</span><br><span class="item-sub">${esc(r.sector)}</span></td>
        ${COLS.map(c => {
          const v = r[c.key];
          const tone = c.key === "move_pct" || c.key === "change_pct" ? dirClass(v) : "";
          return `<td class="r ${tone}">${c.key === "move_pct" ? arrow(v) : ""}${fmt(c.key, v)}</td>`;
        }).join("")}
      </tr>`).join("") : `<tr><td colspan="${COLS.length + 3}"><div class="empty">No items match these filters.</div></td></tr>`;

    $("rows").querySelectorAll("button.star").forEach(b => b.addEventListener("click", () => {
      shortlist.toggle(items.find(r => r.item_id === b.dataset.id));
      render();
    }));
  }

  for (const id of ["q", "f-class", "f-sector", "f-source", "f-dir", "starred"]) {
    $(id).addEventListener("input", render);
  }
  $("reset").addEventListener("click", () => {
    for (const id of ["q", "f-class", "f-sector", "f-source", "f-dir"]) $(id).value = "";
    $("starred").checked = false;
    sort = { key: "volume_usd", dir: -1 };
    render();
  });
  render();
})();
