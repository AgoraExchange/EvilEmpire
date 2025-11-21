/* =========================================================
   Evil Empire — script.js
   (notifications + vaulting complete + Save modal + Spotlight)
   - Splash timing & handoff to shell
   - Bottom nav (Editor/Directory/Dropbox)
   - Editor actions: Copy, Paste, Delete (with confirm modal)
   - Line numbers: generate & sync scroll
   - Language heuristic -> updates #editor-lang
   - Focus trap for modal + ESC handling
   - Status toasts + top notifications
   - DIRECTORY + DROPBOX: Local vault (localStorage) with:
       • Vault It (save uploaded file OR current editor text)
       • Vault From Editor (force taking editor content)
       • Save (from Editor) → prompts modal → adds to Directory
       • List in Directory (searchable)
       • Open/Edit → loads content into Editor
       • Download (blob)
       • Delete (from vault)
   - SPOTLIGHT (pinned links):
       • Add (title + url) → renders sub-cards
       • Toggle delete mode (Off/On)
         - When On: tapping a link deletes it immediately
         - When Off: tapping opens the link
       • Persists in localStorage
   ========================================================= */

(() => {
  const SPLASH_MS = 2500;
  const VAULT_KEY = 'evilEmpireVault';           // localStorage key for files
  const SPOT_KEY  = 'evilEmpireSpotlight';       // localStorage key for spotlight
  const MAX_TEXT_BYTES = 250_000;                // ~250 KB safety for localStorage demo

  // ---------- DOM helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Regions / major nodes
  const appRoot = document.body; // class "app" already on <body>
  const splash = $('#splash');
  const shell = $('#shell');

  const notifyRoot = $('#notify-root');
  const statusRegion = $('.topbar__status');

  // Tabs
  const tabEditor = $('#tab-editor');
  const tabDirectory = $('#tab-directory');
  const tabDropbox = $('#tab-dropbox');

  const navEditor = $('#nav-editor');
  const navDirectory = $('#nav-directory');
  const navDropbox = $('#nav-dropbox');

  // Editor nodes
  const textarea = $('#editor-textarea');
  const gutterList = $('.gutter__lines');
  const btnCopy = $('#btn-copy');
  const btnPaste = $('#btn-paste');
  const btnDelete = $('#btn-delete');
  const langSlot = $('#editor-lang');

  // NEW: Save-from-Editor controls
  const btnSave = $('#btn-save');
  const modalSave = $('#modal-save');
  const saveForm = $('#save-form');
  const saveTitle = $('#save-title');
  const saveCategory = $('#save-category');
  const saveNote = $('#save-note');
  const saveCancel = $('#save-cancel');
  const saveConfirm = $('#save-confirm');

  // Modal: Clear
  const modalClear = $('#modal-clear');
  const modalCancel = $('#modal-clear-cancel');
  const modalConfirm = $('#modal-clear-confirm');

  // Directory (stubs already in HTML)
  const dirGrid = $('#dir-grid');
  const dirSearch = $('#dir-search');

  // File modal (Directory item actions)
  const fileModal = $('#modal-file');
  const mfClose = $('#mf-close');
  const mfEdit = $('#mf-edit');
  const mfDownload = $('#mf-download');
  const mfDelete = $('#mf-delete');
  const mfName = $('#mf-name');
  const mfCategory = $('#mf-category');
  const mfNote = $('#mf-note');

  // Dropbox form controls (IDs from your HTML)
  const dropForm = $('#drop-form');
  const dropTitle = $('#drop-title');
  const dropNote = $('#drop-note');
  const dropCategory = $('#drop-category');
  const dropFile = $('#drop-file');
  const btnVault = $('#btn-vault');               // <button type="submit" id="btn-vault">
  const btnVaultBlank = $('#btn-vault-blank');    // <button type="button" id="btn-vault-blank">

  // Spotlight controls (in Dropbox tab)
  const spotTitle = $('#spot-title');
  const spotLink = $('#spot-link');
  const spotAdd = $('#spot-add');
  const spotToggle = $('#spot-toggle');
  const spotList = $('#spot-list');

  // In-memory caches
  let VAULT = [];
  let SPOT = [];
  let spotDeleteMode = false; // Off by default

  // ---------- Splash sequencing ----------
  function boot() {
    if (!splash || !shell) return;
    setTimeout(() => {
      splash.style.display = 'none';
      shell.hidden = false;
      appRoot.classList.add('ready');
      activateTab('editor');
      ensureGutterLines();
      updateLanguageHeuristic();
      loadVaultFromStorage();
      renderDirectory();
      loadSpotFromStorage();
      renderSpotlight();
      toast('Editor ready');
      notify({
        title: 'Welcome to Evil Empire',
        msg: 'Hacking all the way to the bank.',
        duration: 3000,
      });
    }, SPLASH_MS);
  }

  // ---------- Bottom navigation ----------
  function activateTab(name) {
    const isEditor = name === 'editor';
    const isDir = name === 'directory';
    const isDrop = name === 'dropbox';

    tabEditor.hidden = !isEditor;
    tabDirectory.hidden = !isDir;
    tabDropbox.hidden = !isDrop;

    setActive(navEditor, isEditor);
    setActive(navDirectory, isDir);
    setActive(navDropbox, isDrop);

    if (isEditor) {
      ensureGutterLines();
      syncGutterScroll();
    }
    if (isDir) {
      renderDirectory(); // refresh list when entering
    }
    if (isDrop) {
      renderSpotlight(); // ensure latest pins show
    }
  }

  function setActive(btn, active) {
    if (!btn) return;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
  }

  function wireNav() {
    navEditor?.addEventListener('click', () => activateTab('editor'));
    navDirectory?.addEventListener('click', (e) => {
      e.preventDefault();
      activateTab('directory');
    });
    navDropbox?.addEventListener('click', (e) => {
      e.preventDefault();
      activateTab('dropbox');
    });
  }

  // Enable Directory/Dropbox without touching HTML structure
  function unlockTabs() {
    [navDirectory, navDropbox].forEach(btn => {
      if (!btn) return;
      btn.removeAttribute('aria-disabled');
      btn.tabIndex = 0;
    });
    [tabDirectory, tabDropbox].forEach(sec => {
      if (!sec) return;
      sec.removeAttribute('aria-disabled');
    });
  }

  // ---------- Top notifications (singleton + de-dupe) ----------
  // Internal state to prevent spam/flooding
  const DEDUPE_MS = 3000;                 // drop exact duplicate title+msg within this window
  let activeNotice = null;                // HTMLElement of the current .notice (or null)
  let activeTimer = null;                 // dismiss timer handle
  let lastNoticeKey = '';                 // last "title|msg"
  let lastNoticeTs = 0;                   // timestamp of last shown key

  function notify({ title = 'Notice', msg = '', duration = 3000 } = {}) {
    if (!notifyRoot) return;

    const key = `${title}|${msg}`;
    const now = Date.now();

    // 1) De-dupe: exact same key within window → ignore
    if (key === lastNoticeKey && (now - lastNoticeTs) < DEDUPE_MS) return;
    lastNoticeKey = key;
    lastNoticeTs = now;

    // 2) If a notice is already visible, update it in-place instead of stacking
    if (activeNotice && activeNotice.isConnected) {
      const t = activeNotice.querySelector('.notice__title');
      const p = activeNotice.querySelector('.notice__msg');
      const bar = activeNotice.querySelector('.notice__bar');

      if (t) t.textContent = title;
      if (p) p.textContent = msg;

      // Reset/retime the progress bar animation
      if (bar) {
        bar.style.setProperty('--dur', `${duration}ms`);
        bar.style.animation = 'none';     // force restart
        // trigger reflow to restart animation
        // eslint-disable-next-line no-unused-expressions
        bar.offsetHeight;
        bar.style.animation = '';
      }

      // Reset the dismissal timer
      clearTimeout(activeTimer);
      activeTimer = setTimeout(closeActiveNotice, duration + 60);
      return;
    }

    // 3) No notice on screen → ensure tray is clean, then create one
    // If anything else leaked in, clear it
    while (notifyRoot.firstChild) notifyRoot.removeChild(notifyRoot.firstChild);

    const card = document.createElement('div');
    card.className = 'notice';
    card.setAttribute('role', 'status');
    card.innerHTML = `
      <div class="notice__title">${escapeHTML(title)}</div>
      <p class="notice__msg">${escapeHTML(msg)}</p>
      <div class="notice__bar" style="--dur:${duration}ms"></div>
    `;
    card.style.opacity = '0';
    card.style.transform = 'translateY(-8px)';
    notifyRoot.appendChild(card);

    // capture as the active singleton
    activeNotice = card;

    // clicking dismisses (and clears internal pointer)
    card.addEventListener('click', () => {
      closeActiveNotice(true);
    }, { once: true });

    // animate in
    requestAnimationFrame(() => {
      card.style.transform = 'translateY(0)';
      card.style.opacity = '1';
    });

    // auto-dismiss
    clearTimeout(activeTimer);
    activeTimer = setTimeout(closeActiveNotice, duration + 60);
  }

  function closeActiveNotice(userInitiated = false) {
    if (!activeNotice) return;
    const el = activeNotice;
    activeNotice = null;
    clearTimeout(activeTimer);
    el.style.opacity = '0';
    el.style.transform = 'translateY(-8px)';
    setTimeout(() => {
      if (el.isConnected) el.remove();
      // If user spam-clicked notify() again right as we closed,
      // leave lastNoticeKey/lastNoticeTs alone so dedupe still works.
      if (userInitiated) {
        // optional: keep dedupe window intact
      }
    }, 180);
  }

  // ---------- Status / toasts (topbar inline) ----------
  let toastTimer = null;
  function toast(message, ms = 1500) {
    if (!statusRegion) return;
    clearTimeout(toastTimer);
    statusRegion.textContent = message;
    toastTimer = setTimeout(() => {
      statusRegion.textContent = '';
    }, ms);
  }

  // ---------- Editor: line numbers ----------
  function countLines(value) {
    return Math.max(1, value.split('\n').length);
  }

  function ensureGutterLines() {
    if (!textarea || !gutterList) return;
    const lines = countLines(textarea.value);
    const current = gutterList.children.length;

    if (current < lines) {
      for (let i = current; i < lines; i++) {
        gutterList.appendChild(document.createElement('li'));
      }
    } else if (current > lines) {
      for (let i = current; i > lines; i--) {
        const last = gutterList.lastElementChild;
        if (last) last.remove();
      }
    }
  }

  function syncGutterScroll() {
    if (!textarea || !gutterList) return;
    gutterList.style.transform = `translateY(${-textarea.scrollTop}px)`;
  }

  function wireEditor() {
    if (!textarea) return;

    textarea.addEventListener('input', () => {
      ensureGutterLines();
      updateLanguageHeuristic();
    });

    textarea.addEventListener('scroll', syncGutterScroll);
    window.addEventListener('resize', ensureGutterLines);

    btnCopy?.addEventListener('click', onCopy);
    btnPaste?.addEventListener('click', onPaste);
    btnDelete?.addEventListener('click', onDelete);

    // NEW: Save button opens Save modal
    btnSave?.addEventListener('click', openSaveModalPrefilled);
  }

  // ---------- Editor: copy/paste/delete ----------
  async function onCopy() {
    try {
      const text = textarea.value;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        textarea.select();
        document.execCommand('copy');
        textarea.setSelectionRange(text.length, text.length);
      }
      toast('Copied to clipboard');
      notify({ title: 'Copied', msg: 'Editor contents saved to clipboard.', duration: 2000 });
    } catch {
      toast('Copy failed (permissions?)');
      notify({ title: 'Copy failed', msg: 'Clipboard permission denied.', duration: 2500 });
    }
  }

  async function onPaste() {
    try {
      if (!navigator.clipboard?.readText) {
        toast('Paste not available in this context');
        notify({ title: 'Paste unavailable', msg: 'Browser blocked read access.', duration: 2500 });
        return;
      }
      const paste = await navigator.clipboard.readText();
      const { selectionStart, selectionEnd, value } = textarea;
      const before = value.slice(0, selectionStart);
      const after = value.slice(selectionEnd);
      textarea.value = before + paste + after;
      const caret = (before + paste).length;
      textarea.setSelectionRange(caret, caret);
      ensureGutterLines();
      updateLanguageHeuristic();
      toast('Pasted from clipboard');
      notify({ title: 'Pasted', msg: 'Content inserted into editor.', duration: 2000 });
    } catch {
      toast('Paste failed (permissions?)');
      notify({ title: 'Paste failed', msg: 'Clipboard permission denied.', duration: 2500 });
    }
  }

  function onDelete() {
    openModal(modalClear);
  }

  // ---------- Modal: confirm clear + Save modal ----------
  let lastFocused = null;

  function openModal(modalEl) {
    if (!modalEl) return;
    lastFocused = document.activeElement;
    document.body.classList.add('body--modal-open');
    modalEl.hidden = false;

    const focusables = getFocusable(modalEl);
    if (focusables.length) focusables[0].focus();

    modalEl.addEventListener('keydown', trapFocus);
    modalEl.addEventListener('keydown', onEscClose);
  }

  function closeModal(modalEl) {
    if (!modalEl) return;
    document.body.classList.remove('body--modal-open');
    modalEl.hidden = true;
    modalEl.removeEventListener('keydown', trapFocus);
    modalEl.removeEventListener('keydown', onEscClose);
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  }

  function onEscClose(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal(modalClear);
      closeModal(fileModal);
      closeModal(modalSave); // NEW
    }
  }

  function getFocusable(root) {
    return $$(
      [
        'a[href]',
        'button:not([disabled])',
        'textarea:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        '[tabindex]:not([tabindex="-1"])'
      ].join(','),
      root
    ).filter(el => !el.hasAttribute('disabled') && !el.getAttribute('aria-disabled'));
  }

  function trapFocus(e) {
    if (e.key !== 'Tab') return;
    const currentModal = !modalClear?.hidden
      ? modalClear
      : (!fileModal?.hidden ? fileModal : (!modalSave?.hidden ? modalSave : null));
    if (!currentModal) return;
    const focusables = getFocusable(currentModal);
    if (!focusables.length) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function wireModal() {
    // Clear editor modal
    modalCancel?.addEventListener('click', () => closeModal(modalClear));
    modalConfirm?.addEventListener('click', () => {
      textarea.value = '';
      ensureGutterLines();
      updateLanguageHeuristic();
      closeModal(modalClear);
      toast('Editor cleared');
      notify({ title: 'Cleared', msg: 'Editor emptied.', duration: 1800 });
    });

    modalClear?.addEventListener('mousedown', (e) => {
      if (e.target === modalClear) closeModal(modalClear);
    });

    // File modal (Directory actions)
    mfClose?.addEventListener('click', () => closeModal(fileModal));
    fileModal?.addEventListener('mousedown', (e) => {
      if (e.target === fileModal) closeModal(fileModal);
    });

    mfEdit?.addEventListener('click', () => {
      const id = fileModal?.dataset?.fileId;
      const item = VAULT.find(f => f.id === id);
      if (!item) {
        notify({ title: 'Missing', msg: 'File not found.', duration: 2000 });
        return;
      }
      if (typeof item.text === 'string') {
        textarea.value = item.text;
        ensureGutterLines();
        updateLanguageHeuristic();
        activateTab('editor');
        toast(`Loaded "${item.name}"`);
        notify({ title: 'Opened in Editor', msg: item.name, duration: 2000 });
      } else {
        notify({ title: 'Not editable', msg: 'Binary file cannot open in editor.', duration: 2400 });
      }
      closeModal(fileModal);
    });

    mfDownload?.addEventListener('click', () => {
      const id = fileModal?.dataset?.fileId;
      const item = VAULT.find(f => f.id === id);
      if (!item) return;

      let blob;
      if (typeof item.text === 'string') {
        blob = new Blob([item.text], { type: item.mime || 'text/plain;charset=utf-8' });
      } else if (item.base64) {
        const bytes = atob(item.base64);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        blob = new Blob([arr], { type: item.mime || 'application/octet-stream' });
      } else {
        notify({ title: 'No data', msg: 'Nothing to download.', duration: 2000 });
        return;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = item.name || 'file';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 500);
      notify({ title: 'Downloading', msg: item.name, duration: 1800 });
    });

    mfDelete?.addEventListener('click', () => {
      const id = fileModal?.dataset?.fileId;
      if (!id) return;
      VAULT = VAULT.filter(f => f.id !== id);
      saveVaultToStorage();
      renderDirectory();
      closeModal(fileModal);
      notify({ title: 'Deleted', msg: 'Removed from vault.', duration: 1800 });
    });

    // NEW: Save modal buttons
    saveCancel?.addEventListener('click', () => closeModal(modalSave));
    modalSave?.addEventListener('mousedown', (e) => {
      if (e.target === modalSave) closeModal(modalSave);
    });
    saveConfirm?.addEventListener('click', handleSaveConfirm);
  }

  // ---------- Save-from-Editor flow ----------
  function openSaveModalPrefilled() {
    const text = (textarea?.value || '').trim();
    if (!text) {
      notify({ title: 'Nothing to save', msg: 'Editor is empty.', duration: 2000 });
      return;
    }
    // Prefill filename + category based on heuristic
    saveTitle.value = inferFilename();
    saveCategory.value = mapLangToCategory(langSlot?.textContent || '');
    saveNote.value = '';
    openModal(modalSave);
  }

  function mapLangToCategory(lang) {
    const s = (lang || '').toLowerCase();
    if (s.includes('python')) return 'Python';
    if (s.includes('powershell')) return 'PowerShell';
    if (s.includes('batch')) return 'Bat';
    if (s.includes('bash') || s.includes('shell')) return 'Bash/Shell';
    if (s.includes('javascript')) return 'JavaScript';
    if (s.includes('html')) return 'HTML';
    if (s.includes('json')) return 'JSON';
    if (s.includes('badusb')) return 'BadUSB';
    if (s.includes('sql')) return 'SQL';
    return 'Hacking';
  }

  function handleSaveConfirm() {
    const text = (textarea?.value || '').trim();
    if (!text) {
      notify({ title: 'Nothing to save', msg: 'Editor is empty.', duration: 2000 });
      closeModal(modalSave);
      return;
    }
    const name = (saveTitle?.value || '').trim() || inferFilename();
    const cat = (saveCategory?.value || '').trim() || 'Hacking';
    const note = (saveNote?.value || '').trim();

    const payload = {
      text: text.length <= MAX_TEXT_BYTES ? text : text.slice(0, MAX_TEXT_BYTES),
      base64: null,
      mime: 'text/plain;charset=utf-8'
    };

    finalizeVault({ name, note, cat, payload }).then(() => {
      closeModal(modalSave);
    });
  }

  // ---------- Language heuristic ----------
  function updateLanguageHeuristic() {
    if (!langSlot) return;
    const text = textarea.value;

    const tests = [
      { name: 'Python', re: /\b(def |import |from |elif|self\b|print\(|async\s+def|with |lambda )/ },
      { name: 'PowerShell', re: /\b(Get-|Set-|New-|Write-Host|Import-Module|\$env:|\.ps1\b)/i },
      { name: 'Batch (.bat)', re: /\b(@echo off|setlocal|endlocal|goto\s+:|\.bat\b|%\~\w)/i },
      { name: 'Bash/Shell', re: /\b(#!\/bin\/bash|#!\/bin\/sh|#!\/usr\/bin\/env\s+bash|#!)/i },
      { name: 'JavaScript', re: /\b(functions?\s+|=>|const\s+|let\s+|document\.|console\.|import\s+|export\s+)/ },
      { name: 'HTML', re: /<\/?[a-z][\s\S]*>/i },
      { name: 'JSON', re: /^\s*\{[\s\S]*\}\s*$/ },
      { name: 'BadUSB (DuckyScript)', re: /\b(STRING |DELAY |GUI |CTRL |ALT |ENTER|REM )/i },
      { name: 'SQL', re: /\b(SELECT |INSERT |UPDATE |DELETE |FROM |WHERE |JOIN )/i }
    ];

    const found = tests.find(t => t.re.test(text));
    langSlot.textContent = found ? found.name : 'Auto (pending)';
  }

  // ---------- Keybinds ----------
  function wireKeybinds() {
    document.addEventListener('keydown', (e) => {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onDelete();
      }
      // Quick save: Cmd/Ctrl+S opens Save modal
      if (meta && e.key.toLowerCase() === 's') {
        e.preventDefault();
        openSaveModalPrefilled();
      }
    });
  }

  // ---------- VAULT: persistence ----------
  function loadVaultFromStorage() {
    try {
      const raw = localStorage.getItem(VAULT_KEY);
      VAULT = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(VAULT)) VAULT = [];
    } catch {
      VAULT = [];
    }
  }

  function saveVaultToStorage() {
    try {
      localStorage.setItem(VAULT_KEY, JSON.stringify(VAULT));
    } catch (e) {
      notify({ title: 'Storage full', msg: 'Could not save to localStorage.', duration: 2500 });
    }
  }

  // ---------- DIRECTORY: render & open modal ----------
  function renderDirectory() {
    if (!dirGrid) return;

    // Ensure minimal seeds if completely empty the first time
    if (VAULT.length === 0 && !localStorage.getItem(VAULT_KEY)) {
      const seed = [
        { id: uid(), name: 'recon.py', cat: 'Python', note: 'Light footprint recon.', text: '#!/usr/bin/env python3\nprint("recon!")', mime: 'text/x-python' },
        { id: uid(), name: 'persist.ps1', cat: 'PowerShell', note: 'Demo persistence script.', text: 'Write-Host "Hello"', mime: 'text/x-powershell' },
      ];
      VAULT.push(...seed);
      saveVaultToStorage();
    }

    dirGrid.innerHTML = '';
    const q = (dirSearch?.value || '').toLowerCase();

    VAULT.forEach(item => {
      const hay = `${item.name} ${item.cat} ${item.note || ''}`.toLowerCase();
      if (q && !hay.includes(q)) return;

      const card = document.createElement('div');
      card.className = 'file-card';
      card.dataset.name = item.name || '';
      card.dataset.cat = item.cat || '';
      card.dataset.note = item.note || '';
      card.dataset.id = item.id;
      card.innerHTML = `
        <div class="file-card__name">${escapeHTML(item.name || 'unnamed')}</div>
        <div class="file-card__cat">${escapeHTML(item.cat || '—')}</div>
        <div class="file-card__note">${escapeHTML(item.note || '')}</div>
        <button class="btn file-card__btn" type="button">Open</button>
      `;
      card.querySelector('.file-card__btn')?.addEventListener('click', () => {
        mfName.textContent = item.name || '—';
        mfCategory.textContent = item.cat || '—';
        mfNote.textContent = item.note || '—';
        fileModal.dataset.fileId = item.id;
        openModal(fileModal);
      });
      dirGrid.appendChild(card);
    });
  }

  dirSearch?.addEventListener('input', renderDirectory);

  // ---------- DROPBOX: "Vault It" + "Vault From Editor" ----------
  function wireDropbox() {
    // Intercept form submit for "Vault It"
    dropForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await vaultFromForm(); // uses file if provided, else editor text if present
    });

    // Explicitly vault from editor regardless of file input
    btnVaultBlank?.addEventListener('click', async () => {
      await vaultFromEditor();
    });
  }

  async function vaultFromForm() {
    // Collect metadata
    const name = (dropTitle?.value || '').trim() || inferFilename();
    const note = (dropNote?.value || '').trim();
    const cat = (dropCategory?.value || '').trim() || 'Hacking';

    let payload = { text: null, base64: null, mime: null };
    const file = dropFile?.files?.[0];

    if (file) {
      payload.mime = file.type || 'application/octet-stream';
      try {
        if (file.size <= MAX_TEXT_BYTES) {
          const text = await readFileAsText(file);
          payload.text = text;
        } else {
          const b64 = await readFileAsBase64(file);
          payload.base64 = b64;
        }
      } catch {
        notify({ title: 'Read error', msg: 'Could not read uploaded file.', duration: 2200 });
      }
    } else if (textarea && textarea.value.trim().length) {
      const text = textarea.value;
      payload.text = text.length <= MAX_TEXT_BYTES ? text : text.slice(0, MAX_TEXT_BYTES);
      payload.mime = 'text/plain;charset=utf-8';
    }

    await finalizeVault({ name, note, cat, payload });
  }

  async function vaultFromEditor() {
    const text = (textarea?.value || '').trim();
    if (!text) {
      notify({ title: 'Nothing to vault', msg: 'Editor is empty.', duration: 2000 });
      return;
    }
    const name = inferFilename();
    const note = (dropNote?.value || '').trim(); // optional carry-over
    const cat = (dropCategory?.value || '').trim() || 'Hacking';

    const payload = {
      text: text.length <= MAX_TEXT_BYTES ? text : text.slice(0, MAX_TEXT_BYTES),
      base64: null,
      mime: 'text/plain;charset=utf-8'
    };

    await finalizeVault({ name, note, cat, payload });
  }

  async function finalizeVault({ name, note, cat, payload }) {
    const item = {
      id: uid(),
      name,
      cat,
      note,
      mime: payload.mime || null
    };
    if (payload.text !== null) item.text = payload.text;
    if (payload.base64 !== null) item.base64 = payload.base64;

    VAULT.unshift(item);
    saveVaultToStorage();
    renderDirectory();

    notify({ title: 'Vaulted', msg: `"${name}" added to Directory.`, duration: 2200 });
    toast('Saved to vault');

    // Reset inputs
    if (dropTitle) dropTitle.value = '';
    if (dropNote) dropNote.value = '';
    if (dropCategory) dropCategory.value = 'Hacking';
    if (dropFile) dropFile.value = '';

    // Show the user the result
    activateTab('directory');
  }

  function inferFilename() {
    // Try to infer from editor language / fallback timestamp
    const hint = (langSlot?.textContent || '').toLowerCase();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (hint.includes('python')) return `script-${stamp}.py`;
    if (hint.includes('powershell')) return `script-${stamp}.ps1`;
    if (hint.includes('batch')) return `script-${stamp}.bat`;
    if (hint.includes('bash') || hint.includes('shell')) return `script-${stamp}.sh`;
    if (hint.includes('javascript')) return `script-${stamp}.js`;
    if (hint.includes('html')) return `snippet-${stamp}.html`;
    if (hint.includes('json')) return `data-${stamp}.json`;
    if (hint.includes('badusb')) return `payload-${stamp}.txt`;
    if (hint.includes('sql')) return `query-${stamp}.sql`;
    return `vault-${stamp}.txt`;
  }

  function readFileAsText(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result || ''));
      r.onerror = rej;
      r.readAsText(file);
    });
  }
  function readFileAsBase64(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => {
        const result = String(r.result || '');
        const b64 = result.split(',')[1] || '';
        res(b64);
      };
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  // ---------- SPOTLIGHT: persistence + rendering ----------
  function loadSpotFromStorage() {
    try {
      const raw = localStorage.getItem(SPOT_KEY);
      SPOT = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(SPOT)) SPOT = [];
    } catch {
      SPOT = [];
    }
  }

  function saveSpotToStorage() {
    try {
      localStorage.setItem(SPOT_KEY, JSON.stringify(SPOT));
    } catch {
      notify({ title: 'Storage full', msg: 'Could not save Spotlight items.', duration: 2500 });
    }
  }

  function renderSpotlight() {
    if (!spotList) return;
    spotList.innerHTML = '';

    if (!SPOT.length) {
      const empty = document.createElement('div');
      empty.className = 'spot__empty';
      empty.textContent = 'No links yet. Add one above.';
      spotList.appendChild(empty);
    } else {
      SPOT.forEach(item => {
        const row = document.createElement('div');
        row.className = 'spot__item';
        row.setAttribute('role', 'listitem');
        row.dataset.id = item.id;

        // anchor
        const a = document.createElement('a');
        a.className = 'spot__item-link';
        a.textContent = item.title || item.url;
        a.href = item.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';

        const url = document.createElement('div');
        url.className = 'spot__item-url';
        url.textContent = item.url;

        row.appendChild(a);
        row.appendChild(url);

        // When delete mode is ON, clicking deletes immediately
        row.addEventListener('click', (e) => {
          if (!spotDeleteMode) return; // normal behavior when Off (let <a> open)
          e.preventDefault();
          const id = row.dataset.id;
          SPOT = SPOT.filter(x => x.id !== id);
          saveSpotToStorage();
          renderSpotlight();
          notify({ title: 'Deleted', msg: 'Link removed from Spotlight.', duration: 1600 });
        });

        // When Off, allow row click to open link even outside the <a>
        row.addEventListener('mousedown', (e) => {
          if (spotDeleteMode) return;
          if (e.target.tagName.toLowerCase() !== 'a') {
            window.open(item.url, '_blank', 'noopener');
          }
        });

        spotList.appendChild(row);
      });
    }

    // reflect toggle label/state
    if (spotToggle) {
      spotToggle.textContent = spotDeleteMode ? 'On' : 'Off';
      spotToggle.setAttribute('aria-pressed', String(spotDeleteMode));
    }
  }

  function wireSpotlight() {
    // Add new link
    spotAdd?.addEventListener('click', () => {
      const title = (spotTitle?.value || '').trim();
      const url = (spotLink?.value || '').trim();

      if (!url) {
        notify({ title: 'Missing link', msg: 'Enter a URL to pin.', duration: 2000 });
        return;
      }
      const normalized = normalizeUrl(url);
      if (!isLikelyUrl(normalized)) {
        notify({ title: 'Invalid URL', msg: 'Double-check the link format.', duration: 2200 });
        return;
      }
      const item = {
        id: uid(),
        title: title || normalized,
        url: normalized,
        addedAt: Date.now()
      };
      SPOT.unshift(item);
      saveSpotToStorage();
      renderSpotlight();

      if (spotTitle) spotTitle.value = '';
      if (spotLink) spotLink.value = '';

      notify({ title: 'Pinned', msg: 'Link added to Spotlight.', duration: 1800 });
      toast('Spotlight updated');
    });

    // Toggle delete mode (Off ↔ On)
    spotToggle?.addEventListener('click', () => {
      spotDeleteMode = !spotDeleteMode;
      renderSpotlight();
      notify({
        title: `Delete mode: ${spotDeleteMode ? 'ON' : 'OFF'}`,
        msg: spotDeleteMode ? 'Tap a saved link to delete it immediately.' : 'Link taps will open as usual.',
        duration: 2400
      });
    });
  }

  function normalizeUrl(u) {
    try {
      const test = new URL(u);
      return test.href;
    } catch {
      try {
        const test2 = new URL(`https://${u}`);
        return test2.href;
      } catch {
        return u;
      }
    }
  }
  function isLikelyUrl(u) {
    return /^https?:\/\/.+\..+/.test(u);
    }

  // ---------- Utils ----------
  function escapeHTML(str = '') {
    return str.replace(/[&<>"']/g, s => (
      { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[s]
    ));
  }
  function uid() {
    return 'id-' + Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36);
  }

  // ---------- Initialize ----------
  window.addEventListener('DOMContentLoaded', () => {
    wireNav();
    wireEditor();
    wireModal();
    wireKeybinds();
    unlockTabs();
    wireDropbox();        // listens to #drop-form submit and #btn-vault-blank
    wireSpotlight();      // Spotlight add/toggle/delete
    loadVaultFromStorage();
    renderDirectory();
    loadSpotFromStorage();
    renderSpotlight();
    boot();
  });
})();
