// sub-worker single-file build
// 直接粘贴到 Cloudflare Dashboard -> Workers & Pages -> 你的 Worker -> Edit code。
// 变量模式：在 Settings -> Variables and Secrets 设置一个 TOKEN（Secret）。
// 对外域名由请求 Origin 自动决定，无需配置。
// KV 绑定变量名必须是 SUBS。

/**
 * sub-worker
 *
 * 固定订阅入口 + 多机器自动上报 + WebUI 节点编辑/排序 + 客户端格式适配
 *
 * 上报：POST /api/v1/report/:machine         Bearer TOKEN，body 为 base64 订阅
 * 读取：GET  /sub/:machine/:token           单机
 *       GET  /sub/all/:token                 全部机器
 *       GET  /sub/:token                     全部机器简写
 * 格式：?format=clash|singbox|base64，或 ?clash / ?singbox / ?b64
 * WebUI：GET /ui/:token
 * API：GET/PUT /api/v1/nodes/:machine
 *      POST /api/v1/machines/:machine/reset
 *
 * KV：
 *   sub:<machine> -> {
 *     machine, content, hash, bytes, updated_at,
 *     nodes: [{id, name, link, protocol, order}],
 *     manual: boolean
 *   }
 */

const VERSION = "1.1.2";
const MAX_BODY = 512 * 1024;
const MACHINE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const UI_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sub-worker 节点管理</title>
<style>
:root{--bg:#ffffff;--card:#ffffff;--line:#dfe6ef;--ink:#1f2937;--sub:#64748b;--acc:#2563eb;--ok:#15803d;--err:#dc2626;--input:#ffffff}
*{box-sizing:border-box}body{margin:0;background:#ffffff;color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif}
.wrap{max-width:1180px;margin:28px auto 50px;padding:0 18px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}
h1{font-size:25px;margin:0}.ver{color:var(--acc);font:12px ui-monospace,Consolas,monospace;border:1px solid var(--line);padding:3px 8px;border-radius:8px}
.card{background:#ffffff;border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:18px;box-shadow:0 1px 4px rgba(15,23,42,.06)}
.card h2{font-size:17px;margin:0 0 12px}.tip{font-size:12px;color:var(--sub);font-weight:400}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.row label{color:var(--sub);font-size:13px}
select,input,button{font:14px inherit}select,input{background:var(--input);color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:8px 10px;outline:none}
select:focus,input:focus{border-color:var(--acc)}button{cursor:pointer;border:1px solid var(--line);border-radius:9px;padding:8px 12px;background:#f1f5f9;color:var(--ink)}
button:hover{border-color:var(--acc)}button.primary{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}button.danger{color:var(--err)}
button:disabled{opacity:.4;cursor:not-allowed}.nodes{margin-top:14px;display:grid;gap:8px}.node{display:grid;grid-template-columns:34px 1fr 180px 34px 34px 34px;gap:8px;align-items:center}
.node .idx{color:var(--sub);font:12px ui-monospace,Consolas,monospace;text-align:center}.node input.link{font:12px ui-monospace,Consolas,monospace;min-width:0}
.node input.name{font-size:13px}.node button{padding:6px 8px}.status{margin-top:12px;min-height:22px;font-size:13px;color:var(--sub)}.status.ok{color:var(--ok)}.status.err{color:var(--err)}
.machine-list{display:grid;gap:7px;margin-top:12px}.machine{display:grid;grid-template-columns:34px 1fr 90px 34px 34px 70px;gap:8px;align-items:center;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:#f8fafc}
.machine .idx{color:var(--sub);font:12px ui-monospace,Consolas,monospace;text-align:center}.machine .mname{font-weight:600}.machine .mcount{font-size:12px;color:var(--sub)}.machine button{padding:5px 7px}.machine .edit{font-size:12px;padding:5px 8px}
code{font:12px ui-monospace,Consolas,monospace;color:#1d4ed8;word-break:break-all}.subrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:7px 0}.subrow code{flex:1;min-width:260px}
.hint{color:var(--sub);font-size:12px;line-height:1.7}.empty{color:var(--sub);padding:20px 0;text-align:center}
@media(max-width:850px){.node{grid-template-columns:28px 1fr;padding-bottom:8px;border-bottom:1px dashed var(--line)}.node input.name{grid-column:2}.node button{grid-row:2}.node .idx{grid-row:1/span 2}}
</style>
</head>
<body>
<div class="wrap">
<div class="top"><div><h1>sub-worker <span class="tip">节点管理</span></h1><div class="hint">先调整机器顺序，再编辑每台机器的节点顺序；保存后订阅自动按顺序生成。</div></div><span class="ver" id="version">v1.1.2</span></div>

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
<h2>订阅链接 <span class="tip">客户端会按 User-Agent 自动选择格式</span></h2>
<div class="subrow"><span class="tip">通用 base64</span><code id="url-base"></code><button data-copy="url-base" type="button">复制</button></div>
<div class="subrow"><span class="tip">Clash / Mihomo</span><code id="url-clash"></code><button data-copy="url-clash" type="button">复制</button></div>
<div class="subrow"><span class="tip">sing-box</span><code id="url-singbox"></code><button data-copy="url-singbox" type="button">复制</button></div>
<div class="hint">也可以显式使用 <code>?format=clash</code>、<code>?format=singbox</code>、<code>?format=base64</code>。手动保存后，机器自动上报不会覆盖你编辑的节点；点“恢复自动上报”才会恢复。</div>
</section>
</div>
<script>
(function () {
  "use strict";
  var TOKEN = decodeURIComponent((location.pathname.split("/").pop() || ""));
  var state = { machines: [], current: "", nodes: [] };
  var $ = function (id) { return document.getElementById(id); };

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers || {}, { Authorization: "Bearer " + TOKEN });
    return fetch("/api/v1" + path, opts).then(function (r) {
      return r.text().then(function (text) {
        var data;
        try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { ok: false, error: text || ("HTTP " + r.status) }; }
        if (!r.ok || data.ok === false) throw new Error(data.error || ("HTTP " + r.status));
        return data;
      });
    });
  }
  function setStatus(text, ok) {
    var el = $("status"); el.textContent = text || ""; el.className = "status" + (ok === true ? " ok" : ok === false ? " err" : "");
  }
  function nodeRow(node, index) {
    var row = document.createElement("div"); row.className = "node";
    var idx = document.createElement("div"); idx.className = "idx"; idx.textContent = String(index + 1);
    var link = document.createElement("input"); link.className = "link"; link.type = "text"; link.value = node.link || ""; link.placeholder = "vless://... / tuic://... / anytls://...";
    var name = document.createElement("input"); name.className = "name"; name.type = "text"; name.value = node.name || ""; name.placeholder = "显示名称";
    var up = document.createElement("button"); up.type = "button"; up.textContent = "↑"; up.title = "上移";
    var down = document.createElement("button"); down.type = "button"; down.textContent = "↓"; down.title = "下移";
    var del = document.createElement("button"); del.type = "button"; del.className = "danger"; del.textContent = "×"; del.title = "删除";
    up.onclick = function () { if (index > 0) { var t = state.nodes[index - 1]; state.nodes[index - 1] = state.nodes[index]; state.nodes[index] = t; render(); } };
    down.onclick = function () { if (index < state.nodes.length - 1) { var t = state.nodes[index + 1]; state.nodes[index + 1] = state.nodes[index]; state.nodes[index] = t; render(); } };
    del.onclick = function () { state.nodes.splice(index, 1); render(); };
    link.oninput = function () { state.nodes[index].link = link.value; };
    name.oninput = function () { state.nodes[index].name = name.value; };
    row.appendChild(idx); row.appendChild(link); row.appendChild(name); row.appendChild(up); row.appendChild(down); row.appendChild(del);
    return row;
  }
  function render() {
    var box = $("nodes"); box.innerHTML = "";
    if (!state.nodes.length) { var e = document.createElement("div"); e.className = "empty"; e.textContent = "暂无节点，点击下方添加"; box.appendChild(e); return; }
    state.nodes.forEach(function (n, i) { box.appendChild(nodeRow(n, i)); });
  }
  function renderMachines() {
    var sel = $("machine"); sel.innerHTML = "";
    if (!state.machines.length) { var o = document.createElement("option"); o.value = ""; o.textContent = "暂无机器上报"; sel.appendChild(o); return; }
    state.machines.forEach(function (m) { var o = document.createElement("option"); o.value = m.machine; o.textContent = m.machine + (m.manual ? "（手动）" : ""); sel.appendChild(o); });
    if (!state.current || !state.machines.some(function (m) { return m.machine === state.current; })) state.current = state.machines[0].machine;
    sel.value = state.current;
  }
  function renderMachineList() {
    var box = $("machine-list"); box.innerHTML = "";
    if (!state.machines.length) { var e = document.createElement("div"); e.className = "empty"; e.textContent = "暂无机器上报"; box.appendChild(e); return; }
    state.machines.forEach(function (m, index) {
      var row = document.createElement("div"); row.className = "machine";
      var idx = document.createElement("div"); idx.className = "idx"; idx.textContent = String(index + 1);
      var name = document.createElement("div"); name.className = "mname"; name.textContent = m.machine + (m.manual ? "（手动）" : "");
      var count = document.createElement("div"); count.className = "mcount"; count.textContent = (m.nodes || 0) + " 节点";
      var up = document.createElement("button"); up.type = "button"; up.textContent = "↑"; up.title = "上移"; up.disabled = index === 0;
      var down = document.createElement("button"); down.type = "button"; down.textContent = "↓"; down.title = "下移"; down.disabled = index === state.machines.length - 1;
      var edit = document.createElement("button"); edit.type = "button"; edit.className = "edit"; edit.textContent = "编辑节点";
      up.onclick = function () { if (index > 0) { var t = state.machines[index - 1]; state.machines[index - 1] = state.machines[index]; state.machines[index] = t; renderMachineList(); renderMachines(); } };
      down.onclick = function () { if (index < state.machines.length - 1) { var t = state.machines[index + 1]; state.machines[index + 1] = state.machines[index]; state.machines[index] = t; renderMachineList(); renderMachines(); } };
      edit.onclick = function () { state.current = m.machine; $("machine").value = m.machine; loadNodes(); };
      row.appendChild(idx); row.appendChild(name); row.appendChild(count); row.appendChild(up); row.appendChild(down); row.appendChild(edit);
      box.appendChild(row);
    });
  }
  function renderUrls() {
    var base = location.origin + "/sub/all/" + encodeURIComponent(TOKEN);
    $("url-base").textContent = base;
    $("url-clash").textContent = base + "?format=clash";
    $("url-singbox").textContent = base + "?format=singbox";
  }
  function loadNodes() {
    if (!state.current) { state.nodes = []; render(); return Promise.resolve(); }
    setStatus("加载中...");
    return api("/nodes/" + encodeURIComponent(state.current)).then(function (data) {
      state.nodes = (data.nodes || []).map(function (n) { return { link: n.link || "", name: n.name || "" }; });
      render(); setStatus("已加载 " + state.nodes.length + " 个节点");
    }).catch(function (e) { setStatus("加载失败：" + e.message, false); });
  }
  function loadMachines() {
    return api("/machines").then(function (data) {
      state.machines = data.machines || []; renderMachines(); renderMachineList(); return loadNodes();
    }).catch(function (e) { setStatus("加载失败：" + e.message, false); });
  }
  $("machine").onchange = function () { state.current = this.value; loadNodes(); };
  $("save-machine-order").onclick = function () {
    var machines = state.machines.map(function (m) { return m.machine; });
    var el = $("order-status"); el.textContent = "保存中..."; el.className = "status";
    api("/machines/order", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machines: machines }) })
      .then(function () { el.textContent = "机器顺序已保存"; el.className = "status ok"; return loadMachines(); })
      .catch(function (e) { el.textContent = "保存失败：" + e.message; el.className = "status err"; });
  };
  $("reload").onclick = loadMachines;
  $("add").onclick = function () { state.nodes.push({ link: "", name: "" }); render(); };
  $("save").onclick = function () {
    if (!state.current) return setStatus("没有可保存的机器", false);
    var nodes = state.nodes.filter(function (n) { return String(n.link || "").trim(); }).map(function (n, i) {
      return { link: String(n.link).trim(), name: String(n.name || "").trim(), order: i };
    });
    setStatus("保存中...");
    api("/nodes/" + encodeURIComponent(state.current), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodes: nodes }) })
      .then(function (data) { setStatus("保存成功：" + data.nodes.length + " 个节点", true); return loadMachines(); })
      .catch(function (e) { setStatus("保存失败：" + e.message, false); });
  };
  $("reset").onclick = function () {
    if (!state.current || !confirm("恢复后会用最近一次自动上报的节点覆盖手动配置，确定？")) return;
    api("/machines/" + encodeURIComponent(state.current) + "/reset", { method: "POST" })
      .then(function () { setStatus("已恢复自动上报", true); return loadMachines(); })
      .catch(function (e) { setStatus("恢复失败：" + e.message, false); });
  };
  document.addEventListener("click", function (ev) {
    var id = ev.target && ev.target.getAttribute("data-copy");
    if (!id) return;
    var text = $(id).textContent;
    var done = function () { var old = ev.target.textContent; ev.target.textContent = "已复制"; setTimeout(function () { ev.target.textContent = old; }, 1200); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done).catch(done); else done();
  });
  renderUrls(); loadMachines();
})();
</script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method === "GET" && path === "/health") return json({ ok: true, version: VERSION, time: new Date().toISOString() });

    if (request.method === "GET" && path === "/") {
      return json({
        name: "sub-worker",
        version: VERSION,
        subscription_base: baseUrl(request),
        formats: ["base64", "clash", "singbox"],
        ui: "/ui/:token",
        endpoints: [
          "POST /api/v1/report/:machine",
          "GET /sub/:machine/:token",
          "GET /sub/all/:token",
          "GET /sub/:token",
          "GET/PUT /api/v1/nodes/:machine",
          "POST /api/v1/machines/:machine/reset",
          "GET/PUT /api/v1/machines/order",
          "GET /api/v1/machines",
          "GET /health",
        ],
      });
    }

    let m = path.match(/^\/ui\/([^/]+)$/);
    if (m) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      if (!authToken(env)) return missingConfig("TOKEN");
      if (!checkToken(decodeURIComponent(m[1]), authToken(env))) return unauthorized();
      return html(UI_HTML);
    }

    m = path.match(/^\/api\/v1\/report\/([^/]+)$/);
    if (m) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return report(request, env, decodeURIComponent(m[1]));
    }

    m = path.match(/^\/api\/v1\/nodes\/([^/]+)$/);
    if (m) {
      if (!authToken(env)) return missingConfig("TOKEN");
      if (!checkBearer(request, authToken(env))) return unauthorized();
      const machine = decodeURIComponent(m[1]);
      if (!MACHINE_RE.test(machine)) return json({ ok: false, error: "invalid machine name" }, 400);
      if (request.method === "GET") return getNodeConfig(env, machine);
      if (request.method === "PUT") return putNodeConfig(request, env, machine);
      return methodNotAllowed("GET, PUT");
    }

    m = path.match(/^\/api\/v1\/machines\/([^/]+)\/reset$/);
    if (m) {
      if (!authToken(env)) return missingConfig("TOKEN");
      if (!checkBearer(request, authToken(env))) return unauthorized();
      if (request.method !== "POST") return methodNotAllowed("POST");
      return resetMachine(env, decodeURIComponent(m[1]));
    }

    m = path.match(/^\/api\/v1\/machines\/order$/);
    if (m) {
      if (!authToken(env)) return missingConfig("TOKEN");
      if (!checkBearer(request, authToken(env))) return unauthorized();
      if (request.method === "GET") return json({ ok: true, machine_order: await getMachineOrder(env) });
      if (request.method !== "PUT") return methodNotAllowed("GET, PUT");
      return putMachineOrder(request, env);
    }

    m = path.match(/^\/api\/v1\/machines(?:\/([^/]+))?$/);
    if (m) {
      if (!authToken(env)) return missingConfig("TOKEN");
      if (!checkBearer(request, authToken(env))) return unauthorized();
      if (request.method === "GET" && !m[1]) return listMachines(env);
      if (request.method === "DELETE" && m[1]) return deleteMachine(env, decodeURIComponent(m[1]));
      return methodNotAllowed("GET, DELETE");
    }

    m = path.match(/^\/sub\/all\/([^/]+)$/);
    if (m) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return getAll(env, decodeURIComponent(m[1]), request);
    }

    m = path.match(/^\/sub\/([^/]+)$/);
    if (m) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return getAll(env, decodeURIComponent(m[1]), request);
    }

    m = path.match(/^\/sub\/([^/]+)\/([^/]+)$/);
    if (m) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return getOne(env, decodeURIComponent(m[1]), decodeURIComponent(m[2]), request);
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};

