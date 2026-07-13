// Tabs the extension can drive — must stay within manifest host_permissions /
// content_scripts.matches. The "Allowed site" guardrail (auto-filled from the
// tab you pick) pins a single origin per run.
const TAB_QUERY_URL = 'https://*.ucalgary.ca/*';

function isSupportedTabUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)ucalgary\.ca$/i.test(u.host);
  } catch {
    return false;
  }
}

const csvFileInput = document.getElementById('csvFile');
const addCurrentTabBtn = document.getElementById('addCurrentTabBtn');
const testRunBtn = document.getElementById('testRunBtn');
const fullRunBtn = document.getElementById('fullRunBtn');
const downloadLogBtn = document.getElementById('downloadLogBtn');
const downloadOutputBtn = document.getElementById('downloadOutputBtn');
const stopRunBtn = document.getElementById('stopRunBtn');
const renderWaitMsInput = document.getElementById('renderWaitMs');
const fileSummaryEl = document.getElementById('fileSummary');
const rowSummaryEl = document.getElementById('rowSummary');
const runBadge = document.getElementById('runBadge');
const tabSelect = document.getElementById('tabSelect');
const refreshTabsBtn = document.getElementById('refreshTabsBtn');
const assignPageTeamCheckbox = document.getElementById('assignPageTeam');

const targetsBody = document.getElementById('targetsBody');
const saveTargetsBtn = document.getElementById('saveTargetsBtn');
const addTargetBtn = document.getElementById('addTargetBtn');
const downloadCleanCsvBtn = document.getElementById('downloadCleanCsvBtn');
const targetsStatus = document.getElementById('targetsStatus');

const statPages = document.getElementById('statPages');
const statBlocks = document.getElementById('statBlocks');
const statOk = document.getElementById('statOk');
const statFail = document.getElementById('statFail');
const failuresList = document.getElementById('failuresList');
const failuresHeading = document.getElementById('failuresHeading');
const copyFailuresBtn = document.getElementById('copyFailuresBtn');

const activityLogEl = document.getElementById('activityLog');
const copyActivityBtn = document.getElementById('copyActivityBtn');
const clearActivityBtn = document.getElementById('clearActivityBtn');
const allowedOriginInput = document.getElementById('allowedOrigin');
const pathPrefixInput = document.getElementById('pathPrefix');
const maxPagesInput = document.getElementById('maxPages');
const maxAssignmentsInput = document.getElementById('maxAssignments');
const assignGapMsInput = document.getElementById('assignGapMs');
const postSaveWaitMsInput = document.getElementById('postSaveWaitMs');
const anomalyAutoPauseEnabled = document.getElementById('anomalyAutoPauseEnabled');
const anomalyMinSample = document.getElementById('anomalyMinSample');
const anomalyErrorRatePct = document.getElementById('anomalyErrorRatePct');
const anomalyConsecutiveTeamNotFound = document.getElementById('anomalyConsecutiveTeamNotFound');
const anomalyReceiverErrorsInWindow = document.getElementById('anomalyReceiverErrorsInWindow');
const anomalyWindowSize = document.getElementById('anomalyWindowSize');
const autoPauseModal = document.getElementById('autoPauseModal');
const autoPauseReason = document.getElementById('autoPauseReason');
const autoPauseCloseBtn = document.getElementById('autoPauseCloseBtn');
const autoPauseResumeBtn = document.getElementById('autoPauseResumeBtn');
const setOutputFileBtn = document.getElementById('setOutputFileBtn');
const outputFileStatus = document.getElementById('outputFileStatus');

let pages = [];
let inputFileName = '';
let activityLines = [];
let isRunning = false;
let outputFileHandle = null;
let outputCsvRows = [];
let runEntries = [];
let scannedPageUrls = new Set();

const LOG_SESSION_KEY = 'activityLogLines';
const MAX_LOG_LINES = 500;

function formatTs(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  } catch {
    return iso;
  }
}

