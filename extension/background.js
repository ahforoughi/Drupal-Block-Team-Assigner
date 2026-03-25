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

/** Count as "ok" for progress (block already had the team). */
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

function emitPageSummary(summary) {
  chrome.runtime.sendMessage({ type: 'PAGE_SUMMARY_UPDATE', summary }).catch(() => {});
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

/* ─── message router ──────────────────────────────────────────────── */

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
        const chunk = await chrome.storage.local.get(STORAGE_KEYS.phase2Chunk);
        if (chunk[STORAGE_KEYS.phase2Chunk]) {
          emitLog(
            'error',
            'Run blocked',
            'A run is in progress. Wait for it to finish or use Stop, then retry.'
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

        const outcome = await runPages(pageLimit, testFirstBlockOnly);
        if (outcome.mode !== 'scheduled') {
          await sendRunComplete(pageLimit);
        }
      } catch (e) {
        emitLog('error', 'Run failed', String(e));
        const chunkNow = await chrome.storage.local.get(STORAGE_KEYS.phase2Chunk);
        if (!chunkNow[STORAGE_KEYS.phase2Chunk]) {
          await sendRunComplete(
            Math.min(msg.mode === 'test' ? msg.limit || 1 : pages.length, pages.length)
          );
        }
      } finally {
        const stillChunked = await chrome.storage.local.get(STORAGE_KEYS.phase2Chunk);
        if (stillChunked[STORAGE_KEYS.phase2Chunk]) {
          /* Still running via alarms — keep running true */
        } else {
          running = false;
          await chrome.storage.local.remove(STORAGE_KEYS.runActive);
        }
      }
    })();
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
      await runNextChunk();
    })().catch((e) => {
      emitLog('error', 'Resume auto-pause failed', String(e));
      running = false;
      chrome.storage.local.remove(STORAGE_KEYS.runActive).catch(() => {});
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
    running = false;
    chrome.storage.local
      .remove([STORAGE_KEYS.phase2Chunk, STORAGE_KEYS.runActive, STORAGE_KEYS.autoPausePhase2])
      .catch(() => {});
    chrome.alarms.clear(ASSIGN_ALARM).catch(() => {});
    emitLog('warn', 'Run stopped', 'State cleared — you can start a new run.');
  }
});

/* ─── run lifecycle helpers ───────────────────────────────────────── */

async function sendRunComplete(pageLimit) {
  const pageCount = Math.min(pageLimit, pages.length);
  const successCount = logEntries.filter((l) => isAssignmentOk(l.status)).length;
  const errorCount = logEntries.filter((l) => !isAssignmentOk(l.status)).length;
  chrome.runtime
    .sendMessage({
      type: 'RUN_COMPLETE',
      total: logEntries.length,
      pageCount,
      successCount,
      errorCount
    })
    .catch(() => {});
}

async function finishRun(pageLimitForMeta) {
  running = false;
  await chrome.storage.local.remove(STORAGE_KEYS.runActive);
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.outputPageSummaries]: pageSummaries });
  } catch {
    /* ignore */
  }
  await sendRunComplete(pageLimitForMeta || pages.length);
}

/* ─── page-by-page orchestration ──────────────────────────────────── */

function buildPageBlocks(blocks, testFirstBlockOnly) {
  const items = [];
  const slice = testFirstBlockOnly ? blocks.slice(0, 1) : blocks;
  for (let bi = 0; bi < slice.length; bi += 1) {
    const block = slice[bi];
    if (block.hasTeam) continue;
    items.push({ blockIndex: bi, block });
  }
  return items;
}

async function runPages(pageLimit, testFirstBlockOnly) {
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

  pageSummaries = [];

  const state = {
    validPages,
    pi: 0,
    pageScanned: false,
    currentBlocks: [],
    bi: 0,
    testFirstBlockOnly,
    tabId,
    renderWaitMs,
    teamSeparator,
    assignGapMs: guardrails.assignGapMs,
    postSaveWaitMs: guardrails.postSaveWaitMs,
    anomalyState: createAnomalyState(),
    pageSummaries: [],
    pageLimit,
    totalAssigned: 0,
    maxAssignments: guardrails.maxAssignments,
    maxAssignmentsReached: false
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.phase2Chunk]: state });
  await runNextChunk();
  return { mode: 'scheduled' };
}

/**
 * Main processing loop.  Processes pages one at a time:
 *   scan → assign blocks (in batches) → re-scan for "after" count → next page.
 * Yields to a chrome.alarm between assignment batches for MV3 resilience.
 */
