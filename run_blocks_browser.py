#!/usr/bin/env python3
"""
Run from Cursor/terminal to automate Drupal block team assignment in a real browser.
Uses Playwright. You log in once; the script visits each page, finds blocks without
team, opens each block edit, assigns the team, saves, and writes run_log.csv.

Usage:
  pip install playwright
  playwright install chromium
  # Copy config.example.json to config.json and set base_url, login_url, input_csv.
  python run_blocks_browser.py [--test] [--config config.json]
"""

import argparse
import csv
import json
import os
import sys
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("Install Playwright: pip install playwright && playwright install chromium")
    sys.exit(1)


# Selectors derived from your Drupal HTML (block_no_team.html, block_setting_edit_no_team.html)
EDIT_LINK_SELECTOR = 'a.edit-this-block'
EDIT_LINK_HREF = '/admin/content/block/'
IFRAME_SELECTOR = 'iframe.lbim-dialog-iframe'
TEAM_SELECTORS = [
    'select[name*="team"]',
    'select[id*="field-team"]',
    'select[data-drupal-selector*="team"]',
    'select[name*="field_team"]',
]
SAVE_SELECTORS = [
    'input[type="submit"][value="Save"]',
    'input#edit-submit',
    'button[value="Save"]',
    'input[type="submit"]',
]