function authToken(env) { return (env && env.TOKEN) || ""; }
function baseUrl(request) { return new URL(request.url).origin; }

async function report(request, env, machine) {
  if (!authToken(env)) return missingConfig("TOKEN");
  if (!checkBearer(request, authToken(env))) return unauthorized();
  if (!MACHINE_RE.test(machine)) return json({ ok: false, error: "invalid machine name" }, 400);

  const body = await request.text();
  if (body.length > MAX_BODY) return json({ ok: false, error: "subscription too large" }, 413);
  const content = body.replace(/\s+/g, "");
  if (!content || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) return json({ ok: false, error: "body must be base64 text" }, 400);
  let decoded;
  try { decoded = decodeBase64(content); } catch { return json({ ok: false, error: "invalid base64" }, 400); }

  const key = `sub:${machine}`;
  const hash = await sha256Hex(content);
  const old = await env.SUBS.get(key, { type: "json" });
  if (old && old.hash === hash && !old.manual) {
    return json({ ok: true, changed: false, machine, bytes: content.length, hash, updated_at: old.updated_at });
  }
  const links = splitLinks(decoded);
  const nodes = old && old.manual && Array.isArray(old.nodes)
    ? old.nodes
    : await normalizeNodes(links, old && Array.isArray(old.nodes) ? old.nodes : []);
  const updatedAt = new Date().toISOString();
  const record = { machine, content, hash, bytes: content.length, updated_at: updatedAt, nodes, manual: Boolean(old && old.manual) };
  await env.SUBS.put(key, JSON.stringify(record));
  return json({ ok: true, changed: true, machine, bytes: content.length, hash, nodes: nodes.length, manual: record.manual, updated_at: updatedAt });
}

