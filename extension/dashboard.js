const DASHBOARD_HOST_MATCH = 'https://outdoor-centre.ucalgary.ca/';

const csvFileInput = document.getElementById('csvFile');
const testRunBtn = document.getElementById('testRunBtn');
const fullRunBtn = document.getElementById('fullRunBtn');
const downloadLogBtn = document.getElementById('downloadLogBtn');
const downloadOutputBtn = document.getElementById('downloadOutputBtn');
const stopRunBtn = document.getElementById('stopRunBtn');
const useCurrentPageBtn = document.getElementById('useCurrentPageBtn');
const allBlocksBtn = document.getElementById('allBlocksBtn');
const renderWaitMsInput = document.getElementById('renderWaitMs');
const teamSeparatorSelect = document.getElementById('teamSeparator');
const fileSummaryEl = document.getElementById('fileSummary');
const rowSummaryEl = document.getElementById('rowSummary');
const runBadge = document.getElementById('runBadge');
const tabSelect = document.getElementById('tabSelect');
const refreshTabsBtn = document.getElementById('refreshTabsBtn');
const rulesText = document.getElementById('rulesText');
const saveRulesBtn = document.getElementById('saveRulesBtn');
const resetRulesBtn = document.getElementById('resetRulesBtn');
const rulesStatus = document.getElementById('rulesStatus');
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
  const tabs = await chrome.tabs.query({ url: `${DASHBOARD_HOST_MATCH}*` });
  tabSelect.innerHTML = '';
  if (!tabs.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No outdoor-centre.ucalgary.ca tabs open';
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
}

function parseCsv(text, separator) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];

  const header = lines[0].split(',').map((h) => h.trim());
  const idxPageUrl = header.indexOf('page_url');
  const idxTeams = header.indexOf('page_teams');

  if (idxPageUrl === -1) {
    appendActivityLine({
      level: 'error',
      message: 'CSV must have a page_url column',
      timestamp: new Date().toISOString()
    });
    return [];
  }

  return lines
    .slice(1)
    .map((line) => {
      const cols = line.split(',');
      return {
        page_url: (cols[idxPageUrl] || '').trim(),
        page_teams: idxTeams === -1 ? '' : (cols[idxTeams] || '').trim()
      };
    })
    .filter((row) => row.page_url);
}

function parseAllowedOriginInput() {
  const raw = (allowedOriginInput.value || '').trim();
  if (!raw) return 'https://outdoor-centre.ucalgary.ca';
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (u.protocol !== 'https:') return 'https://outdoor-centre.ucalgary.ca';
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'https://outdoor-centre.ucalgary.ca';
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
    anomalyConsecutiveTeamNotFound: Math.max(
      0,
      parseInt(anomalyConsecutiveTeamNotFound.value, 10) || 0
    ),
    anomalyReceiverErrorsInWindow: Math.max(
      0,
      parseInt(anomalyReceiverErrorsInWindow.value, 10) || 0
    ),
    anomalyWindowSize: Math.max(1, parseInt(anomalyWindowSize.value, 10) || 1)
  };
}

