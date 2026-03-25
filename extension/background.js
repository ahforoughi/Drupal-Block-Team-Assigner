let pages = [];
let inputFileName = '';
let logEntries = [];
let pageSummaries = [];
let running = false;
let cancelRequested = false;
let runTabId = null;
let renderWaitMs = 1200;
let teamSeparator = '|';

const ASSIGN_ALARM = 'assign_continue';
const ASSIGN_BATCH_SIZE = 3;
/** Pause between batches so the service worker can yield (MV3). */
const ASSIGN_ALARM_DELAY_MIN = 4 / 60;

const STORAGE_KEYS = {
  runCancel: 'runCancelV1',
  runActive: 'runActiveV1',
  phase2Chunk: 'phase2ChunkV1',
  pendingPhase2: 'pendingPhase2ConfirmV1',
  autoPausePhase2: 'autoPausePhase2V1',
  outputPageSummaries: 'outputPageSummariesV1'
};

let guardrails = {
  allowedOrigin: 'https://arts.ucalgary.ca',
  pathPrefix: '',
  maxPages: 0,
  maxAssignments: 0,
  assignGapMs: 800,
  postSaveWaitMs: 1200,
  anomalyAutoPauseEnabled: true,
  anomalyMinSample: 10,
  anomalyErrorRatePct: 15,
  anomalyConsecutiveTeamNotFound: 3,
  anomalyReceiverErrorsInWindow: 2,
  anomalyWindowSize: 10
};

/** Count as “ok” for progress (block already had the team). */
function isAssignmentOk(status) {
  return status === 'success' || status === 'already_set';
}

function emitAssignResultLog(status, notes) {
  if (isAssignmentOk(status)) {
    emitLog('success', `Assign result: ${status}`, notes || '');
  } else if (status === 'error') {
    emitLog('error', `Assign result: ${status}`, notes || '');
  } else {
    emitLog('warn', `Assign result: ${status}`, notes || '');
  }
}

function emitLog(level, message, details) {
  const entry = {
    level: level || 'info',
    message: message || '',
    details: details || '',
    timestamp: new Date().toISOString()
  };
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', entry }).catch(() => {});
}

function normalizePathPrefix(prefix) {
  const p = (prefix || '').trim();
  if (!p) return '';
  return p.startsWith('/') ? p : `/${p}`;
}

/**
 * Allowed URL: https only, origin match, optional path prefix on pathname.
 */
function isPageUrlAllowed(urlStr, allowedOrigin, pathPrefix) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  const trimmed = urlStr.trim();
  if (trimmed.toLowerCase().indexOf('javascript:') === 0) return false;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'https:') return false;
    const want = new URL(allowedOrigin);
    if (u.origin !== want.origin) return false;
    const prefix = normalizePathPrefix(pathPrefix);
    if (prefix && !u.pathname.startsWith(prefix)) return false;
    return true;
  } catch {
    return false;
  }
}

async function setRunCancelled() {
  await chrome.storage.local.set({ [STORAGE_KEYS.runCancel]: true });
}

async function isRunCancelledStorage() {
  const v = await chrome.storage.local.get(STORAGE_KEYS.runCancel);
  return !!v[STORAGE_KEYS.runCancel];
}

async function clearRunCancelled() {
  await chrome.storage.local.remove(STORAGE_KEYS.runCancel);
}

