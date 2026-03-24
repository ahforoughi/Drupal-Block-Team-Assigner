let pages = [];
let inputFileName = '';
let logEntries = [];
let running = false;
let cancelRequested = false;
let runTabId = null;
let renderWaitMs = 1200;
let teamSeparator = '|';

function emitLog(level, message, details) {
  const entry = {
    level: level || 'info',
    message: message || '',
    details: details || '',
    timestamp: new Date().toISOString()
  };
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', entry }).catch(() => {});
}

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('dashboard.html');
  const tabs = await chrome.tabs.query({ url: url + '*' });
  if (tabs.length > 0) {
    const t = tabs[0];
    await chrome.tabs.update(t.id, { active: true });
    if (t.windowId != null) {
      await chrome.windows.update(t.windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SET_BLOCKS') {
    pages = msg.blocks || [];
    inputFileName = msg.inputFileName || '';
    if (msg.targetTabId != null && msg.targetTabId !== '') {
      const tid =
        typeof msg.targetTabId === 'number' ? msg.targetTabId : parseInt(msg.targetTabId, 10);
      runTabId = Number.isFinite(tid) ? tid : null;
    } else {
      runTabId = null;
    }
    if (typeof msg.renderWaitMs === 'number') renderWaitMs = msg.renderWaitMs;
    if (msg.teamSeparator === ',' || msg.teamSeparator === '|') teamSeparator = msg.teamSeparator;
    logEntries = [];
  }

  if (msg.type === 'START_RUN') {
    if (running || !pages.length) return;
    running = true;
    cancelRequested = false;
    if (msg.targetTabId != null && msg.targetTabId !== '') {
      const tid =
        typeof msg.targetTabId === 'number' ? msg.targetTabId : parseInt(msg.targetTabId, 10);
      if (Number.isFinite(tid)) runTabId = tid;
    }
    if (typeof msg.renderWaitMs === 'number') renderWaitMs = msg.renderWaitMs;
    if (msg.teamSeparator === ',' || msg.teamSeparator === '|') teamSeparator = msg.teamSeparator;
    const pageLimit = msg.mode === 'test' ? msg.limit || 1 : pages.length;
    const testFirstBlockOnly = msg.mode === 'test';
    runPages(pageLimit, testFirstBlockOnly).finally(() => {
      running = false;
      const pageCount = Math.min(pageLimit, pages.length);
      chrome.runtime.sendMessage({
        type: 'RUN_COMPLETE',
        total: logEntries.length,
        pageCount,
        successCount: logEntries.filter((l) => l.status === 'success').length,
        errorCount: logEntries.filter((l) => l.status !== 'success').length
      }).catch(() => {});
    });
  }

  if (msg.type === 'DOWNLOAD_LOG') {
    downloadLogCsv();
  }

  if (msg.type === 'STOP_RUN') {
    cancelRequested = true;
    emitLog('warn', 'Stop requested', '');
  }

});