async function saveRunOptionsToStorage() {
  const g = buildGuardrailPayload();
  await chrome.storage.local.set({
    renderWaitMs: Math.max(0, parseInt(renderWaitMsInput.value, 10) || 0),
    teamSeparator: teamSeparatorSelect.value === ',' ? ',' : '|',
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
    'teamSeparator',
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
  if (data.teamSeparator === ',') teamSeparatorSelect.value = ',';
  if (typeof data.guardrailAllowedOrigin === 'string' && data.guardrailAllowedOrigin) {
    allowedOriginInput.value = data.guardrailAllowedOrigin;
  } else {
    allowedOriginInput.value = 'https://outdoor-centre.ucalgary.ca';
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

async function loadRulesEditor() {
  try {
    const stored = await chrome.storage.local.get('rules');
    if (stored.rules) {
      rulesText.value = JSON.stringify(stored.rules, null, 2);
      rulesStatus.textContent = 'Loaded rules from storage.';
    } else {
      const res = await fetch(chrome.runtime.getURL('rules_default.json'));
      const json = await res.json();
      rulesText.value = JSON.stringify(json, null, 2);
      rulesStatus.textContent = 'Loaded default rules (not saved yet).';
    }
  } catch (e) {
    rulesStatus.textContent = `Error loading rules: ${String(e)}`;
  }
}

csvFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  inputFileName = file.name;
  try {
    const text = await file.text();
    const sep = teamSeparatorSelect.value === ',' ? ',' : '|';
    pages = parseCsv(text, sep);
    if (!pages.length) {
      fileSummaryEl.textContent = inputFileName;
      rowSummaryEl.textContent = '0 pages';
      testRunBtn.disabled = true;
      fullRunBtn.disabled = true;
      return;
    }
    fileSummaryEl.textContent = inputFileName;
    rowSummaryEl.textContent = `${pages.length} pages`;
    await pushPagesToBackground();
    setRunningState(false);
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
    teamSeparator: teamSeparatorSelect.value === ',' ? ',' : '|',
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
    teamSeparator: teamSeparatorSelect.value === ',' ? ',' : '|',
    ...g
  };
}

function refreshToolbar() {
  testRunBtn.disabled = isRunning || !pages.length;
  fullRunBtn.disabled = isRunning || !pages.length;
  allBlocksBtn.disabled = isRunning;
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

function formatOutputCsvRow(row) {
  const keys = ['page_title', 'page_url', 'page_team', 'blocks_no_team_before', 'blocks_no_team_after'];
  return keys
    .map((k) => {
      const raw = row && row[k] != null ? row[k] : '';
      return `"${String(raw).replace(/"/g, '""')}"`;
    })
    .join(',');
}

async function writeOutputCsvToFile() {
  if (!outputFileHandle) return;
  const header = 'page_title,page_url,page_team,blocks_no_team_before,blocks_no_team_after';
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

teamSeparatorSelect.addEventListener('change', async () => {
  await saveRunOptionsToStorage();
});

renderWaitMsInput.addEventListener('change', () => saveRunOptionsToStorage());

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

testRunBtn.addEventListener('click', async () => {
  outputCsvRows = [];
  await pushPagesToBackground();
  chrome.runtime.sendMessage(buildStartRunMessage('test', 1));
  setRunningState(true);
  writeOutputCsvToFile();
});

fullRunBtn.addEventListener('click', async () => {
  outputCsvRows = [];
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

useCurrentPageBtn.addEventListener('click', async () => {
  const tid = getSelectedTabId();
  if (!tid) {
    appendActivityLine({
      level: 'warn',
      message: 'Select a target tab first',
      timestamp: new Date().toISOString()
    });
    return;
  }
  const tab = await chrome.tabs.get(tid);
  if (!tab.url) {
    appendActivityLine({ level: 'error', message: 'Tab has no URL', timestamp: new Date().toISOString() });
    return;
  }
  pages = [{ page_url: tab.url, page_teams: '' }];
  inputFileName = '(selected tab)';
  fileSummaryEl.textContent = inputFileName;
  rowSummaryEl.textContent = '1 page';
  await pushPagesToBackground();
  setRunningState(false);
  appendActivityLine({
    level: 'info',
    message: `Single-page run URL: ${tab.url}`,
    timestamp: new Date().toISOString()
  });
});

allBlocksBtn.addEventListener('click', async () => {
  const tid = getSelectedTabId();
  if (!tid) {
    appendActivityLine({
      level: 'warn',
      message: 'Select a target tab first',
      timestamp: new Date().toISOString()
    });
    return;
  }
  const tab = await chrome.tabs.get(tid);
  if (!tab.url || !tab.url.startsWith('https://outdoor-centre.ucalgary.ca')) {
    appendActivityLine({
      level: 'error',
      message: 'Selected tab must be an outdoor-centre.ucalgary.ca page',
      timestamp: new Date().toISOString()
    });
    return;
  }
  pages = [{ page_url: tab.url, page_teams: '' }];
  inputFileName = '(selected tab)';
  fileSummaryEl.textContent = inputFileName;
  rowSummaryEl.textContent = '1 page – all blocks';
  outputCsvRows = [];
  await pushPagesToBackground();
  chrome.runtime.sendMessage(buildStartRunMessage('full'));
  setRunningState(true);
  writeOutputCsvToFile();
});

refreshTabsBtn.addEventListener('click', refreshTabList);

saveRulesBtn.addEventListener('click', async () => {
  try {
    const parsed = JSON.parse(rulesText.value);
    await chrome.storage.local.set({ rules: parsed });
    rulesStatus.textContent = 'Rules saved.';
    appendActivityLine({
      level: 'success',
      message: 'Rules saved to storage',
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    rulesStatus.textContent = `Invalid JSON: ${String(e)}`;
  }
});

resetRulesBtn.addEventListener('click', async () => {
  try {
    const res = await fetch(chrome.runtime.getURL('rules_default.json'));
    const json = await res.json();
    await chrome.storage.local.set({ rules: json });
    rulesText.value = JSON.stringify(json, null, 2);
    rulesStatus.textContent = 'Reset to default rules.';
    appendActivityLine({
      level: 'info',
      message: 'Rules reset to defaults',
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    rulesStatus.textContent = `Error: ${String(e)}`;
  }
});

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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG_ENTRY' && msg.entry) {
    appendActivityLine(msg.entry);
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
    writeOutputCsvToFile();
  }
  if (msg.type === 'RUN_COMPLETE') {
    const { total, pageCount, successCount, errorCount } = msg;
    setRunningState(false);
    downloadLogBtn.disabled = total === 0;
    downloadOutputBtn.disabled = pageCount === 0;
    const pagesPart =
      typeof pageCount === 'number' ? `${pageCount} page(s), ` : '';
    appendActivityLine({
      level: 'success',
      message: `Run complete. ${pagesPart}${total} row(s): ok ${successCount}, other ${errorCount}`,
      timestamp: new Date().toISOString()
    });
  }
});

(async function init() {
  await loadActivityLogFromSession();
  await loadRunOptionsFromStorage();
  await refreshTabList();
  await loadRulesEditor();
  appendActivityLine({
    level: 'info',
    message: 'Dashboard ready',
    timestamp: new Date().toISOString()
  });
  refreshToolbar();
})();