function mergeGuardrailsFromMsg(msg) {
  if (msg.allowedOrigin && typeof msg.allowedOrigin === 'string') {
    try {
      const o = new URL(msg.allowedOrigin.trim());
      guardrails.allowedOrigin = `${o.protocol}//${o.host}`;
    } catch {
      /* keep previous */
    }
  }
  if (typeof msg.pathPrefix === 'string') guardrails.pathPrefix = msg.pathPrefix;
  if (typeof msg.maxPages === 'number' && msg.maxPages >= 0) guardrails.maxPages = msg.maxPages;
  if (typeof msg.maxAssignments === 'number' && msg.maxAssignments >= 0) {
    guardrails.maxAssignments = msg.maxAssignments;
  }
  if (typeof msg.assignGapMs === 'number' && msg.assignGapMs >= 0) {
    guardrails.assignGapMs = msg.assignGapMs;
  }
  if (typeof msg.postSaveWaitMs === 'number' && msg.postSaveWaitMs >= 0) {
    guardrails.postSaveWaitMs = msg.postSaveWaitMs;
  }
  if (typeof msg.anomalyAutoPauseEnabled === 'boolean') {
    guardrails.anomalyAutoPauseEnabled = msg.anomalyAutoPauseEnabled;
  }
  if (typeof msg.anomalyMinSample === 'number' && msg.anomalyMinSample >= 0) {
    guardrails.anomalyMinSample = msg.anomalyMinSample;
  }
  if (typeof msg.anomalyErrorRatePct === 'number' && msg.anomalyErrorRatePct >= 0) {
    guardrails.anomalyErrorRatePct = msg.anomalyErrorRatePct;
  }
  if (
    typeof msg.anomalyConsecutiveTeamNotFound === 'number' &&
    msg.anomalyConsecutiveTeamNotFound >= 0
  ) {
    guardrails.anomalyConsecutiveTeamNotFound = msg.anomalyConsecutiveTeamNotFound;
  }
  if (
    typeof msg.anomalyReceiverErrorsInWindow === 'number' &&
    msg.anomalyReceiverErrorsInWindow >= 0
  ) {
    guardrails.anomalyReceiverErrorsInWindow = msg.anomalyReceiverErrorsInWindow;
  }
  if (typeof msg.anomalyWindowSize === 'number' && msg.anomalyWindowSize > 0) {
    guardrails.anomalyWindowSize = msg.anomalyWindowSize;
  }
}

function isReceiverErrorStatus(status, notes) {
  if (status !== 'error') return false;
  const n = (notes || '').toLowerCase();
  return n.indexOf('no receiver for assign_team') !== -1;
}

function createAnomalyState() {
  return {
    total: 0,
    errors: 0,
    consecutiveTeamOptionNotFound: 0,
    receiverWindow: []
  };
}

function updateAnomalyState(state, status, notes) {
  const next = state || createAnomalyState();
  next.total += 1;
  if (!isAssignmentOk(status)) next.errors += 1;
  if (status === 'team_option_not_found') {
    next.consecutiveTeamOptionNotFound += 1;
  } else {
    next.consecutiveTeamOptionNotFound = 0;
  }
  const recv = isReceiverErrorStatus(status, notes) ? 1 : 0;
  next.receiverWindow.push(recv);
  while (next.receiverWindow.length > guardrails.anomalyWindowSize) {
    next.receiverWindow.shift();
  }
  return next;
}

