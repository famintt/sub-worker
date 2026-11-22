/**
 * sub-worker v2.0.1
 *
 * 固定订阅入口 + 多机器自动上报 + WebUI 机器/节点管理 + 客户端格式适配
 *
 * 权限（SW-01）
 *   ADMIN_TOKEN     管理：WebUI + /api/v1/* 全部管理接口（不进入任何订阅 URL）
 *   READ_TOKEN      只读：/sub/... 订阅读取
 *   每机上报密钥    POST /api/v1/report/:machine，只能在授权的那台机器上写
 *   REPORT_TOKEN    可选全局上报密钥（迁移期兼容）
 *   TOKEN           旧共享密钥，ALLOW_LEGACY_TOKEN=0 时彻底禁用
 *
 * 存储（SW-03/SW-09：自动快照与手工覆盖分开，互不覆盖）
 *   report:<machine>    { machine, content, hash, bytes, updated_at }
 *   manual:<machine>    { machine, nodes, updated_at }
 *   tokenhash:<machine> sha256(按机上报密钥)
 *   meta:machine_order  [machine...]
 *   兼容读取旧版 sub:<machine>
 *
 * 读取：GET /sub/:machine/:token  |  GET /sub/all/:token  |  GET /sub/:token
 * 格式：?format=clash|singbox|base64，或 ?clash / ?singbox / ?b64
 * WebUI：GET /ui
 */