async function runPages(pageLimit, testFirstBlockOnly) {
  const rules = await loadRules();

  const tabId = runTabId;

  if (!tabId) {
    emitLog('error', 'No target tab selected', 'Choose a tab in the dashboard (Target tab) before running.');
    return;
  }

  const pageCount = Math.min(pageLimit, pages.length);
  emitLog(
    'info',
    'Run started',
    `${pageCount} page(s), ${testFirstBlockOnly ? 'test (first block per page only)' : 'full (all blocks)'}, tab ${tabId}`
  );

  const pagePlans = [];

  emitLog('info', 'Phase 1: scan all pages', `Visiting ${pageCount} page(s) to list blocks only.`);

  for (let i = 0; i < pageCount; i += 1) {
    if (cancelRequested) break;
    const page = pages[i];

    try {
      emitLog('info', `Scan: navigate`, page.page_url);
      await chrome.tabs.update(tabId, { url: page.page_url });
      await waitForTabComplete(tabId);
      if (renderWaitMs > 0) {
        await sleep(renderWaitMs);
      }

      const scanResult = await sendScanBlocks(tabId);
      const blocks = (scanResult && scanResult.blocks) || [];
      if (scanResult && scanResult.error) {
        emitLog('warn', 'Scan warning', scanResult.error);
      }
      emitLog('info', `Scan: done`, `page ${i + 1}/${pageCount} — ${blocks.length} block(s)`);
      pagePlans.push({ page, blocks });
    } catch (err) {
      const errMsg = String(err);
      emitLog('error', `Scan: page error`, errMsg);
      pagePlans.push({ page, blocks: [], scanError: errMsg });
    }
  }

  if (cancelRequested) {
    emitLog('warn', 'Run cancelled', 'Stopped after scan phase.');
    return;
  }

  const blockTotal = pagePlans.reduce((sum, p) => sum + (p.blocks && p.blocks.length ? p.blocks.length : 0), 0);
  emitLog(
    'info',
    'Phase 1 complete',
    `${pagePlans.length} page(s), ${blockTotal} block(s) found on the page(s).`
  );

  if (testFirstBlockOnly && blockTotal > 1) {
    emitLog(
      'info',
      'Test mode',
      `Only the first block per page will be assigned (${blockTotal} scanned). Use Full batch for every block.`
    );
  }

  const workQueue = [];
  for (const plan of pagePlans) {
    const { page, blocks } = plan;
    const slice = testFirstBlockOnly ? blocks.slice(0, 1) : blocks;
    for (let bi = 0; bi < slice.length; bi += 1) {
      const block = slice[bi];
      if (block.hasTeam) continue;
      workQueue.push({ page, blockIndex: bi, block });
    }
  }

  if (!workQueue.length) {
    emitLog('info', 'Phase 2 skipped', 'No blocks to assign (empty or all skipped).');
    return;
  }

  emitLog(
    'info',
    'Phase 2: assign teams',
    `${workQueue.length} block assignment(s) queued.`
  );

  let prevPageUrl = null;
  const progressTotal = workQueue.length;

  for (let wi = 0; wi < workQueue.length; wi += 1) {
    if (cancelRequested) break;
    const { page, blockIndex, block } = workQueue[wi];

    try {
      if (wi > 0) {
        await sleep(800);
      }
      if (page.page_url !== prevPageUrl) {
        emitLog('info', `Assign: navigate`, page.page_url);
        await chrome.tabs.update(tabId, { url: page.page_url });
        await waitForTabComplete(tabId);
        if (renderWaitMs > 0) {
          await sleep(renderWaitMs);
        }
        prevPageUrl = page.page_url;
      }

      const teamName = getTeamForPage(page, rules, teamSeparator);
      let status = 'no_rule_match';
      let notes = '';

      if (!teamName) {
        notes = 'no matching team for page';
      } else if (!block.editUrl) {
        status = 'error';
        notes = 'missing editUrl for block';
      } else {
        try {
          emitLog(
            'info',
            `Assign team (${wi + 1}/${progressTotal})`,
            `${teamName} — ${block.label || ''} [index ${blockIndex}]`
          );
          const result = await sendAssignTeam(tabId, teamName, blockIndex);
          status = result.status;
          notes = result.notes || '';
          emitLog(status === 'success' ? 'success' : 'warn', `Assign result: ${status}`, notes);
        } catch (err) {
          status = 'error';
          notes = String(err);
          emitLog('error', 'Assign threw', notes);
        }
      }

      logEntries.push({
        page_url: page.page_url,
        block_label: block.label || '',
        block_edit_url: block.editUrl || '',
        team_name: teamName || '',
        status,
        notes,
        timestamp: new Date().toISOString()
      });

      chrome.runtime
        .sendMessage({
          type: 'PROGRESS_UPDATE',
          currentIndex: wi + 1,
          total: progressTotal,
          successCount: logEntries.filter((l) => l.status === 'success').length,
          errorCount: logEntries.filter((l) => l.status !== 'success').length,
          lastEntry: logEntries[logEntries.length - 1]
        })
        .catch(() => {});
    } catch (err) {
      const errMsg = String(err);
      emitLog('error', `Assign: error`, errMsg);
      logEntries.push({
        page_url: page.page_url,
        block_label: block.label || '',
        block_edit_url: block.editUrl || '',
        team_name: '',
        status: 'error',
        notes: errMsg,
        timestamp: new Date().toISOString()
      });

      chrome.runtime
        .sendMessage({
          type: 'PROGRESS_UPDATE',
          currentIndex: wi + 1,
          total: progressTotal,
          successCount: logEntries.filter((l) => l.status === 'success').length,
          errorCount: logEntries.filter((l) => l.status !== 'success').length,
          lastEntry: logEntries[logEntries.length - 1]
        })
        .catch(() => {});
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadRules() {
  const stored = await chrome.storage.local.get('rules');
  if (stored.rules) return stored.rules;

  const res = await fetch(chrome.runtime.getURL('rules_default.json'));
  const json = await res.json();
  return json;
}

function getTeamForUrl(url, rulesObj) {
  const urlNorm = (url || '').toLowerCase();
  const rules = rulesObj.rules || [];

  for (const r of rules) {
    const pattern = (r.pattern || '').toLowerCase();
    if (pattern && urlNorm.includes(pattern)) {
      return { teamName: r.team_name, reason: `matched pattern ${r.pattern}` };
    }
  }

  if (rulesObj.default_team) {
    return { teamName: rulesObj.default_team, reason: 'default_team' };
  }

  return { teamName: null, reason: 'no matching rule' };
}

function getTeamForPage(page, rulesObj, sep) {
  const separator = sep === ',' ? ',' : '|';
  if (page.page_teams) {
    const first = page.page_teams.split(separator)[0].trim();
    if (first) return first;
  }
  const byUrl = getTeamForUrl(page.page_url, rulesObj);
  return byUrl.teamName;
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function isTransientReceiverError(msg) {
  const s = msg || '';
  return (
    s.indexOf('Receiving end does not exist') !== -1 ||
    s.indexOf('Could not establish connection') !== -1 ||
    s.indexOf('message port closed') !== -1
  );
}

/**
 * Content scripts inject at document_idle; right after load or save/navigation
 * there may be no listener yet. Retry before failing.
 */
function sendTabMessageWithRetry(tabId, message, maxAttempts, delayMs) {
  const attempts = typeof maxAttempts === 'number' ? maxAttempts : 25;
  const delay = typeof delayMs === 'number' ? delayMs : 200;
  return new Promise((resolve) => {
    let attempt = 0;
    function trySend() {
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError.message || String(chrome.runtime.lastError);
            if (attempt < attempts && isTransientReceiverError(errMsg)) {
              attempt += 1;
              setTimeout(trySend, delay);
              return;
            }
            resolve({ ok: false, error: errMsg, response: null });
            return;
          }
          resolve({ ok: true, error: null, response });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e), response: null });
      }
    }
    trySend();
  });
}

