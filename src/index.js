/**
 * sub-worker
 *
 * 固定订阅入口 + 多机器自动上报：
 *   POST /api/v1/report/:machine   Bearer TOKEN，body 为 base64 订阅
 *   GET  /sub/:machine/:token      读取单机订阅（text/plain，base64，token=TOKEN）
 *   GET  /sub/all/:token           合并所有机器订阅（base64，token=TOKEN）
 *   GET  /api/v1/machines          Bearer TOKEN，查看已上报机器
 *   DELETE /api/v1/machines/:machine Bearer TOKEN，删除
 *   GET  /health                   健康检查
 *
 * KV:
 *   sub:<machine> -> { machine, content, hash, bytes, updated_at }
 */

const VERSION = "1.0.0";
const MAX_BODY = 512 * 1024;
const MACHINE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// 变量模式：只需要一个 TOKEN（Secret），上报和读取共用。
// 对外域名不配置：直接取当前请求的 origin，自动适配 workers.dev 或自定义域名。
function authToken(env) {
  return (env && env.TOKEN) || "";
}

function baseUrl(request) {
  return new URL(request.url).origin;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === "GET" && path === "/health") {
      return json({ ok: true, version: VERSION, time: new Date().toISOString() });
    }

    if (request.method === "GET" && path === "/") {
      return json({
        name: "sub-worker",
        version: VERSION,
        subscription_base: baseUrl(request),
        endpoints: [
          "POST /api/v1/report/:machine",
          "GET /sub/:machine/:token",
          "GET /sub/all/:token",
          "GET /api/v1/machines",
          "GET /health",
        ],
      });
    }

    // /api/v1/report/:machine
    let m = path.match(/^\/api\/v1\/report\/([^/]+)$/);
    if (m) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return report(request, env, decodeURIComponent(m[1]));
    }

    // /api/v1/machines 或 /api/v1/machines/:machine
    m = path.match(/^\/api\/v1\/machines(?:\/([^/]+))?$/);
    if (m) {
      if (!authToken(env)) return missingConfig("TOKEN");
      if (!checkBearer(request, authToken(env))) return unauthorized();
      if (request.method === "GET" && !m[1]) return listMachines(env);
      if (request.method === "DELETE" && m[1]) return deleteMachine(env, decodeURIComponent(m[1]));
      return methodNotAllowed("GET, DELETE");
    }

    // /sub/all/:token 必须放在 /sub/:machine/:token 之前判断
    m = path.match(/^\/sub\/all\/([^/]+)$/);
    if (m) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return getAll(env, decodeURIComponent(m[1]));
    }

    // /sub/:token 全部机器合并（去掉链接里的 /all 后的简写）
    m = path.match(/^\/sub\/([^/]+)$/);
    if (m) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return getAll(env, decodeURIComponent(m[1]));
    }

    // /sub/:machine/:token
    m = path.match(/^\/sub\/([^/]+)\/([^/]+)$/);
    if (m) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return getOne(env, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};

async function report(request, env, machine) {
  if (!authToken(env)) return missingConfig("TOKEN");
  if (!checkBearer(request, authToken(env))) return unauthorized();
  if (!MACHINE_RE.test(machine)) {
    return json({ ok: false, error: "invalid machine name" }, 400);
  }

  const body = await request.text();
  if (body.length > MAX_BODY) {
    return json({ ok: false, error: "subscription too large" }, 413);
  }
  const content = body.replace(/\s+/g, "");
  if (!content || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
    return json({ ok: false, error: "body must be base64 text" }, 400);
  }
  try {
    atob(content);
  } catch {
    return json({ ok: false, error: "invalid base64" }, 400);
  }

  const key = `sub:${machine}`;
  const hash = await sha256Hex(content);
  const old = await env.SUBS.get(key, { type: "json" });
  if (old && old.hash === hash) {
    return json({
      ok: true,
      changed: false,
      machine,
      bytes: content.length,
      hash,
      updated_at: old.updated_at,
    });
  }

  const updatedAt = new Date().toISOString();
  const record = {
    machine,
    content,
    hash,
    bytes: content.length,
    updated_at: updatedAt,
  };
  await env.SUBS.put(key, JSON.stringify(record));
  return json({
    ok: true,
    changed: true,
    machine,
    bytes: content.length,
    hash,
    updated_at: updatedAt,
  });
}

async function getOne(env, machine, token) {
  if (!authToken(env)) return missingConfig("TOKEN");
  if (!checkToken(token, authToken(env))) return unauthorized();
  if (!MACHINE_RE.test(machine)) return json({ ok: false, error: "invalid machine name" }, 400);
  const record = await env.SUBS.get(`sub:${machine}`, { type: "json" });
  if (!record) return json({ ok: false, error: "subscription not found" }, 404);
  return new Response(record.content, {
    headers: {
      ...corsHeaders(),
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-machine": machine,
      "x-updated-at": record.updated_at,
    },
  });
}

async function getAll(env, token) {
  if (!authToken(env)) return missingConfig("TOKEN");
  if (!checkToken(token, authToken(env))) return unauthorized();
  const list = await env.SUBS.list({ prefix: "sub:" });
  const parts = [];
  for (const key of list.keys) {
    const record = await env.SUBS.get(key.name, { type: "json" });
    if (!record || !record.content) continue;
    try {
      parts.push(decodeBase64(record.content));
    } catch {
      // 单条损坏不影响其它机器
    }
  }
  const merged = parts.join("\n").trim();
  const content = encodeBase64(merged);
  return new Response(content, {
    headers: {
      ...corsHeaders(),
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-machines": String(parts.length),
      "x-updated-at": new Date().toISOString(),
    },
  });
}

async function listMachines(env) {
  const list = await env.SUBS.list({ prefix: "sub:" });
  const machines = [];
  for (const key of list.keys) {
    const record = await env.SUBS.get(key.name, { type: "json" });
    if (!record) continue;
    machines.push({
      machine: record.machine,
      bytes: record.bytes,
      updated_at: record.updated_at,
      hash: record.hash,
    });
  }
  machines.sort((a, b) => a.machine.localeCompare(b.machine));
  return json({ ok: true, count: machines.length, machines });
}

async function deleteMachine(env, machine) {
  if (!MACHINE_RE.test(machine)) return json({ ok: false, error: "invalid machine name" }, 400);
  await env.SUBS.delete(`sub:${machine}`);
  return json({ ok: true, deleted: machine });
}

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
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), "content-type": "application/json; charset=utf-8" },
  });
}

function unauthorized() {
  return json({ ok: false, error: "unauthorized" }, 401);
}

function missingConfig(name) {
  return json({ ok: false, error: `${name} is not configured` }, 500);
}

function methodNotAllowed(allow) {
  return new Response(JSON.stringify({ ok: false, error: "method not allowed" }), {
    status: 405,
    headers: { ...corsHeaders(), "content-type": "application/json; charset=utf-8", allow },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type",
    "x-content-type-options": "nosniff",
  };
}