function getAnomalyPauseReason(state) {
  if (!guardrails.anomalyAutoPauseEnabled) return null;
  const minSample = Math.max(0, guardrails.anomalyMinSample);
  if (state.total >= minSample && state.total > 0) {
    const errorRate = (state.errors / state.total) * 100;
    if (errorRate >= guardrails.anomalyErrorRatePct) {
      return `error rate ${errorRate.toFixed(1)}% >= ${guardrails.anomalyErrorRatePct}%`;
    }
  }
  if (
    guardrails.anomalyConsecutiveTeamNotFound > 0 &&
    state.consecutiveTeamOptionNotFound >= guardrails.anomalyConsecutiveTeamNotFound
  ) {
    return `team_option_not_found repeated ${state.consecutiveTeamOptionNotFound} times in a row`;
  }
  if (guardrails.anomalyReceiverErrorsInWindow > 0) {
    const recvCount = state.receiverWindow.reduce((a, b) => a + b, 0);
    if (recvCount >= guardrails.anomalyReceiverErrorsInWindow) {
      return `receiver errors ${recvCount} in last ${state.receiverWindow.length} assignments`;
    }
  }
  return null;
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
    mergeGuardrailsFromMsg(msg);
    logEntries = [];
    pageSummaries = [];
    chrome.storage.local.remove(STORAGE_KEYS.outputPageSummaries).catch(() => {});
  }

  if (msg.type === 'START_RUN') {
    if (running || !pages.length) return;
    (async () => {
      try {
        const pending = await chrome.storage.local.get(STORAGE_KEYS.pendingPhase2);
        if (pending[STORAGE_KEYS.pendingPhase2]) {
          emitLog(
            'error',
            'Run blocked',
            'A run is waiting for confirmation. Continue or cancel in the dashboard first.'
          );
          return;
        }
        const chunk = await chrome.storage.local.get(STORAGE_KEYS.phase2Chunk);
        if (chunk[STORAGE_KEYS.phase2Chunk]) {
          emitLog(
            'error',
            'Run blocked',
            'A chunked assignment is in progress. Wait for it to finish or use Stop, then retry.'
          );
          return;
        }
        running = true;
        cancelRequested = false;
        await clearRunCancelled();
        await chrome.storage.local.set({ [STORAGE_KEYS.runActive]: true });
        if (msg.targetTabId != null && msg.targetTabId !== '') {
          const tid =
            typeof msg.targetTabId === 'number' ? msg.targetTabId : parseInt(msg.targetTabId, 10);
          if (Number.isFinite(tid)) runTabId = tid;
        }
        if (typeof msg.renderWaitMs === 'number') renderWaitMs = msg.renderWaitMs;
        if (msg.teamSeparator === ',' || msg.teamSeparator === '|') teamSeparator = msg.teamSeparator;
        mergeGuardrailsFromMsg(msg);
        const pageLimit = msg.mode === 'test' ? msg.limit || 1 : pages.length;
        const testFirstBlockOnly = msg.mode === 'test';
        const scanOnly = !!msg.scanOnly;
        const confirmBeforeAssign = !!msg.confirmBeforeAssign;

        const outcome = await runPages(pageLimit, testFirstBlockOnly, {
          scanOnly,
          confirmBeforeAssign
        });
        if (outcome.mode === 'await_confirm') {
          chrome.runtime
            .sendMessage({
              type: 'AWAIT_PHASE2_CONFIRM',
              summary: outcome.summary
            })
            .catch(() => {});
        } else if (outcome.mode === 'phase2_scheduled') {
          /* RUN_COMPLETE sent when phase 2 chunker finishes */
        } else {
          await sendRunComplete(pageLimit, outcome.scanOnly === true);
        }
      } catch (e) {
        emitLog('error', 'Run failed', String(e));
        const chunkNow = await chrome.storage.local.get(STORAGE_KEYS.phase2Chunk);
        if (!chunkNow[STORAGE_KEYS.phase2Chunk]) {
          await sendRunComplete(Math.min(msg.mode === 'test' ? msg.limit || 1 : pages.length, pages.length), false);
        }
      } finally {
        const stillChunked = await chrome.storage.local.get(STORAGE_KEYS.phase2Chunk);
        const pending2 = await chrome.storage.local.get(STORAGE_KEYS.pendingPhase2);
        if (stillChunked[STORAGE_KEYS.phase2Chunk]) {
          /* Assignments still running via alarms; keep running true and runActive */
        } else if (pending2[STORAGE_KEYS.pendingPhase2]) {
          running = false;
          await chrome.storage.local.remove(STORAGE_KEYS.runActive);
        } else {
          running = false;
          await chrome.storage.local.remove(STORAGE_KEYS.runActive);
        }
      }
    })();
    return;
  }

  if (msg.type === 'RESUME_PHASE2') {
    (async () => {
      const { [STORAGE_KEYS.pendingPhase2]: pending } = await chrome.storage.local.get(
        STORAGE_KEYS.pendingPhase2
      );
      if (!pending || !pending.workQueue || !pending.workQueue.length) {
        emitLog('warn', 'Resume assignments', 'No pending run found.');
        return;
      }
      if (running) {
        emitLog('warn', 'Resume assignments', 'A run is already active.');
        return;
      }
      running = true;
      cancelRequested = false;
      await clearRunCancelled();
      await chrome.storage.local.set({ [STORAGE_KEYS.runActive]: true });
      await chrome.storage.local.remove(STORAGE_KEYS.pendingPhase2);
      runTabId = pending.tabId;
      renderWaitMs = pending.renderWaitMs;
      teamSeparator = pending.teamSeparator;
      guardrails.assignGapMs = pending.assignGapMs;
      guardrails.postSaveWaitMs = pending.postSaveWaitMs;
      emitLog('info', 'Assignments starting', `${pending.workQueue.length} assignment(s) after confirmation.`);
      await startPhase2Chunked(pending.workQueue, pending.progressMeta);
    })().catch((e) => {
      emitLog('error', 'Resume assignments failed', String(e));
      running = false;
      chrome.storage.local.remove(STORAGE_KEYS.runActive).catch(() => {});
    });
    return;
  }

  if (msg.type === 'RESUME_AUTO_PAUSE_PHASE2') {
    (async () => {
      const { [STORAGE_KEYS.autoPausePhase2]: paused } = await chrome.storage.local.get(
        STORAGE_KEYS.autoPausePhase2
      );
      if (!paused) {
        emitLog('warn', 'Resume auto-pause', 'No paused run found.');
        return;
      }
      if (running) {
        emitLog('warn', 'Resume auto-pause', 'A run is already active.');
        return;
      }
      running = true;
      cancelRequested = false;
      await clearRunCancelled();
      await chrome.storage.local.set({ [STORAGE_KEYS.runActive]: true });
      await chrome.storage.local.remove(STORAGE_KEYS.autoPausePhase2);
      await chrome.storage.local.set({ [STORAGE_KEYS.phase2Chunk]: paused.phase2Chunk });
      emitLog('warn', 'Run resumed after auto-pause', paused.reason || '');
      await runPhase2NextBatch();
    })().catch((e) => {
      emitLog('error', 'Resume auto-pause failed', String(e));
      running = false;
      chrome.storage.local.remove(STORAGE_KEYS.runActive).catch(() => {});
    });
    return;
  }

  if (msg.type === 'CANCEL_PENDING_PHASE2') {
    chrome.storage.local.remove(STORAGE_KEYS.pendingPhase2).then(() => {
      emitLog('info', 'Pending confirmation cancelled', '');
    });
    return;
  }

  if (msg.type === 'DOWNLOAD_LOG') {
    downloadLogCsv();
  }

  if (msg.type === 'DOWNLOAD_OUTPUT_LOG') {
    downloadOutputCsv();
  }

  if (msg.type === 'STOP_RUN') {
    cancelRequested = true;
    setRunCancelled();
    emitLog('warn', 'Stop requested', '');
  }
});

