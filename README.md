# Drupal Block Team Assigner

A Chrome extension that bulk-assigns Drupal teams to blocks that are missing one. Upload a CSV of page URLs, define URL-to-team rules, and the extension navigates each page, finds teamless blocks, assigns the correct team, and exports before/after reports.

## Install

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` folder from this repo.
4. Open your Drupal site in a browser tab and log in with permissions to edit blocks.

To target a different site, edit `extension/manifest.json` — update `host_permissions` and `content_scripts.matches` to your site's origin (e.g. `https://your-site.example.com/*`). Then set the same origin in the dashboard **Allowed origin** guardrail.

## How it works

```
For each page in your CSV:
  1. Navigate the target tab to the page URL
  2. Scan for blocks without a team
  3. For each block: open the edit form, check the matching team checkbox, save
  4. Re-scan and record before/after counts
  5. Move to the next page
```

**Team resolution** (in order):

1. If the CSV row has `page_teams`, the first team in that field is used.
2. Otherwise, rules in the dashboard (or `rules_default.json`) are checked — each `pattern` is matched as a substring of the URL. First match wins.
3. If nothing matches, the block is logged as `no_rule_match`.

`team_name` values must match the Drupal checkbox label exactly (e.g. `ARTS - 1`, not "Faculty of Arts").

The extension processes one page at a time. The service worker uses `chrome.alarms` to stay alive across long runs and persists state so it can resume after MV3 restarts.

## Usage

1. Click the extension icon to open the **Dashboard** tab.
2. In another tab, open your Drupal site.
3. In the dashboard, select that tab from **Target tab** (click **Refresh tabs** if needed).
4. Upload a CSV or click **Use current page** for a single-page run.
5. Run **Test 1 block** (first block per page only) or **Full batch** (all blocks on every page).
6. When done, download **run_log.csv** (per-block detail) and **output.csv** (per-page summary).

### Input CSV

```csv
page_url,page_teams
https://arts.ucalgary.ca/english,ENGL - 13
https://arts.ucalgary.ca/history,
```

| Column | Required | Description |
|--------|----------|-------------|
| `page_url` | Yes | Full URL of the Drupal page |
| `page_teams` | No | Team name(s), separated by `\|` or `,`. First value is used. Blank = use rules. |

### Rules

```json
{
  "default_team": "",
  "rules": [
    { "pattern": "/english", "team_name": "ENGL - 13" },
    { "pattern": "/history", "team_name": "HIST - 29" }
  ]
}
```

Edit rules in the dashboard or in `extension/rules_default.json`.

### Output

- **run_log.csv** — one row per block: URL, block label, team, status (`success`, `already_set`, `no_rule_match`, `team_option_not_found`, `error`), notes, timestamp.
- **output.csv** — one row per page: title, URL, resolved team, blocks without team before/after.

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