async function runNextChunk() {
  const { [STORAGE_KEYS.phase2Chunk]: raw } = await chrome.storage.local.get(
    STORAGE_KEYS.phase2Chunk
  );
  if (!raw || !raw.validPages || !raw.validPages.length) return;

  if ((await isRunCancelledStorage()) || cancelRequested) {
    pageSummaries = Array.isArray(raw.pageSummaries) ? raw.pageSummaries : [];
    await chrome.storage.local.remove(STORAGE_KEYS.phase2Chunk);
    try { await chrome.alarms.clear(ASSIGN_ALARM); } catch { /* ignore */ }
    emitLog('warn', 'Run stopped', 'Run cancelled.');
    await finishRun(raw.pageLimit);
    return;
  }

  const rules = await loadRules();
  let {
    validPages,
    pi,
    pageScanned,
    currentBlocks,
    bi,
    testFirstBlockOnly,
    tabId,
    renderWaitMs: rw,
    teamSeparator: sep,
    assignGapMs,
    postSaveWaitMs,
    anomalyState,
    pageSummaries: rawPS,
    pageLimit,
    totalAssigned,
    maxAssignments,
    maxAssignmentsReached
  } = raw;
  pageSummaries = Array.isArray(rawPS) ? rawPS : [];

  /* ── outer loop: iterate pages ──────────────────────────────────── */
  while (pi < validPages.length && !maxAssignmentsReached) {
    if ((await isRunCancelledStorage()) || cancelRequested) break;

    const page = validPages[pi];

    /* ── SCAN current page if needed ──────────────────────────────── */
    if (!pageScanned) {
      try {
        emitLog('info', `Page ${pi + 1}/${validPages.length}: navigate`, page.page_url);
        await chrome.tabs.update(tabId, { url: page.page_url });
        await waitForTabComplete(tabId);
        if (rw > 0) await sleep(rw);

        const scanResult = await sendScanBlocks(tabId);
        const blocks = (scanResult && scanResult.blocks) || [];
        if (scanResult && scanResult.error) {
          emitLog('warn', 'Scan warning', scanResult.error);
        }
        const pageTitle =
          scanResult && typeof scanResult.pageTitle === 'string' ? scanResult.pageTitle : '';
        const pageTeam = getTeamForPage(page, rules, sep) || '';

        pageSummaries.push({
          page_title: pageTitle,
          page_url: page.page_url,
          page_team: pageTeam,
          blocks_no_team_before: blocks.length,
          blocks_no_team_after: null
        });

        currentBlocks = buildPageBlocks(blocks, testFirstBlockOnly);
        bi = 0;
        pageScanned = true;

        emitLog(
          'info',
          `Page ${pi + 1}/${validPages.length}: scanned`,
          `${blocks.length} block(s), ${currentBlocks.length} to assign`
        );

        if (!currentBlocks.length) {
          pageSummaries[pageSummaries.length - 1].blocks_no_team_after = blocks.length;
          emitPageSummary(pageSummaries[pageSummaries.length - 1]);
          pi++;
          pageScanned = false;
          currentBlocks = [];
          bi = 0;
          continue;
        }
      } catch (err) {
        emitLog('error', `Page ${pi + 1}: scan failed`, String(err));
        const pageTeam = getTeamForPage(page, rules, sep) || '';
        const failSummary = {
          page_title: '',
          page_url: page.page_url,
          page_team: pageTeam,
          blocks_no_team_before: 0,
          blocks_no_team_after: 0
        };
        pageSummaries.push(failSummary);
        emitPageSummary(failSummary);
        pi++;
        pageScanned = false;
        currentBlocks = [];
        bi = 0;
        continue;
      }
    }

    /* ── ASSIGN batch on current page ─────────────────────────────── */
    const end = Math.min(bi + ASSIGN_BATCH_SIZE, currentBlocks.length);

    for (; bi < end; bi++) {
      if ((await isRunCancelledStorage()) || cancelRequested) break;

      if (maxAssignments > 0 && totalAssigned >= maxAssignments) {
        emitLog(
          'warn',
          'Assignment cap reached',
          `Stopped after ${totalAssigned} assignment(s) (max: ${maxAssignments}).`
        );
        maxAssignmentsReached = true;
        break;
      }

      const { blockIndex, block } = currentBlocks[bi];

      try {
        if (totalAssigned > 0) await sleep(assignGapMs);

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
              `Page ${pi + 1}: assign (${bi + 1}/${currentBlocks.length})`,
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

        totalAssigned++;

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
            currentIndex: bi + 1,
            total: currentBlocks.length,
            pageIndex: pi + 1,
            pageTotal: validPages.length,
            successCount: logEntries.filter((l) => isAssignmentOk(l.status)).length,
            errorCount: logEntries.filter((l) => !isAssignmentOk(l.status)).length,
            lastEntry: logEntries[logEntries.length - 1]
          })
          .catch(() => {});

        anomalyState = updateAnomalyState(anomalyState, status, notes);
        const pauseReason = getAnomalyPauseReason(anomalyState);
        if (pauseReason) {
          const pausedChunk = {
            ...raw,
            pi,
            pageScanned,
            currentBlocks,
            bi: bi + 1,
            pageSummaries,
            totalAssigned,
            anomalyState,
            maxAssignmentsReached
          };
          await chrome.storage.local.set({
            [STORAGE_KEYS.autoPausePhase2]: { reason: pauseReason, phase2Chunk: pausedChunk }
          });
          await chrome.storage.local.remove(STORAGE_KEYS.phase2Chunk);
          try { await chrome.alarms.clear(ASSIGN_ALARM); } catch { /* ignore */ }
          running = false;
          await chrome.storage.local.remove(STORAGE_KEYS.runActive);
          emitLog('warn', 'Auto-paused', pauseReason);
          chrome.runtime
            .sendMessage({ type: 'AUTO_PAUSED_PHASE2', reason: pauseReason })
            .catch(() => {});
          return;
        }
      } catch (err) {
        const errMsg = String(err);
        emitLog('error', 'Assign: error', errMsg);
        totalAssigned++;
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
            currentIndex: bi + 1,
            total: currentBlocks.length,
            pageIndex: pi + 1,
            pageTotal: validPages.length,
            successCount: logEntries.filter((l) => isAssignmentOk(l.status)).length,
            errorCount: logEntries.filter((l) => !isAssignmentOk(l.status)).length,
            lastEntry: logEntries[logEntries.length - 1]
          })
          .catch(() => {});
      }
    }

    /* ── page done? ───────────────────────────────────────────────── */
    if (bi >= currentBlocks.length || maxAssignmentsReached) {
      try {
        emitLog('info', `Page ${pi + 1}: re-scanning for after count`, page.page_url);
        const afterScan = await sendScanBlocks(tabId);
        const afterBlocks = (afterScan && afterScan.blocks) || [];
        const summaryIdx = pageSummaries.findIndex((s) => s.page_url === page.page_url);
        if (summaryIdx !== -1) {
          pageSummaries[summaryIdx].blocks_no_team_after = afterBlocks.length;
          if (afterScan && typeof afterScan.pageTitle === 'string' && afterScan.pageTitle) {
            pageSummaries[summaryIdx].page_title = afterScan.pageTitle;
          }
        }
      } catch (e) {
        emitLog('warn', 'Re-scan for after count failed', String(e));
      }

      const doneSummary = pageSummaries.find((s) => s.page_url === page.page_url);
      if (doneSummary) emitPageSummary(doneSummary);

      pi++;
      pageScanned = false;
      currentBlocks = [];
      bi = 0;
      continue;
    }

    /* ── more blocks on this page — YIELD via alarm ───────────────── */
    await chrome.storage.local.set({
      [STORAGE_KEYS.phase2Chunk]: {
        ...raw,
        pi,
        pageScanned,
        currentBlocks,
        bi,
        pageSummaries,
        totalAssigned,
        anomalyState,
        maxAssignmentsReached
      }
    });
    try { await chrome.alarms.clear(ASSIGN_ALARM); } catch { /* ignore */ }
    chrome.alarms.create(ASSIGN_ALARM, { delayInMinutes: ASSIGN_ALARM_DELAY_MIN });
    return;
  }

  /* ── all pages processed (or cancelled / capped) ────────────────── */
  await chrome.storage.local.remove(STORAGE_KEYS.phase2Chunk);
  try { await chrome.alarms.clear(ASSIGN_ALARM); } catch { /* ignore */ }
  emitLog(
    'info',
    'Run complete',
    `${validPages.length} page(s) processed, ${totalAssigned} assignment(s).`
  );
  await finishRun(pageLimit);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ASSIGN_ALARM) {
    runNextChunk().catch((e) => emitLog('error', 'Chunk processing failed', String(e)));
  }
});

/* ─── utilities ───────────────────────────────────────────────────── */

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

/* ─── CSV downloads ───────────────────────────────────────────────── */

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

  const url = `data:text/csv;charset=utf-8,${encodeURIComponent(lines.join('\n'))}`;
  chrome.downloads.download({ url, filename: 'run_log.csv', saveAs: true });
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

  const url = `data:text/csv;charset=utf-8,${encodeURIComponent(lines.join('\n'))}`;
  chrome.downloads.download({ url, filename: 'output.csv', saveAs: true });
}