async function getOne(env, machine, token, request) {
  if (!authToken(env)) return missingConfig("TOKEN");
  if (!checkToken(token, authToken(env))) return unauthorized();
  if (!MACHINE_RE.test(machine)) return json({ ok: false, error: "invalid machine name" }, 400);
  const record = await env.SUBS.get(`sub:${machine}`, { type: "json" });
  if (!record) return json({ ok: false, error: "subscription not found" }, 404);
  const nodes = await nodesOf(record);
  return subResponse(nodes, request, { "x-machine": machine, "x-updated-at": record.updated_at });
}

async function getAll(env, token, request) {
  if (!authToken(env)) return missingConfig("TOKEN");
  if (!checkToken(token, authToken(env))) return unauthorized();
  const list = await env.SUBS.list({ prefix: "sub:" });
  const order = await getMachineOrder(env);
  const rank = new Map(order.map((m, i) => [m, i]));
  const all = [];
  let manual = 0;
  for (const key of list.keys) {
    const record = await env.SUBS.get(key.name, { type: "json" });
    if (!record) continue;
    if (record.manual) manual++;
    const nodes = await nodesOf(record);
    nodes.forEach((n) => all.push({ ...n, machine: record.machine }));
  }
  all.sort((a, b) => {
    const ar = rank.has(a.machine) ? rank.get(a.machine) : defaultMachineRank(a.machine);
    const br = rank.has(b.machine) ? rank.get(b.machine) : defaultMachineRank(b.machine);
    return ar - br || (Number(a._sort) || 0) - (Number(b._sort) || 0) || String(a.machine).localeCompare(String(b.machine)) || String(a.name).localeCompare(String(b.name));
  });
  return subResponse(all, request, { "x-machines": String(list.keys.length), "x-nodes": String(all.length), "x-manual-machines": String(manual), "x-machine-order": order.join(",") });
}