function appendActivityLine(entry) {
  const line = document.createElement('div');
  line.className = `log-line level-${entry.level || 'info'}`;
  const ts = formatTs(entry.timestamp || new Date().toISOString());
  const details = entry.details ? ` — ${entry.details}` : '';
  line.textContent = `[${ts}] [${(entry.level || 'info').toUpperCase()}] ${entry.message || ''}${details}`;
  activityLogEl.insertBefore(line, activityLogEl.firstChild);

  activityLines.unshift({
    text: `[${entry.timestamp || new Date().toISOString()}] [${(entry.level || 'info').toUpperCase()}] ${entry.message || ''}${details}`
  });
  while (activityLogEl.children.length > MAX_LOG_LINES) {
    activityLogEl.removeChild(activityLogEl.lastChild);
  }
  while (activityLines.length > MAX_LOG_LINES) activityLines.pop();
  persistActivityLog();
}

function persistActivityLog() {
  const slice = activityLines.slice(0, 200).map((x) => x.text);
  chrome.storage.session.set({ [LOG_SESSION_KEY]: slice }).catch(() => {});
}

async function loadActivityLogFromSession() {
  try {
    const { [LOG_SESSION_KEY]: lines } = await chrome.storage.session.get(LOG_SESSION_KEY);
    if (!lines || !lines.length) return;
    activityLogEl.innerHTML = '';
    activityLines = [];
    for (const text of lines) {
      const m = text.match(/^\[([^\]]+)\]\s*\[(\w+)\]\s*(.*)$/);
      const level = m && m[2] ? m[2].toLowerCase() : 'info';
      const line = document.createElement('div');
      line.className = `log-line level-${level}`;
      line.textContent = text;
      activityLogEl.appendChild(line);
      activityLines.push({ text });
    }
  } catch {
    /* ignore */
  }
}

function getSelectedTabId() {
  const v = tabSelect.value;
  if (!v) return null;
  const id = parseInt(v, 10);
  return Number.isFinite(id) ? id : null;
}

async function refreshTabList() {
  const selected = getSelectedTabId();
  const tabs = await chrome.tabs.query({ url: TAB_QUERY_URL });
  tabSelect.innerHTML = '';
  if (!tabs.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No ucalgary.ca tabs open';
    tabSelect.appendChild(opt);
    return;
  }
  for (const t of tabs) {
    const opt = document.createElement('option');
    opt.value = String(t.id);
    const title = (t.title || '').slice(0, 60);
    opt.textContent = `${title || 'Tab'} — ${(t.url || '').slice(0, 80)}`;
    tabSelect.appendChild(opt);
  }
  if (selected && tabs.some((t) => t.id === selected)) {
    tabSelect.value = String(selected);
  }
  await syncAllowedOriginFromTab();
}

/* ─── CSV preprocessing ───────────────────────────────────────────────
 * Non-tech-friendly parsing: one team per URL, tolerant of spaces after the
 * comma, optional header row, and surrounding quotes.
 */

function stripQuotes(s) {
  const t = (s || '').trim();
  if (
    t.length >= 2 &&
    ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function splitUrlTeam(line) {
  const idx = line.indexOf(',');
  if (idx === -1) return { page_url: stripQuotes(line), page_teams: '' };
  const url = stripQuotes(line.slice(0, idx));
  // Everything after the first comma is the team; drop any trailing empty columns.
  const team = stripQuotes(line.slice(idx + 1).trim().replace(/,+\s*$/, ''));
  return { page_url: url, page_teams: team };
}

function isHeaderRow(row) {
  const u = (row.page_url || '').toLowerCase();
  const t = (row.page_teams || '').toLowerCase();
  return (
    u === 'page_url' ||
    u === 'url' ||
    u === 'page url' ||
    t === 'page_teams' ||
    t === 'team' ||
    t === 'teams' ||
    t === 'team_name'
  );
}

function parseCsv(text) {
  const clean = (text || '').replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/);
  const rows = [];
  let checkedHeader = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const row = splitUrlTeam(line);
    if (!checkedHeader) {
      checkedHeader = true;
      if (isHeaderRow(row)) continue;
    }
    if (!row.page_url) continue;
    rows.push(row);
  }
  return rows;
}

/* ─── Targets table (editable preview) ────────────────────────────────── */