function isScanPreviewOk(status) {
  return status === 'would_assign' || status === 'no_rule_match';
}

async function sendRunComplete(pageLimit, scanOnlyRun) {
  const pageCount = Math.min(pageLimit, pages.length);
  const successCount = scanOnlyRun
    ? logEntries.filter((l) => isScanPreviewOk(l.status)).length
    : logEntries.filter((l) => isAssignmentOk(l.status)).length;
  const errorCount = scanOnlyRun
    ? logEntries.filter((l) => !isScanPreviewOk(l.status)).length
    : logEntries.filter((l) => !isAssignmentOk(l.status)).length;
  chrome.runtime
    .sendMessage({
      type: 'RUN_COMPLETE',
      total: logEntries.length,
      pageCount,
      successCount,
      errorCount,
      scanOnly: !!scanOnlyRun
    })
    .catch(() => {});
}

async function finishPhase2Run(pageLimitForMeta, scanOnlyRun) {
  running = false;
  await chrome.storage.local.remove(STORAGE_KEYS.runActive);
  await chrome.storage.local.set({ [STORAGE_KEYS.outputPageSummaries]: pageSummaries }).catch(() => {});
  await sendRunComplete(pageLimitForMeta || pages.length, scanOnlyRun === true);
}

function buildWorkQueue(pagePlans, testFirstBlockOnly) {
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
  const cap = guardrails.maxAssignments;
  if (cap > 0 && workQueue.length > cap) {
    emitLog(
      'warn',
      'Assignment cap applied',
      `Queue truncated from ${workQueue.length} to ${cap} (max assignments).`
    );
    return workQueue.slice(0, cap);
  }
  return workQueue;
}