async function sendAssignTeam(tabId, teamName, blockIndex) {
  const { ok, error, response } = await sendTabMessageWithRetry(
    tabId,
    { type: 'ASSIGN_TEAM', teamName, blockIndex },
    25,
    200
  );
  if (!ok) {
    return {
      status: 'error',
      notes: `no receiver for ASSIGN_TEAM: ${error}`
    };
  }
  return response || { status: 'error', notes: 'no response from content script' };
}

async function sendScanBlocks(tabId) {
  const { ok, error, response } = await sendTabMessageWithRetry(
    tabId,
    { type: 'SCAN_BLOCKS' },
    25,
    200
  );
  if (!ok) {
    return {
      blocks: [],
      error: `no receiver for SCAN_BLOCKS: ${error}`
    };
  }
  return response || { blocks: [] };
}

function downloadLogCsv() {
  if (!logEntries.length) return;

  const header = [
    'page_url',
    'block_label',
    'block_edit_url',
    'team_name',
    'status',
    'notes',
    'timestamp'
  ];
  const lines = [header.join(',')];

  for (const row of logEntries) {
    const line = header
      .map((key) => {
        const raw = String(row[key] || '');
        const escaped = raw.replace(/"/g, '""');
        return `"${escaped}"`;
      })
      .join(',');
    lines.push(line);
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download({
    url,
    filename: 'run_log.csv',
    saveAs: true
  });
}