function makeTargetRow(url, team) {
  const tr = document.createElement('tr');

  const tdIndex = document.createElement('td');
  tdIndex.className = 'row-index';

  const tdUrl = document.createElement('td');
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 't-url';
  urlInput.placeholder = 'https://…';
  urlInput.value = url || '';
  tdUrl.appendChild(urlInput);

  const tdTeam = document.createElement('td');
  const teamInput = document.createElement('input');
  teamInput.type = 'text';
  teamInput.className = 't-team';
  teamInput.placeholder = 'Team name';
  teamInput.value = team || '';
  tdTeam.appendChild(teamInput);

  const tdRemove = document.createElement('td');
  tdRemove.className = 'row-remove';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 't-del';
  del.title = 'Remove row';
  del.textContent = '✕';
  del.addEventListener('click', () => {
    tr.remove();
    if (!targetsBody.querySelector('.t-url')) renderTargetsTable([]);
    renumberTargetRows();
    syncTargetsFromTable();
  });
  tdRemove.appendChild(del);

  tr.appendChild(tdIndex);
  tr.appendChild(tdUrl);
  tr.appendChild(tdTeam);
  tr.appendChild(tdRemove);
  return tr;
}

function renumberTargetRows() {
  const rows = targetsBody.querySelectorAll('tr');
  let i = 0;
  rows.forEach((tr) => {
    const idxCell = tr.querySelector('.row-index');
    if (idxCell) idxCell.textContent = String(++i);
  });
}

function renderTargetsTable(rows) {
  targetsBody.innerHTML = '';
  const list = rows || [];
  if (!list.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'targets-empty';
    td.textContent = 'No pages yet — load a CSV, or use “Add row”.';
    tr.appendChild(td);
    targetsBody.appendChild(tr);
    return;
  }
  list.forEach((r) => targetsBody.appendChild(makeTargetRow(r.page_url, r.page_teams)));
  renumberTargetRows();
}

function readTargetsTable() {
  const out = [];
  targetsBody.querySelectorAll('tr').forEach((tr) => {
    const url = (tr.querySelector('.t-url')?.value || '').trim();
    const team = (tr.querySelector('.t-team')?.value || '').trim();
    tr.classList.toggle('row-invalid', !!url && !/^https?:\/\//i.test(url));
    if (!url) return;
    out.push({ page_url: url, page_teams: team });
  });
  return out;
}

/** Recompute `pages` + counts + toolbar from whatever is currently in the table. */
function syncTargetsFromTable() {
  pages = readTargetsTable();
  const n = pages.length;
  rowSummaryEl.textContent = n ? `${n} page${n === 1 ? '' : 's'}` : '0 pages';
  refreshToolbar();
}

function addTargetRow(url, team) {
  const emptyRow = targetsBody.querySelector('.targets-empty');
  if (emptyRow && emptyRow.parentElement) emptyRow.parentElement.remove();
  targetsBody.appendChild(makeTargetRow(url, team));
  renumberTargetRows();
  syncTargetsFromTable();
}

/* ─── Guardrails / run options ────────────────────────────────────────── */

function parseAllowedOriginInput() {
  const raw = (allowedOriginInput.value || '').trim();
  if (!raw) return 'https://arts.ucalgary.ca';
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (u.protocol !== 'https:') return 'https://arts.ucalgary.ca';
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'https://arts.ucalgary.ca';
  }
}

/** Point the "Allowed site" guardrail at whatever tab the user selected. */
async function syncAllowedOriginFromTab() {
  const tid = getSelectedTabId();
  if (!tid) return;
  try {
    const tab = await chrome.tabs.get(tid);
    const u = new URL(tab.url);
    if (u.protocol === 'https:') {
      allowedOriginInput.value = `${u.protocol}//${u.host}`;
      await saveRunOptionsToStorage();
    }
  } catch {
    /* ignore */
  }
}

function buildGuardrailPayload() {
  return {
    allowedOrigin: parseAllowedOriginInput(),
    pathPrefix: (pathPrefixInput.value || '').trim(),
    maxPages: Math.max(0, parseInt(maxPagesInput.value, 10) || 0),
    maxAssignments: Math.max(0, parseInt(maxAssignmentsInput.value, 10) || 0),
    assignGapMs: Math.max(0, parseInt(assignGapMsInput.value, 10) || 0),
    postSaveWaitMs: Math.max(0, parseInt(postSaveWaitMsInput.value, 10) || 0),
    anomalyAutoPauseEnabled: !!anomalyAutoPauseEnabled.checked,
    anomalyMinSample: Math.max(0, parseInt(anomalyMinSample.value, 10) || 0),
    anomalyErrorRatePct: Math.max(0, parseInt(anomalyErrorRatePct.value, 10) || 0),
    anomalyConsecutiveTeamNotFound: Math.max(0, parseInt(anomalyConsecutiveTeamNotFound.value, 10) || 0),
    anomalyReceiverErrorsInWindow: Math.max(0, parseInt(anomalyReceiverErrorsInWindow.value, 10) || 0),
    anomalyWindowSize: Math.max(1, parseInt(anomalyWindowSize.value, 10) || 1)
  };
}

