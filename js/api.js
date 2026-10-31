(function (global) {
  'use strict';

  function normalizeBaseUrl(url) {
    var u = String(url || '').trim();
    if (!u) u = 'https://api.openai.com/v1';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u.replace(/\/+$/, '');
  }

  async function testConnection(cfg) {
    var base = normalizeBaseUrl(cfg.baseUrl);
    var res = await fetch(base + '/models', {
      headers: buildHeaders(cfg)
    });
    if (res.status === 401) throw new Error('API Key 无效 (401)');
    if (!res.ok) throw new Error('服务响应异常：HTTP ' + res.status);
    return true;
  }

  async function listModels(cfg) {
    var base = normalizeBaseUrl(cfg.baseUrl);
    var res = await fetch(base + '/models', { headers: buildHeaders(cfg) });
    if (res.status === 401) throw new Error('API Key 无效 (401)');
    if (res.status === 404) throw new Error('服务不提供 /models 接口 (404)，请手动填写模型名');
    if (!res.ok) throw new Error('服务响应异常：HTTP ' + res.status);
    var json = await res.json();
    var arr = [];
    if (Array.isArray(json)) arr = json;
    else if (json && Array.isArray(json.data)) arr = json.data;
    else if (json && Array.isArray(json.models)) arr = json.models;
    var ids = arr.map(function (m) {
      if (typeof m === 'string') return m;
      return m.id || m.name || m.model || '';
    }).filter(Boolean);
    return Array.from(new Set(ids)).sort();
  }

  function buildHeaders(cfg) {
    var h = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) h['Authorization'] = 'Bearer ' + cfg.apiKey;
    return h;
  }

  async function streamChat(cfg, messages, callbacks, signal) {
    var base = normalizeBaseUrl(cfg.baseUrl);
    var onText = callbacks.onText || function () {};
    var onStatus = callbacks.onStatus || function () {};
    var onUsage = callbacks.onUsage || function () {};

    onStatus('连接模型', 0);

    var res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: buildHeaders(cfg),
      body: JSON.stringify({
        model: cfg.model || 'gpt-4o',
        messages: messages,
        stream: true,
        temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.4
      }),
      signal: signal
    });

    if (!res.ok) {
      var errText = '';
      try { errText = (await res.text()).slice(0, 300); } catch (e) {}
      if (res.status === 401) throw new Error('API Key 无效或未授权 (401)');
      if (res.status === 404) throw new Error('接口路径或模型不存在 (404)，请检查 Base URL 与模型名');
      if (res.status === 429) throw new Error('请求过于频繁或额度不足 (429)');
      throw new Error('请求失败：HTTP ' + res.status + (errText ? ' — ' + errText : ''));
    }

    onStatus('接收响应', 1);

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var got = false;

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line.startsWith('data:')) continue;
        var payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          var json = JSON.parse(payload);
          var delta = json.choices && json.choices[0] && json.choices[0].delta;
          if (delta) {
            if (delta.reasoning_content) {
              onText(delta.reasoning_content, 'think');
              got = true;
            }
            if (delta.content) {
              onText(delta.content, 'text');
              got = true;
            }
          }
          if (json.usage) onUsage(json.usage);
        } catch (e) {}
      }
    }

    if (!got) throw new Error('模型未返回任何内容，请检查模型名与配置');
    onStatus('完成', 2);
  }

  function buildWorkspaceContext(files, maxTotal) {
    var maxTotalChars = maxTotal || 40000;
    var names = Object.keys(files);
    if (!names.length) return '';
    var parts = [];
    var used = 0;
    names.forEach(function (name) {
      var content = files[name];
      var budget = Math.floor(maxTotalChars / names.length) + 2000;
      var body = content;
      if (body.length > budget) body = body.slice(0, budget) + '\n... (内容过长已截断)';
      used += body.length;
      parts.push('----- 文件: ' + name + ' -----\n' + body);
    });
    return '当前工作区文件如下：\n\n' + parts.join('\n\n');
  }

  global.MonoAPI = {
    normalizeBaseUrl: normalizeBaseUrl,
    testConnection: testConnection,
    listModels: listModels,
    streamChat: streamChat,
    buildWorkspaceContext: buildWorkspaceContext
  };
})(window);