async function getNodeConfig(env, machine) {
  const record = await env.SUBS.get(`sub:${machine}`, { type: "json" });
  if (!record) return json({ ok: true, machine, nodes: [], manual: false });
  return json({ ok: true, machine, manual: Boolean(record.manual), updated_at: record.updated_at, nodes: await nodesOf(record) });
}

async function putNodeConfig(request, env, machine) {
  const body = await request.text();
  if (body.length > MAX_BODY) return json({ ok: false, error: "config too large" }, 413);
  let data;
  try { data = JSON.parse(body); } catch { return json({ ok: false, error: "invalid json" }, 400); }
  if (!data || !Array.isArray(data.nodes)) return json({ ok: false, error: "nodes must be an array" }, 400);
  if (data.nodes.length > 500) return json({ ok: false, error: "too many nodes" }, 400);
  const inputs = [];
  for (const item of data.nodes) {
    if (!item || typeof item.link !== "string") return json({ ok: false, error: "each node needs link" }, 400);
    const link = item.link.trim();
    if (!link || link.length > 8192 || !parseLink(link)) return json({ ok: false, error: "invalid node link" }, 400);
    inputs.push({ link, name: typeof item.name === "string" ? item.name.trim().slice(0, 160) : "" });
  }
  const old = await env.SUBS.get(`sub:${machine}`, { type: "json" });
  const nodes = await normalizeNodes(inputs.map((x) => x.link), old && Array.isArray(old.nodes) ? old.nodes : [], inputs);
  const content = encodeBase64(nodes.map((n) => n.link).join("\n"));
  const record = { machine, content, hash: await sha256Hex(content), bytes: content.length, updated_at: new Date().toISOString(), nodes, manual: true };
  await env.SUBS.put(`sub:${machine}`, JSON.stringify(record));
  return json({ ok: true, machine, manual: true, nodes });
}