async function saveRunOptionsToStorage() {
  const g = buildGuardrailPayload();
  await chrome.storage.local.set({
    renderWaitMs: Math.max(0, parseInt(renderWaitMsInput.value, 10) || 0),
    assignPageTeam: !!assignPageTeamCheckbox.checked,
    guardrailAllowedOrigin: g.allowedOrigin,
    guardrailPathPrefix: g.pathPrefix,
    guardrailMaxPages: g.maxPages,
    guardrailMaxAssignments: g.maxAssignments,
    guardrailAssignGapMs: g.assignGapMs,
    guardrailPostSaveWaitMs: g.postSaveWaitMs,
    anomalyAutoPauseEnabled: g.anomalyAutoPauseEnabled,
    anomalyMinSample: g.anomalyMinSample,
    anomalyErrorRatePct: g.anomalyErrorRatePct,
    anomalyConsecutiveTeamNotFound: g.anomalyConsecutiveTeamNotFound,
    anomalyReceiverErrorsInWindow: g.anomalyReceiverErrorsInWindow,
    anomalyWindowSize: g.anomalyWindowSize
  });
}

async function loadRunOptionsFromStorage() {
  const data = await chrome.storage.local.get([
    'renderWaitMs',
    'assignPageTeam',
    'guardrailAllowedOrigin',
    'guardrailPathPrefix',
    'guardrailMaxPages',
    'guardrailMaxAssignments',
    'guardrailAssignGapMs',
    'guardrailPostSaveWaitMs',
    'anomalyAutoPauseEnabled',
    'anomalyMinSample',
    'anomalyErrorRatePct',
    'anomalyConsecutiveTeamNotFound',
    'anomalyReceiverErrorsInWindow',
    'anomalyWindowSize'
  ]);
  if (typeof data.renderWaitMs === 'number') renderWaitMsInput.value = String(data.renderWaitMs);
  if (typeof data.assignPageTeam === 'boolean') assignPageTeamCheckbox.checked = data.assignPageTeam;
  if (typeof data.guardrailAllowedOrigin === 'string' && data.guardrailAllowedOrigin) {
    allowedOriginInput.value = data.guardrailAllowedOrigin;
  } else {
    allowedOriginInput.value = 'https://arts.ucalgary.ca';
  }
  if (typeof data.guardrailPathPrefix === 'string') pathPrefixInput.value = data.guardrailPathPrefix;
  if (typeof data.guardrailMaxPages === 'number') maxPagesInput.value = String(data.guardrailMaxPages);
  if (typeof data.guardrailMaxAssignments === 'number') {
    maxAssignmentsInput.value = String(data.guardrailMaxAssignments);
  }
  if (typeof data.guardrailAssignGapMs === 'number') {
    assignGapMsInput.value = String(data.guardrailAssignGapMs);
  }
  if (typeof data.guardrailPostSaveWaitMs === 'number') {
    postSaveWaitMsInput.value = String(data.guardrailPostSaveWaitMs);
  }
  if (typeof data.anomalyAutoPauseEnabled === 'boolean') {
    anomalyAutoPauseEnabled.checked = data.anomalyAutoPauseEnabled;
  }
  if (typeof data.anomalyMinSample === 'number') anomalyMinSample.value = String(data.anomalyMinSample);
  if (typeof data.anomalyErrorRatePct === 'number') {
    anomalyErrorRatePct.value = String(data.anomalyErrorRatePct);
  }
  if (typeof data.anomalyConsecutiveTeamNotFound === 'number') {
    anomalyConsecutiveTeamNotFound.value = String(data.anomalyConsecutiveTeamNotFound);
  }
  if (typeof data.anomalyReceiverErrorsInWindow === 'number') {
    anomalyReceiverErrorsInWindow.value = String(data.anomalyReceiverErrorsInWindow);
  }
  if (typeof data.anomalyWindowSize === 'number') {
    anomalyWindowSize.value = String(data.anomalyWindowSize);
  }
}

