# Drupal Block Team Assigner

A Chrome extension that bulk-assigns Drupal teams to blocks that are missing one. Load a simple CSV — one page URL and its team per row — review the list in an editable table, and the extension navigates each page, assigns that team to its teamless blocks (and optionally to the page itself), and exports before/after reports.

## Install

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` folder from this repo.
4. Open your Drupal site in a browser tab and log in with permissions to edit blocks.

### Which sites it runs on

Out of the box the extension works on **any `https://*.ucalgary.ca` site** (arts, outdoor-centre, other faculty Drupal sites — all covered by one build). Each batch is scoped to a single site by the **Allowed site** guardrail, which is filled in automatically from the tab you pick (override it under **Advanced settings**). Pages on other sites are logged as `skipped_invalid_url`.

To run on a domain outside `ucalgary.ca`, edit `extension/manifest.json` — add your origin (e.g. `https://your-site.example.com/*`) to both `host_permissions` and `content_scripts.matches` — then reload the extension. The dashboard Target-tab list also filters to `*.ucalgary.ca`; widen `TAB_QUERY_URL` / `isSupportedTabUrl` in `extension/dashboard.js` to include the new domain.

## How it works

```
For each page in your CSV:
  1. Navigate the target tab to the page URL
  2. Scan for blocks without a team
  3. For each block: open the edit form, check the matching team checkbox, save
  4. (Optional) Open the page's own Edit form and set the same team on the page
  5. Re-scan and record before/after counts
  6. Move to the next page
```

**Also set the page's team** (dashboard toggle, on by default): after a page's blocks
are assigned, the extension opens the node's **Edit** tab, finds the **Teams** field,
and checks the same team it used for that page's blocks, then saves. This keeps a page
and its blocks on the same team. The per-page result is recorded in the
`page_team_status` column of `output.csv`. Turn the toggle off to leave pages untouched
and only assign block teams.

**Team resolution:** each page gets the **one team** listed next to it in your CSV (or in the editable **Targets** table). There are no URL rules — what you see in the table is what gets assigned. A page with a blank team is logged as `no_rule_match` and skipped.

`team_name` values must match the Drupal checkbox label exactly (e.g. `ARTS - 1`, not "Faculty of Arts").

The extension processes one page at a time. The service worker uses `chrome.alarms` to stay alive across long runs and persists state so it can resume after MV3 restarts.

## Usage

1. Click the extension icon to open the **Dashboard** tab.
2. In another tab, open your Drupal site and log in.
3. **Load your list** — choose a CSV (or click *add the selected tab as a row*).
4. **Pick the site tab** — select that Drupal tab (click **Refresh** if needed). The *Allowed site* guardrail is filled in from it automatically.
5. **Review the Targets** table on the right. Edit any URL or team inline, click **Save targets** to keep changes (or **Download cleaned CSV**).
6. **Run** — **Test (1 page)** does the first page/first block as a safe check; **Run all pages** processes everything.
7. Watch the **Results** panel update live — pages scanned, blocks processed, succeeded, and failed. Anything that didn't succeed appears under **Needs attention** with **Open page** / **Open block** links and the reason; use **Copy failed links** to grab them all.
8. When done, **Download results** (per-page summary) and **Download detailed log** (per-block detail).

### Input CSV

One row per page: the page URL, a comma, then the team name. **One team per URL.** A header row is optional, and spaces/quotes around values are cleaned up automatically on load — so all of these work:

```csv
page_url,team_name
https://arts.ucalgary.ca/english, ENGL - 13
"https://arts.ucalgary.ca/history",HIST - 29
https://arts.ucalgary.ca/drama
```

| Column | Required | Description |
|--------|----------|-------------|
| Page URL | Yes | Full URL of the Drupal page (first field) |
| Team name | No | The single team for that page (everything after the first comma). Blank = page is skipped. |

After loading, the CSV appears in the **Targets** table where you can fix any row before running.

### Output

- **run_log.csv** — one row per block: URL, block label, team, status (`success`, `already_set`, `no_rule_match`, `team_option_not_found`, `error`), notes, timestamp. Page-team assignments appear as rows with the block label `(page team)`.
- **output.csv** — one row per page: title, URL, resolved team, blocks without team before/after, and `page_team_status` (the result of setting the page's own team: `success`, `already_set`, `team_option_not_found`, `no_edit_url`, `no_rule_match`, `error`, or blank when the toggle is off).

## Prepare CSV from a Drupal export

If your source data uses different columns (e.g. `url location`, `page title`):

```bash
python3 make_extension_input_csv.py \
  --input your_export.csv \
  --rules extension/rules_default.json \
  --output pages_for_extension.csv \
  --dedupe
```

## Alternative: Playwright script

For environments where a Chrome extension isn't practical:

```bash
pip install -r requirements.txt
playwright install chromium
cp config.example.json config.json   # edit with your site URLs
python3 run_blocks_browser.py        # add --test for a dry run
```

Opens Chromium, waits for you to log in, then runs the same assignment flow.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Receiving end does not exist" | Reload the extension, refresh the target tab, confirm the URL matches `manifest.json`. |
| Blocks not found | Increase **Render wait (ms)** in the dashboard (try 2000–3000 ms). |
| `team_option_not_found` | Verify `team_name` matches the checkbox label in the block edit form. |
| Run stops mid-batch | Check the Activity log for auto-pause reasons. The extension auto-pauses when error rates spike; you can resume or adjust thresholds in **Guardrails**. |