async function resetMachine(env, machine) {
  if (!MACHINE_RE.test(machine)) return json({ ok: false, error: "invalid machine name" }, 400);
  const old = await env.SUBS.get(`sub:${machine}`, { type: "json" });
  if (!old) return json({ ok: false, error: "subscription not found" }, 404);
  const nodes = await normalizeNodes(splitLinks(decodeSafe(old.content)), []);
  const record = { ...old, nodes, manual: false, updated_at: new Date().toISOString() };
  await env.SUBS.put(`sub:${machine}`, JSON.stringify(record));
  return json({ ok: true, machine, manual: false, nodes });
}

async function listMachines(env) {
  const list = await env.SUBS.list({ prefix: "sub:" });
  const order = await getMachineOrder(env);
  const rank = new Map(order.map((m, i) => [m, i]));
  const machines = [];
  for (const key of list.keys) {
    const record = await env.SUBS.get(key.name, { type: "json" });
    if (!record) continue;
    const nodes = await nodesOf(record);
    machines.push({ machine: record.machine, bytes: record.bytes, updated_at: record.updated_at, hash: record.hash, manual: Boolean(record.manual), nodes: nodes.length });
  }
  machines.sort((a, b) => {
    const ar = rank.has(a.machine) ? rank.get(a.machine) : defaultMachineRank(a.machine);
    const br = rank.has(b.machine) ? rank.get(b.machine) : defaultMachineRank(b.machine);
    return ar - br || a.machine.localeCompare(b.machine);
  });
  return json({ ok: true, count: machines.length, machines, machine_order: order });
}

