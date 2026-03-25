(function () {
  const DEFAULT_EDIT_LINK_SELECTOR = 'a.edit-this-block';
  const EDIT_LINK_HREF = '/admin/content/block/';
  const TEAM_CHECKBOX_SELECTORS = [
    '#edit-teams-teams input[type="checkbox"]',
    '#edit-teams input[type="checkbox"]',
    'input[name^="teams[teams]"]'
  ];
  const SAVE_SELECTORS = [
    'input[type="submit"][value="Save"]',
    'input#edit-submit',
    'button#edit-submit',
    'button[data-drupal-selector="edit-submit"]',
    'input[data-drupal-selector="edit-submit"]',
    'button[value="Save"]',
    '.form-actions input[type="submit"]',
    '.form-actions button[type="submit"]',
    'input[type="submit"]'
  ];

  const IFRAME_SELECTORS = [
    'iframe.lbim-dialog-iframe',
    'iframe[src*="/admin/content/block/"]',
    'iframe[src*="admin/content"]',
    '.ui-dialog-content iframe',
    '.ui-dialog iframe',
    '[role="dialog"] iframe'
  ];

  function isBlockEditHref(href) {
    if (!href) return false;
    const h = href.split('#')[0];
    if (h.indexOf(EDIT_LINK_HREF) !== -1) return true;
    if (h.indexOf('content/block') !== -1 && /\/block\/\d+/i.test(h)) return true;
    if (h.indexOf('/block/') !== -1 && h.toLowerCase().indexOf('edit') !== -1) return true;
    if (h.indexOf('layout_builder') !== -1 && /block/i.test(h)) return true;
    return false;
  }

  function isEditThisBlockAnchor(a) {
    if (!a || a.tagName !== 'A') return false;
    if (/\bedit-this-block\b/.test(a.getAttribute('class') || '')) return true;
    const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
    return /\bedit\s+this\s+block\b/i.test(t);
  }

  function decodeHtmlEntities(str) {
    if (!str) return '';
    const ta = document.createElement('textarea');
    ta.innerHTML = str;
    return ta.value;
  }

  function closeBlockModal() {
    try {
      const topDoc = window.top && window.top.document;
      if (topDoc) {
        const closeBtn =
          topDoc.querySelector('.ui-dialog .ui-dialog-titlebar-close') ||
          topDoc.querySelector('button[title="Close"].ui-dialog-titlebar-close');
        if (closeBtn) closeBtn.click();
      }
    } catch (e) {}
  }

  function findElement(doc, selectors) {
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Save often lives in the jQuery UI dialog chrome (top document) while the
   * form and Teams checkboxes live inside a nested iframe.
   */
  function findSaveButton(formDoc) {
    const inDoc = findElement(formDoc, SAVE_SELECTORS);
    if (inDoc) return inDoc;

    function pickSaveFromRoot(root) {
      if (!root) return null;
      try {
        const dialogs = root.querySelectorAll('.ui-dialog, [role="dialog"]');
        for (let d = 0; d < dialogs.length; d += 1) {
          const dialog = dialogs[d];
          const btn = findElement(dialog, SAVE_SELECTORS);
          if (btn) return btn;
          const nodes = dialog.querySelectorAll('button, input[type="submit"], input[type="button"]');
          for (let i = 0; i < nodes.length; i += 1) {
            const el = nodes[i];
            const label = (el.getAttribute('value') || el.textContent || '').trim();
            if (/^save$/i.test(label)) return el;
          }
        }
      } catch (e) {}
      return null;
    }

    try {
      const topDoc = window.top && window.top.document;
      const fromTop = pickSaveFromRoot(topDoc);
      if (fromTop) return fromTop;
    } catch (e) {}

    try {
      if (document && document !== formDoc) {
        return pickSaveFromRoot(document);
      }
    } catch (e) {}

    return null;
  }

  function ensureCheckboxChecked(cb) {
    if (!cb || cb.checked) return;
    cb.focus();
    cb.click();
    if (cb.checked) return;
    cb.checked = true;
    try {
      cb.dispatchEvent(new Event('input', { bubbles: true }));
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {}
  }

  function collectEditLinks(doc) {
    const seen = new Set();
    const out = [];

    function addAnchor(a) {
      if (!a || a.tagName !== 'A') return;
      const href = a.getAttribute('href') || '';
      if (!isBlockEditHref(href) && !isEditThisBlockAnchor(a)) return;
      if (seen.has(a)) return;
      seen.add(a);
      out.push(a);
    }

    const linkSelectors = [
      DEFAULT_EDIT_LINK_SELECTOR,
      'a.use-ajax[href*="content/block"]',
      'a[href*="' + EDIT_LINK_HREF + '"]',
      'a[href*="block/"][href*="edit"]',
      'a.use-ajax[href*="layout_builder"]',
      '.block-editing a',
      '.layout-builder a[href*="block"]'
    ];
    for (const sel of linkSelectors) {
      try {
        doc.querySelectorAll(sel).forEach(addAnchor);
      } catch (e) {}
    }

    out.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return out;
  }

  function getTeamCheckboxes(doc) {
    for (const sel of TEAM_CHECKBOX_SELECTORS) {
      const list = doc.querySelectorAll(sel);
      if (list.length > 0) return Array.from(list);
    }
    return [];
  }

  function collectIframeElements() {
    const seen = new Set();
    const out = [];
    for (const sel of IFRAME_SELECTORS) {
      try {
        document.querySelectorAll(sel).forEach((el) => {
          if (el && el.tagName === 'IFRAME' && !seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        });
      } catch (e) {}
    }
    return out;
  }

  /** Document (possibly nested iframe) that contains team checkboxes. */
  function findDocWithTeamCheckboxes(root, depth) {
    if (!root || depth > 6) return null;
    try {
      if (getTeamCheckboxes(root).length > 0) return root;
    } catch (e) {
      return null;
    }
    try {
      const frames = root.querySelectorAll('iframe');
      for (let i = 0; i < frames.length; i += 1) {
        const id = frames[i].contentDocument;
        if (!id) continue;
        const found = findDocWithTeamCheckboxes(id, depth + 1);
        if (found) return found;
      }
    } catch (e) {}
    return null;
  }

  function waitForTeamsFormDoc() {
    return new Promise((resolve) => {
      const deadline = Date.now() + 22000;
      function run() {
        for (const iframe of collectIframeElements()) {
          const idoc = iframe.contentDocument;
          if (idoc) {
            const found = findDocWithTeamCheckboxes(idoc, 0);
            if (found) {
              resolve(found);
              return;
            }
          }
        }
        const top = findDocWithTeamCheckboxes(document, 0);
        if (top) {
          resolve(top);
          return;
        }
        if (Date.now() > deadline) {
          resolve(null);
          return;
        }
        setTimeout(run, 150);
      }
      run();
    });
  }

  function labelTextForCheckbox(doc, cb) {
    let labelText = '';
    if (cb.id) {
      const lab = doc.querySelector(`label[for="${cb.id}"]`);
      if (lab) labelText = (lab.textContent || '').trim();
    }
    if (!labelText && cb.closest('.form-item')) {
      const lab = cb.closest('.form-item').querySelector('.form-item__label, label');
      if (lab) labelText = (lab.textContent || '').trim();
    }
    if (!labelText && cb.closest('label')) {
      labelText = (cb.closest('label').textContent || '').trim();
    }
    return decodeHtmlEntities(labelText).replace(/\s+/g, ' ').trim();
  }

  function findCheckboxForTeamName(doc, allCbs, teamName) {
    const tn = decodeHtmlEntities(teamName).replace(/\s+/g, ' ').trim();
    for (const cb of allCbs) {
      const normalized = labelTextForCheckbox(doc, cb);
      if (!normalized) continue;
      if (
        normalized === tn ||
        normalized.startsWith(tn) ||
        normalized.indexOf(tn) !== -1
      ) {
        return cb;
      }
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'ASSIGN_TEAM') {
      (async () => {
        let result = { status: 'error', notes: 'assign handler did not finish' };
        try {
          const teamName = msg.teamName;
          const blockIndex = typeof msg.blockIndex === 'number' ? msg.blockIndex : 0;
          if (!teamName) {
            result = { status: 'error', notes: 'missing teamName' };
          } else {
            const links = collectEditLinks(document);
            if (!links.length || !links[blockIndex]) {
              result = {
                status: 'error',
                notes: `edit link not found for blockIndex ${blockIndex}`
              };
            } else {
              links[blockIndex].click();
              const doc = await waitForTeamsFormDoc();
              if (!doc) {
                result = { status: 'error', notes: 'team checkboxes not found (modal/iframe)' };
              } else {
                const allCbs = getTeamCheckboxes(doc);
                if (!allCbs.length) {
                  result = { status: 'error', notes: 'no team checkboxes found' };
                } else {
                  const targetCb = findCheckboxForTeamName(doc, allCbs, teamName);
                  if (!targetCb) {
                    result = {
                      status: 'team_option_not_found',
                      notes: `checkbox for "${teamName}" not found`
                    };
                  } else if (targetCb.checked) {
                    result = { status: 'already_set', notes: 'target team already selected' };
                  } else {
                    ensureCheckboxChecked(targetCb);
                    if (!targetCb.checked) {
                      result = { status: 'error', notes: 'could not check team checkbox' };
                    } else {
                      await sleep(400);
                      const saveBtn = findSaveButton(doc);
                      if (!saveBtn) {
                        result = {
                          status: 'error',
                          notes: 'Save button not found (form or dialog title bar)'
                        };
                      } else {
                        saveBtn.click();
                        const postSave =
                          typeof msg.postSaveWaitMs === 'number' && msg.postSaveWaitMs >= 0
                            ? msg.postSaveWaitMs
                            : 1200;
                        await sleep(postSave);
                        result = { status: 'success', notes: '' };
                      }
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          result = { status: 'error', notes: String(e) };
        }
        try {
          sendResponse(result);
        } catch (e) {}
        closeBlockModal();
      })();
      return true;
    }

    if (msg.type === 'SCAN_BLOCKS') {
      try {
        const blocks = [];
        const linkEls = collectEditLinks(document);
        const origin = window.location.origin;

        for (const a of linkEls) {
          const href = a.getAttribute('href') || '';
          if (!isBlockEditHref(href) && !isEditThisBlockAnchor(a)) continue;
          const label = a.getAttribute('title') || a.textContent.trim() || 'Block';
          let path = href.split('#')[0];
          if (!path || path === '#' || path.toLowerCase().indexOf('javascript:') === 0) {
            try {
              path = (a.href && a.href.split('#')[0]) || '';
            } catch (e) {
              path = '';
            }
          }
          const editUrl =
            path && path.indexOf('http') === 0
              ? path.split('?')[0]
              : path
                ? `${origin}${path.split('?')[0]}`
                : label;
          blocks.push({ label, editUrl, hasTeam: false });
        }
        sendResponse({ blocks, pageTitle: document.title || '' });
      } catch (e) {
        sendResponse({ blocks: [], pageTitle: document.title || '' });
      }
    }
  });
})();