const VERSION = "2.0.1";
const MAX_BODY = 512 * 1024;
const MAX_NODES = 500;
const MAX_LINK = 8192;
const MACHINE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const UI_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sub-worker 节点管理</title>
<style>
:root{--bg:#fff;--line:#dfe6ef;--ink:#1f2937;--sub:#64748b;--acc:#2563eb;--ok:#15803d;--err:#dc2626}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif}
.wrap{max-width:1180px;margin:28px auto 60px;padding:0 18px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}
h1{font-size:25px;margin:0}.ver{color:var(--acc);font:12px ui-monospace,Consolas,monospace;border:1px solid var(--line);padding:3px 8px;border-radius:8px}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:18px;box-shadow:0 1px 4px rgba(15,23,42,.06)}
.card h2{font-size:17px;margin:0 0 12px}.tip{font-size:12px;color:var(--sub);font-weight:400}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.row label{color:var(--sub);font-size:13px}
select,input,button,textarea{font:14px inherit}select,input,textarea{background:#fff;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:8px 10px;outline:none}
textarea{width:100%;min-height:96px;font:12px ui-monospace,Consolas,monospace}
select:focus,input:focus,textarea:focus{border-color:var(--acc)}
button{cursor:pointer;border:1px solid var(--line);border-radius:9px;padding:8px 12px;background:#f1f5f9;color:var(--ink)}
button:hover{border-color:var(--acc)}button.primary{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}button.danger{color:var(--err)}
button:disabled{opacity:.4;cursor:not-allowed}
.nodes{margin-top:14px;display:grid;gap:8px}.node{display:grid;grid-template-columns:34px 1fr 180px 34px 34px 34px;gap:8px;align-items:center}
.node .idx{color:var(--sub);font:12px ui-monospace,Consolas,monospace;text-align:center}.node input.link{font:12px ui-monospace,Consolas,monospace;min-width:0}
.node input.name{font-size:13px}.node button{padding:6px 8px}
.status{margin-top:12px;min-height:22px;font-size:13px;color:var(--sub)}.status.ok{color:var(--ok)}.status.err{color:var(--err)}
.machine-list{display:grid;gap:7px;margin-top:12px}
.machine{display:grid;grid-template-columns:34px 1fr 96px 34px 34px 70px 34px 60px 34px;gap:8px;align-items:center;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:#f8fafc}
.machine .idx{color:var(--sub);font:12px ui-monospace,Consolas,monospace;text-align:center}
.machine .mname{font-weight:600;word-break:break-all}.machine .mcount{font-size:12px;color:var(--sub)}
.machine .badge{font-size:11px;color:#b45309;border:1px solid #fcd34d;background:#fffbeb;border-radius:999px;padding:1px 7px;margin-left:6px}
.machine button{padding:5px 7px}.machine .edit{font-size:12px;padding:5px 8px}.machine .tok{font-size:12px;padding:5px 8px}
code{font:12px ui-monospace,Consolas,monospace;color:#1d4ed8;word-break:break-all}
.subrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:7px 0}.subrow code{flex:1;min-width:260px}
.hint{color:var(--sub);font-size:12px;line-height:1.7}.empty{color:var(--sub);padding:20px 0;text-align:center}
#login{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:9}
#login .box{background:#fff;border-radius:16px;padding:22px;width:min(420px,92vw);box-shadow:0 12px 40px rgba(15,23,42,.25)}
#login h3{margin:0 0 10px;font-size:18px}#login input{width:100%;margin:8px 0 14px}
.hidden{display:none!important}
@media(max-width:900px){.node{grid-template-columns:28px 1fr}.node input.name{grid-column:2}.node button{grid-row:2}.machine{grid-template-columns:28px 1fr 34px 34px 34px 34px}}
</style>
</head>
<body>
<div id="login"><div class="box">
<h3>sub-worker 管理登录</h3>
<div class="hint">管理密钥不会出现在 URL 里；只保存在本浏览器 sessionStorage。</div>
<input id="login-token" type="password" placeholder="ADMIN_TOKEN" autocomplete="current-password">
<div class="row"><button id="login-go" class="primary" type="button">登录</button><span id="login-msg" class="status"></span></div>
</div></div>

<div class="wrap">
<div class="top"><div><h1>sub-worker <span class="tip">节点管理</span></h1><div class="hint">机器顺序决定合并订阅里的先后；手动配置优先于自动上报。</div></div><span class="ver" id="version">v2.0.1</span></div>


<section class="card">
<h2>机器排序 <span class="tip">这里决定合并订阅里机器出现的先后顺序</span></h2>
<div id="machine-list" class="machine-list"></div>
<div class="row" style="margin-top:12px"><button id="save-machine-order" class="primary" type="button">保存机器顺序</button></div>
<div id="order-status" class="status"></div>
</section>

<section class="card">
<h2>节点配置 <span class="tip">先选择机器</span></h2>
<div class="row"><label>编辑机器</label><select id="machine"></select><button id="reload" type="button">刷新</button><button id="reset" class="danger" type="button">恢复自动上报</button></div>
<div id="nodes" class="nodes"></div>
<div class="row" style="margin-top:12px"><button id="add" type="button">+ 添加节点</button><button id="save" class="primary" type="button">保存配置</button></div>
<div id="status" class="status"></div>
</section>

<section class="card">
<h2>新增机器 <span class="tip">手动添加的机器不依赖自动上报</span></h2>
<div class="row"><label>机器名</label><input id="new-machine" placeholder="例如 hk-opt-dandan" size="26"><label>节点链接</label></div>
<textarea id="new-links" placeholder="每行一个链接，可留空先建空机器&#10;vless://...&#10;tuic://..."></textarea>
<div class="row" style="margin-top:10px"><button id="create-machine" class="primary" type="button">创建机器</button><span id="create-status" class="status"></span></div>
<div class="hint">机器名只允许小写字母、数字和连字符。创建后可在下方编辑节点，或用“密钥”按钮生成该机的上报密钥。</div>
</section>

<section class="card">
<h2>订阅链接 <span class="tip">客户端会按 User-Agent 自动选择格式</span></h2>
<div class="subrow"><span class="tip">通用 base64</span><code id="url-base"></code><button data-copy="url-base" type="button">复制</button></div>
<div class="subrow"><span class="tip">Clash / Mihomo</span><code id="url-clash"></code><button data-copy="url-clash" type="button">复制</button></div>
<div class="subrow"><span class="tip">sing-box</span><code id="url-singbox"></code><button data-copy="url-singbox" type="button">复制</button></div>
<div class="hint">手动保存后，机器自动上报不会覆盖你编辑的节点；点“恢复自动上报”才会回到最近一次自动快照。</div>
</section>
</div>
<script>
(function () {
  "use strict";
  var STORE = "sw_admin_token";
  var state = { machines: [], current: "", nodes: [], manual: false, settings: {} };
  var $ = function (id) { return document.getElementById(id); };
  function tok() { return sessionStorage.getItem(STORE) || ""; }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers || {}, { Authorization: "Bearer " + tok() });
    return fetch("/api/v1" + path, opts).then(function (r) {
      return r.text().then(function (text) {
        var data;
        try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { ok: false, error: text || ("HTTP " + r.status) }; }
        if (!r.ok || data.ok === false) throw new Error(data.error || ("HTTP " + r.status));
        return data;
      });
    });
  }
  function setStatus(el, text, ok) {
    var node = $(el); node.textContent = text || "";
    node.className = "status" + (ok === true ? " ok" : ok === false ? " err" : "");
  }
  function showLogin(show) { $("login").className = show ? "" : "hidden"; }

  function renderUrls() {
    var base = location.origin;
    var rt = state.settings.read_token || "";
    var urls = {
      "url-base": base + "/sub/" + encodeURIComponent(rt),
      "url-clash": base + "/sub/" + encodeURIComponent(rt) + "?format=clash",
      "url-singbox": base + "/sub/" + encodeURIComponent(rt) + "?format=singbox"
    };
    Object.keys(urls).forEach(function (id) { $(id).textContent = urls[id]; });
  }
  function nodeRow(node, index) {
    var row = document.createElement("div"); row.className = "node";
    var idx = document.createElement("div"); idx.className = "idx"; idx.textContent = String(index + 1);
    var link = document.createElement("input"); link.className = "link"; link.type = "text"; link.value = node.link || ""; link.placeholder = "vless://... / tuic://... / anytls://...";
    var name = document.createElement("input"); name.className = "name"; name.type = "text"; name.value = node.name || ""; name.placeholder = "显示名称";
    var up = document.createElement("button"); up.type = "button"; up.textContent = "↑"; up.title = "上移";
    var down = document.createElement("button"); down.type = "button"; down.textContent = "↓"; down.title = "下移";
    var del = document.createElement("button"); del.type = "button"; del.className = "danger"; del.textContent = "×"; del.title = "删除";
    up.onclick = function () { if (index > 0) { var t = state.nodes[index - 1]; state.nodes[index - 1] = state.nodes[index]; state.nodes[index] = t; renderNodes(); } };
    down.onclick = function () { if (index < state.nodes.length - 1) { var t = state.nodes[index + 1]; state.nodes[index + 1] = state.nodes[index]; state.nodes[index] = t; renderNodes(); } };
    del.onclick = function () { state.nodes.splice(index, 1); renderNodes(); };
    link.oninput = function () { state.nodes[index].link = link.value; };
    name.oninput = function () { state.nodes[index].name = name.value; };
    row.appendChild(idx); row.appendChild(link); row.appendChild(name); row.appendChild(up); row.appendChild(down); row.appendChild(del);
    return row;
  }
  function renderNodes() {
    var box = $("nodes"); box.innerHTML = "";
    if (!state.current) { box.innerHTML = '<div class="empty">先选择或新增一台机器</div>'; return; }
    if (!state.nodes.length) { box.innerHTML = '<div class="empty">当前没有节点，点“+ 添加节点”</div>'; return; }
    state.nodes.forEach(function (n, i) { box.appendChild(nodeRow(n, i)); });
  }
  function renderMachines() {
    var box = $("machine-list"); box.innerHTML = "";
    if (!state.machines.length) { box.innerHTML = '<div class="empty">还没有机器</div>'; }
    state.machines.forEach(function (m, i) {
      var row = document.createElement("div"); row.className = "machine";
      var idx = document.createElement("div"); idx.className = "idx"; idx.textContent = String(i + 1);
      var name = document.createElement("div"); name.className = "mname"; name.textContent = m.machine;
      if (m.manual) { var b = document.createElement("span"); b.className = "badge"; b.textContent = "手动"; name.appendChild(b); }
      var count = document.createElement("div"); count.className = "mcount"; count.textContent = m.nodes + " 节点";
      var up = document.createElement("button"); up.type = "button"; up.textContent = "↑"; up.title = "上移";
      var down = document.createElement("button"); down.type = "button"; down.textContent = "↓"; down.title = "下移";
      var edit = document.createElement("button"); edit.type = "button"; edit.className = "edit"; edit.textContent = "编辑";
      var token = document.createElement("button"); token.type = "button"; token.className = "tok"; token.textContent = "密钥"; token.title = "生成/轮换该机上报密钥";
      var del = document.createElement("button"); del.type = "button"; del.className = "danger"; del.textContent = "×"; del.title = "删除机器";
      up.onclick = function () { if (i > 0) { var t = state.machines[i - 1]; state.machines[i - 1] = state.machines[i]; state.machines[i] = t; renderMachines(); } };
      down.onclick = function () { if (i < state.machines.length - 1) { var t = state.machines[i + 1]; state.machines[i + 1] = state.machines[i]; state.machines[i] = t; renderMachines(); } };
      edit.onclick = function () { selectMachine(m.machine); };
      token.onclick = function () {
        if (!confirm("为 " + m.machine + " 生成新的上报密钥？旧密钥立即失效。")) return;
        api("/machines/" + encodeURIComponent(m.machine) + "/token", { method: "POST" })
          .then(function (d) { window.prompt("上报密钥（只显示这一次，请保存）", d.token); loadMachines(); })
          .catch(function (e) { setStatus("order-status", "生成失败：" + e.message, false); });
      };
      del.onclick = function () {
        if (!confirm("删除机器 " + m.machine + " 及其节点与上报密钥？")) return;
        api("/machines/" + encodeURIComponent(m.machine), { method: "DELETE" })
          .then(function () { if (state.current === m.machine) { state.current = ""; state.nodes = []; renderNodes(); } loadMachines(); })
          .catch(function (e) { setStatus("order-status", "删除失败：" + e.message, false); });
      };
      row.appendChild(idx); row.appendChild(name); row.appendChild(count);
      row.appendChild(up); row.appendChild(down); row.appendChild(edit); row.appendChild(token); row.appendChild(del);
      box.appendChild(row);
    });
    var sel = $("machine"); sel.innerHTML = "";
    state.machines.forEach(function (m) {
      var o = document.createElement("option"); o.value = m.machine; o.textContent = m.machine; sel.appendChild(o);
    });
    sel.value = state.current || (state.machines[0] ? state.machines[0].machine : "");
  }
  function loadMachines() {
    return api("/machines").then(function (d) {
      state.machines = d.machines || [];
      if (!state.current && state.machines.length) state.current = state.machines[0].machine;
      renderMachines(); renderNodes();
      if (state.current) return selectMachine(state.current);
    }).catch(function (e) {
      if (/unauthorized|401/.test(e.message)) { sessionStorage.removeItem(STORE); showLogin(true); return; }
      setStatus("order-status", "加载失败：" + e.message, false);
    });
  }
  function selectMachine(machine) {
    state.current = machine;
    $("machine").value = machine;
    return api("/nodes/" + encodeURIComponent(machine)).then(function (d) {
      state.nodes = (d.nodes || []).map(function (n) { return { link: n.link, name: n.name }; });
      state.manual = Boolean(d.manual);
      renderNodes();
      setStatus("status", state.manual ? "当前是手动配置（自动上报不会覆盖）" : "当前来自自动上报", null);
    }).catch(function (e) { setStatus("status", "读取失败：" + e.message, false); });
  }
  function createMachine() {
    var machine = ($("new-machine").value || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(machine)) { setStatus("create-status", "机器名只能用小写字母、数字、连字符", false); return; }
    var links = ($("new-links").value || "").split(/\\r?\\n/).map(function (x) { return x.trim(); }).filter(Boolean);
    api("/machines/" + encodeURIComponent(machine), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })
      .then(function () {
        if (!links.length) return null;
        return api("/nodes/" + encodeURIComponent(machine), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodes: links.map(function (l) { return { link: l }; }) }) });
      })
      .then(function () {
        setStatus("create-status", "已创建 " + machine, true);
        $("new-machine").value = ""; $("new-links").value = "";
        state.current = machine;
        return loadMachines();
      })
      .catch(function (e) { setStatus("create-status", "创建失败：" + e.message, false); });
  }
  $("login-go").onclick = function () {
    var t = ($("login-token").value || "").trim();
    if (!t) { setStatus("login-msg", "请输入管理密钥", false); return; }
    sessionStorage.setItem(STORE, t);
    api("/machines").then(function () { showLogin(false); setStatus("login-msg", "", null); boot(); })
      .catch(function (e) { sessionStorage.removeItem(STORE); setStatus("login-msg", "登录失败：" + e.message, false); });
  };
  $("login-token").onkeydown = function (ev) { if (ev.key === "Enter") $("login-go").click(); };
  $("machine").onchange = function () { selectMachine($("machine").value); };
  $("reload").onclick = function () { if (state.current) selectMachine(state.current); };
  $("add").onclick = function () { state.nodes.push({ link: "", name: "" }); renderNodes(); };
  $("save").onclick = function () {
    if (!state.current) return;
    var nodes = state.nodes.map(function (n) { return { link: (n.link || "").trim(), name: (n.name || "").trim() }; }).filter(function (n) { return n.link; });
    api("/nodes/" + encodeURIComponent(state.current), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodes: nodes }) })
      .then(function (d) { setStatus("status", "已保存：" + (d.nodes || []).length + " 个节点", true); state.manual = true; return loadMachines(); })
      .catch(function (e) { setStatus("status", "保存失败：" + e.message, false); });
  };
  $("reset").onclick = function () {
    if (!state.current || !confirm("恢复后会用最近一次自动上报的节点覆盖手动配置，确定？")) return;
    api("/machines/" + encodeURIComponent(state.current) + "/reset", { method: "POST" })
      .then(function () { setStatus("status", "已恢复自动上报", true); return loadMachines(); })
      .catch(function (e) { setStatus("status", "恢复失败：" + e.message, false); });
  };
  $("save-machine-order").onclick = function () {
    var machines = state.machines.map(function (m) { return m.machine; });
    api("/machines/order", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machines: machines }) })
      .then(function () { setStatus("order-status", "机器顺序已保存", true); })
      .catch(function (e) { setStatus("order-status", "保存失败：" + e.message, false); });
  };
  $("create-machine").onclick = createMachine;
  document.addEventListener("click", function (ev) {
    var id = ev.target && ev.target.getAttribute("data-copy");
    if (!id) return;
    var text = $(id).textContent;
    var done = function () { var old = ev.target.textContent; ev.target.textContent = "已复制"; setTimeout(function () { ev.target.textContent = old; }, 1200); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done).catch(done); else done();
  });
  function boot() {
    api("/settings").then(function (d) { state.settings = d; renderUrls(); }).catch(function () {});
    loadMachines();
  }
  if (tok()) { showLogin(false); boot(); } else { showLogin(true); }
})();
</script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method === "GET" && path === "/health") {
      return json({
        ok: true,
        version: VERSION,
        roles: {
          admin: Boolean(adminTokens(env).length),
          read: Boolean(readTokens(env).length),
          per_machine_report: true,
          legacy_token: legacyAllowed(env),
        },
        time: new Date().toISOString(),
      });
    }

    if (request.method === "GET" && path === "/") {
      return json({
        name: "sub-worker",
        version: VERSION,
        subscription_base: baseUrl(request),
        formats: ["base64", "clash", "singbox"],
        ui: "/ui",
        roles: ["admin", "read", "report(per-machine)"],
        endpoints: [
          "POST /api/v1/report/:machine",
          "GET /sub/:machine/:token",
          "GET /sub/all/:token",
          "GET /sub/:token",
          "GET/POST /api/v1/machines/:machine",
          "DELETE /api/v1/machines/:machine",
          "POST /api/v1/machines/:machine/reset",
          "POST/DELETE /api/v1/machines/:machine/token",
          "GET/PUT /api/v1/nodes/:machine",
          "GET/PUT /api/v1/machines/order",
          "GET /api/v1/machines",
          "GET /api/v1/settings",
          "GET /ui",
          "GET /health",
        ],
      });
    }

    // 管理 UI：不再把凭据放进 URL（SW-05）；旧的 /ui/:token 仍兼容，但要求是管理密钥。
    if (request.method === "GET" && (path === "/ui" || /^\/ui\/[^/]+$/.test(path))) {
      const m = path.match(/^\/ui\/([^/]+)$/);
      if (m && !anyTokenMatch(decodeURIComponent(m[1]), adminTokens(env))) return unauthorized();
      if (!adminTokens(env).length) return missingConfig("ADMIN_TOKEN");
      return html(UI_HTML);
    }

    let m = path.match(/^\/api\/v1\/report\/([^/]+)$/);
    if (m) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return report(request, env, decodeURIComponent(m[1]));
    }

    // 以下全部是管理接口：只接受管理员凭据。
    if (path.startsWith("/api/v1/")) {
      if (!adminTokens(env).length) return missingConfig("ADMIN_TOKEN");
      if (!isAdmin(request, env)) return unauthorized();

      m = path.match(/^\/api\/v1\/settings$/);
      if (m) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return json({ ok: true, version: VERSION, read_token: readTokens(env)[0] || "", legacy_token: legacyAllowed(env) });
      }

      m = path.match(/^\/api\/v1\/nodes\/([^/]+)$/);
      if (m) {
        const machine = decodeURIComponent(m[1]);
        if (!MACHINE_RE.test(machine)) return json({ ok: false, error: "invalid machine name" }, 400);
        if (request.method === "GET") return getNodeConfig(env, machine);
        if (request.method === "PUT") return putNodeConfig(request, env, machine);
        return methodNotAllowed("GET, PUT");
      }

      m = path.match(/^\/api\/v1\/machines\/order$/);
      if (m) {
        if (request.method === "GET") return json({ ok: true, machine_order: await getMachineOrder(env) });
        if (request.method !== "PUT") return methodNotAllowed("GET, PUT");
        return putMachineOrder(request, env);
      }

      m = path.match(/^\/api\/v1\/machines\/([^/]+)\/reset$/);
      if (m) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        return resetMachine(env, decodeURIComponent(m[1]));
      }

      m = path.match(/^\/api\/v1\/machines\/([^/]+)\/token$/);
      if (m) {
        const machine = decodeURIComponent(m[1]);
        if (!MACHINE_RE.test(machine)) return json({ ok: false, error: "invalid machine name" }, 400);
        if (request.method === "POST") return mintMachineToken(env, machine);
        if (request.method === "GET") return getMachineToken(env, machine);
        if (request.method === "DELETE") return revokeMachineToken(env, machine);
        return methodNotAllowed("POST, GET, DELETE");
      }

      m = path.match(/^\/api\/v1\/machines(?:\/([^/]+))?$/);
      if (m) {
        if (!m[1]) {
          if (request.method !== "GET") return methodNotAllowed("GET");
          return listMachines(env);
        }
        const machine = decodeURIComponent(m[1]);
        if (!MACHINE_RE.test(machine)) return json({ ok: false, error: "invalid machine name" }, 400);
        if (request.method === "POST") return createMachine(env, machine);
        if (request.method === "DELETE") return deleteMachine(env, machine);
        return methodNotAllowed("POST, DELETE");
      }

      return json({ ok: false, error: "not found" }, 404);
    }

    m = path.match(/^\/sub\/all\/([^/]+)$/);
    if (m) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return getAll(env, decodeURIComponent(m[1]), request);
    }

    m = path.match(/^\/sub\/([^/]+)\/([^/]+)$/);
    if (m) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return getOne(env, decodeURIComponent(m[1]), decodeURIComponent(m[2]), request);
    }

    m = path.match(/^\/sub\/([^/]+)$/);
    if (m) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return getAll(env, decodeURIComponent(m[1]), request);
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};