function defaultMachineRank(machine) {
  const m = String(machine || "").toLowerCase();
  if (/^hk(?:-|$)/.test(m)) return 10;
  if (/^kr(?:-|$)/.test(m)) return 20;
  if (/^jp(?:-|$)/.test(m)) return 30;
  if (/^sg(?:-|$)/.test(m)) return 40;
  if (/^(in|my|dxb|il|pk|bd|lk|np|th|vn|ph|id|kz|ae|qa|sa|tr)(?:-|$)/.test(m)) return 50;
  if (/^us(?:-|$)/.test(m) || m === "phx-amd") return 60;
  if (/^de(?:-|$)/.test(m)) return 70;
  if (/^(nl|uk|fr|fra|fi|se|no|dk|pl|cz|at|ch|be|es|it|pt|ie|ro|bg|gr|hu|lt|lv|ee)(?:-|$)/.test(m)) return 80;
  if (/^(ca|mx|br|ar|cl|pe|co)(?:-|$)/.test(m)) return 90;
  return 100;
}

async function getMachineOrder(env) {
  const raw = await env.SUBS.get("meta:machine_order", { type: "json" });
  return Array.isArray(raw) ? raw.filter((x) => typeof x === "string" && MACHINE_RE.test(x)) : [];
}

async function putMachineOrder(request, env) {
  const body = await request.text();
  if (body.length > 65536) return json({ ok: false, error: "order too large" }, 413);
  let data;
  try { data = JSON.parse(body); } catch { return json({ ok: false, error: "invalid json" }, 400); }
  if (!data || !Array.isArray(data.machines)) return json({ ok: false, error: "machines must be an array" }, 400);
  const unique = [];
  for (const item of data.machines) {
    if (typeof item !== "string" || !MACHINE_RE.test(item)) return json({ ok: false, error: "invalid machine name" }, 400);
    if (!unique.includes(item)) unique.push(item);
  }
  await env.SUBS.put("meta:machine_order", JSON.stringify(unique));
  return json({ ok: true, machine_order: unique });
}