/* ─── CSV file load ───────────────────────────────────────────────────── */

csvFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  inputFileName = file.name;
  try {
    const text = await file.text();
    const parsed = parseCsv(text);
    fileSummaryEl.textContent = inputFileName;
    renderTargetsTable(parsed);
    syncTargetsFromTable();
    if (!pages.length) {
      targetsStatus.textContent = 'No usable rows found. Each row needs a URL, a comma, then a team.';
      return;
    }
    await pushPagesToBackground();
    setRunningState(false);
    targetsStatus.textContent = `Loaded ${pages.length} page(s). Edit if needed, then Save targets or Run.`;
    appendActivityLine({
      level: 'info',
      message: `Loaded CSV: ${pages.length} pages`,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    appendActivityLine({
      level: 'error',
      message: `Error reading CSV: ${String(err)}`,
      timestamp: new Date().toISOString()
    });
  }
});

async function pushPagesToBackground() {
  await saveRunOptionsToStorage();
  const g = buildGuardrailPayload();
  await chrome.runtime.sendMessage({
    type: 'SET_BLOCKS',
    blocks: pages,
    inputFileName,
    targetTabId: getSelectedTabId(),
    renderWaitMs: Math.max(0, parseInt(renderWaitMsInput.value, 10) || 0),
    assignPageTeam: !!assignPageTeamCheckbox.checked,
    ...g
  });
}

function buildStartRunMessage(mode, limit) {
  const g = buildGuardrailPayload();
  return {
    type: 'START_RUN',
    mode,
    limit: mode === 'test' ? limit || 1 : undefined,
    targetTabId: getSelectedTabId(),
    renderWaitMs: Math.max(0, parseInt(renderWaitMsInput.value, 10) || 0),
    assignPageTeam: !!assignPageTeamCheckbox.checked,
    ...g
  };
}

function refreshToolbar() {
  testRunBtn.disabled = isRunning || !pages.length;
  fullRunBtn.disabled = isRunning || !pages.length;
  stopRunBtn.disabled = !isRunning;
  runBadge.textContent = isRunning ? 'Running' : 'Ready';
  runBadge.classList.toggle('running', isRunning);
}

function setRunningState(running) {
  isRunning = running;
  refreshToolbar();
}

function openAutoPauseModal(reason) {
  autoPauseReason.textContent = reason || 'Paused due to anomaly thresholds.';
  autoPauseModal.classList.add('open');
}

function closeAutoPauseModal() {
  autoPauseModal.classList.remove('open');
}

/* ─── run analytics ───────────────────────────────────────────────────── */

function isEntryOk(e) {
  return e.status === 'success' || e.status === 'already_set';
}

function entryType(e) {
  if (e.status === 'skipped_invalid_url') return 'skip';
  if (e.block_label === '(page team)') return 'page';
  return 'block';
}

function resetAnalytics() {
  runEntries = [];
  scannedPageUrls = new Set();
  recomputeAnalytics();
}

function recomputeAnalytics() {
  const blocks = runEntries.filter((e) => entryType(e) === 'block');
  const failures = runEntries.filter((e) => !isEntryOk(e));

  statPages.textContent = String(scannedPageUrls.size);
  statBlocks.textContent = String(blocks.length);
  statOk.textContent = String(runEntries.filter(isEntryOk).length);
  statFail.textContent = String(failures.length);

  failuresHeading.textContent = failures.length
    ? `Needs attention (${failures.length})`
    : 'Needs attention';
  copyFailuresBtn.disabled = failures.length === 0;
  renderFailures(failures);
}

function failureChip(type) {
  if (type === 'skip') return { cls: 'type-skip', text: 'Skipped' };
  if (type === 'page') return { cls: 'type-page', text: 'Page team' };
  return { cls: 'type-block', text: 'Block' };
}

function makeLink(href, text) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  return a;
}