/* ---------------- 权限 ---------------- */

function legacyAllowed(env) { return String((env && env.ALLOW_LEGACY_TOKEN) || "1") !== "0"; }
function adminTokens(env) {
  const out = [];
  if (env && env.ADMIN_TOKEN) out.push(env.ADMIN_TOKEN);
  if (legacyAllowed(env) && env && env.TOKEN) out.push(env.TOKEN);
  return out;
}
function readTokens(env) {
  const out = [];
  if (env && env.READ_TOKEN) out.push(env.READ_TOKEN);
  if (legacyAllowed(env) && env && env.TOKEN) out.push(env.TOKEN);
  return out;
}
function bearerOf(request) {
  const header = request.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}
function isAdmin(request, env) { return anyTokenMatch(bearerOf(request), adminTokens(env)); }
function isReaderToken(token, env) { return anyTokenMatch(token, readTokens(env)); }
async function reportAllowed(env, request, machine) {
  const token = bearerOf(request);
  if (!token) return false;
  // 管理员是读取/上报权限的超集，便于 WebUI 与运维直接补报。
  if (isAdmin(request, env)) return true;
  const hash = await env.SUBS.get(`tokenhash:${machine}`);
  if (hash && checkToken(await sha256Hex(token), hash)) return true;
  if (env.REPORT_TOKEN && checkToken(token, env.REPORT_TOKEN)) return true;
  if (legacyAllowed(env) && env.TOKEN && checkToken(token, env.TOKEN)) return true;
  return false;
}