async function deleteMachine(env, machine) {
  if (!MACHINE_RE.test(machine)) return json({ ok: false, error: "invalid machine name" }, 400);
  await env.SUBS.delete(`sub:${machine}`);
  const order = await getMachineOrder(env);
  if (order.includes(machine)) await env.SUBS.put("meta:machine_order", JSON.stringify(order.filter((m) => m !== machine)));
  return json({ ok: true, deleted: machine });
}

async function nodesOf(record) {
  let nodes;
  if (record && Array.isArray(record.nodes) && record.nodes.length) {
    nodes = record.nodes.slice();
  } else {
    nodes = await normalizeNodes(splitLinks(record && record.content ? decodeSafe(record.content) : ""), []);
  }
  nodes.sort((a, b) => {
    if (record && record.manual) return (Number(a.order) || 0) - (Number(b.order) || 0);
    return protocolRank(a) - protocolRank(b) || (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.name).localeCompare(String(b.name));
  });
  return nodes.map((n, i) => ({ ...n, _sort: i }));
}

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

/* ---------------- link parsing ---------------- */

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
    const base = { kind, server, port, name: fragment || `${kind.toUpperCase()}-${server}`, insecure: isInsecure(q) };
    if (kind === "vless") {
      const security = (q.get("security") || "").toLowerCase();
      return { ...base, uuid: safeDecode(u.username), tls: security === "tls" || security === "reality", reality: security === "reality", sni: q.get("sni") || q.get("serverName") || "", flow: q.get("flow") || "", network: q.get("type") || "tcp", path: q.get("path") || "", host: q.get("host") || "", pbk: q.get("pbk") || "", sid: q.get("sid") || "", fp: q.get("fp") || "chrome" };
    }
    if (kind === "anytls") return { ...base, password: safeDecode(u.username), tls: true, sni: q.get("sni") || "" };
    if (kind === "hysteria2" || kind === "hy2") return { ...base, kind: "hy2", password: safeDecode(u.username), tls: true, sni: q.get("sni") || "", obfs: q.get("obfs") || "", obfsPassword: q.get("obfs-password") || "" };
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
    return { kind: "vmess", server: j.add, port, name: j.ps || `VMess-${j.add}`, uuid: j.id, alterId: Number(j.aid || 0), cipher: j.scy || "auto", tls: String(j.tls || "") === "tls", sni: j.sni || j.host || "", network: j.net || "tcp", path: j.path || "", host: j.host || "", insecure: false };
  } catch { return null; }
}