function buildConfirmSummary(workQueue, rules) {
  const sample = [];
  const teamCounts = {};
  for (let i = 0; i < workQueue.length; i += 1) {
    const { page, block } = workQueue[i];
    const teamName = getTeamForPage(page, rules, teamSeparator) || '';
    if (teamName) {
      teamCounts[teamName] = (teamCounts[teamName] || 0) + 1;
    }
    if (sample.length < 8) {
      sample.push({
        page_url: page.page_url,
        block_label: block.label || '',
        team_name: teamName
      });
    }
  }
  return {
    queueLength: workQueue.length,
    teamCounts,
    sample
  };
}

async function runPages(pageLimit, testFirstBlockOnly, opts) {
  const scanOnly = opts && opts.scanOnly;
  const confirmBeforeAssign = opts && opts.confirmBeforeAssign;
  const rules = await loadRules();

  const tabId = runTabId;

  if (!tabId) {
    emitLog('error', 'No target tab selected', 'Choose a tab in the dashboard (Target tab) before running.');
    return { mode: 'complete' };
  }

  let pageCount = Math.min(pageLimit, pages.length);
  const maxP = guardrails.maxPages;
  if (maxP > 0 && pageCount > maxP) {
    emitLog('warn', 'Page cap applied', `Processing ${maxP} of ${pageCount} page(s) from input.`);
    pageCount = maxP;
  }

  const slice = pages.slice(0, pageCount);
  const validPages = [];
  for (const page of slice) {
    if (isPageUrlAllowed(page.page_url, guardrails.allowedOrigin, guardrails.pathPrefix)) {
      validPages.push(page);
    } else {
      const notes = `URL not allowed (origin/path guardrails): ${guardrails.allowedOrigin}${normalizePathPrefix(guardrails.pathPrefix) || ''}`;
      emitLog('warn', 'Skipped invalid URL', page.page_url);
      logEntries.push({
        page_url: page.page_url,
        block_label: '',
        block_edit_url: '',
        team_name: '',
        status: 'skipped_invalid_url',
        notes,
        timestamp: new Date().toISOString()
      });
    }
  }

  if (!validPages.length) {
    emitLog('error', 'No allowed pages to scan', 'Fix CSV URLs or guardrail settings.');
    return { mode: 'complete' };
  }

  emitLog(
    'info',
    'Run started',
    `${validPages.length} page(s), ${testFirstBlockOnly ? 'test (first block per page only)' : 'full (all blocks)'}, tab ${tabId}`
  );

  const pagePlans = [];

  emitLog('info', 'Scanning pages', `Visiting ${validPages.length} page(s) to list blocks only.`);

  for (let i = 0; i < validPages.length; i += 1) {
    if (cancelRequested || (await isRunCancelledStorage())) break;
    const page = validPages[i];

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
      emitLog('info', `Scan: done`, `page ${i + 1}/${validPages.length} — ${blocks.length} block(s)`);
      const pageTitle = scanResult && typeof scanResult.pageTitle === 'string' ? scanResult.pageTitle : '';
      const pageTeam = getTeamForPage(page, rules, teamSeparator) || '';
      pageSummaries.push({
        page_title: pageTitle,
        page_url: page.page_url,
        page_team: pageTeam,
        blocks_no_team_before: blocks.length,
        blocks_no_team_after: null
      });
      pagePlans.push({ page, blocks });
    } catch (err) {
      const errMsg = String(err);
      emitLog('error', `Scan: page error`, errMsg);
      pagePlans.push({ page, blocks: [], scanError: errMsg });
      const pageTeam = getTeamForPage(page, rules, teamSeparator) || '';
      pageSummaries.push({
        page_title: '',
        page_url: page.page_url,
        page_team: pageTeam,
        blocks_no_team_before: 0,
        blocks_no_team_after: null
      });
    }
  }

  if (cancelRequested || (await isRunCancelledStorage())) {
    emitLog('warn', 'Run cancelled', 'Stopped after scanning.');
    return { mode: 'complete' };
  }

  const blockTotal = pagePlans.reduce((sum, p) => sum + (p.blocks && p.blocks.length ? p.blocks.length : 0), 0);
  emitLog(
    'info',
    'Scan complete',
    `${pagePlans.length} page(s), ${blockTotal} block(s) found on the page(s).`
  );

  if (testFirstBlockOnly && blockTotal > 1) {
    emitLog(
      'info',
      'Test mode',
      `Only the first block per page will be assigned (${blockTotal} scanned). Use Full batch for every block.`
    );
  }

  const workQueue = buildWorkQueue(pagePlans, testFirstBlockOnly);

  if (!workQueue.length) {
    emitLog('info', 'Assignments skipped', 'No blocks to assign (empty or all skipped).');
    // If we didn't assign anything, the "after" state equals "before".
    // Persist immediately so downloads still work even if MV3 suspends/restarts the SW.
    for (const s of pageSummaries) {
      if (s && (s.blocks_no_team_after == null || s.blocks_no_team_after === '')) {
        s.blocks_no_team_after = s.blocks_no_team_before;
      }
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.outputPageSummaries]: pageSummaries }).catch(() => {});
    return { mode: 'complete' };
  }

  if (scanOnly) {
    emitLog('info', 'Scan-only mode', `Recording ${workQueue.length} would-be assignment(s); no edits.`);
    // Scan-only doesn't mutate the page, so after = before for output purposes.
    for (const s of pageSummaries) {
      if (s && (s.blocks_no_team_after == null || s.blocks_no_team_after === '')) {
        s.blocks_no_team_after = s.blocks_no_team_before;
      }
    }
    await chrome.storage.local
      .set({ [STORAGE_KEYS.outputPageSummaries]: pageSummaries })
      .catch(() => {});
    for (const { page, block } of workQueue) {
      const teamName = getTeamForPage(page, rules, teamSeparator);
      let status = 'would_assign';
      let notes = '';
      if (!teamName) {
        status = 'no_rule_match';
        notes = 'no matching team for page';
      } else if (!block.editUrl) {
        status = 'error';
        notes = 'missing editUrl for block';
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
    }
    return { mode: 'complete', scanOnly: true };
  }

  if (confirmBeforeAssign) {
    const summary = buildConfirmSummary(workQueue, rules);
    await chrome.storage.local.set({
      [STORAGE_KEYS.pendingPhase2]: {
        workQueue,
        tabId,
        renderWaitMs,
        teamSeparator,
        assignGapMs: guardrails.assignGapMs,
        postSaveWaitMs: guardrails.postSaveWaitMs,
        progressMeta: { pageLimit }
      }
    });
    emitLog(
      'info',
      'Awaiting confirmation',
      `Assignments paused: ${summary.queueLength} assignment(s). Open the dashboard and confirm to proceed.`
    );
    return { mode: 'await_confirm', summary };
  }

  emitLog('info', 'Assigning teams', `${workQueue.length} block assignment(s) queued (chunked for reliability).`);
  await startPhase2Chunked(workQueue, { pageLimit });
  return { mode: 'phase2_scheduled' };
}