function makeFailureRow(e) {
  const type = entryType(e);
  const chipInfo = failureChip(type);

  const row = document.createElement('div');
  row.className = 'failure';

  const chip = document.createElement('span');
  chip.className = `failure-chip ${chipInfo.cls}`;
  chip.textContent = chipInfo.text;

  const main = document.createElement('div');
  main.className = 'failure-main';

  const title = document.createElement('div');
  title.className = 'failure-title';
  const labelText =
    type === 'skip'
      ? 'Page skipped (outside allowed site)'
      : type === 'page'
        ? 'Page team not set'
        : `Block: ${e.block_label || 'unknown'}`;
  title.textContent = `${labelText} — `;
  const statusSpan = document.createElement('span');
  statusSpan.className = 'failure-status';
  statusSpan.textContent = e.status;
  title.appendChild(statusSpan);
  main.appendChild(title);

  const links = document.createElement('div');
  links.className = 'failure-links';
  if (e.page_url) links.appendChild(makeLink(e.page_url, 'Open page'));
  if (e.block_edit_url && e.block_edit_url !== e.page_url) {
    links.appendChild(makeLink(e.block_edit_url, type === 'page' ? 'Open edit form' : 'Open block'));
  }
  if (links.childNodes.length) main.appendChild(links);

  if (e.notes) {
    const notes = document.createElement('div');
    notes.className = 'failure-notes';
    notes.textContent = e.notes;
    main.appendChild(notes);
  }

  row.appendChild(chip);
  row.appendChild(main);
  return row;
}

function renderFailures(failures) {
  failuresList.innerHTML = '';
  if (!failures.length) {
    const empty = document.createElement('div');
    empty.className = 'failures-empty';
    empty.textContent = runEntries.length ? 'No failures so far. ✅' : 'Nothing to show yet — failures and skipped pages will appear here during a run.';
    failuresList.appendChild(empty);
    return;
  }
  for (let i = failures.length - 1; i >= 0; i--) {
    failuresList.appendChild(makeFailureRow(failures[i]));
  }
}

/* ─── output.csv (live file + on-demand download) ─────────────────────── */

function formatOutputCsvRow(row) {
  const keys = [
    'page_title',
    'page_url',
    'page_team',
    'blocks_no_team_before',
    'blocks_no_team_after',
    'page_team_status'
  ];
  return keys
    .map((k) => {
      const raw = row && row[k] != null ? row[k] : '';
      return `"${String(raw).replace(/"/g, '""')}"`;
    })
    .join(',');
}

async function writeOutputCsvToFile() {
  if (!outputFileHandle) return;
  const header =
    'page_title,page_url,page_team,blocks_no_team_before,blocks_no_team_after,page_team_status';
  const lines = [header, ...outputCsvRows.map(formatOutputCsvRow)];
  try {
    const writable = await outputFileHandle.createWritable();
    await writable.write(lines.join('\n') + '\n');
    await writable.close();
  } catch (e) {
    appendActivityLine({
      level: 'error',
      message: `Output file write failed: ${String(e)}`,
      timestamp: new Date().toISOString()
    });
  }
}