/* ---------------- KV helpers (SW-08 分页) ---------------- */

async function listAllKeys(env, prefix) {
  const out = [];
  let cursor = undefined;
  for (let page = 0; page < 100; page++) {
    const res = await env.SUBS.list(cursor ? { prefix, cursor } : { prefix });
    for (const key of res.keys) out.push(key.name);
    if (res.list_complete || !res.cursor) break;
    cursor = res.cursor;
  }
  return out;
}

async function loadReport(env, machine) {
  let rec = await env.SUBS.get(`report:${machine}`, { type: "json" });
  if (rec) return rec;
  const legacy = await env.SUBS.get(`sub:${machine}`, { type: "json" });
  if (!legacy) return null;
  return {
    machine,
    content: legacy.content || "",
    hash: legacy.hash || "",
    bytes: legacy.bytes || 0,
    updated_at: legacy.updated_at || "",
    legacy_manual: Boolean(legacy.manual),
    legacy_nodes: Array.isArray(legacy.nodes) ? legacy.nodes : [],
  };
}

async function loadManual(env, machine) {
  const rec = await env.SUBS.get(`manual:${machine}`, { type: "json" });
  if (rec && Array.isArray(rec.nodes)) return rec;
  const legacy = await loadReport(env, machine);
  if (legacy && legacy.legacy_manual) return { machine, nodes: legacy.legacy_nodes || [], updated_at: legacy.updated_at };
  return null;
}

async function machineSet(env) {
  const names = new Set();
  // 登记表里先出现的机器即使还没有任何上报/手工节点，也要在 UI 里可见。
  for (const name of await getMachineOrder(env)) {
    if (MACHINE_RE.test(name)) names.add(name);
  }
  for (const prefix of ["report:", "manual:", "sub:"]) {
    for (const key of await listAllKeys(env, prefix)) {
      const name = key.slice(prefix.length);
      if (MACHINE_RE.test(name)) names.add(name);
    }
  }
  return [...names];
}

async function nodesOf(env, machine) {
  const manual = await loadManual(env, machine);
  if (manual) {
    const nodes = manual.nodes.slice();
    nodes.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    return nodes.map((n, i) => ({ ...n, _sort: i }));
  }
  const rep = await loadReport(env, machine);
  const nodes = rep ? await normalizeNodes(splitLinks(decodeSafe(rep.content)), []) : [];
  nodes.sort((a, b) => protocolRank(a) - protocolRank(b) || (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.name).localeCompare(String(b.name)));
  return nodes.map((n, i) => ({ ...n, _sort: i }));
}

/* ---------------- 订阅 ---------------- */

async function report(request, env, machine) {
  if (!MACHINE_RE.test(machine)) return json({ ok: false, error: "invalid machine name" }, 400);
  if (!(await reportAllowed(env, request, machine))) return unauthorized();

  const limited = await readLimitedText(request, MAX_BODY);
  if (limited.tooLarge) return json({ ok: false, error: "subscription too large" }, 413);
  const body = limited.text;
  const content = body.replace(/\s+/g, "");
  if (!content || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) return json({ ok: false, error: "body must be base64 text" }, 400);
  let decoded;
  try { decoded = decodeBase64(content); } catch { return json({ ok: false, error: "invalid base64" }, 400); }
  if (decoded.length > MAX_BODY) return json({ ok: false, error: "decoded content too large" }, 413);
  const links = splitLinks(decoded);
  if (links.length > MAX_NODES) return json({ ok: false, error: "too many nodes" }, 413);
  if (links.some((l) => l.length > MAX_LINK)) return json({ ok: false, error: "node link too long" }, 413);

  const hash = await sha256Hex(content);
  const old = await env.SUBS.get(`report:${machine}`, { type: "json" });
  const manual = await loadManual(env, machine);
  if (old && old.hash === hash) {
    return json({ ok: true, changed: false, machine, bytes: content.length, hash, manual: Boolean(manual), updated_at: old.updated_at });
  }
  const updatedAt = new Date().toISOString();
  // 自动快照单独存 report:<machine>；手工覆盖在 manual:<machine>，互不覆盖（SW-03/SW-09）。
  await env.SUBS.put(`report:${machine}`, JSON.stringify({ machine, content, hash, bytes: content.length, updated_at: updatedAt }));
  const derived = await normalizeNodes(links, []);
  return json({ ok: true, changed: true, machine, bytes: content.length, hash, nodes: derived.length, manual: Boolean(manual), updated_at: updatedAt });
}

async function getOne(env, machine, token, request) {
  if (!readTokens(env).length) return missingConfig("READ_TOKEN");
  if (!isReaderToken(token, env)) return unauthorized();
  if (!MACHINE_RE.test(machine)) return json({ ok: false, error: "invalid machine name" }, 400);
  const rep = await loadReport(env, machine);
  const manual = await loadManual(env, machine);
  if (!rep && !manual) return json({ ok: false, error: "subscription not found" }, 404);
  const nodes = await nodesOf(env, machine);
  return subResponse(nodes, request, { "x-machine": machine, "x-updated-at": (manual && manual.updated_at) || (rep && rep.updated_at) || "" });
}

async function getAll(env, token, request) {
  if (!readTokens(env).length) return missingConfig("READ_TOKEN");
  if (!isReaderToken(token, env)) return unauthorized();
  const names = await machineSet(env);
  const order = await getMachineOrder(env);
  const rank = new Map(order.map((m, i) => [m, i]));
  const all = [];
  let manual = 0;
  for (const machine of names) {
    if (await loadManual(env, machine)) manual++;
    const nodes = await nodesOf(env, machine);
    nodes.forEach((n) => all.push({ ...n, machine }));
  }
  all.sort((a, b) => {
    const ar = rank.has(a.machine) ? rank.get(a.machine) : defaultMachineRank(a.machine);
    const br = rank.has(b.machine) ? rank.get(b.machine) : defaultMachineRank(b.machine);
    return ar - br || (Number(a._sort) || 0) - (Number(b._sort) || 0) || String(a.machine).localeCompare(String(b.machine)) || String(a.name).localeCompare(String(b.name));
  });
  return subResponse(all, request, { "x-machines": String(names.length), "x-nodes": String(all.length), "x-manual-machines": String(manual), "x-machine-order": order.join(",") });
}

/* ---------------- 管理 API ---------------- */