async function startPhase2Chunked(workQueue, progressMeta) {
  const state = {
    workQueue,
    wi: 0,
    prevPageUrl: null,
    tabId: runTabId,
    renderWaitMs,
    teamSeparator,
    assignGapMs: guardrails.assignGapMs,
    postSaveWaitMs: guardrails.postSaveWaitMs,
    anomalyState: createAnomalyState(),
    progressTotal: workQueue.length,
    pageLimit: progressMeta && progressMeta.pageLimit != null ? progressMeta.pageLimit : pages.length,
    pageSummaries
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.phase2Chunk]: state });
  await runPhase2NextBatch();
}

async function runPhase2NextBatch() {
  const { [STORAGE_KEYS.phase2Chunk]: raw } = await chrome.storage.local.get(STORAGE_KEYS.phase2Chunk);
  if (!raw || !raw.workQueue || !raw.workQueue.length) {
    return;
  }
  if ((await isRunCancelledStorage()) || cancelRequested) {
    await chrome.storage.local.remove(STORAGE_KEYS.phase2Chunk);
    try {
      await chrome.alarms.clear(ASSIGN_ALARM);
    } catch {
      /* ignore */
    }
    emitLog('warn', 'Run stopped', 'Run cancelled during assignments.');
    await finishPhase2Run(raw.pageLimit, false);
    return;
  }

  const rules = await loadRules();
  let {
    workQueue,
    wi,
    prevPageUrl,
    tabId,
    renderWaitMs: rw,
    teamSeparator: sep,
    assignGapMs,
    postSaveWaitMs,
    anomalyState,
    progressTotal,
    pageLimit,
    pageSummaries: rawPageSummaries
  } = raw;
  pageSummaries = Array.isArray(rawPageSummaries) ? rawPageSummaries : [];

  const end = Math.min(wi + ASSIGN_BATCH_SIZE, workQueue.length);

  for (; wi < end; wi += 1) {
    if ((await isRunCancelledStorage()) || cancelRequested) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.phase2Chunk]: {
          ...raw,
          wi,
          prevPageUrl,
          pageSummaries
        }
      });
      await chrome.storage.local.remove(STORAGE_KEYS.phase2Chunk);
      try {
        await chrome.alarms.clear(ASSIGN_ALARM);
      } catch {
        /* ignore */
      }
      emitLog('warn', 'Run stopped', 'Run cancelled during assignments.');
      await finishPhase2Run(pageLimit, false);
      return;
    }

    const { page, blockIndex, block } = workQueue[wi];

    try {
      if (wi > 0) {
        await sleep(assignGapMs);
      }
      if (page.page_url !== prevPageUrl) {
        // We just finished all assignments for `prevPageUrl` because `workQueue` keeps pages grouped.
        // Re-scan now (before navigating away) to capture the "after" block count.
        if (prevPageUrl) {
          try {
            emitLog('info', 'Output CSV: re-scan finished page', prevPageUrl);
            const afterScan = await sendScanBlocks(tabId);
            const afterBlocks = (afterScan && afterScan.blocks) || [];
            const idx = pageSummaries.findIndex((s) => s.page_url === prevPageUrl);
            if (idx !== -1) {
              pageSummaries[idx].blocks_no_team_after = afterBlocks.length;
              if (afterScan && typeof afterScan.pageTitle === 'string' && afterScan.pageTitle) {
                pageSummaries[idx].page_title = afterScan.pageTitle;
              }
            }
          } catch (e) {
            emitLog('warn', 'Output CSV: re-scan failed', String(e));
          }
        }

        emitLog('info', `Assign: navigate`, page.page_url);
        await chrome.tabs.update(tabId, { url: page.page_url });
        await waitForTabComplete(tabId);
        if (rw > 0) {
          await sleep(rw);
        }
        prevPageUrl = page.page_url;
      }

      const teamName = getTeamForPage(page, rules, sep);
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
          const result = await sendAssignTeam(tabId, teamName, blockIndex, postSaveWaitMs);
          status = result.status;
          notes = result.notes || '';
          emitAssignResultLog(status, notes);
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
          successCount: logEntries.filter((l) => isAssignmentOk(l.status)).length,
          errorCount: logEntries.filter((l) => !isAssignmentOk(l.status)).length,
          lastEntry: logEntries[logEntries.length - 1]
        })
        .catch(() => {});
      anomalyState = updateAnomalyState(anomalyState, status, notes);
      const pauseReason = getAnomalyPauseReason(anomalyState);
      if (pauseReason) {
        const pausedChunk = {
          workQueue,
          wi: wi + 1,
          prevPageUrl,
          tabId,
          renderWaitMs: rw,
          teamSeparator: sep,
          assignGapMs,
          postSaveWaitMs,
          anomalyState,
          progressTotal,
          pageLimit,
          pageSummaries
        };
        await chrome.storage.local.set({
          [STORAGE_KEYS.autoPausePhase2]: { reason: pauseReason, phase2Chunk: pausedChunk }
        });
        await chrome.storage.local.remove(STORAGE_KEYS.phase2Chunk);
        try {
          await chrome.alarms.clear(ASSIGN_ALARM);
        } catch {
          /* ignore */
        }
        running = false;
        await chrome.storage.local.remove(STORAGE_KEYS.runActive);
        emitLog('warn', 'Auto-paused', pauseReason);
        chrome.runtime
          .sendMessage({
            type: 'AUTO_PAUSED_PHASE2',
            reason: pauseReason
          })
          .catch(() => {});
        return;
      }
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
          successCount: logEntries.filter((l) => isAssignmentOk(l.status)).length,
          errorCount: logEntries.filter((l) => !isAssignmentOk(l.status)).length,
          lastEntry: logEntries[logEntries.length - 1]
        })
        .catch(() => {});
    }
  }

  const nextState = {
    workQueue,
    wi,
    prevPageUrl,
    tabId,
    renderWaitMs: rw,
    teamSeparator: sep,
    assignGapMs,
    postSaveWaitMs,
    anomalyState,
    progressTotal,
    pageLimit,
    pageSummaries
  };

  if (wi >= workQueue.length) {
    // Last processed page is still loaded in the tab: capture its "after" count.
    if (prevPageUrl) {
      try {
        emitLog('info', 'Output CSV: re-scan finished page', prevPageUrl);
        const finalScan = await sendScanBlocks(tabId);
        const finalBlocks = (finalScan && finalScan.blocks) || [];
        const idx = pageSummaries.findIndex((s) => s.page_url === prevPageUrl);
        if (idx !== -1) {
          pageSummaries[idx].blocks_no_team_after = finalBlocks.length;
          if (finalScan && typeof finalScan.pageTitle === 'string' && finalScan.pageTitle) {
            pageSummaries[idx].page_title = finalScan.pageTitle;
          }
        }
      } catch (e) {
        emitLog('warn', 'Output CSV: final re-scan failed', String(e));
      }
    }

    await chrome.storage.local.remove(STORAGE_KEYS.phase2Chunk);
    try {
      await chrome.alarms.clear(ASSIGN_ALARM);
    } catch {
      /* ignore */
    }
    emitLog('info', 'Run complete', `${progressTotal} assignment(s) processed.`);
    await finishPhase2Run(pageLimit, false);
    return;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.phase2Chunk]: nextState });
  try {
    await chrome.alarms.clear(ASSIGN_ALARM);
  } catch {
    /* ignore */
  }
  chrome.alarms.create(ASSIGN_ALARM, { delayInMinutes: ASSIGN_ALARM_DELAY_MIN });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ASSIGN_ALARM) {
    runPhase2NextBatch().catch((e) => emitLog('error', 'Assign chunk failed', String(e)));
  }
});

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
    s.indexOf('message port closed') !== -1 ||
    s.indexOf('message channel closed') !== -1
  );
}

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

