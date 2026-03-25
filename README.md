# Drupal Block Team Assigner

A Chrome extension that bulk-assigns teams to Drupal blocks. Upload a CSV of page URLs, define team-matching rules, and let the extension navigate each page, scan for blocks without a team, assign the correct team, and produce before/after reports.

## Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Input CSV Format](#input-csv-format)
- [Dashboard Controls](#dashboard-controls)
- [Rules Engine](#rules-engine)
- [Guardrails and Safety](#guardrails-and-safety)
- [Output Files](#output-files)
- [CSV Preparation Script](#csv-preparation-script)
- [Architecture and Components](#architecture-and-components)
- [Troubleshooting](#troubleshooting)
- [Configuration](#configuration)

---

## Quick Start

### 1. Install the extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** and select the `extension/` folder from this project.

### 2. Prepare your input

Create a CSV file with two columns:

```csv
page_url,page_teams
https://arts.ucalgary.ca/some-department,DEPT - 5
https://arts.ucalgary.ca/another-page,ARTS - 1
```

If `page_teams` is left blank, the extension resolves the team from its rules engine.

### 3. Run

1. Click the extension icon to open the **Dashboard** tab.
2. Open your target Drupal site in another tab (e.g. `https://arts.ucalgary.ca`).
3. In the dashboard, select that tab from the **Target tab** dropdown and click **Refresh tabs**.
4. Upload your CSV.
5. Click **Test 1 block** (assigns only the first block per page) or **Full batch** (assigns all blocks on every page).
6. Watch the Activity log for real-time progress.
7. When complete, download **run_log.csv** (per-block detail) and **output.csv** (per-page summary with before/after counts).

---

## How It Works

The extension processes pages **one at a time**, completing each page before moving on:

```
For each page in the CSV:
  1. Navigate the target tab to the page URL
  2. Scan for block edit links (blocks without a team)
  3. For each block:
     a. Click the edit link to open the block modal/iframe
     b. Find the team checkbox matching the resolved team name
     c. Check it and click Save
  4. Re-scan the page to count remaining teamless blocks
  5. Record the before/after counts for output.csv
  6. Move to the next page
```

Between assignment batches, the service worker yields via `chrome.alarms` to stay within Manifest V3 lifetime limits.

---

## Input CSV Format

| Column | Required | Description |
|--------|----------|-------------|
| `page_url` | Yes | Full HTTPS URL of the Drupal page containing blocks |
| `page_teams` | No | Team name(s) separated by pipe `\|` or comma. The first team is used. If blank, the rules engine determines the team from the URL. |

**Example:**

```csv
page_url,page_teams
https://arts.ucalgary.ca/english,ENGL - 13
https://arts.ucalgary.ca/history,
https://arts.ucalgary.ca/philosophy,PHIL - 33|ARTS - 1
```

The second row has no `page_teams`, so the extension looks up `/history` in the rules and assigns `HIST - 29`.

---

## Dashboard Controls

### Input section
- **Upload CSV** — Load a `page_url,page_teams` CSV file.
- **Use current page** — Populate the queue with just the URL of the selected target tab.

### Run section
- **Test 1 block** — Assign only the first block on each page (safe for dry runs).
- **Full batch** — Assign every block on every page.
- **All blocks on selected tab** — One-click run: assigns all blocks on whichever tab is selected.
- **Stop** — Cancel the current run gracefully.
- **Download run_log.csv** — Per-block assignment log.
- **Download output.csv** — Per-page summary with before/after block counts.

### Settings
- **Render wait (ms)** — Time to wait after page load before scanning (default 1200 ms). Increase for slow-loading pages.
- **Team separator** — Pipe `|` or comma `,`. Controls how `page_teams` values are split.

### Target tab
- **Tab selector** — Choose which open `arts.ucalgary.ca` tab the extension drives. Click **Refresh tabs** to update the list.

### Rules (JSON)
- **Rules editor** — Edit the JSON rules in-place. Click **Save rules** to persist or **Reset to defaults** to reload `rules_default.json`.

---

## Rules Engine

The rules JSON has this structure:

```json
{
  "default_team": "",
  "rules": [
    { "pattern": "/english", "team_name": "ENGL - 13" },
    { "pattern": "/history", "team_name": "HIST - 29" }
  ]
}
```

**Resolution order:**

1. If the CSV row has a non-empty `page_teams`, the first team in that field is used directly.
2. Otherwise, each rule's `pattern` is checked as a **substring match** against the lowercased page URL. The first match wins.
3. If no rule matches and `default_team` is set, that value is used.
4. If nothing matches, the block is logged as `no_rule_match`.

**`team_name` values must match the Drupal checkbox label** (e.g. `ARTS - 1`, `CLARE - 2`). A label like "Faculty of Arts" will not match a checkbox labeled `ARTS - 1`.

---

## Guardrails and Safety

All guardrails are configured in the dashboard's **Guardrails** section:

| Setting | Default | Description |
|---------|---------|-------------|
| Allowed origin | `https://arts.ucalgary.ca` | Only URLs from this origin are processed. |
| Path prefix | *(empty)* | Optional path prefix filter (e.g. `/english` to limit to one department). |
| Max pages | 0 (unlimited) | Cap on how many pages to process per run. |
| Max assignments | 0 (unlimited) | Cap on total block assignments per run. |
| Delay between assigns (ms) | 800 | Throttle between consecutive block assignments. |
| Post-save wait (ms) | 1200 | Wait after clicking Save before proceeding. |

### Anomaly auto-pause

The extension monitors assignment results in real time and **automatically pauses** if error patterns emerge:

| Threshold | Default | Triggers when... |
|-----------|---------|-------------------|
| Min sample | 10 | ...at least this many assignments have been attempted before checking error rate. |
| Error rate (%) | 15 | ...the cumulative error rate exceeds this percentage. |
| Consecutive team_option_not_found | 3 | ...the team checkbox is missing N times in a row (likely wrong rules). |
| Receiver errors in window | 2 | ...content script communication fails N times in the last window (likely tab issue). |
| Window size | 10 | Sliding window for receiver error tracking. |

When auto-paused, a modal appears with the reason. You can **Resume anyway** or **Keep paused** to investigate.

---

## Output Files

### run_log.csv

One row per block assignment attempt:

| Column | Description |
|--------|-------------|
| `page_url` | The page URL |
| `block_label` | Block name (from the edit link title) |
| `block_edit_url` | Direct URL to the block edit form |
| `team_name` | Team that was assigned (or attempted) |
| `status` | `success`, `already_set`, `no_rule_match`, `team_option_not_found`, `error`, `skipped_invalid_url` |
| `notes` | Additional context for non-success statuses |
| `timestamp` | ISO 8601 timestamp |

### output.csv

One row per page — a before/after summary:

| Column | Description |
|--------|-------------|
| `page_title` | The HTML `<title>` of the page |
| `page_url` | Page URL |
| `page_team` | The team that was resolved for this page |
| `blocks_no_team_before` | Number of teamless blocks found during initial scan |
| `blocks_no_team_after` | Number of teamless blocks remaining after assignments |

---

## CSV Preparation Script

If your source data is in a different format (e.g. exported from Drupal views), use the included Python script to convert it:

```bash
python3 make_extension_input_csv.py \
  --input your_export.csv \
  --rules extension/rules_default.json \
  --output pages_for_extension.csv \
  --dedupe
```

| Flag | Description |
|------|-------------|
| `--input` | Source CSV. Expects a `url location` column for URLs and `page title` for rule matching. |
| `--rules` | Path to the rules JSON (same format as the extension). |
| `--output` | Output CSV in `page_url,page_teams` format, ready for the extension. |
| `--dedupe` | Remove duplicate URLs (keeps first occurrence). |
| `--no-match-title` | Skip title-based pattern matching; only match on URL. |

---

## Architecture and Components

### File structure

```
extension/
  manifest.json        Chrome MV3 extension manifest
  background.js        Service worker — orchestration engine
  content.js           Content script — DOM interaction on target pages
  dashboard.html       Dashboard UI (opens as a tab)
  dashboard.js         Dashboard logic and message handling
  rules_default.json   Default URL-to-team mapping rules
make_extension_input_csv.py   CSV conversion utility
config.example.json           Config template for the Playwright script
run_blocks_browser.py         Alternative Playwright-based automation
requirements.txt              Python dependencies (playwright)
```

### background.js — Service Worker

The orchestration engine. Runs as a Manifest V3 service worker.

**Responsibilities:**
- Receives commands from the dashboard (`START_RUN`, `STOP_RUN`, etc.) via `chrome.runtime.onMessage`.
- Manages the page-by-page processing loop: for each page, navigates the target tab, triggers scans, dispatches assignments, and collects results.
- Applies guardrails: URL validation, page/assignment caps, throttling delays.
- Runs anomaly detection after each assignment and auto-pauses if thresholds are exceeded.
- Persists run state to `chrome.storage.local` so it survives MV3 service worker restarts. Uses `chrome.alarms` to schedule continuation between assignment batches.
- Generates `run_log.csv` and `output.csv` downloads via data URIs.

**Key functions:**
- `runPages()` — Validates input, builds the list of allowed pages, starts the page-by-page loop.
- `runNextChunk()` — Main processing loop: scans, assigns, re-scans, advances pages. Yields to alarms between batches.
- `sendScanBlocks()` / `sendAssignTeam()` — Send messages to the content script with retry logic for transient errors.
- `finishRun()` — Persists `pageSummaries` and sends `RUN_COMPLETE` to the dashboard.

### content.js — Content Script

Injected into every page matching `https://arts.ucalgary.ca/*`.

**Handles two message types:**

- `SCAN_BLOCKS` — Finds all block edit links on the page using multiple CSS selectors. Returns an array of `{ label, editUrl, hasTeam }` objects plus the `pageTitle`.
- `ASSIGN_TEAM` — Clicks a block edit link, waits for the team checkboxes to appear (including inside iframes), finds the checkbox matching the given team name, checks it, clicks Save, and returns the result status.

**DOM interaction strategy:**
- Searches for edit links via selectors like `a.edit-this-block`, `a[href*="content/block"]`, and layout builder anchors.
- After clicking an edit link, polls up to 22 seconds for team checkboxes to appear, searching through nested iframes (up to 6 levels deep).
- Checkbox matching is by label text substring (handles encoded entities and whitespace normalization).

### dashboard.html + dashboard.js — User Interface

The dashboard opens in its own Chrome tab (not a popup).

**dashboard.js responsibilities:**
- Reads CSV files and sends page data to the background script.
- Manages all UI state: input summary, running/ready badge, button enable/disable.
- Persists user settings (guardrails, render wait, team separator) to `chrome.storage.local`.
- Listens for `LOG_ENTRY`, `PROGRESS_UPDATE`, `RUN_COMPLETE`, and `AUTO_PAUSED_PHASE2` messages from the background to update the Activity log and modals in real time.
- Wires the download buttons to send `DOWNLOAD_LOG` / `DOWNLOAD_OUTPUT_LOG` messages.

### rules_default.json

A JSON file bundled with the extension containing site-specific URL-to-team mappings. Each rule has a `pattern` (URL substring) and a `team_name` (must match the Drupal checkbox label). Rules are checked top-to-bottom; first match wins.

### Message Flow

```
Dashboard                  Background (SW)              Content Script
   |                            |                            |
   |── SET_BLOCKS ─────────────>|                            |
   |── START_RUN ──────────────>|                            |
   |                            |── tabs.update (navigate) ──>|
   |                            |── SCAN_BLOCKS ────────────>|
   |                            |<── { blocks, pageTitle } ──|
   |                            |── ASSIGN_TEAM ────────────>|
   |                            |<── { status, notes } ──────|
   |<── PROGRESS_UPDATE ────────|                            |
   |<── LOG_ENTRY ──────────────|                            |
   |                            |── SCAN_BLOCKS (re-scan) ──>|
   |                            |<── { blocks, pageTitle } ──|
   |<── RUN_COMPLETE ───────────|                            |
   |── DOWNLOAD_LOG ───────────>|                            |
   |── DOWNLOAD_OUTPUT_LOG ────>|                            |
```

---

## Troubleshooting

**"Receiving end does not exist" errors**
The content script is not loaded on the target tab. Fix: reload the extension from `chrome://extensions`, refresh the target tab, and ensure the tab URL matches `https://arts.ucalgary.ca/*`.

**Blocks not found on a page**
The page may still be loading. Increase **Render wait (ms)** in the dashboard (try 2000–3000 ms for heavy pages).

**Wrong team assigned / team_option_not_found**
Check that the `team_name` in your rules or CSV exactly matches the Drupal checkbox label (e.g. `ARTS - 1`, not `Faculty of Arts`). Open a block edit form manually to verify the label text.

**Extension stops mid-run**
MV3 service workers can restart. The extension persists state to storage and uses alarms to resume automatically. If it does not resume within 10 seconds, check the Activity log for auto-pause reasons or errors.

**Auto-paused unexpectedly**
Lower the error-rate threshold or increase the min-sample in the Anomaly auto-pause section. Or click **Resume anyway** in the modal if the errors are expected.

---

## Configuration

### Changing the target Drupal site

Edit `extension/manifest.json`:

1. Update `host_permissions` to your site's origin:
   ```json
   "host_permissions": ["https://your-site.example.com/*"]
   ```
2. Update `content_scripts.matches` to the same pattern:
   ```json
   "matches": ["https://your-site.example.com/*"]
   ```
3. In the dashboard, update the **Allowed origin** guardrail to `https://your-site.example.com`.

### Alternative: Playwright script

For environments where a Chrome extension is not practical, an alternative Playwright-based script is included:

```bash
pip install -r requirements.txt
playwright install chromium
cp config.example.json config.json   # edit with your site URLs
python3 run_blocks_browser.py        # or --test for a dry run
```

This opens a real Chromium window, waits for you to log in, then automates the same block assignment flow.