async function getNodeConfig(env, machine) {
  const manual = await loadManual(env, machine);
  const rep = await loadReport(env, machine);
  const nodes = await nodesOf(env, machine);
  return json({
    ok: true,
    machine,
    manual: Boolean(manual),
    updated_at: (manual && manual.updated_at) || (rep && rep.updated_at) || "",
    has_report: Boolean(rep),
    nodes,
  });
}

async function putNodeConfig(request, env, machine) {
  const limited = await readLimitedText(request, MAX_BODY);
  if (limited.tooLarge) return json({ ok: false, error: "config too large" }, 413);
  let data;
  try { data = JSON.parse(limited.text); } catch { return json({ ok: false, error: "invalid json" }, 400); }
  if (!data || !Array.isArray(data.nodes)) return json({ ok: false, error: "nodes must be an array" }, 400);
  if (data.nodes.length > MAX_NODES) return json({ ok: false, error: "too many nodes" }, 400);

  // SW-03：可选的乐观并发检查（If-Match: <updated_at>）。只是可解释的冲突提示，不宣称 KV 上的 CAS。
  const ifMatch = request.headers.get("if-match") || "";
  const prevManual = await loadManual(env, machine);
  if (ifMatch && prevManual && prevManual.updated_at && ifMatch !== prevManual.updated_at) {
    return json({ ok: false, error: "version conflict", expected: prevManual.updated_at }, 409);
  }

  const inputs = [];
  const links = [];
  for (const item of data.nodes) {
    if (!item || typeof item.link !== "string") return json({ ok: false, error: "each node needs link" }, 400);
    const link = item.link.trim();
    if (!link || link.length > MAX_LINK || !parseLink(link)) return json({ ok: false, error: "invalid node link: " + link.slice(0, 60) }, 400);
    links.push(link);
    inputs.push({ link, name: typeof item.name === "string" ? item.name.trim().slice(0, 160) : "" });
  }
  const nodes = await normalizeNodes(links, [], inputs);
  const updatedAt = new Date().toISOString();
  await env.SUBS.put(`manual:${machine}`, JSON.stringify({ machine, nodes, updated_at: updatedAt }));
  return json({ ok: true, machine, manual: true, nodes, updated_at: updatedAt });
}

async function createMachine(env, machine) {
  if (!MACHINE_RE.test(machine)) return json({ ok: false, error: "invalid machine name" }, 400);
  const rep = await loadReport(env, machine);
  const manual = await loadManual(env, machine);
  // 只登记机器，不写空 manual：空 manual 会遮蔽后续上报（nodesOf 手工优先）。
  const order = await getMachineOrder(env);
  if (!order.includes(machine)) {
    order.push(machine);
    await env.SUBS.put("meta:machine_order", JSON.stringify(order));
  }
  const nodes = await nodesOf(env, machine);
  return json({
    ok: true,
    machine,
    created: !rep && !manual,
    manual: Boolean(manual),
    has_report: Boolean(rep),
    nodes: nodes.length,
    machine_order: order,
  });
}

async function resetMachine(env, machine) {
  if (!MACHINE_RE.test(machine)) return json({ ok: false, error: "invalid machine name" }, 400);
  await env.SUBS.delete(`manual:${machine}`);
  await env.SUBS.delete(`sub:${machine}`);
  const rep = await loadReport(env, machine);
  const nodes = await nodesOf(env, machine);
  return json({ ok: true, machine, manual: false, has_report: Boolean(rep), nodes });
}

async function mintMachineToken(env, machine) {
  const raw = randomHex(32);
  await env.SUBS.put(`tokenhash:${machine}`, await sha256Hex(raw));
  await env.SUBS.put(`tokenmeta:${machine}`, JSON.stringify({ machine, created_at: new Date().toISOString() }));
  return json({ ok: true, machine, token: raw });
}

async function getMachineToken(env, machine) {
  const meta = await env.SUBS.get(`tokenmeta:${machine}`, { type: "json" });
  return json({ ok: true, machine, has_token: Boolean(await env.SUBS.get(`tokenhash:${machine}`)), created_at: (meta && meta.created_at) || "" });
}

async function revokeMachineToken(env, machine) {
  await env.SUBS.delete(`tokenhash:${machine}`);
  await env.SUBS.delete(`tokenmeta:${machine}`);
  return json({ ok: true, machine, revoked: true });
}

async function listMachines(env) {
  const names = await machineSet(env);
  const order = await getMachineOrder(env);
  const rank = new Map(order.map((m, i) => [m, i]));
  const machines = [];
  for (const machine of names) {
    const manual = await loadManual(env, machine);
    const rep = await loadReport(env, machine);
    const nodes = await nodesOf(env, machine);
    machines.push({
      machine,
      bytes: (rep && rep.bytes) || 0,
      updated_at: (manual && manual.updated_at) || (rep && rep.updated_at) || "",
      hash: (rep && rep.hash) || "",
      manual: Boolean(manual),
      has_token: Boolean(await env.SUBS.get(`tokenhash:${machine}`)),
      nodes: nodes.length,
    });
  }
  machines.sort((a, b) => {
    const ar = rank.has(a.machine) ? rank.get(a.machine) : defaultMachineRank(a.machine);
    const br = rank.has(b.machine) ? rank.get(b.machine) : defaultMachineRank(b.machine);
    return ar - br || a.machine.localeCompare(b.machine);
  });
  return json({ ok: true, count: machines.length, machines, machine_order: order });
}

async function deleteMachine(env, machine) {
  if (!MACHINE_RE.test(machine)) return json({ ok: false, error: "invalid machine name" }, 400);
  for (const key of [`report:${machine}`, `manual:${machine}`, `sub:${machine}`, `tokenhash:${machine}`, `tokenmeta:${machine}`]) {
    await env.SUBS.delete(key);
  }
  const order = await getMachineOrder(env);
  if (order.includes(machine)) await env.SUBS.put("meta:machine_order", JSON.stringify(order.filter((m) => m !== machine)));
  return json({ ok: true, deleted: machine });
}

async function getMachineOrder(env) {
  const raw = await env.SUBS.get("meta:machine_order", { type: "json" });
  return Array.isArray(raw) ? raw.filter((x) => typeof x === "string" && MACHINE_RE.test(x)) : [];
}

async function putMachineOrder(request, env) {
  const limited = await readLimitedText(request, 65536);
  if (limited.tooLarge) return json({ ok: false, error: "order too large" }, 413);
  let data;
  try { data = JSON.parse(limited.text); } catch { return json({ ok: false, error: "invalid json" }, 400); }
  if (!data || !Array.isArray(data.machines)) return json({ ok: false, error: "machines must be an array" }, 400);
  const unique = [];
  for (const item of data.machines) {
    if (typeof item !== "string" || !MACHINE_RE.test(item)) return json({ ok: false, error: "invalid machine name" }, 400);
    if (!unique.includes(item)) unique.push(item);
  }
  await env.SUBS.put("meta:machine_order", JSON.stringify(unique));
  return json({ ok: true, machine_order: unique });
}