async function sendAssignTeam(tabId, teamName, blockIndex, postSaveWaitMs) {
  const { ok, error, response } = await sendTabMessageWithRetry(
    tabId,
    {
      type: 'ASSIGN_TEAM',
      teamName,
      blockIndex,
      postSaveWaitMs: typeof postSaveWaitMs === 'number' ? postSaveWaitMs : guardrails.postSaveWaitMs
    },
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
  // MV3 service workers don't always support URL.createObjectURL; use data URLs instead.
  const url = `data:text/csv;charset=utf-8,${encodeURIComponent(lines.join('\n'))}`;

  chrome.downloads.download({
    url,
    filename: 'run_log.csv',
    saveAs: true
  });
}

async function downloadOutputCsv() {
  let summaries = pageSummaries;

  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.outputPageSummaries);
    const v = stored && stored[STORAGE_KEYS.outputPageSummaries];
    if (Array.isArray(v)) summaries = v;
  } catch {
    /* ignore */
  }

  if (!summaries || !summaries.length) return;

  const header = [
    'page_title',
    'page_url',
    'page_team',
    'blocks_no_team_before',
    'blocks_no_team_after'
  ];

  const lines = [header.join(',')];

  for (const row of summaries) {
    const line = header
      .map((key) => {
        const raw = row && row[key] != null ? row[key] : '';
        const escaped = String(raw).replace(/"/g, '""');
        return `"${escaped}"`;
      })
      .join(',');
    lines.push(line);
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  // MV3 service workers don't always support URL.createObjectURL; use data URLs instead.
  const url = `data:text/csv;charset=utf-8,${encodeURIComponent(lines.join('\n'))}`;

  chrome.downloads.download({
    url,
    filename: 'output.csv',
    saveAs: true
  });
}