function isInsecure(q) {
  const v = (q.get("allow_insecure") || q.get("allowInsecure") || q.get("insecure") || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || q.has("pinSHA256");
}

/* ---------------- subscription formats ---------------- */

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
  let body;
  let type = "text/plain; charset=utf-8";
  if (format === "clash") { body = toClash(nodes); type = "text/yaml; charset=utf-8"; }
  else if (format === "singbox") { body = toSingbox(nodes); type = "application/json; charset=utf-8"; }
  else body = encodeBase64(nodes.map((n) => n.link).join("\n"));
  return new Response(body, {
    headers: { ...corsHeaders(), "content-type": type, "cache-control": "no-store, max-age=0", "profile-update-interval": "6", ...(extraHeaders || {}) },
  });
}

function yamlString(value) { return JSON.stringify(String(value == null ? "" : value)); }

function toClash(nodes) {
  const lines = ["proxies:"];
  for (const node of nodes) {
    const p = node.proxy || parseLink(node.link);
    if (!p) continue;
    lines.push(`  - name: ${yamlString(node.name || p.name)}`);
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
      }
      if (p.reality && p.pbk) {
        lines.push("    reality-opts:");
        lines.push(`      public-key: ${yamlString(p.pbk)}`);
        if (p.sid) lines.push(`      short-id: ${yamlString(p.sid)}`);
        lines.push(`    client-fingerprint: ${yamlString(p.fp || "chrome")}`);
      }
      if (p.insecure) lines.push("    skip-cert-verify: true");
    } else if (p.kind === "anytls") {
      lines.push(`    password: ${yamlString(p.password)}`);
      if (p.sni) lines.push(`    sni: ${yamlString(p.sni)}`);
      if (p.insecure) lines.push("    skip-cert-verify: true");
    } else if (p.kind === "hy2") {
      lines.push(`    password: ${yamlString(p.password)}`);
      if (p.sni) lines.push(`    sni: ${yamlString(p.sni)}`);
      lines.push("    alpn:"); lines.push("      - h3");
      if (p.insecure) lines.push("    skip-cert-verify: true");
    } else if (p.kind === "tuic") {
      lines.push(`    uuid: ${yamlString(p.uuid)}`);
      lines.push(`    password: ${yamlString(p.password)}`);
      if (p.sni) lines.push(`    sni: ${yamlString(p.sni)}`);
      lines.push("    alpn:"); lines.push("      - h3");
      lines.push("    congestion-controller: bbr");
      lines.push("    udp-relay-mode: native");
      if (p.insecure) lines.push("    skip-cert-verify: true");
    } else if (p.kind === "trojan") {
      lines.push(`    password: ${yamlString(p.password)}`);
      if (p.sni) lines.push(`    sni: ${yamlString(p.sni)}`);
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
      }
    }
  }
  return lines.join("\n") + "\n";
}

function toSingbox(nodes) {
  const outbounds = [];
  for (const node of nodes) {
    const p = node.proxy || parseLink(node.link);
    if (!p) continue;
    const tag = node.name || p.name;
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
      }
      outbounds.push(o);
    } else if (p.kind === "anytls") {
      outbounds.push({ type: "anytls", tag, server: p.server, server_port: p.port, password: p.password, tls });
    } else if (p.kind === "hy2") {
      outbounds.push({ type: "hysteria2", tag, server: p.server, server_port: p.port, password: p.password, tls });
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
      }
      outbounds.push(o);
    }
  }
  return JSON.stringify({ outbounds }, null, 2);
}

/* ---------------- auth / encoding ---------------- */

function checkBearer(request, expected) {
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? checkToken(m[1].trim(), expected) : false;
}
function checkToken(actual, expected) {
  if (!expected || typeof actual !== "string" || actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
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
  return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type", "x-content-type-options": "nosniff" };
}