def load_config(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def parse_pages_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    if not rows or "page_url" not in rows[0]:
        return []
    return [{"page_url": r.get("page_url", "").strip(), "page_teams": r.get("page_teams", "").strip()} for r in rows if r.get("page_url")]


def get_team_for_page(page, base_url):
    if page.get("page_teams"):
        first = page["page_teams"].split("|")[0].strip()
        if first:
            return first
    return None


def run(config_path, test_only):
    config = load_config(config_path)
    base_url = config.get("base_url", "").rstrip("/")
    login_url = config.get("login_url") or f"{base_url}/user/login"
    input_csv = config.get("input_csv", "example_pages.csv")
    run_log_csv = config.get("run_log_csv", "run_log.csv")
    limit = config.get("test_limit", 3) if test_only else 9999

    input_path = Path(config_path).parent / input_csv
    pages = parse_pages_csv(str(input_path))
    if not pages:
        print("No rows in input CSV or missing page_url column.")
        return

    pages = pages[:limit]
    log_entries = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headed=True)
        context = browser.new_context()
        page = context.new_page()
        page.set_default_timeout(20000)

        print("Browser opened. Log in to Drupal, then press Enter here to continue.")
        page.goto(login_url)
        input("Press Enter after you have logged in...")

        for i, page_row in enumerate(pages):
            page_url = page_row["page_url"]
            team_name = get_team_for_page(page_row, base_url)
            if not team_name:
                log_entries.append({
                    "page_url": page_url,
                    "block_label": "",
                    "block_edit_url": "",
                    "team_name": "",
                    "status": "no_rule_match",
                    "notes": "no page_teams",
                    "timestamp": __import__("datetime").datetime.now().isoformat(),
                })
                print(f"  Skip page (no team): {page_url}")
                continue

            print(f"Page {i + 1}/{len(pages)}: {page_url}")
            page.goto(page_url)
            page.wait_for_load_state("networkidle")

            edit_links = page.locator(EDIT_LINK_SELECTOR).all()
            if not edit_links:
                edit_links = page.locator(f'a[href*="{EDIT_LINK_HREF}"]').all()

            for el in edit_links:
                href = el.get_attribute("href") or ""
                title = el.get_attribute("title") or "Block"
                if EDIT_LINK_HREF not in href:
                    continue
                edit_url = href if href.startswith("http") else f"{base_url}{href.split('?')[0]}"
                if "?" in href and not href.startswith("http"):
                    edit_url = f"{base_url}{href}"

                print(f"  Edit: {title} -> {edit_url}")
                page.goto(edit_url)
                page.wait_for_load_state("networkidle")
                # Edit form may be in iframe (modal) or in main document
                try:
                    if page.locator(IFRAME_SELECTOR).count() > 0:
                        page.wait_for_selector(IFRAME_SELECTOR, state="attached", timeout=5000)
                        frame = page.frame_locator(IFRAME_SELECTOR)
                        team_select = frame.locator(TEAM_SELECTORS[0]).first
                        for sel in TEAM_SELECTORS[1:]:
                            if frame.locator(sel).count() > 0:
                                team_select = frame.locator(sel).first
                                break
                        save_btn = frame.locator(SAVE_SELECTORS[0]).first
                        for sel in SAVE_SELECTORS[1:]:
                            if frame.locator(sel).count() > 0:
                                save_btn = frame.locator(sel).first
                                break
                    else:
                        team_select = page.locator(TEAM_SELECTORS[0]).first
                        for sel in TEAM_SELECTORS[1:]:
                            if page.locator(sel).count() > 0:
                                team_select = page.locator(sel).first
                                break
                        save_btn = page.locator(SAVE_SELECTORS[0]).first
                        for sel in SAVE_SELECTORS[1:]:
                            if page.locator(sel).count() > 0:
                                save_btn = page.locator(sel).first
                                break
                except Exception as e:
                    log_entries.append({
                        "page_url": page_url,
                        "block_label": title,
                        "block_edit_url": edit_url,
                        "team_name": team_name,
                        "status": "error",
                        "notes": f"form not found: {e}",
                        "timestamp": __import__("datetime").datetime.now().isoformat(),
                    })
                    continue

                if team_select.count() == 0:
                    log_entries.append({
                        "page_url": page_url,
                        "block_label": title,
                        "block_edit_url": edit_url,
                        "team_name": team_name,
                        "status": "error",
                        "notes": "team field not found",
                        "timestamp": __import__("datetime").datetime.now().isoformat(),
                    })
                    continue

                try:
                    team_select.select_option(label=team_name)
                except Exception as e:
                    try:
                        team_select.select_option(value=team_name)
                    except Exception:
                        log_entries.append({
                            "page_url": page_url,
                            "block_label": title,
                            "block_edit_url": edit_url,
                            "team_name": team_name,
                            "status": "team_option_not_found",
                            "notes": str(e),
                            "timestamp": __import__("datetime").datetime.now().isoformat(),
                        })
                        continue

                if save_btn.count() == 0:
                    log_entries.append({
                        "page_url": page_url,
                        "block_label": title,
                        "block_edit_url": edit_url,
                        "team_name": team_name,
                        "status": "error",
                        "notes": "Save button not found",
                        "timestamp": __import__("datetime").datetime.now().isoformat(),
                    })
                    continue

                save_btn.click()
                page.wait_for_load_state("networkidle")
                log_entries.append({
                    "page_url": page_url,
                    "block_label": title,
                    "block_edit_url": edit_url,
                    "team_name": team_name,
                    "status": "success",
                    "notes": "",
                    "timestamp": __import__("datetime").datetime.now().isoformat(),
                })
                print(f"    Saved with team: {team_name}")

        browser.close()

    out_path = Path(config_path).parent / run_log_csv
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["page_url", "block_label", "block_edit_url", "team_name", "status", "notes", "timestamp"])
        writer.writeheader()
        writer.writerows(log_entries)
    print(f"Wrote {out_path}")


def main():
    parser = argparse.ArgumentParser(description="Drupal block team assignment via browser (Playwright)")
    parser.add_argument("--test", action="store_true", help="Process only first N pages (from config test_limit)")
    parser.add_argument("--config", default="config.json", help="Config JSON path (default: config.json)")
    args = parser.parse_args()
    config_path = args.config
    if not os.path.isfile(config_path):
        config_path = "config.example.json"
    if not os.path.isfile(config_path):
        print("Create config.json (see config.example.json)")
        sys.exit(1)
    run(config_path, args.test)


if __name__ == "__main__":
    main()
