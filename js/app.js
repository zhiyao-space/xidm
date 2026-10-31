(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
    }
  };

  var S = {
    settings: store.get('mono_settings', { baseUrl: '', apiKey: '', model: '', system: '' }),
    presets: store.get('mono_presets', []),
    activePresetId: store.get('mono_active_preset', ''),
    repoCfg: store.get('mono_repo', { url: '', token: '', branch: '' }),
    messages: store.get('mono_session', { title: '', messages: [] }).messages,
    title: store.get('mono_session', { title: '', messages: [] }).title || '',
    files: store.get('mono_files', {}),
    attachments: [],
    repoFiles: [],
    generating: false,
    abortCtrl: null,
    genStart: 0,
    genTimer: null
  };

  var DEFAULT_SYSTEM = '你是 MONO/CODE 工作台中的编码助手。规则：\n1. 用中文回复，简洁专业。\n2. 写代码时，每个独立文件用一个代码块，代码块信息行格式为「语言 文件路径」，例如 ```html index.html 或 ```css css/style.css。每个文件写完整内容，不要省略。\n3. 动手写代码前，先用 2-4 句话简述实现计划（即工作汇报）。\n4. 纯前端项目默认使用 HTML/CSS/JS 单页结构，入口为 index.html。\n5. 遵循现代、简洁、可维护的编码风格。';

  var EXT_MAP = { html: 'html', htm: 'html', css: 'css', js: 'js', javascript: 'js', ts: 'ts', jsx: 'jsx', tsx: 'tsx', json: 'json', py: 'py', python: 'py', go: 'go', java: 'java', md: 'md', markdown: 'md', sh: 'sh', bash: 'sh', yaml: 'yml', yml: 'yml', vue: 'vue', sql: 'sql', txt: 'txt', xml: 'xml', toml: 'toml' };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtSize(n) {
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
    return (n / 1024 / 1024).toFixed(1) + 'MB';
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.hidden = true; }, ms || 2200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板');
    } catch (e) {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制到剪贴板');
    }
  }

  function downloadText(name, content) {
    var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    MonoZip.downloadBlob(blob, name.split('/').pop());
  }

  function extOf(name) {
    var m = String(name).match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
  }

  function langToFile(lang, idx) {
    var l = (lang || '').toLowerCase();
    var ext = EXT_MAP[l] || (l && /^[a-z0-9]{1,6}$/.test(l) ? l : 'txt');
    return 'untitled-' + (idx + 1) + '.' + ext;
  }

  function saveSession() {
    store.set('mono_session', { title: S.title, messages: S.messages });
  }

  function saveFiles() {
    store.set('mono_files', S.files);
    renderWsFiles();
  }

  function saveSettings() {
    store.set('mono_settings', S.settings);
  }

  /* ---------------- Nav / Sidebar ---------------- */

  function initNav() {
    var items = document.querySelectorAll('.nav-item');
    items.forEach(function (item) {
      item.addEventListener('click', function () {
        var panel = $(item.dataset.panel);
        var isOpen = panel.classList.contains('show');
        document.querySelectorAll('.nav-panel').forEach(function (p) { p.classList.remove('show'); });
        items.forEach(function (i) { i.classList.remove('open'); });
        if (!isOpen) {
          panel.classList.add('show');
          item.classList.add('open');
        }
      });
    });

    $('menuBtn').addEventListener('click', function () {
      $('sidebar').classList.add('open');
      $('scrim').classList.add('show');
    });
    $('sidebarClose').addEventListener('click', closeSidebar);
    $('scrim').addEventListener('click', closeSidebar);
  }

  function closeSidebar() {
    $('sidebar').classList.remove('open');
    $('scrim').classList.remove('show');
  }

  /* ---------------- API config ---------------- */

  function activePresetModels() {
    var p = S.presets.find(function (x) { return x.id === S.activePresetId; });
    return p && p.models ? p.models : [];
  }

  function closeDropdowns() {
    $('presetMenu').hidden = true;
    $('modelMenu').hidden = true;
    $('presetDD').classList.remove('open');
    $('modelDD').classList.remove('open');
  }

  function renderModelDatalist(models) {
    var box = $('modelOptions');
    if (!box) return;
    box.innerHTML = '';
    var list = models || [];
    var q = ($('modelSearch').value || '').trim().toLowerCase();
    var shown = q ? list.filter(function (m) { return m.toLowerCase().indexOf(q) >= 0; }) : list;

    if (!list.length) {
      var h = document.createElement('div');
      h.className = 'dd-hint';
      h.textContent = '暂无模型列表 · 先点「识别模型」拉取';
      box.appendChild(h);
      return;
    }
    if (!shown.length) {
      var nh = document.createElement('div');
      nh.className = 'dd-hint';
      nh.textContent = '无匹配模型';
      box.appendChild(nh);
      return;
    }
    shown.slice(0, 300).forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dd-item';
      b.textContent = m;
      b.addEventListener('click', function () {
        $('cfgModel').value = m;
        syncSettingsFromForm();
        saveSettings();
        closeDropdowns();
        toast('已选择：' + m);
      });
      box.appendChild(b);
    });
    var cnt = document.createElement('div');
    cnt.className = 'dd-hint';
    cnt.textContent = '共 ' + shown.length + ' 个模型' + (q ? ' · 已按「' + q + '」过滤' : '');
    box.appendChild(cnt);
  }

  function syncSettingsFromForm() {
    S.settings.baseUrl = $('cfgBaseUrl').value.trim();
    S.settings.apiKey = $('cfgApiKey').value.trim();
    S.settings.model = $('cfgModel').value.trim();
    S.settings.system = $('cfgSystem').value.trim();
  }

  function applyPreset(p) {
    $('cfgName').value = p ? (p.name || '') : '';
    $('cfgBaseUrl').value = p ? (p.baseUrl || '') : '';
    $('cfgApiKey').value = p ? (p.apiKey || '') : '';
    $('cfgModel').value = p ? (p.model || '') : '';
    updatePresetLabel();
    syncSettingsFromForm();
    saveSettings();
  }

  function updatePresetLabel() {
    var p = S.presets.find(function (x) { return x.id === S.activePresetId; }) || null;
    $('presetLabel').textContent = p
      ? (p.name || '未命名') + (p.model ? ' · ' + p.model : '')
      : '（暂无预设 · 填写后保存）';
  }

  function renderPresetMenu() {
    var menu = $('presetMenu');
    menu.innerHTML = '';
    if (!S.presets.length) {
      var hint = document.createElement('div');
      hint.className = 'dd-hint';
      hint.textContent = '暂无预设 · 填写配置后点「保存预设」';
      menu.appendChild(hint);
      return;
    }
    S.presets.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dd-item' + (p.id === S.activePresetId ? ' active' : '');
      var label = document.createElement('span');
      label.textContent = p.name || '未命名';
      var sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = p.model || '';
      b.appendChild(label);
      b.appendChild(sub);
      b.addEventListener('click', function () {
        S.activePresetId = p.id;
        store.set('mono_active_preset', S.activePresetId);
        applyPreset(p);
        closeDropdowns();
        toast('已切换预设：' + (p.name || '未命名'));
      });
      menu.appendChild(b);
    });
  }

  function renderPresetSelect() {
    var valid = S.presets.some(function (p) { return p.id === S.activePresetId; });
    if (!valid) S.activePresetId = S.presets.length ? S.presets[0].id : '';
    updatePresetLabel();
    if (!$('presetMenu').hidden) renderPresetMenu();
    store.set('mono_active_preset', S.activePresetId);
  }

  function initApiPanel() {
    if (!S.presets.length && (S.settings.baseUrl || S.settings.apiKey)) {
      S.presets.push({
        id: 'p' + Date.now(),
        name: '默认配置',
        baseUrl: S.settings.baseUrl || '',
        apiKey: S.settings.apiKey || '',
        model: S.settings.model || '',
        models: []
      });
      S.activePresetId = S.presets[0].id;
      store.set('mono_presets', S.presets);
      store.set('mono_active_preset', S.activePresetId);
    }
    $('cfgSystem').value = S.settings.system || DEFAULT_SYSTEM;

    $('presetToggle').addEventListener('click', function () {
      var willOpen = $('presetMenu').hidden;
      closeDropdowns();
      if (willOpen) {
        renderPresetMenu();
        $('presetMenu').hidden = false;
        $('presetDD').classList.add('open');
      }
    });

    $('btnModelToggle').addEventListener('click', function () {
      var willOpen = $('modelMenu').hidden;
      closeDropdowns();
      if (willOpen) {
        $('modelSearch').value = '';
        renderModelDatalist(activePresetModels());
        $('modelMenu').hidden = false;
        $('modelDD').classList.add('open');
        $('modelSearch').focus();
      }
    });

    $('modelSearch').addEventListener('input', function () {
      renderModelDatalist(activePresetModels());
    });

    document.addEventListener('pointerdown', function (e) {
      if (!e.target.closest('#presetDD') && !e.target.closest('#modelDD')) closeDropdowns();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDropdowns();
    });

    $('btnFetchModels').addEventListener('click', async function () {
      var btn = $('btnFetchModels');
      var cfg = { baseUrl: $('cfgBaseUrl').value.trim(), apiKey: $('cfgApiKey').value.trim() };
      if (!cfg.baseUrl && !cfg.apiKey) { toast('请先填写 Base URL 与 API Key'); return; }
      btn.textContent = '识别中…';
      btn.disabled = true;
      try {
        var ids = await MonoAPI.listModels(cfg);
        if (!ids.length) throw new Error('服务未返回模型列表');
        var p = S.presets.find(function (x) { return x.id === S.activePresetId; });
        if (p) { p.models = ids; store.set('mono_presets', S.presets); }
        if (!$('modelMenu').hidden) renderModelDatalist(ids);
        if (!$('cfgModel').value.trim()) {
          $('cfgModel').value = ids[0];
          syncSettingsFromForm();
          saveSettings();
        }
        toast('识别到 ' + ids.length + ' 个模型，点击 MODEL 输入框选择');
      } catch (e) {
        toast('识别失败：' + e.message, 3500);
      }
      btn.textContent = '识别模型';
      btn.disabled = false;
    });

    $('btnSaveApi').addEventListener('click', function () {
      syncSettingsFromForm();
      saveSettings();
      var p = S.presets.find(function (x) { return x.id === S.activePresetId; });
      if (!p) {
        p = { id: 'p' + Date.now(), models: [] };
        S.presets.push(p);
        S.activePresetId = p.id;
      }
      p.name = $('cfgName').value.trim() || '未命名配置';
      p.baseUrl = S.settings.baseUrl;
      p.apiKey = S.settings.apiKey;
      p.model = S.settings.model;
      store.set('mono_presets', S.presets);
      store.set('mono_active_preset', S.activePresetId);
      renderPresetSelect();
      toast('预设已保存：' + p.name);
    });

    $('btnTestApi').addEventListener('click', async function () {
      var cfg = {
        baseUrl: $('cfgBaseUrl').value.trim(),
        apiKey: $('cfgApiKey').value.trim(),
        model: $('cfgModel').value.trim()
      };
      if (!cfg.baseUrl && !cfg.apiKey) { toast('请先填写 Base URL 或 API Key'); return; }
      $('btnTestApi').textContent = '测试中…';
      $('btnTestApi').disabled = true;
      try {
        await MonoAPI.testConnection(cfg);
        toast('连接成功，服务可用');
      } catch (e) {
        toast('连接失败：' + e.message, 3500);
      }
      $('btnTestApi').textContent = '测试连通';
      $('btnTestApi').disabled = false;
    });

    ['cfgBaseUrl', 'cfgApiKey', 'cfgModel'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        syncSettingsFromForm();
        saveSettings();
      });
    });

    $('cfgSystem').addEventListener('change', function () {
      S.settings.system = $('cfgSystem').value.trim();
      saveSettings();
    });

    renderPresetSelect();
  }

  function apiReady() {
    return !!(S.settings.apiKey || S.settings.baseUrl);
  }

  /* ---------------- Repo ---------------- */

  function initRepoPanel() {
    $('repoUrl').value = S.repoCfg.url || '';
    $('repoToken').value = S.repoCfg.token || '';
    $('repoBranch').value = S.repoCfg.branch || '';

    $('btnFetchRepo').addEventListener('click', function () {
      if (S.fetching) return;
      var url = $('repoUrl').value.trim();
      if (!url) { toast('请填写仓库地址'); return; }
      S.repoCfg = { url: url, token: $('repoToken').value.trim(), branch: $('repoBranch').value.trim() };
      store.set('mono_repo', S.repoCfg);
      fetchRepo();
    });
  }

  function setRepoProgress(text, cur, total, detail) {
    $('repoProgress').hidden = false;
    $('repoStatusText').textContent = text + (detail ? ' · ' + detail : '');
    var pct = total ? Math.round((cur / total) * 100) : 0;
    $('repoPercent').textContent = pct + '%';
    $('repoBar').style.width = pct + '%';
  }

  async function fetchRepo() {
    S.fetching = true;
    $('btnFetchRepo').disabled = true;
    $('btnFetchRepo').textContent = '拉取中';
    $('repoFiles').innerHTML = '';
    try {
      var result = await MonoGit.pullRepo({
        url: S.repoCfg.url,
        token: S.repoCfg.token,
        branch: S.repoCfg.branch,
        onProgress: setRepoProgress
      });
      S.repoMeta = result.info;
      S.repoFiles = result.files;
      S.repoTreeCount = result.tree.length;
      toast('拉取完成：' + result.files.length + ' 个文件已就绪');
      renderRepoFiles();
    } catch (e) {
      toast(e.message, 4000);
      setRepoProgress('失败', 0, 1, e.message);
    }
    S.fetching = false;
    $('btnFetchRepo').disabled = false;
    $('btnFetchRepo').textContent = '拉取';
  }

  function renderRepoFiles() {
    var box = $('repoFiles');
    box.innerHTML = '';
    if (!S.repoFiles.length) return;

    var head = document.createElement('div');
    head.className = 'file-row';
    head.style.cursor = 'default';
    var meta = S.repoMeta ? S.repoMeta.owner + '/' + S.repoMeta.repo + ' @ ' + S.repoMeta.branch : '';
    head.innerHTML = '<span class="fname" style="direction:ltr">' + esc(meta) + '</span>';
    var allBtn = document.createElement('button');
    allBtn.className = 'fbtn';
    allBtn.textContent = '全部加入';
    allBtn.addEventListener('click', function () {
      var added = 0;
      S.repoFiles.forEach(function (f) {
        if (!S.files[f.path]) { S.files[f.path] = f.content; added++; }
      });
      saveFiles();
      refreshAddStates();
      toast('已加入 ' + added + ' 个文件');
    });
    head.appendChild(allBtn);
    box.appendChild(head);

    S.repoFiles.forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'file-row';
      row.dataset.path = f.path;
      var name = document.createElement('span');
      name.className = 'fname';
      name.textContent = f.path;
      name.title = f.path;
      var size = document.createElement('span');
      size.className = 'fsize';
      size.textContent = fmtSize(f.content.length);
      var btn = document.createElement('button');
      btn.className = 'fbtn';
      btn.textContent = '+ 加入';
      btn.addEventListener('click', function () {
        if (S.files[f.path]) { toast('已存在于工作区'); return; }
        S.files[f.path] = f.content;
        saveFiles();
        refreshAddStates();
        toast('已加入：' + f.path);
      });
      row.appendChild(name);
      row.appendChild(size);
      row.appendChild(btn);
      box.appendChild(row);
    });
  }

  function refreshAddStates() {
    document.querySelectorAll('#repoFiles .file-row[data-path]').forEach(function (row) {
      var btn = row.querySelector('.fbtn');
      if (S.files[row.dataset.path]) {
        btn.textContent = '已加入';
        btn.classList.add('added');
      }
    });
  }

  /* ---------------- Workspace files ---------------- */

  function initFilesPanel() {
    $('btnNewFile').addEventListener('click', function () {
      var name = prompt('输入文件名（可含路径）：', 'untitled.html');
      if (!name) return;
      name = name.trim().replace(/^\/+/, '');
      if (!name) return;
      if (S.files[name] !== undefined) { toast('文件已存在'); return; }
      S.files[name] = '';
      saveFiles();
      openEditor(name);
    });

    $('btnZipAll').addEventListener('click', function () {
      var names = Object.keys(S.files);
      if (!names.length) { toast('工作区为空，先添加文件'); return; }
      var list = names.map(function (n) { return { name: n, content: S.files[n] }; });
      var blob = MonoZip.zipFiles(list);
      var d = new Date();
      var stamp = d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
      MonoZip.downloadBlob(blob, 'mono-code-' + stamp + '.zip');
      toast('已打包 ' + names.length + ' 个文件');
    });

    $('btnEditorSave').addEventListener('click', function () {
      var name = $('editorFileName').textContent;
      if (!name) return;
      S.files[name] = $('editorText').value;
      saveFiles();
      toast('已保存：' + name);
    });

    $('btnEditorClose').addEventListener('click', function () {
      $('fileEditor').hidden = true;
    });

    $('btnEditorPreview').addEventListener('click', function () {
      var name = $('editorFileName').textContent;
      if (!name) return;
      S.files[name] = $('editorText').value;
      saveFiles();
      openPreview(name);
    });
  }

  function renderWsFiles() {
    var box = $('wsFiles');
    box.innerHTML = '';
    var names = Object.keys(S.files).sort();
    $('fileCount').textContent = names.length;
    if (!names.length) {
      var empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = '暂无文件。可从仓库加入，或由 AI 生成后写入。';
      box.appendChild(empty);
      return;
    }
    names.forEach(function (name) {
      var row = document.createElement('div');
      row.className = 'file-row added';
      var nameEl = document.createElement('span');
      nameEl.className = 'fname';
      nameEl.style.direction = 'ltr';
      nameEl.textContent = name;
      nameEl.title = '点击编辑 ' + name;
      nameEl.addEventListener('click', function () { openEditor(name); });
      var size = document.createElement('span');
      size.className = 'fsize';
      size.textContent = fmtSize(S.files[name].length);
      var dl = document.createElement('button');
      dl.className = 'fbtn';
      dl.textContent = '导出';
      dl.addEventListener('click', function (e) {
        e.stopPropagation();
        downloadText(name, S.files[name]);
      });
      var pv = document.createElement('button');
      pv.className = 'fbtn';
      pv.textContent = '预览';
      pv.addEventListener('click', function (e) {
        e.stopPropagation();
        openPreview(name);
      });
      var del = document.createElement('button');
      del.className = 'fbtn';
      del.textContent = '×';
      del.title = '移出工作区';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        delete S.files[name];
        saveFiles();
        toast('已移出：' + name);
      });
      row.appendChild(nameEl);
      row.appendChild(size);
      row.appendChild(pv);
      row.appendChild(dl);
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  function openEditor(name) {
    $('editorFileName').textContent = name;
    $('editorText').value = S.files[name] || '';
    $('fileEditor').hidden = false;
  }

  /* ---------------- Chat render ---------------- */

  function initChat() {
    renderAllMessages();
    updateEmptyState();
    if (S.title) $('chatTitle').textContent = S.title.toUpperCase();

    $('emptyActs').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (chip) {
        $('input').value = chip.dataset.prompt;
        $('input').focus();
        autoGrow();
      }
    });

    $('btnClear').addEventListener('click', function () {
      if (!S.messages.length) { toast('会话已为空'); return; }
      if (!confirm('确认清空当前会话？工作区文件将保留。')) return;
      S.messages = [];
      S.title = '';
      $('chatTitle').textContent = 'UNTITLED SESSION';
      saveSession();
      renderAllMessages();
      updateEmptyState();
      toast('会话已清空');
    });
  }

  function updateEmptyState() {
    $('chatEmpty').style.display = S.messages.length ? 'none' : 'flex';
  }

  function renderAllMessages() {
    var list = $('chatList');
    list.innerHTML = '';
    S.messages.forEach(function (m, i) {
      list.appendChild(buildMessageEl(m, i));
    });
    scrollBottom();
  }

  function scrollBottom(force) {
    var chat = $('chat');
    var nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160;
    if (nearBottom || force) chat.scrollTop = chat.scrollHeight;
  }

  function buildMessageEl(m, idx) {
    var el = document.createElement('div');
    el.className = 'msg ' + (m.role === 'user' ? 'user' : 'ai');
    el.dataset.idx = idx;

    var head = document.createElement('div');
    head.className = 'msg-head';
    var role = document.createElement('span');
    role.className = 'msg-role ' + (m.role === 'user' ? 'user' : 'ai');
    var no = document.createElement('span');
    no.className = 'msg-idx';
    no.textContent = '#' + ('0' + (idx + 1)).slice(-2);
    var time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = fmtTime(m.ts || Date.now());
    head.appendChild(role);
    head.appendChild(no);
    head.appendChild(time);
    el.appendChild(head);

    var body = document.createElement('div');
    body.className = 'msg-body';
    body.dataset.idx = idx;
    renderContent(body, m, m.streaming === true);
    el.appendChild(body);
    return el;
  }

  function renderContent(bodyEl, m, streaming) {
    bodyEl.innerHTML = '';
    if (streaming) bodyEl.classList.add('streaming');
    else bodyEl.classList.remove('streaming');

    var text = m.content || '';
    var think = m.think || '';

    if (think) {
      var thinkBox = document.createElement('div');
      thinkBox.className = 'think' + (m.thinkOpen ? ' open' : '');
      var th = document.createElement('div');
      th.className = 'think-head';
      th.innerHTML = '<span>思考过程 · ' + think.length + ' 字</span><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>';
      th.addEventListener('click', function () {
        m.thinkOpen = !m.thinkOpen;
        thinkBox.classList.toggle('open', m.thinkOpen);
      });
      var tb = document.createElement('div');
      tb.className = 'think-body';
      tb.textContent = think;
      thinkBox.appendChild(th);
      thinkBox.appendChild(tb);
      bodyEl.appendChild(thinkBox);
    }

    var segments = splitSegments(text);
    var codeIdx = 0;
    segments.forEach(function (seg) {
      if (seg.type === 'code') {
        bodyEl.appendChild(buildCodeBlock(seg, codeIdx++, m));
      } else {
        renderMarkdownText(bodyEl, seg.text);
      }
    });

    if (streaming) {
      var cur = document.createElement('span');
      cur.className = 'cursor-blink';
      bodyEl.appendChild(cur);
    }
  }

  function splitSegments(text) {
    var segs = [];
    var re = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g;
    var last = 0;
    var match;
    while ((match = re.exec(text)) !== null) {
      if (match.index > last) {
        segs.push({ type: 'text', text: text.slice(last, match.index) });
      }
      var info = (match[1] || '').trim();
      var lang = info.split(/\s+/)[0] || '';
      var file = info.split(/\s+/)[1] || '';
      segs.push({ type: 'code', lang: lang, file: file, code: match[2] });
      last = re.lastIndex;
    }
    if (last < text.length) segs.push({ type: 'text', text: text.slice(last) });
    return segs;
  }

  function renderMarkdownText(container, raw) {
    var lines = raw.split('\n');
    var para = [];
    var listEl = null;

    function flushPara() {
      if (!para.length) return;
      var p = document.createElement('p');
      para.forEach(function (part, i) {
        if (i) p.appendChild(document.createTextNode('\n'));
        appendInline(p, part);
      });
      container.appendChild(p);
      para = [];
    }

    function flushList() {
      listEl = null;
    }

    lines.forEach(function (line) {
      var t = line.trim();
      if (!t) { flushPara(); flushList(); return; }
      var h = t.match(/^(#{1,4})\s+(.*)/);
      if (h) {
        flushPara(); flushList();
        var hd = document.createElement('p');
        hd.style.fontWeight = '700';
        appendInline(hd, h[2]);
        container.appendChild(hd);
        return;
      }
      var li = t.match(/^[-*]\s+(.*)/) || t.match(/^\d+[.、]\s+(.*)/);
      if (li) {
        flushPara();
        if (!listEl) {
          listEl = document.createElement('ul');
          container.appendChild(listEl);
        }
        var item = document.createElement('li');
        appendInline(item, li[1]);
        listEl.appendChild(item);
        return;
      }
      if (t === '---' || t === '***') {
        flushPara(); flushList();
        var hr = document.createElement('p');
        hr.style.letterSpacing = '0.5em';
        hr.textContent = '———';
        container.appendChild(hr);
        return;
      }
      flushList();
      para.push(t);
    });
    flushPara();
  }

  function appendInline(el, text) {
    var parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    parts.forEach(function (part) {
      if (!part) return;
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        var c = document.createElement('code');
        c.textContent = part.slice(1, -1);
        el.appendChild(c);
      } else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        var b = document.createElement('strong');
        b.textContent = part.slice(2, -2);
        el.appendChild(b);
      } else {
        el.appendChild(document.createTextNode(part));
      }
    });
  }

  function buildCodeBlock(seg, idx, m) {
    var wrap = document.createElement('div');
    wrap.className = 'codeblock pre';

    var head = document.createElement('div');
    head.className = 'codeblock-head';

    var lang = document.createElement('span');
    lang.className = 'codeblock-lang';
    lang.textContent = seg.lang || 'code';

    var fileSpan = document.createElement('span');
    fileSpan.className = 'codeblock-file';
    fileSpan.textContent = seg.file || '';

    var acts = document.createElement('div');
    acts.className = 'codeblock-acts';

    function mkBtn(label, fn) {
      var b = document.createElement('button');
      b.className = 'cbtn';
      b.textContent = label;
      b.addEventListener('click', fn);
      acts.appendChild(b);
      return b;
    }

    var fileName = seg.file || langToFile(seg.lang, idx);
    mkBtn('加入工作区', function (e) {
      S.files[fileName] = seg.code;
      saveFiles();
      refreshAddStates();
      e.target.textContent = '已加入';
      e.target.classList.add('done');
      toast('已写入工作区：' + fileName);
    });
    mkBtn('下载', function () { downloadText(fileName, seg.code); });
    mkBtn('复制', function () { copyText(seg.code); });

    head.appendChild(lang);
    head.appendChild(fileSpan);
    head.appendChild(acts);

    var pre = document.createElement('pre');
    var code = document.createElement('code');
    code.textContent = seg.code;
    pre.appendChild(code);

    wrap.appendChild(head);
    wrap.appendChild(pre);
    return wrap;
  }

  /* ---------------- Context menu (long press) ---------------- */

  var ctxTarget = null;

  function initCtxMenu() {
    var menu = $('ctxMenu');

    document.addEventListener('contextmenu', function (e) {
      var body = e.target.closest('.msg-body');
      if (body) {
        e.preventDefault();
        openCtxMenu(body, e.clientX, e.clientY);
      } else {
        menu.hidden = true;
      }
    });

    document.addEventListener('click', function (e) {
      if (!e.target.closest('.ctx-menu')) menu.hidden = true;
    });

    menu.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn || !ctxTarget) return;
      menu.hidden = true;
      handleCtxAction(btn.dataset.act, ctxTarget);
    });

    document.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.msg-body') && e.pointerType !== 'mouse') {
        var body = e.target.closest('.msg-body');
        var sx = e.clientX, sy = e.clientY;
        var timer = setTimeout(function () {
          openCtxMenu(body, sx, sy);
          if (navigator.vibrate) navigator.vibrate(30);
        }, 480);
        var cancel = function (ev) {
          if (Math.abs(ev.clientX - sx) > 8 || Math.abs(ev.clientY - sy) > 8) clearTimeout(timer);
        };
        var clear = function () { clearTimeout(timer); };
        document.addEventListener('pointermove', cancel, { once: true });
        document.addEventListener('pointerup', clear, { once: true });
        document.addEventListener('pointercancel', clear, { once: true });
      } else if (!e.target.closest('.ctx-menu') && !e.target.closest('.msg-body')) {
        menu.hidden = true;
      }
    });
  }

  function openCtxMenu(bodyEl, x, y) {
    var idx = parseInt(bodyEl.dataset.idx, 10);
    var m = S.messages[idx];
    if (!m) return;
    ctxTarget = { idx: idx, m: m };
    var menu = $('ctxMenu');
    var isUser = m.role === 'user';

    menu.querySelectorAll('button').forEach(function (b) {
      var act = b.dataset.act;
      var show = true;
      if (act === 'edit' || act === 'regen') show = false;
      if (act === 'edit' && isUser) show = true;
      if (act === 'regen' && m.role === 'assistant') show = true;
      if (act === 'continue') show = m.role === 'assistant';
      b.style.display = show ? 'block' : 'none';
    });

    menu.hidden = false;
    var mw = menu.offsetWidth || 160;
    var mh = menu.offsetHeight || 190;
    menu.style.left = Math.min(x, window.innerWidth - mw - 10) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - mh - 10) + 'px';
  }

  function handleCtxAction(act, target) {
    var m = target.m;
    var idx = target.idx;
    if (act === 'copy') {
      copyText(m.content || '');
    } else if (act === 'quote') {
      var q = (m.content || '').slice(0, 400);
      $('input').value = '> ' + q.replace(/\n/g, '\n> ') + '\n\n';
      $('input').focus();
      autoGrow();
    } else if (act === 'edit') {
      openEditOverlay(idx, m);
    } else if (act === 'regen') {
      regenerateFrom(idx);
    } else if (act === 'continue') {
      continueGeneration(idx);
    }
  }

  function openEditOverlay(idx, m) {
    var overlay = $('editOverlay');
    overlay.classList.add('show');
    $('editText').value = m.content || '';
    $('editText').dataset.idx = idx;
    $('editText').focus();
  }

  function initEditOverlay() {
    $('editCancel').addEventListener('click', function () {
      $('editOverlay').classList.remove('show');
    });
    $('editSave').addEventListener('click', function () {
      var idx = parseInt($('editText').dataset.idx, 10);
      var text = $('editText').value.trim();
      $('editOverlay').classList.remove('show');
      if (!text || isNaN(idx)) return;
      S.messages = S.messages.slice(0, idx);
      renderAllMessages();
      $('input').value = text;
      autoGrow();
      sendMessage();
    });
    $('editOverlay').addEventListener('click', function (e) {
      if (e.target === $('editOverlay')) $('editOverlay').classList.remove('show');
    });
  }

  /* ---------------- Generation ---------------- */

  function setStatus(label) {
    $('statusLabel').textContent = label;
  }

  function startStatus() {
    $('statusbar').hidden = false;
    $('genDot').classList.add('busy');
    S.genStart = Date.now();
    clearInterval(S.genTimer);
    S.genTimer = setInterval(function () {
      var sec = ((Date.now() - S.genStart) / 1000).toFixed(1);
      $('statusTime').textContent = sec + 's';
    }, 100);
    $('statusChars').textContent = '0 chars';
  }

  function stopStatus() {
    $('statusbar').hidden = true;
    $('genDot').classList.remove('busy');
    clearInterval(S.genTimer);
    var sec = ((Date.now() - S.genStart) / 1000).toFixed(1);
    $('genMeta').textContent = 'LAST ' + sec + 's';
  }

  function updateChars(n) {
    $('statusChars').textContent = n.toLocaleString() + ' chars';
  }

  function buildPayloadMessages(extra) {
    var msgs = [];
    var sys = S.settings.system || DEFAULT_SYSTEM;
    var wsCtx = MonoAPI.buildWorkspaceContext(S.files);
    if (wsCtx) sys += '\n\n' + wsCtx;
    msgs.push({ role: 'system', content: sys });

    S.messages.forEach(function (m) {
      var content = m.content || '';
      if (m.role === 'user' && m.attach && m.attach.length) {
        var att = m.attach.map(function (a) {
          return '【附件 ' + a.name + '】\n```\n' + a.content + '\n```';
        }).join('\n\n');
        content = content + '\n\n' + att;
      }
      msgs.push({ role: m.role, content: content });
    });
    if (extra) msgs.push(extra);
    return msgs;
  }

  function autoTitle() {
    if (S.title) return;
    var first = S.messages.find(function (m) { return m.role === 'user'; });
    if (first) {
      S.title = (first.content || '').slice(0, 20).replace(/\s+/g, ' ');
      $('chatTitle').textContent = S.title.toUpperCase();
      saveSession();
    }
  }

  async function sendMessage() {
    var text = $('input').value.trim();
    if (S.generating) { toast('正在生成中，请稍候'); return; }
    if (!text && !S.attachments.length) return;
    if (!apiReady()) {
      toast('请先在左侧 01 · API 接入 中填写服务配置', 3000);
      document.querySelector('[data-panel="panel-api"]').click();
      return;
    }

    var msg = { role: 'user', content: text, ts: Date.now(), attach: S.attachments.slice() };
    S.messages.push(msg);
    S.attachments = [];
    renderAttachments();
    $('input').value = '';
    autoGrow();
    autoTitle();
    updateEmptyState();
    renderAllMessages();
    saveSession();

    await generate(null);
  }

  async function generate(extra, targetMsg) {
    S.generating = true;
    S.abortCtrl = new AbortController();
    startStatus();
    setStatus('连接模型');

    var m = targetMsg;
    if (!m) {
      m = { role: 'assistant', content: '', think: '', ts: Date.now(), streaming: true, thinkOpen: false };
      S.messages.push(m);
    } else {
      m.streaming = true;
    }

    var list = $('chatList');
    var el = buildMessageEl(m, S.messages.length - 1);
    list.appendChild(el);
    scrollBottom(true);

    var pending = '';
    var thinkPending = '';
    var mode = 'text';
    var rafPending = false;
    var lastRender = 0;
    var streamText = m.content || '';
    var streamThink = m.think || '';

    function scheduleRender(force) {
      if (rafPending && !force) return;
      rafPending = true;
      requestAnimationFrame(function () {
        rafPending = false;
        if (Date.now() - lastRender < 90 && !force) return;
        lastRender = Date.now();
        m.content = streamText;
        m.think = streamThink;
        var newEl = buildMessageEl(m, S.messages.length - 1);
        el.replaceWith(newEl);
        el = newEl;
        scrollBottom();
      });
    }

    function handleText(delta, kind) {
      if (kind === 'think') {
        mode = 'think';
        streamThink += delta;
        setStatus('思考中');
      } else {
        pending += delta;
        while (true) {
          if (mode === 'text') {
            var openTag = pending.indexOf('<think>');
            if (openTag >= 0) {
              streamText += pending.slice(0, openTag);
              pending = pending.slice(openTag + 7);
              mode = 'think';
              setStatus('思考中');
              continue;
            }
          } else {
            var closeTag = pending.indexOf('</think>');
            if (closeTag >= 0) {
              streamThink += pending.slice(0, closeTag);
              pending = pending.slice(closeTag + 8);
              mode = 'text';
              setStatus('生成中');
              continue;
            }
          }
          break;
        }
        if (mode === 'text') {
          streamText += pending;
          pending = '';
          setStatus('生成中');
        } else {
          streamThink += pending;
          pending = '';
        }
      }
      updateChars(streamText.length + streamThink.length);
      scheduleRender(false);
    }

    try {
      var payloadMsgs = buildPayloadMessages(extra);
      await MonoAPI.streamChat(
        { baseUrl: S.settings.baseUrl, apiKey: S.settings.apiKey, model: S.settings.model },
        payloadMsgs,
        {
          onText: handleText,
          onStatus: function (label) { setStatus(label === '接收响应' ? '生成中' : label === '完成' ? '整理结果' : label); }
        },
        S.abortCtrl.signal
      );
      m.content = streamText;
      m.think = streamThink;
      m.streaming = false;
      m.done = true;
      setStatus('整理结果');
      var finalEl = buildMessageEl(m, S.messages.length - 1);
      el.replaceWith(finalEl);
      scrollBottom();
    } catch (e) {
      if (e.name === 'AbortError') {
        m.content = streamText + (streamText ? '\n\n*[已手动停止]*' : '');
        m.think = streamThink;
        m.streaming = false;
      } else {
        m.content = streamText;
        m.think = streamThink;
        m.streaming = false;
        m.error = e.message;
        var errEl = buildMessageEl(m, S.messages.length - 1);
        var errBox = document.createElement('div');
        errBox.style.cssText = 'margin-top:10px;padding:10px 14px;border:1px solid #111;font-family:var(--mono);font-size:11px;background:#fff';
        errBox.textContent = '生成失败：' + e.message + '（可长按本条消息重新生成）';
        errEl.appendChild(errBox);
        el.replaceWith(errEl);
      }
      scrollBottom();
    }

    saveSession();
    S.generating = false;
    S.abortCtrl = null;
    stopStatus();
  }

  function regenerateFrom(idx) {
    if (S.generating) { toast('正在生成中'); return; }
    S.messages = S.messages.slice(0, idx);
    renderAllMessages();
    updateEmptyState();
    generate(null);
  }

  async function continueGeneration(idx) {
    if (S.generating) { toast('正在生成中'); return; }
    var m = S.messages[idx];
    if (!m) return;
    var extra = { role: 'user', content: '继续。请从上一次输出中断的位置继续输出剩余内容，保持格式与文件名一致，不要重复已经输出的内容。' };
    await generate(extra, m);
  }

  /* ---------------- Composer ---------------- */

  function autoGrow() {
    var input = $('input');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  function initComposer() {
    var input = $('input');
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    $('btnSend').addEventListener('click', sendMessage);

    $('btnAttach').addEventListener('click', function () {
      $('fileInput').click();
    });
    $('fileInput').addEventListener('change', function (e) {
      var files = Array.from(e.target.files || []);
      files.forEach(readAttachment);
      e.target.value = '';
    });

    $('attachChips').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-i]');
      if (btn) {
        S.attachments.splice(parseInt(btn.dataset.i, 10), 1);
        renderAttachments();
      }
    });

    $('btnStop').addEventListener('click', function () {
      if (S.abortCtrl) S.abortCtrl.abort();
    });
  }

  var BINARY_UPLOAD = /\.(png|jpe?g|gif|bmp|webp|ico|mp4|mp3|wav|zip|gz|tar|rar|7z|pdf|doc|docx|xls|xlsx|ppt|pptx|exe|dll|bin|woff2?|ttf|otf|eot)$/i;

  function readAttachment(file) {
    if (BINARY_UPLOAD.test(file.name)) {
      toast('暂不支持二进制文件：' + file.name, 3000);
      return;
    }
    if (file.size > 200 * 1024) {
      toast('文件过大（限 200KB）：' + file.name, 3000);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      S.attachments.push({ name: file.name, content: String(reader.result || '') });
      renderAttachments();
      toast('已附加：' + file.name);
    };
    reader.readAsText(file);
  }

  function renderAttachments() {
    var box = $('attachChips');
    box.innerHTML = '';
    S.attachments.forEach(function (a, i) {
      var chip = document.createElement('span');
      chip.className = 'atchip';
      var label = document.createElement('span');
      label.textContent = a.name + ' · ' + fmtSize(a.content.length);
      var x = document.createElement('button');
      x.textContent = '×';
      x.dataset.i = i;
      x.title = '移除';
      chip.appendChild(label);
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }

  /* ---------------- Preview ---------------- */

  function buildPreviewHtml(preferName) {
    var names = Object.keys(S.files);
    if (!names.length) return null;

    var entryName = null;
    if (preferName && /\.html?$/i.test(preferName) && S.files[preferName] !== undefined) {
      entryName = preferName;
    } else if (S.files['index.html'] !== undefined) {
      entryName = 'index.html';
    } else {
      entryName = names.find(function (n) { return /\.html?$/i.test(n); });
    }

    if (!entryName) {
      return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:ui-monospace,monospace;background:#f7f7f5;color:#111;padding:40px;line-height:1.8}h1{font-size:14px;letter-spacing:.2em}li{margin:6px 0}</style></head><body><h1>PREVIEW · 无 HTML 入口文件</h1><p>工作区中暂无 HTML 文件。当前文件列表：</p><ul>' +
        names.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') +
        '</ul></body></html>';
    }

    var html = S.files[entryName];

    html = html.replace(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi, function (full, href) {
      var key = href.replace(/^\.\//, '').replace(/^\//, '').split('?')[0];
      if (S.files[key] !== undefined) return '<style>\n' + S.files[key] + '\n</style>';
      return full;
    });

    html = html.replace(/<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, function (full, src) {
      var key = src.replace(/^\.\//, '').replace(/^\//, '').split('?')[0];
      if (S.files[key] !== undefined) return '<script>\n' + S.files[key] + '\n<\/script>';
      return full;
    });

    return html;
  }

  function openPreview(preferName) {
    var html = buildPreviewHtml(preferName);
    if (html === null) {
      toast('工作区为空，无法预览');
      return;
    }
    $('previewFile').textContent = ' · ' + (preferName || guessEntry());
    $('previewFrame').srcdoc = html;
    $('previewLayer').hidden = false;
  }

  function guessEntry() {
    if (S.files['index.html'] !== undefined) return 'index.html';
    var names = Object.keys(S.files);
    var found = names.find(function (n) { return /\.html?$/i.test(n); });
    return found || '';
  }

  function initPreview() {
    $('btnPreview').addEventListener('click', function () {
      var entry = guessEntry();
      if (!entry) { toast('工作区中还没有 HTML 文件'); return; }
      openPreview(entry);
    });

    $('btnPreviewClose').addEventListener('click', function () {
      $('previewLayer').hidden = true;
      $('previewFrame').srcdoc = '';
      if (document.fullscreenElement) document.exitFullscreen();
    });

    $('btnPreviewRefresh').addEventListener('click', function () {
      openPreview($('editorFileName').textContent && !$('fileEditor').hidden ? $('editorFileName').textContent : guessEntry());
      toast('已刷新');
    });

    $('btnPreviewFs').addEventListener('click', function () {
      var stage = $('previewStage');
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (stage.requestFullscreen) {
        stage.requestFullscreen();
      }
    });
  }

  /* ---------------- Boot ---------------- */

  function safe(fn) {
    try { fn(); } catch (e) { console.error('[MONO/CODE] init failed:', fn.name, e); }
  }

  function boot() {
    safe(initNav);
    safe(initApiPanel);
    safe(initRepoPanel);
    safe(initFilesPanel);
    safe(initChat);
    safe(initCtxMenu);
    safe(initEditOverlay);
    safe(initComposer);
    safe(initPreview);
    safe(renderWsFiles);
    safe(renderAttachments);
    safe(autoGrow);
    document.querySelector('.nav-item[data-panel="panel-api"]').click();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
