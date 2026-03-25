# Drupal Block Team Assigner

Assign teams to Drupal blocks from a list of page URLs: visit each page, find blocks with no team, open the block edit form, set the team, and save.

## Two ways to run

### 1. Browser script (Playwright) – run from Cursor/terminal

Runs a real Chromium window. You log in once; the script drives the browser and writes `run_log.csv`.

**Setup**

```bash
pip install playwright
playwright install chromium
```

**Config**

- Copy `config.example.json` to `config.json`.
- Set `base_url` and `login_url` to your Drupal site.
- Set `input_csv` to a CSV with columns `page_url` and `page_teams` (e.g. `ARTS - 1|CLARE - 2`).

**Run**

```bash
# Test run (first N pages from config.test_limit)
python run_blocks_browser.py --test

# Full run
python run_blocks_browser.py
```

The script opens the login page, then waits for you to press Enter after logging in. It then processes each page, finds “Edit this block” links, opens each edit form (including in an iframe modal), sets the team from `page_teams`, and saves.

### 2. Chrome extension

Load the `extension` folder in Chrome (Developer mode → Load unpacked). Click the extension icon to open the **dashboard** (its own tab): upload a CSV, choose the target `arts.ucalgary.ca` tab, set render wait / team separator, edit rules JSON, then run. The extension navigates the **selected** tab to each page, scans blocks, opens the block edit modal, assigns the team, and logs to the Activity panel (copy for troubleshooting) plus a downloadable `run_log.csv`.

- Update `manifest.json` so `host_permissions` and `content_scripts.matches` use your Drupal origin (default: `https://arts.ucalgary.ca/*`).
- Input CSV: `page_url`, `page_teams` (optional; first team uses the separator chosen in the dashboard: pipe or comma).
- **Test 1 block** only assigns the **first** block on each page. **Full batch** assigns **all** blocks on each page—even when the CSV has only one URL (e.g. one long landing page with many blocks).

**Guardrails (dashboard):** **Allowed origin** (https only) and optional **path prefix** filter CSV URLs (`skipped_invalid_url` if not allowed). **Max pages** / **max assignments** cap each run (`0` = no limit). **Delay between assigns** and **post-save wait** throttle automation. Assignments use batched work plus `chrome.alarms` pauses for long Manifest V3 runs.

## Input CSV format

**Pages CSV (for both methods)**

| page_url | page_teams |
|----------|------------|
| https://arts.ucalgary.ca/clare-intermediary/greek-and-roman-studies-old | ARTS - 1\|CLARE - 2 |

- `page_url`: full URL of the page that displays the blocks.
- `page_teams`: optional; the first team uses the separator set in the dashboard (pipe or comma). If empty, the extension uses URL-based rules from the dashboard rules editor.

**Rules and `team_name`:** In the dashboard rules JSON, each rule’s `team_name` must match the **Teams** checkbox label in the block edit form closely enough for the extension to find it (same text as in the UI, including codes like `ARTS - 1` or `CLARE - 2`). A value such as “Faculty of Arts” will not match a checkbox labeled `ARTS - 1`.

## Log output

Both methods write (or download) `run_log.csv` with:

- `page_url`, `block_label`, `block_edit_url`, `team_name`, `status`, `notes`, `timestamp`

`status` can be: `success`, `already_set` (target team already checked), `no_rule_match`, `team_option_not_found`, `error`, `skipped_invalid_url` (URL failed guardrails).

If you see **Receiving end does not exist** on a run: reload the extension, **refresh the arts.ucalgary.ca tab**, ensure that tab stays on a normal page (not `chrome://`), and try again—the background script now retries messaging automatically; persistent failures usually mean the content script is not injected on that URL (check `manifest.json` `matches`).