setOutputFileBtn.addEventListener('click', async () => {
  try {
    outputFileHandle = await window.showSaveFilePicker({
      suggestedName: 'output.csv',
      types: [{ description: 'CSV files', accept: { 'text/csv': ['.csv'] } }]
    });
    outputFileStatus.textContent = outputFileHandle.name;
    appendActivityLine({
      level: 'success',
      message: `Output file set: ${outputFileHandle.name}`,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    if (e.name !== 'AbortError') {
      appendActivityLine({
        level: 'error',
        message: `Failed to pick output file: ${String(e)}`,
        timestamp: new Date().toISOString()
      });
    }
  }
});

/* ─── option change listeners ─────────────────────────────────────────── */

renderWaitMsInput.addEventListener('change', () => saveRunOptionsToStorage());
assignPageTeamCheckbox.addEventListener('change', () => saveRunOptionsToStorage());

[
  allowedOriginInput,
  pathPrefixInput,
  maxPagesInput,
  maxAssignmentsInput,
  assignGapMsInput,
  postSaveWaitMsInput,
  anomalyAutoPauseEnabled,
  anomalyMinSample,
  anomalyErrorRatePct,
  anomalyConsecutiveTeamNotFound,
  anomalyReceiverErrorsInWindow,
  anomalyWindowSize
].forEach((el) => el.addEventListener('change', () => saveRunOptionsToStorage()));

tabSelect.addEventListener('change', () => {
  syncAllowedOriginFromTab();
});

/* ─── targets table events ────────────────────────────────────────────── */

targetsBody.addEventListener('input', (e) => {
  if (e.target && (e.target.classList.contains('t-url') || e.target.classList.contains('t-team'))) {
    syncTargetsFromTable();
  }
});

addTargetBtn.addEventListener('click', () => {
  addTargetRow('', '');
  targetsStatus.textContent = 'Added an empty row.';
});

saveTargetsBtn.addEventListener('click', async () => {
  syncTargetsFromTable();
  renderTargetsTable(pages); // normalise (drops blank rows, re-numbers)
  syncTargetsFromTable();
  await pushPagesToBackground();
  targetsStatus.textContent = pages.length
    ? `Saved ${pages.length} target(s).`
    : 'No targets to save — add at least one URL.';
  appendActivityLine({
    level: 'success',
    message: `Targets saved: ${pages.length} page(s)`,
    timestamp: new Date().toISOString()
  });
});

downloadCleanCsvBtn.addEventListener('click', () => {
  const rows = readTargetsTable();
  if (!rows.length) {
    targetsStatus.textContent = 'Nothing to download — add at least one URL.';
    return;
  }
  const header = 'page_url,team_name';
  const lines = [header];
  for (const r of rows) {
    const url = `"${String(r.page_url).replace(/"/g, '""')}"`;
    const team = `"${String(r.page_teams).replace(/"/g, '""')}"`;
    lines.push(`${url},${team}`);
  }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'targets_cleaned.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  targetsStatus.textContent = `Downloaded ${rows.length} cleaned row(s).`;
});

/* ─── run controls ────────────────────────────────────────────────────── */

addCurrentTabBtn.addEventListener('click', async () => {
  const tid = getSelectedTabId();
  if (!tid) {
    targetsStatus.textContent = 'Pick a site tab first (step 2).';
    return;
  }
  try {
    const tab = await chrome.tabs.get(tid);
    if (!tab.url) {
      targetsStatus.textContent = 'That tab has no URL.';
      return;
    }
    addTargetRow(tab.url, '');
    targetsStatus.textContent = 'Added the selected tab. Fill in its team, then Save targets.';
  } catch (e) {
    targetsStatus.textContent = `Could not read the tab: ${String(e)}`;
  }
});

testRunBtn.addEventListener('click', async () => {
  syncTargetsFromTable();
  if (!pages.length) return;
  outputCsvRows = [];
  resetAnalytics();
  await pushPagesToBackground();
  chrome.runtime.sendMessage(buildStartRunMessage('test', 1));
  setRunningState(true);
  writeOutputCsvToFile();
});

fullRunBtn.addEventListener('click', async () => {
  syncTargetsFromTable();
  if (!pages.length) return;
  outputCsvRows = [];
  resetAnalytics();
  await pushPagesToBackground();
  chrome.runtime.sendMessage(buildStartRunMessage('full'));
  setRunningState(true);
  writeOutputCsvToFile();
});

downloadLogBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_LOG' });
});

downloadOutputBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_OUTPUT_LOG' });
});

stopRunBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_RUN' });
});