const COUNTRY_GROUPS = {
  ASIA: "AE AF AM AZ BD BH BN BT CN GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE",
  EUROPE: "AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK",
  AMERICAS: "AG AI AR AW BB BL BM BO BQ BR BS BZ CA CL CO CR CU CW DM DO EC FK GD GF GL GP GT GY HN HT JM KN KY LC MF MQ MS MX NI PA PE PM PR PY SR SV SX TC TT US UY VC VE VG VI UM",
  AFRICA: "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW",
  OCEANIA: "AS AU CC CK CX FJ FM GU HM KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS",
  OTHER: "AQ BV GS IO TF",
};
const COUNTRY_REGION = (() => {
  const out = {};
  for (const [region, list] of Object.entries(COUNTRY_GROUPS)) {
    for (const code of list.split(/\s+/)) out[code] = region;
  }
  return out;
})();
const ISO3_TO_ALPHA2 = {
  AFG:"AF", ALB:"AL", DZA:"DZ", ASM:"AS", AND:"AD", AGO:"AO", AIA:"AI", ATA:"AQ", ATG:"AG", ARG:"AR", ARM:"AM", ABW:"AW", AUS:"AU", AUT:"AT", AZE:"AZ",
  BHS:"BS", BHR:"BH", BGD:"BD", BRB:"BB", BLR:"BY", BEL:"BE", BLZ:"BZ", BEN:"BJ", BMU:"BM", BTN:"BT", BOL:"BO", BES:"BQ", BIH:"BA", BWA:"BW", BVT:"BV",
  BRA:"BR", IOT:"IO", BRN:"BN", BGR:"BG", BFA:"BF", BDI:"BI", CPV:"CV", KHM:"KH", CMR:"CM", CAN:"CA", CYM:"KY", CAF:"CF", TCD:"TD", CHL:"CL", CHN:"CN",
  CXR:"CX", CCK:"CC", COL:"CO", COM:"KM", COG:"CG", COD:"CD", COK:"CK", CRI:"CR", CIV:"CI", HRV:"HR", CUB:"CU", CUW:"CW", CYP:"CY", CZE:"CZ", DNK:"DK",
  DJI:"DJ", DMA:"DM", DOM:"DO", ECU:"EC", EGY:"EG", SLV:"SV", GNQ:"GQ", ERI:"ER", EST:"EE", SWZ:"SZ", ETH:"ET", FLK:"FK", FRO:"FO", FJI:"FJ", FIN:"FI",
  FRA:"FR", GUF:"GF", PYF:"PF", ATF:"TF", GAB:"GA", GMB:"GM", GEO:"GE", DEU:"DE", GHA:"GH", GIB:"GI", GRC:"GR", GRL:"GL", GRD:"GD", GLP:"GP", GUM:"GU",
  GTM:"GT", GGY:"GG", GIN:"GN", GNB:"GW", GUY:"GY", HTI:"HT", HMD:"HM", VAT:"VA", HND:"HN", HKG:"HK", HUN:"HU", ISL:"IS", IND:"IN", IDN:"ID", IRN:"IR",
  IRQ:"IQ", IRL:"IE", IMN:"IM", ISR:"IL", ITA:"IT", JAM:"JM", JPN:"JP", JEY:"JE", JOR:"JO", KAZ:"KZ", KEN:"KE", KIR:"KI", PRK:"KP", KOR:"KR", KWT:"KW",
  KGZ:"KG", LAO:"LA", LVA:"LV", LBN:"LB", LSO:"LS", LBR:"LR", LBY:"LY", LIE:"LI", LTU:"LT", LUX:"LU", MAC:"MO", MDG:"MG", MWI:"MW", MYS:"MY", MDV:"MV",
  MLI:"ML", MLT:"MT", MHL:"MH", MTQ:"MQ", MRT:"MR", MUS:"MU", MYT:"YT", MEX:"MX", FSM:"FM", MDA:"MD", MCO:"MC", MNG:"MN", MNE:"ME", MSR:"MS", MAR:"MA",
  MOZ:"MZ", MMR:"MM", NAM:"NA", NRU:"NR", NPL:"NP", NLD:"NL", NCL:"NC", NZL:"NZ", NIC:"NI", NER:"NE", NGA:"NG", NIU:"NU", NFK:"NF", MKD:"MK", MNP:"MP",
  NOR:"NO", OMN:"OM", PAK:"PK", PLW:"PW", PSE:"PS", PAN:"PA", PNG:"PG", PRY:"PY", PER:"PE", PHL:"PH", PCN:"PN", POL:"PL", PRT:"PT", PRI:"PR", QAT:"QA",
  REU:"RE", ROU:"RO", RUS:"RU", RWA:"RW", BLM:"BL", SHN:"SH", KNA:"KN", LCA:"LC", MAF:"MF", SPM:"PM", VCT:"VC", WSM:"WS", SMR:"SM", STP:"ST", SAU:"SA",
  SEN:"SN", SRB:"RS", SYC:"SC", SLE:"SL", SGP:"SG", SXM:"SX", SVK:"SK", SVN:"SI", SLB:"SB", SOM:"SO", ZAF:"ZA", SGS:"GS", SSD:"SS", ESP:"ES", LKA:"LK",
  SDN:"SD", SUR:"SR", SJM:"SJ", SWE:"SE", CHE:"CH", SYR:"SY", TWN:"TW", TJK:"TJ", TZA:"TZ", THA:"TH", TLS:"TL", TGO:"TG", TKL:"TK", TON:"TO", TTO:"TT",
  TUN:"TN", TUR:"TR", TKM:"TM", TCA:"TC", TUV:"TV", UGA:"UG", UKR:"UA", ARE:"AE", GBR:"GB", USA:"US", UMI:"UM", URY:"UY", UZB:"UZ", VUT:"VU", VEN:"VE",
  VNM:"VN", VGB:"VG", VIR:"VI", WLF:"WF", ESH:"EH", YEM:"YE", ZMB:"ZM", ZWE:"ZW",
};
const MACHINE_ALIASES = { PHX: "US", FRA: "FR", DXB: "AE", AMS: "NL", TKY: "JP", OSA: "JP", SIN: "SG", HKG: "HK", SFO: "US", SJC: "US", LAX: "US", NYC: "US" };

function countryCodeOf(machine) {
  const first = String(machine || "").toLowerCase().split("-")[0].toUpperCase();
  if (!first) return "";
  if (first === "UK") return "GB";
  if (first === "EL") return "GR";
  if (MACHINE_ALIASES[first]) return MACHINE_ALIASES[first];
  if (first.length === 2) return first;
  if (first.length === 3) return ISO3_TO_ALPHA2[first] || "";
  return "";
}

function defaultMachineRank(machine) {
  const code = countryCodeOf(machine);
  if (code === "HK") return 10;
  if (code === "KR") return 20;
  if (code === "JP") return 30;
  if (code === "SG") return 40;
  if (code === "US") return 60;
  if (code === "DE") return 70;
  const region = COUNTRY_REGION[code] || "OTHER";
  if (region === "ASIA") return 50;
  if (region === "EUROPE") return 80;
  if (region === "AMERICAS") return 90;
  return 100;
}

/* ---------------- 节点规范化 ---------------- */

function protocolRank(node) {
  const p = node && node.link ? parseLink(node.link) : null;
  if (!p) return 90;
  if (p.kind === "vless" && p.reality) return 10;
  if (p.kind === "anytls") return 20;
  if (p.kind === "vless" && p.network === "ws") {
    const text = `${node.name || ""} ${node.link || ""}`.toLowerCase();
    return text.includes("argo") || text.includes("trycloudflare") ? 30 : 40;
  }
  if (p.kind === "hy2") return 50;
  if (p.kind === "tuic") return 60;
  if (p.kind === "socks5" || p.kind === "socks") return 70;
  if (p.kind === "trojan") return 75;
  return 90;
}

async function normalizeNodes(links, previous, inputs) {
  const prev = new Map((previous || []).map((n) => [n.link, n]));
  const inputMap = new Map((inputs || []).map((n) => [n.link, n]));
  const out = [];
  const seen = new Set();
  for (const raw of links) {
    const link = String(raw || "").trim();
    if (!link || seen.has(link)) continue;
    const parsed = parseLink(link);
    if (!parsed) continue;
    seen.add(link);
    const id = (await sha256Hex(link)).slice(0, 16);
    const old = prev.get(link) || {};
    const input = inputMap.get(link) || {};
    out.push({ id, name: input.name || old.name || parsed.name, link, protocol: parsed.kind, order: out.length });
  }
  return out;
}

