"""Open (or update) the GitHub Issue for a run date and close the earlier ones.

Uses the REST API with the GITHUB_TOKEN that GitHub Actions provides. Without a
token (a local run) the issue step is skipped.
"""

from __future__ import annotations

import os

import requests

from .moves import TOP_N

LABEL = "daily-report"
API = "https://api.github.com"


def money(x: float) -> str:
    if x >= 100:
        return f"${x:,.2f}"
    if x >= 1:
        return f"${x:,.4f}"
    return f"${x:.6g}"


def issue_body(date: str, status: dict, top: list[dict], names: dict[str, str], site_url: str = "") -> str:
    ok = sum(s["ok"] for s in status["sources"])
    failed = [s["name"] for s in status["sources"] if not s["ok"]]
    lines = [
        f"Data Tracker report for **{date}** (UTC), run at {status['run_time']}.",
        "",
        f"- Items today: **{status['items']}**",
        f"- Sources OK: **{ok} / {len(status['sources'])}**" + (f" (failed: {', '.join(failed)})" if failed else ""),
        f"- Days with a successful run: **{status['days_with_success']}** (since {status['first_run_date']})",
    ]
    if site_url:
        lines.append(f"- Site: {site_url}")
    lines += ["", f"## Biggest moves since the previous run (top {TOP_N})", ""]
    if top:
        lines += ["| # | Item | Old price | New price | Move |", "|---:|---|---:|---:|---:|"]
        for i, m in enumerate(top, 1):
            arrow = "🔺" if m["move_pct"] > 0 else ("🔻" if m["move_pct"] < 0 else "▫️")
            lines.append(f"| {i} | {m['item']} ({m['symbol']}) | {money(m['old'])} ({m['old_date']}) "
                         f"| {money(m['new'])} | {arrow} {m['move_pct']:+.2f}% |")
    else:
        lines.append("_No earlier run to compare with, so no moves today._")
    for heading, ids in (("Appeared", status["new_today"]), ("Disappeared", status["gone_today"])):
        lines += ["", f"## {heading} ({len(ids)})", ""]
        lines += [f"- {names.get(i, i)} (`{i}`)" for i in ids] if ids else ["_None._"]
    lines += ["", "Move rule: percent change in `price_usd` from the item's previous row in "
              "`data/history.csv`, ranked by absolute size."]
    return "\n".join(lines) + "\n"


class GitHub:
    def __init__(self, repo: str, token: str):
        self.repo = repo
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        })

    def _call(self, method: str, path: str, **kw):
        resp = self.session.request(method, f"{API}/repos/{self.repo}{path}", timeout=30, **kw)
        resp.raise_for_status()
        return resp.json() if resp.content else None

    def report_issues(self) -> list[dict]:
        issues, page = [], 1
        while True:
            batch = self._call("GET", "/issues", params={"labels": LABEL, "state": "all", "per_page": 100, "page": page})
            issues += [i for i in batch if "pull_request" not in i]
            if len(batch) < 100:
                return issues
            page += 1

    def publish(self, title: str, body: str) -> int:
        try:
            self._call("POST", "/labels", json={"name": LABEL, "color": "2a78d6", "description": "Daily Data Tracker report"})
        except requests.HTTPError:
            pass  # label already exists
        issues = self.report_issues()
        today = next((i for i in issues if i["title"] == title), None)
        if today:  # a second run on the same day updates that day's issue
            self._call("PATCH", f"/issues/{today['number']}", json={"body": body, "state": "open"})
            number = today["number"]
        else:
            number = self._call("POST", "/issues", json={"title": title, "body": body, "labels": [LABEL]})["number"]
        for issue in issues:
            if issue["state"] == "open" and issue["number"] != number:
                self._call("PATCH", f"/issues/{issue['number']}", json={"state": "closed", "state_reason": "completed"})
        return number


def publish_issue(date: str, body: str) -> int | None:
    token, repo = os.environ.get("GITHUB_TOKEN"), os.environ.get("GITHUB_REPOSITORY")
    if not token or not repo:
        print("issue: GITHUB_TOKEN / GITHUB_REPOSITORY not set, skipping")
        return None
    number = GitHub(repo, token).publish(date, body)
    print(f"issue: #{number} '{date}'")
    return number


def site_url() -> str:
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if "/" not in repo:
        return ""
    owner, name = repo.split("/", 1)
    return f"https://{owner.lower()}.github.io/{name}/"