copyFailuresBtn.addEventListener('click', async () => {
  const failures = runEntries.filter((e) => !isEntryOk(e));
  if (!failures.length) return;
  const lines = failures.map((e) => {
    const kind = entryType(e) === 'page' ? 'Page team' : entryType(e) === 'skip' ? 'Skipped' : e.block_label || 'Block';
    const parts = [e.status, kind, e.page_url];
    if (e.block_edit_url && e.block_edit_url !== e.page_url) parts.push(e.block_edit_url);
    if (e.notes) parts.push(`(${e.notes})`);
    return parts.filter(Boolean).join(' | ');
  });
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    appendActivityLine({
      level: 'success',
      message: `Copied ${lines.length} failed item(s) to clipboard`,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    appendActivityLine({
      level: 'error',
      message: `Copy failed: ${String(e)}`,
      timestamp: new Date().toISOString()
    });
  }
});

refreshTabsBtn.addEventListener('click', refreshTabList);

copyActivityBtn.addEventListener('click', async () => {
  const text = [...activityLogEl.querySelectorAll('.log-line')]
    .map((el) => el.textContent)
    .reverse()
    .join('\n');
  try {
    await navigator.clipboard.writeText(text || activityLines.map((x) => x.text).join('\n'));
    appendActivityLine({
      level: 'success',
      message: 'Activity log copied to clipboard',
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    appendActivityLine({
      level: 'error',
      message: `Copy failed: ${String(e)}`,
      timestamp: new Date().toISOString()
    });
  }
});

clearActivityBtn.addEventListener('click', async () => {
  activityLogEl.innerHTML = '';
  activityLines = [];
  await chrome.storage.session.remove(LOG_SESSION_KEY);
  appendActivityLine({
    level: 'info',
    message: 'Activity log cleared',
    timestamp: new Date().toISOString()
  });
});

autoPauseCloseBtn.addEventListener('click', () => {
  closeAutoPauseModal();
});

autoPauseResumeBtn.addEventListener('click', () => {
  closeAutoPauseModal();
  setRunningState(true);
  chrome.runtime.sendMessage({ type: 'RESUME_AUTO_PAUSE_PHASE2' });
});

/* ─── messages from background ────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG_ENTRY' && msg.entry) {
    appendActivityLine(msg.entry);
  }
  if (msg.type === 'RUN_ENTRY' && msg.entry) {
    runEntries.push(msg.entry);
    recomputeAnalytics();
  }
  if (msg.type === 'AUTO_PAUSED_PHASE2') {
    setRunningState(false);
    openAutoPauseModal(msg.reason || '');
    appendActivityLine({
      level: 'warn',
      message: `Auto-paused — ${msg.reason || 'threshold reached'}`,
      timestamp: new Date().toISOString()
    });
  }
  if (msg.type === 'PROGRESS_UPDATE') {
    const { currentIndex, total, successCount, errorCount, lastEntry, pageIndex, pageTotal } = msg;
    downloadLogBtn.disabled = total === 0;
    downloadOutputBtn.disabled = true;
    if (lastEntry) {
      appendActivityLine({
        level:
          lastEntry.status === 'success' || lastEntry.status === 'already_set'
            ? 'success'
            : lastEntry.status === 'error'
              ? 'error'
              : 'warn',
        message: `Block ${lastEntry.block_label || 'unknown'} — ${lastEntry.status}`,
        details: `${lastEntry.page_url || ''} ${lastEntry.notes || ''}`.trim(),
        timestamp: lastEntry.timestamp || new Date().toISOString()
      });
    }
    const pagePart = pageTotal ? `Page ${pageIndex}/${pageTotal} — ` : '';
    appendActivityLine({
      level: 'info',
      message: `${pagePart}block ${currentIndex}/${total} (ok: ${successCount}, err: ${errorCount})`,
      timestamp: new Date().toISOString()
    });
  }
  if (msg.type === 'PAGE_SUMMARY_UPDATE' && msg.summary) {
    outputCsvRows.push(msg.summary);
    if (msg.summary.page_url) scannedPageUrls.add(msg.summary.page_url);
    recomputeAnalytics();
    writeOutputCsvToFile();
  }
  if (msg.type === 'RUN_COMPLETE') {
    const { total, pageCount, successCount, errorCount } = msg;
    setRunningState(false);
    downloadLogBtn.disabled = total === 0;
    downloadOutputBtn.disabled = pageCount === 0;
    const pagesPart = typeof pageCount === 'number' ? `${pageCount} page(s), ` : '';
    appendActivityLine({
      level: 'success',
      message: `Run complete. ${pagesPart}${total} row(s): ok ${successCount}, other ${errorCount}`,
      timestamp: new Date().toISOString()
    });
  }
});

/* ─── init ────────────────────────────────────────────────────────────── */

(async function init() {
  await loadActivityLogFromSession();
  await loadRunOptionsFromStorage();
  await refreshTabList();
  renderTargetsTable([]);
  syncTargetsFromTable();
  appendActivityLine({
    level: 'info',
    message: 'Dashboard ready',
    timestamp: new Date().toISOString()
  });
  refreshToolbar();
})();