function splitLinks(text) {
  return String(text || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

function decodeSafe(text) {
  try { return decodeBase64(String(text || "").replace(/\s+/g, "")); } catch { return ""; }
}

/* ---------------- 链接解析 ---------------- */

function safeDecode(value) {
  try { return decodeURIComponent(value || ""); } catch { return value || ""; }
}

function parseLink(link) {
  try {
    if (link.startsWith("vmess://")) return parseVmess(link);
    const u = new URL(link);
    const kind = u.protocol.replace(/:$/, "").toLowerCase();
    const q = u.searchParams;
    const port = Number(u.port || 443);
    const server = u.hostname;
    if (!server || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    const fragment = safeDecode(u.hash.slice(1));
    const base = {
      kind, server, port,
      name: fragment || `${kind.toUpperCase()}-${server}`,
      insecure: hasInsecureFlag(q),
      pin: (q.get("pinSHA256") || "").replace(/[^0-9a-fA-F]/g, "").toLowerCase(),
    };
    if (kind === "vless") {
      const security = (q.get("security") || "").toLowerCase();
      return {
        ...base,
        uuid: safeDecode(u.username),
        tls: security === "tls" || security === "reality",
        reality: security === "reality",
        sni: q.get("sni") || q.get("serverName") || "",
        flow: q.get("flow") || "",
        network: (q.get("type") || "tcp").toLowerCase(),
        path: q.get("path") || "",
        host: q.get("host") || "",
        serviceName: q.get("serviceName") || "",
        mode: q.get("mode") || "",
        pbk: q.get("pbk") || "",
        sid: q.get("sid") || "",
        fp: q.get("fp") || "chrome",
      };
    }
    if (kind === "anytls") return { ...base, password: safeDecode(u.username), tls: true, sni: q.get("sni") || "" };
    if (kind === "hysteria2" || kind === "hy2") {
      return {
        ...base, kind: "hy2",
        password: safeDecode(u.username),
        tls: true,
        sni: q.get("sni") || "",
        obfs: q.get("obfs") || "",
        obfsPassword: q.get("obfs-password") || "",
      };
    }
    if (kind === "tuic") return { ...base, uuid: safeDecode(u.username), password: safeDecode(u.password), tls: true, sni: q.get("sni") || "", congestion: q.get("congestion_control") || "bbr", relay: q.get("udp_relay_mode") || "native" };
    if (kind === "trojan") return { ...base, password: safeDecode(u.username), tls: true, sni: q.get("sni") || "" };
    if (kind === "socks5" || kind === "socks") return { ...base, kind: "socks5", username: safeDecode(u.username), password: safeDecode(u.password), tls: false, sni: "" };
    if (kind === "ss") {
      let user = safeDecode(u.username);
      if (u.password) user = `${user}:${safeDecode(u.password)}`;
      if (!user.includes(":")) user = safeDecode(atob(user));
      const idx = user.indexOf(":");
      if (idx < 1) return null;
      return { ...base, method: user.slice(0, idx), password: user.slice(idx + 1), tls: false, sni: "" };
    }
    return null;
  } catch { return null; }
}

function parseVmess(link) {
  try {
    const raw = decodeBase64(link.slice("vmess://".length));
    const j = JSON.parse(raw);
    const port = Number(j.port || 443);
    if (!j.add || !j.id || !port) return null;
    return {
      kind: "vmess", server: j.add, port,
      name: j.ps || `VMess-${j.add}`,
      uuid: j.id, alterId: Number(j.aid || 0), cipher: j.scy || "auto",
      tls: String(j.tls || "") === "tls", sni: j.sni || j.host || "",
      network: (j.net || "tcp").toLowerCase(), path: j.path || "", host: j.host || "",
      serviceName: j.path || "", mode: "",
      insecure: false, pin: "",
    };
  } catch { return null; }
}

function hasInsecureFlag(q) {
  const v = (q.get("allow_insecure") || q.get("allowInsecure") || q.get("insecure") || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/* ---------------- 订阅格式 ---------------- */

function formatOf(request) {
  const u = new URL(request.url);
  const raw = (u.searchParams.get("format") || "").toLowerCase();
  if (raw === "clash" || raw === "mihomo" || raw === "yaml") return "clash";
  if (raw === "singbox" || raw === "sing-box" || raw === "json") return "singbox";
  if (raw === "base64" || raw === "b64" || raw === "uri" || raw === "v2rayn") return "base64";
  if (u.searchParams.has("clash")) return "clash";
  if (u.searchParams.has("singbox") || u.searchParams.has("sing-box")) return "singbox";
  if (u.searchParams.has("b64") || u.searchParams.has("base64")) return "base64";
  const ua = (request.headers.get("User-Agent") || "").toLowerCase();
  if (ua.includes("clash") || ua.includes("mihomo") || ua.includes("meta")) return "clash";
  if (ua.includes("sing-box") || ua.includes("singbox")) return "singbox";
  return "base64";
}

function subResponse(nodes, request, extraHeaders) {
  const format = formatOf(request);
  const headers = { ...corsHeaders(), "cache-control": "no-store, max-age=0", "profile-update-interval": "6", ...(extraHeaders || {}) };
  if (format === "clash") {
    const built = toClash(nodes);
    if (built.unsupported.length) return unsupportedResponse(format, built.unsupported);
    return new Response(built.text, { headers: { ...headers, "content-type": "text/yaml; charset=utf-8" } });
  }
  if (format === "singbox") {
    const built = toSingbox(nodes);
    if (built.unsupported.length) return unsupportedResponse(format, built.unsupported);
    return new Response(built.text, { headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
  }
  return new Response(encodeBase64(nodes.map((n) => n.link).join("\n")), { headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
}

function unsupportedResponse(format, nodes) {
  // SW-04/SW-07：目标格式表达不了的能力明确拒绝，不退化成跳过验证或 TCP。
  return json(
    { ok: false, error: "format cannot represent node", format, nodes: nodes.slice(0, 20), hint: "使用 ?format=base64 保留原始链接" },
    501,
  );
}

function yamlString(value) { return JSON.stringify(String(value == null ? "" : value)); }

function toClash(nodes) {
  const lines = ["proxies:"];
  const unsupported = [];
  for (const node of nodes) {
    const p = node.proxy || parseLink(node.link);
    if (!p) continue;
    const name = node.name || p.name;
    if (p.network === "xhttp" || p.network === "xhttp-reality" || (p.kind === "vless" && p.mode && p.network === "xhttp")) {
      unsupported.push(name);
      continue;
    }
    if (p.reality && p.pin) {
      // reality 与证书指纹互斥；同时出现说明链接本身异常，明确拒绝。
      unsupported.push(name);
      continue;
    }
    lines.push(`  - name: ${yamlString(name)}`);
    lines.push(`    type: ${p.kind === "hy2" ? "hysteria2" : p.kind}`);
    lines.push(`    server: ${yamlString(p.server)}`);
    lines.push(`    port: ${p.port}`);
    lines.push("    udp: true");
    if (p.kind === "vless") {
      lines.push(`    uuid: ${yamlString(p.uuid)}`);
      if (p.flow) lines.push(`    flow: ${yamlString(p.flow)}`);
      lines.push(`    tls: ${p.tls ? "true" : "false"}`);
      if (p.sni) lines.push(`    servername: ${yamlString(p.sni)}`);
      if (p.network === "ws") {
        lines.push("    network: ws");
        lines.push("    ws-opts:");
        lines.push(`      path: ${yamlString(p.path || "/")}`);
        if (p.host) { lines.push("      headers:"); lines.push(`        Host: ${yamlString(p.host)}`); }
      } else if (p.network === "grpc") {
        lines.push("    network: grpc");
        lines.push("    grpc-opts:");
        lines.push(`      grpc-service-name: ${yamlString(p.serviceName || p.path || "")}`);
      }
      if (p.reality && p.pbk) {
        lines.push("    reality-opts:");
        lines.push(`      public-key: ${yamlString(p.pbk)}`);
        if (p.sid) lines.push(`      short-id: ${yamlString(p.sid)}`);
        lines.push(`    client-fingerprint: ${yamlString(p.fp || "chrome")}`);
      }
      if (p.pin) lines.push(`    fingerprint: ${yamlString(p.pin)}`);
      if (p.insecure) lines.push("    skip-cert-verify: true");
    } else if (p.kind === "anytls") {
      lines.push(`    password: ${yamlString(p.password)}`);
      if (p.sni) lines.push(`    sni: ${yamlString(p.sni)}`);
      if (p.pin) lines.push(`    fingerprint: ${yamlString(p.pin)}`);
      if (p.insecure) lines.push("    skip-cert-verify: true");
    } else if (p.kind === "hy2") {
      lines.push(`    password: ${yamlString(p.password)}`);
      if (p.sni) lines.push(`    sni: ${yamlString(p.sni)}`);
      lines.push("    alpn:"); lines.push("      - h3");
      if (p.obfs) { lines.push(`    obfs: ${yamlString(p.obfs)}`); if (p.obfsPassword) lines.push(`    obfs-password: ${yamlString(p.obfsPassword)}`); }
      if (p.pin) lines.push(`    fingerprint: ${yamlString(p.pin)}`);
      if (p.insecure) lines.push("    skip-cert-verify: true");
    } else if (p.kind === "tuic") {
      lines.push(`    uuid: ${yamlString(p.uuid)}`);
      lines.push(`    password: ${yamlString(p.password)}`);
      if (p.sni) lines.push(`    sni: ${yamlString(p.sni)}`);
      lines.push("    alpn:"); lines.push("      - h3");
      lines.push("    congestion-controller: bbr");
      lines.push("    udp-relay-mode: native");
      if (p.pin) lines.push(`    fingerprint: ${yamlString(p.pin)}`);
      if (p.insecure) lines.push("    skip-cert-verify: true");
    } else if (p.kind === "trojan") {
      lines.push(`    password: ${yamlString(p.password)}`);
      if (p.sni) lines.push(`    sni: ${yamlString(p.sni)}`);
      if (p.pin) lines.push(`    fingerprint: ${yamlString(p.pin)}`);
      if (p.insecure) lines.push("    skip-cert-verify: true");
    } else if (p.kind === "ss") {
      lines.push(`    cipher: ${yamlString(p.method)}`);
      lines.push(`    password: ${yamlString(p.password)}`);
    } else if (p.kind === "socks5") {
      if (p.username) lines.push(`    username: ${yamlString(p.username)}`);
      if (p.password) lines.push(`    password: ${yamlString(p.password)}`);
    } else if (p.kind === "vmess") {
      lines.push(`    uuid: ${yamlString(p.uuid)}`);
      lines.push(`    alterId: ${p.alterId || 0}`);
      lines.push(`    cipher: ${yamlString(p.cipher || "auto")}`);
      lines.push(`    tls: ${p.tls ? "true" : "false"}`);
      if (p.sni) lines.push(`    servername: ${yamlString(p.sni)}`);
      if (p.network === "ws") {
        lines.push("    network: ws");
        lines.push("    ws-opts:");
        lines.push(`      path: ${yamlString(p.path || "/")}`);
        if (p.host) { lines.push("      headers:"); lines.push(`        Host: ${yamlString(p.host)}`); }
      } else if (p.network === "grpc") {
        lines.push("    network: grpc");
        lines.push("    grpc-opts:");
        lines.push(`      grpc-service-name: ${yamlString(p.serviceName || p.path || "")}`);
      }
    }
  }
  return { text: lines.join("\n") + "\n", unsupported };
}

function toSingbox(nodes) {
  const outbounds = [];
  const unsupported = [];
  for (const node of nodes) {
    const p = node.proxy || parseLink(node.link);
    if (!p) continue;
    const tag = node.name || p.name;
    // SW-04：sing-box 没有"证书指纹固定"字段（certificate_public_key_sha256 是公钥 pin，
    // 和证书指纹语义不同，不能混用），因此明确拒绝而不是退化成 insecure。
    if (p.pin) { unsupported.push(tag); continue; }
    // SW-07：sing-box 该版本不保证支持 xhttp 传输，明确拒绝，不降级成 tcp。
    if (p.kind === "vless" && (p.network === "xhttp" || p.network === "xhttp-reality")) { unsupported.push(tag); continue; }
    const tls = { enabled: true };
    if (p.sni) tls.server_name = p.sni;
    if (p.insecure) tls.insecure = true;
    if (p.reality && p.pbk) {
      tls.utls = { enabled: true, fingerprint: p.fp || "chrome" };
      tls.reality = { enabled: true, public_key: p.pbk, short_id: p.sid || "" };
    }
    if (p.kind === "vless") {
      const o = { type: "vless", tag, server: p.server, server_port: p.port, uuid: p.uuid };
      if (p.flow) o.flow = p.flow;
      if (p.tls) o.tls = tls;
      if (p.network === "ws") {
        o.transport = { type: "ws", path: p.path || "/" };
        if (p.host) o.transport.headers = { Host: p.host };
      } else if (p.network === "grpc") {
        o.transport = { type: "grpc", service_name: p.serviceName || p.path || "" };
      }
      outbounds.push(o);
    } else if (p.kind === "anytls") {
      outbounds.push({ type: "anytls", tag, server: p.server, server_port: p.port, password: p.password, tls });
    } else if (p.kind === "hy2") {
      const o = { type: "hysteria2", tag, server: p.server, server_port: p.port, password: p.password, tls };
      if (p.obfs) o.obfs = { type: p.obfs, password: p.obfsPassword || "" };
      outbounds.push(o);
    } else if (p.kind === "tuic") {
      outbounds.push({ type: "tuic", tag, server: p.server, server_port: p.port, uuid: p.uuid, password: p.password, congestion_control: p.congestion || "bbr", udp_relay_mode: p.relay || "native", tls });
    } else if (p.kind === "trojan") {
      outbounds.push({ type: "trojan", tag, server: p.server, server_port: p.port, password: p.password, tls });
    } else if (p.kind === "ss") {
      outbounds.push({ type: "shadowsocks", tag, server: p.server, server_port: p.port, method: p.method, password: p.password });
    } else if (p.kind === "socks5") {
      const o = { type: "socks", tag, server: p.server, server_port: p.port };
      if (p.username) o.username = p.username;
      if (p.password) o.password = p.password;
      outbounds.push(o);
    } else if (p.kind === "vmess") {
      const o = { type: "vmess", tag, server: p.server, server_port: p.port, uuid: p.uuid, security: p.cipher || "auto", alter_id: p.alterId || 0 };
      if (p.tls) o.tls = tls;
      if (p.network === "ws") {
        o.transport = { type: "ws", path: p.path || "/" };
        if (p.host) o.transport.headers = { Host: p.host };
      } else if (p.network === "grpc") {
        o.transport = { type: "grpc", service_name: p.serviceName || p.path || "" };
      }
      outbounds.push(o);
    }
  }
  return { text: JSON.stringify({ outbounds }, null, 2), unsupported };
}

/* ---------------- 请求/编码/响应工具 ---------------- */

async function readLimitedText(request, limit) {
  const declared = Number(request.headers.get("content-length") || "");
  if (Number.isFinite(declared) && declared > limit) return { text: "", tooLarge: true };
  if (!request.body) return { text: "", tooLarge: false };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      try { await reader.cancel(); } catch { /* 已超限，取消读取 */ }
      return { text: "", tooLarge: true };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  return { text: new TextDecoder().decode(merged), tooLarge: false };
}

function checkToken(actual, expected) {
  if (!expected || typeof actual !== "string" || actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
function anyTokenMatch(actual, list) { return Array.isArray(list) && list.some((t) => checkToken(actual, t)); }
function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function decodeBase64(text) {
  const binary = atob(text);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
function baseUrl(request) { return new URL(request.url).origin; }
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(), "content-type": "application/json; charset=utf-8" } });
}
function html(text) {
  return new Response(text, { headers: { ...corsHeaders(), "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY" } });
}
function unauthorized() { return json({ ok: false, error: "unauthorized" }, 401); }
function missingConfig(name) { return json({ ok: false, error: `${name} is not configured` }, 500); }
function methodNotAllowed(allow) {
  return new Response(JSON.stringify({ ok: false, error: "method not allowed" }), { status: 405, headers: { ...corsHeaders(), "content-type": "application/json; charset=utf-8", allow } });
}
function corsHeaders() {
  return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type, If-Match", "x-content-type-options": "nosniff" };
}
