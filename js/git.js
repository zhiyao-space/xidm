(function (global) {
  'use strict';

  var BINARY_EXT = /\.(png|jpe?g|gif|bmp|webp|ico|svgz|mp4|mp3|wav|ogg|webm|mov|avi|zip|gz|tar|rar|7z|pdf|doc|docx|xls|xlsx|ppt|pptx|exe|dll|so|dylib|bin|dat|woff2?|ttf|otf|eot|psd|ai|sketch|class|jar|pyc|wasm)$/i;
  var SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|out|vendor|__MACOSX|\.idea|\.vscode)(\/|$)/i;
  var MAX_FILE_SIZE = 400 * 1024;
  var MAX_FILES = 500;

  function parseRepoUrl(input) {
    var raw = String(input || '').trim();
    if (!raw) return null;
    raw = raw.replace(/\.git$/, '');
    raw = raw.replace(/^git@([^:]+):/, 'https://$1/');

    var u;
    try {
      u = new URL(raw.startsWith('http') ? raw : 'https://' + raw);
    } catch (e) {
      return null;
    }
    var host = u.hostname.replace(/^www\./, '');
    var parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    var owner = parts[0];
    var repo = parts[1];
    var branch = '';

    if (host === 'github.com' || host === 'gitee.com') {
      if (parts[2] === 'tree' && parts[3]) branch = parts[3];
    } else if (host === 'gitlab.com' || host.indexOf('gitlab') >= 0) {
      var dash = parts.indexOf('-');
      if (dash > 0 && parts[dash + 1] === 'tree' && parts[dash + 2]) branch = parts[dash + 2];
      if (parts.length > 2 && parts[2] !== '-' && parts[2] !== 'tree') {
        var sub = parts.slice(2).filter(function (p) { return p !== '-'; });
        if (sub.length) repo = repo;
      }
    }
    return { host: host, owner: owner, repo: repo, branch: branch, provider: detectProvider(host) };
  }

  function detectProvider(host) {
    if (host === 'github.com') return 'github';
    if (host === 'gitee.com') return 'gitee';
    return 'gitlab';
  }

  function authHeaders(token, provider) {
    var h = { Accept: 'application/json' };
    if (!token) return h;
    if (provider === 'gitlab') {
      h['PRIVATE-TOKEN'] = token;
    } else {
      h['Authorization'] = 'Bearer ' + token;
    }
    return h;
  }

  async function apiJson(url, headers) {
    var res = await fetch(url, { headers: headers });
    if (res.status === 401 || res.status === 403) {
      throw new Error('鉴权失败 (' + res.status + ')：请检查访问令牌是否有效');
    }
    if (res.status === 404) {
      throw new Error('未找到资源 (404)：请检查仓库地址与分支');
    }
    if (!res.ok) {
      throw new Error('请求失败：HTTP ' + res.status);
    }
    return res.json();
  }

  async function getDefaultBranch(info, token) {
    var headers = authHeaders(token, info.provider);
    if (info.provider === 'github') {
      var d = await apiJson('https://api.github.com/repos/' + info.owner + '/' + info.repo, headers);
      return d.default_branch || 'main';
    }
    if (info.provider === 'gitee') {
      var g = await apiJson('https://gitee.com/api/v5/repos/' + info.owner + '/' + info.repo + '?access_token=' + encodeURIComponent(token || ''), headers);
      return g.default_branch || 'master';
    }
    var pid = encodeURIComponent(info.owner + '/' + info.repo);
    var l = await apiJson('https://gitlab.com/api/v4/projects/' + pid, headers);
    return l.default_branch || 'main';
  }

  async function listTree(info, branch, token, onProgress) {
    var headers = authHeaders(token, info.provider);
    var files = [];
    onProgress('获取文件树', 0, 1, branch);

    if (info.provider === 'github') {
      var data = await apiJson('https://api.github.com/repos/' + info.owner + '/' + info.repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1', headers);
      (data.tree || []).forEach(function (item) {
        if (item.type === 'blob') files.push({ path: item.path, size: item.size || 0 });
      });
    } else if (info.provider === 'gitee') {
      var gd = await apiJson('https://gitee.com/api/v5/repos/' + info.owner + '/' + info.repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1&access_token=' + encodeURIComponent(token || ''), headers);
      (gd.tree || []).forEach(function (item) {
        if (item.type === 'blob') files.push({ path: item.path, size: item.size || 0 });
      });
    } else {
      var pid = encodeURIComponent(info.owner + '/' + info.repo);
      var page = 1;
      var total = 0;
      while (true) {
        onProgress('获取文件树', total, Math.max(total, page * 100), '第 ' + page + ' 页');
        var list = await apiJson('https://gitlab.com/api/v4/projects/' + pid + '/repository/tree?recursive=true&per_page=100&page=' + page + '&ref=' + encodeURIComponent(branch), headers);
        if (!Array.isArray(list) || list.length === 0) break;
        list.forEach(function (item) {
          if (item.type === 'blob') files.push({ path: item.path, size: 0 });
        });
        total += list.length;
        if (list.length < 100) break;
        page++;
        if (page > 20) break;
      }
    }

    var visible = files.filter(function (f) {
      return !SKIP_DIR.test(f.path) && !BINARY_EXT.test(f.path) && f.size <= MAX_FILE_SIZE;
    });
    visible.sort(function (a, b) { return a.path.localeCompare(b.path); });
    if (visible.length > MAX_FILES) visible = visible.slice(0, MAX_FILES);
    return visible;
  }

  async function fetchFileContent(info, branch, token, path) {
    if (info.provider === 'github') {
      var url = 'https://api.github.com/repos/' + info.owner + '/' + info.repo + '/contents/' + path.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(branch);
      var d = await apiJson(url, authHeaders(token, 'github'));
      if (d.content && d.encoding === 'base64') {
        var b64 = d.content.replace(/\n/g, '');
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
      }
      throw new Error('文件内容为空或编码不支持：' + path);
    }
    if (info.provider === 'gitee') {
      var gurl = 'https://gitee.com/api/v5/repos/' + info.owner + '/' + info.repo + '/raw/' + path + '?ref=' + encodeURIComponent(branch) + '&access_token=' + encodeURIComponent(token || '');
      var res = await fetch(gurl);
      if (!res.ok) throw new Error('拉取失败：HTTP ' + res.status);
      return await res.text();
    }
    var pid = encodeURIComponent(info.owner + '/' + info.repo);
    var lurl = 'https://gitlab.com/api/v4/projects/' + pid + '/repository/files/' + encodeURIComponent(path) + '/raw?ref=' + encodeURIComponent(branch);
    var lres = await fetch(lurl, { headers: authHeaders(token, 'gitlab') });
    if (!lres.ok) throw new Error('拉取失败：HTTP ' + lres.status);
    return await lres.text();
  }

  async function pullRepo(opts) {
    var onProgress = opts.onProgress || function () {};
    var info = parseRepoUrl(opts.url);
    if (!info) throw new Error('无法解析仓库地址，请输入形如 https://github.com/owner/repo 的链接');

    onProgress('解析仓库', 0, 1, info.owner + '/' + info.repo);
    var branch = opts.branch && opts.branch.trim() ? opts.branch.trim() : info.branch;
    if (!branch) {
      branch = await getDefaultBranch(info, opts.token);
    }
    info.branch = branch;

    var files = await listTree(info, branch, opts.token, onProgress);
    var picked = [];
    var priorities = [
      /^readme/i, /^package\.json$/, /^index\.html$/, /^src\//, /^app\//, /^public\//,
      /\.(html|css|js|ts|jsx|tsx|vue|py|go|java|md|json|yaml|yml|toml|sh)$/i
    ];
    var score = function (p) {
      for (var i = 0; i < priorities.length; i++) if (priorities[i].test(p)) return i;
      return priorities.length;
    };
    var rest = files.slice();
    rest.sort(function (a, b) { return score(a.path) - score(b.path); });
    picked = rest.slice(0, 40);

    var results = [];
    for (var i = 0; i < picked.length; i++) {
      onProgress('拉取文件内容', i, picked.length, picked[i].path);
      try {
        var text = await fetchFileContent(info, branch, opts.token, picked[i].path);
        results.push({ path: picked[i].path, content: text });
      } catch (e) {
        results.push({ path: picked[i].path, content: '', error: true });
      }
    }
    onProgress('完成', picked.length, picked.length, '');
    return {
      info: { host: info.host, owner: info.owner, repo: info.repo, branch: branch, provider: info.provider },
      tree: files,
      files: results.filter(function (r) { return !r.error && r.content; })
    };
  }

  global.MonoGit = { parseRepoUrl: parseRepoUrl, pullRepo: pullRepo, fetchFileContent: fetchFileContent };
})(window);
