const DASHBOARD_HOST_MATCH = 'https://arts.ucalgary.ca/';

const csvFileInput = document.getElementById('csvFile');
const testRunBtn = document.getElementById('testRunBtn');
const fullRunBtn = document.getElementById('fullRunBtn');
const downloadLogBtn = document.getElementById('downloadLogBtn');
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

let pages = [];
let inputFileName = '';
let activityLines = [];
let isRunning = false;

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
    opt.textContent = 'No arts.ucalgary.ca tabs open';
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

async function saveRunOptionsToStorage() {
  await chrome.storage.local.set({
    renderWaitMs: Math.max(0, parseInt(renderWaitMsInput.value, 10) || 0),
    teamSeparator: teamSeparatorSelect.value === ',' ? ',' : '|'
  });
}

async function loadRunOptionsFromStorage() {
  const { renderWaitMs, teamSeparator } = await chrome.storage.local.get([
    'renderWaitMs',
    'teamSeparator'
  ]);
  if (typeof renderWaitMs === 'number') renderWaitMsInput.value = String(renderWaitMs);
  if (teamSeparator === ',') teamSeparatorSelect.value = ',';
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
  await chrome.runtime.sendMessage({
    type: 'SET_BLOCKS',
    blocks: pages,
    inputFileName,
    targetTabId: getSelectedTabId(),
    renderWaitMs: Math.max(0, parseInt(renderWaitMsInput.value, 10) || 0),
    teamSeparator: teamSeparatorSelect.value === ',' ? ',' : '|'
  });
}

function setRunningState(running) {
  isRunning = running;
  testRunBtn.disabled = running || !pages.length;
  fullRunBtn.disabled = running || !pages.length;
  allBlocksBtn.disabled = running;
  stopRunBtn.disabled = !running;
  runBadge.textContent = running ? 'Running' : 'Ready';
  runBadge.classList.toggle('running', running);
}

teamSeparatorSelect.addEventListener('change', async () => {
  await saveRunOptionsToStorage();
});

renderWaitMsInput.addEventListener('change', () => saveRunOptionsToStorage());

testRunBtn.addEventListener('click', async () => {
  await pushPagesToBackground();
  chrome.runtime.sendMessage({
    type: 'START_RUN',
    mode: 'test',
    limit: 1,
    targetTabId: getSelectedTabId(),
    renderWaitMs: Math.max(0, parseInt(renderWaitMsInput.value, 10) || 0),
    teamSeparator: teamSeparatorSelect.value === ',' ? ',' : '|'
  });
  setRunningState(true);
});

fullRunBtn.addEventListener('click', async () => {
  await pushPagesToBackground();
  chrome.runtime.sendMessage({
    type: 'START_RUN',
    mode: 'full',
    targetTabId: getSelectedTabId(),
    renderWaitMs: Math.max(0, parseInt(renderWaitMsInput.value, 10) || 0),
    teamSeparator: teamSeparatorSelect.value === ',' ? ',' : '|'
  });
  setRunningState(true);
});

downloadLogBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_LOG' });
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
  if (!tab.url || !tab.url.startsWith('https://arts.ucalgary.ca')) {
    appendActivityLine({
      level: 'error',
      message: 'Selected tab must be an arts.ucalgary.ca page',
      timestamp: new Date().toISOString()
    });
    return;
  }
  pages = [{ page_url: tab.url, page_teams: '' }];
  inputFileName = '(selected tab)';
  fileSummaryEl.textContent = inputFileName;
  rowSummaryEl.textContent = '1 page – all blocks';
  await pushPagesToBackground();
  setRunningState(true);
  chrome.runtime.sendMessage({
    type: 'START_RUN',
    mode: 'full',
    targetTabId: getSelectedTabId(),
    renderWaitMs: Math.max(0, parseInt(renderWaitMsInput.value, 10) || 0),
    teamSeparator: teamSeparatorSelect.value === ',' ? ',' : '|'
  });
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG_ENTRY' && msg.entry) {
    appendActivityLine(msg.entry);
  }
  if (msg.type === 'PROGRESS_UPDATE') {
    const { currentIndex, total, successCount, errorCount, lastEntry } = msg;
    downloadLogBtn.disabled = total === 0;
    if (lastEntry) {
      appendActivityLine({
        level: lastEntry.status === 'success' ? 'success' : lastEntry.status === 'error' ? 'error' : 'warn',
        message: `Block ${lastEntry.block_label || 'unknown'} — ${lastEntry.status}`,
        details: `${lastEntry.page_url || ''} ${lastEntry.notes || ''}`.trim(),
        timestamp: lastEntry.timestamp || new Date().toISOString()
      });
    }
    appendActivityLine({
      level: 'info',
      message: `Progress: assignment ${currentIndex} / ${total} (ok: ${successCount}, err: ${errorCount})`,
      timestamp: new Date().toISOString()
    });
  }
  if (msg.type === 'RUN_COMPLETE') {
    const { total, pageCount, successCount, errorCount } = msg;
    setRunningState(false);
    downloadLogBtn.disabled = total === 0;
    const pagesPart =
      typeof pageCount === 'number' ? `${pageCount} page(s), ` : '';
    appendActivityLine({
      level: 'success',
      message: `Run complete. ${pagesPart}${total} assignment(s): success ${successCount}, errors ${errorCount}`,
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
})();
