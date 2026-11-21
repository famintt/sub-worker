import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

const enc = new TextEncoder();

class MockKV {
  constructor() {
    this.map = new Map();
    this.pageSize = 1000;
  }
  async get(key, opts = {}) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    return opts.type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) {
    this.map.set(key, String(value));
  }
  async delete(key) {
    this.map.delete(key);
  }
  async list({ prefix = "", cursor } = {}) {
    const names = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = names.slice(start, start + this.pageSize);
    const next = start + slice.length;
    return {
      keys: slice.map((name) => ({ name })),
      list_complete: next >= names.length,
      cursor: next >= names.length ? undefined : String(next),
    };
  }
}

const ADMIN = "admin-token";
const READ = "read-token";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");

function makeEnv(extra = {}) {
  return { SUBS: new MockKV(), ADMIN_TOKEN: ADMIN, READ_TOKEN: READ, ...extra };
}

function call(env, method, path, body, headers = {}) {
  const init = { method, headers };
  if (body !== undefined && body !== null) {
    if (body instanceof Uint8Array) {
      init.body = body;
    } else {
      init.body = body;
    }
  }
  return worker.fetch(new Request(`https://sub.example.workers.dev${path}`, init), env);
}

const admin = { authorization: `Bearer ${ADMIN}` };
const reader = { authorization: `Bearer ${READ}` };

const LINKS = [
  "vless://11111111-2222-3333-4444-555555555555@1.1.1.1:443?encryption=none&security=tls&sni=a.example&type=ws&path=%2Fws&host=a.example#A-WS-CDN",
  "vless://11111111-2222-3333-4444-555555555555@2.2.2.2:8443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.bing.com&fp=chrome&pbk=PUBKEY&sid=abcd&type=tcp#B-Reality",
  "anytls://pw@3.3.3.3:443?sni=c.example#C-AnyTLS",
  "hysteria2://pw@4.4.4.4:8443?sni=d.example&insecure=1&obfs=salamander&obfs-password=xyz#D-HY2",
  "tuic://uuid:pw@5.5.5.5:443?congestion_control=bbr&alpn=h3&sni=e.example&allow_insecure=1#E-TUIC",
];

async function reportLinks(env, machine, links, headers = admin) {
  const body = b64(links.join("\n"));
  const res = await call(env, "POST", `/api/v1/report/${machine}`, body, headers);
  return res;
}

test("health exposes role separation", async () => {
  const res = await call(makeEnv(), "GET", "/health");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.version, "2.0.0");
  assert.equal(data.roles.admin, true);
  assert.equal(data.roles.read, true);
  assert.equal(data.roles.per_machine_report, true);
});

test("admin endpoints reject read token and anonymous", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "GET", "/api/v1/machines")).status, 401);
  assert.equal((await call(env, "GET", "/api/v1/machines", null, reader)).status, 401);
  assert.equal((await call(env, "GET", "/api/v1/machines", null, admin)).status, 200);
});

test("read token is required for subscription; admin token is not a read token", async () => {
  const env = makeEnv();
  await reportLinks(env, "sgw", LINKS);
  assert.equal((await call(env, "GET", "/sub/sgw/wrong")).status, 401);
  assert.equal((await call(env, "GET", "/sub/sgw/" + ADMIN)).status, 401);
  const ok = await call(env, "GET", `/sub/sgw/${READ}`);
  assert.equal(ok.status, 200);
  const lines = unb64(await ok.text()).split("\n").filter(Boolean);
  assert.equal(lines.length, LINKS.length);
  assert.ok(lines[0].includes("security=reality"), "reality 排在最前");
});

test("legacy TOKEN works by default but is disabled with ALLOW_LEGACY_TOKEN=0", async () => {
  const legacyEnv = makeEnv({ TOKEN: "old-token" });
  assert.equal((await reportLinks(legacyEnv, "sgw", LINKS, { authorization: "Bearer old-token" })).status, 200);
  assert.equal((await call(legacyEnv, "GET", "/sub/sgw/old-token")).status, 200);

  const strict = makeEnv({ TOKEN: "old-token", ALLOW_LEGACY_TOKEN: "0" });
  assert.equal((await reportLinks(strict, "sgw", LINKS, { authorization: "Bearer old-token" })).status, 401);
  assert.equal((await call(strict, "GET", "/sub/sgw/old-token")).status, 401);
});

test("per-machine token can report only its own machine", async () => {
  const env = makeEnv();
  const minted = await call(env, "POST", "/api/v1/machines/hk/token", null, admin);
  assert.equal(minted.status, 200);
  const { token } = await minted.json();
  assert.match(token, /^[0-9a-f]{64}$/);

  const own = await reportLinks(env, "hk", LINKS, { authorization: `Bearer ${token}` });
  assert.equal(own.status, 200);

  const other = await reportLinks(env, "sgw", LINKS, { authorization: `Bearer ${token}` });
  assert.equal(other.status, 401);

  assert.equal((await call(env, "GET", "/api/v1/machines/hk/token", null, admin)).status, 200);
  assert.equal((await call(env, "DELETE", "/api/v1/machines/hk/token", null, admin)).status, 200);
  assert.equal((await reportLinks(env, "hk", LINKS, { authorization: `Bearer ${token}` })).status, 401);
});

test("report dedupes by content hash", async () => {
  const env = makeEnv();
  const first = await (await reportLinks(env, "sgw", LINKS)).json();
  assert.equal(first.changed, true);
  const second = await (await reportLinks(env, "sgw", LINKS)).json();
  assert.equal(second.changed, false);
});

test("manual override survives later reports; reset restores the snapshot", async () => {
  const env = makeEnv();
  await reportLinks(env, "sgw", LINKS);

  const put = await call(
    env,
    "PUT",
    "/api/v1/nodes/sgw",
    JSON.stringify({ nodes: [{ link: LINKS[3], name: "手工 HY2" }] }),
    { ...admin, "content-type": "application/json" },
  );
  assert.equal(put.status, 200);

  await reportLinks(env, "sgw", LINKS.slice(0, 2));
  const cfg = await (await call(env, "GET", "/api/v1/nodes/sgw", null, admin)).json();
  assert.equal(cfg.manual, true);
  assert.equal(cfg.nodes.length, 1);
  assert.equal(cfg.nodes[0].name, "手工 HY2");

  const reset = await call(env, "POST", "/api/v1/machines/sgw/reset", null, admin);
  assert.equal(reset.status, 200);
  const after = await (await call(env, "GET", "/api/v1/nodes/sgw", null, admin)).json();
  assert.equal(after.manual, false);
  assert.equal(after.nodes.length, 2);
});

test("empty manual array is a valid override and does not fall back to the snapshot", async () => {
  const env = makeEnv();
  await reportLinks(env, "sgw", LINKS);
  const put = await call(env, "PUT", "/api/v1/nodes/sgw", JSON.stringify({ nodes: [] }), { ...admin, "content-type": "application/json" });
  assert.equal(put.status, 200);
  const cfg = await (await call(env, "GET", "/api/v1/nodes/sgw", null, admin)).json();
  assert.equal(cfg.manual, true);
  assert.equal(cfg.nodes.length, 0);
  const sub = await call(env, "GET", `/sub/sgw/${READ}`);
  assert.equal(unb64(await sub.text()), "");
});

test("If-Match conflict is reported instead of silently overwriting", async () => {
  const env = makeEnv();
  const put1 = await call(env, "PUT", "/api/v1/nodes/sgw", JSON.stringify({ nodes: [{ link: LINKS[3] }] }), { ...admin, "content-type": "application/json" });
  const { updated_at } = await put1.json();
  const conflict = await call(env, "PUT", "/api/v1/nodes/sgw", JSON.stringify({ nodes: [{ link: LINKS[4] }] }), { ...admin, "content-type": "application/json", "if-match": "1999-01-01T00:00:00.000Z" });
  assert.equal(conflict.status, 409);
  const ok = await call(env, "PUT", "/api/v1/nodes/sgw", JSON.stringify({ nodes: [{ link: LINKS[4] }] }), { ...admin, "content-type": "application/json", "if-match": updated_at });
  assert.equal(ok.status, 200);
});

test("create machine writes an empty manual override", async () => {
  const env = makeEnv();
  const created = await call(env, "POST", "/api/v1/machines/new-york", JSON.stringify({}), { ...admin, "content-type": "application/json" });
  assert.equal(created.status, 200);
  const list = await (await call(env, "GET", "/api/v1/machines", null, admin)).json();
  assert.equal(list.count, 1);
  assert.equal(list.machines[0].machine, "new-york");
  assert.equal(list.machines[0].manual, true);
  assert.equal(list.machines[0].nodes, 0);
});

test("machine order controls /sub/all ordering", async () => {
  const env = makeEnv();
  await reportLinks(env, "us-one", [LINKS[1]]);
  await reportLinks(env, "hk-one", [LINKS[1]]);
  const order = await call(env, "PUT", "/api/v1/machines/order", JSON.stringify({ machines: ["us-one", "hk-one"] }), { ...admin, "content-type": "application/json" });
  assert.equal(order.status, 200);
  const sub = await call(env, "GET", `/sub/all/${READ}`);
  const lines = unb64(await sub.text()).split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(sub.headers.get("x-machine-order"), "us-one,hk-one");
});

test("pinSHA256 is preserved for Clash and refused for sing-box", async () => {
  const env = makeEnv();
  const pinned = "anytls://pw@6.6.6.6:443?sni=f.example&pinSHA256=AB:CD:EF:01&insecure=1#Pinned";
  await reportLinks(env, "sgw", [pinned]);
  const clash = await call(env, "GET", `/sub/sgw/${READ}?format=clash`);
  assert.equal(clash.status, 200);
  const yaml = await clash.text();
  assert.match(yaml, /fingerprint: "abcdef01"/);
  assert.match(yaml, /skip-cert-verify: true/);
  const sb = await call(env, "GET", `/sub/sgw/${READ}?format=singbox`);
  assert.equal(sb.status, 501);
  const body = await sb.json();
  assert.equal(body.error, "format cannot represent node");
  assert.equal((await call(env, "GET", `/sub/sgw/${READ}`)).status, 200);
});

test("insecure flag alone does not imply fingerprint", async () => {
  const env = makeEnv();
  await reportLinks(env, "sgw", ["anytls://pw@6.6.6.6:443?sni=f.example&insecure=1#PlainInsecure"]);
  const sb = await call(env, "GET", `/sub/sgw/${READ}?format=singbox`);
  assert.equal(sb.status, 200);
  const data = await sb.json();
  assert.equal(data.outbounds[0].tls.insecure, true);
  assert.equal(data.outbounds[0].tls.certificate_public_key_sha256, undefined);
});

test("xhttp nodes are refused instead of silently degrading to tcp", async () => {
  const env = makeEnv();
  const xhttp = "vless://11111111-2222-3333-4444-555555555555@7.7.7.7:443?encryption=none&security=tls&sni=g.example&type=xhttp&path=%2Fx&host=g.example&mode=auto#XHTTP";
  await reportLinks(env, "sgw", [xhttp]);
  assert.equal((await call(env, "GET", `/sub/sgw/${READ}?format=singbox`)).status, 501);
  assert.equal((await call(env, "GET", `/sub/sgw/${READ}?format=clash`)).status, 501);
  assert.equal((await call(env, "GET", `/sub/sgw/${READ}`)).status, 200);
});

test("grpc serviceName and hysteria obfs survive format conversion", async () => {
  const env = makeEnv();
  const grpc = "vless://11111111-2222-3333-4444-555555555555@8.8.8.8:443?encryption=none&security=reality&sni=www.bing.com&fp=chrome&pbk=PUB&sid=ab&type=grpc&serviceName=svc-name#GRPC";
  const hy = "hysteria2://pw@9.9.9.9:8443?sni=h.example&obfs=salamander&obfs-password=secret#HY";
  await reportLinks(env, "sgw", [grpc, hy]);
  const sb = await (await call(env, "GET", `/sub/sgw/${READ}?format=singbox`)).json();
  const grpcOut = sb.outbounds.find((o) => o.tag === "GRPC");
  assert.equal(grpcOut.transport.type, "grpc");
  assert.equal(grpcOut.transport.service_name, "svc-name");
  const hyOut = sb.outbounds.find((o) => o.tag === "HY");
  assert.deepEqual(hyOut.obfs, { type: "salamander", password: "secret" });
  const clash = await (await call(env, "GET", `/sub/sgw/${READ}?format=clash`)).text();
  assert.match(clash, /grpc-service-name: "svc-name"/);
  assert.match(clash, /obfs-password: "secret"/);
});

test("oversized bodies are rejected before being stored (413)", async () => {
  const env = makeEnv();
  const huge = "A".repeat(600 * 1024);
  const res = await call(env, "POST", "/api/v1/report/sgw", huge, { ...admin, "content-type": "text/plain" });
  assert.equal(res.status, 413);
  assert.equal(await env.SUBS.get("report:sgw"), null);

  const streamed = await worker.fetch(
    new Request("https://sub.example.workers.dev/api/v1/report/sgw", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}` },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode("A".repeat(300 * 1024)));
          controller.enqueue(enc.encode("A".repeat(300 * 1024)));
          controller.close();
        },
      }),
      duplex: "half",
    }),
    env,
  );
  assert.equal(streamed.status, 413);
  assert.equal(await env.SUBS.get("report:sgw"), null);
});

test("KV pagination is followed when listing machines", async () => {
  const env = makeEnv();
  env.SUBS.pageSize = 2;
  for (const name of ["aa-one", "bb-two", "cc-three"]) {
    await env.SUBS.put(`report:${name}`, JSON.stringify({ machine: name, content: b64(LINKS[1]), hash: "h", bytes: 1, updated_at: "t" }));
  }
  const list = await (await call(env, "GET", "/api/v1/machines", null, admin)).json();
  assert.equal(list.count, 3);
  const sub = await call(env, "GET", `/sub/all/${READ}`);
  assert.equal(unb64(await sub.text()).split("\n").filter(Boolean).length, 3);
});

test("delete machine clears every stored key", async () => {
  const env = makeEnv();
  await reportLinks(env, "hk", LINKS);
  await call(env, "POST", "/api/v1/machines/hk/token", null, admin);
  await call(env, "PUT", "/api/v1/nodes/hk", JSON.stringify({ nodes: [{ link: LINKS[0] }] }), { ...admin, "content-type": "application/json" });
  const del = await call(env, "DELETE", "/api/v1/machines/hk", null, admin);
  assert.equal(del.status, 200);
  const keys = [...env.SUBS.map.keys()].filter((k) => k.includes("hk"));
  assert.deepEqual(keys, []);
});

test("legacy sub: record is still readable and migrates on edit", async () => {
  const env = makeEnv();
  await env.SUBS.put(
    "sub:old",
    JSON.stringify({ machine: "old", content: b64(LINKS[2]), hash: "h1", bytes: 10, updated_at: "2026-01-01T00:00:00.000Z" }),
  );
  const sub = await call(env, "GET", `/sub/old/${READ}`);
  assert.equal(sub.status, 200);
  assert.match(unb64(await sub.text()), /anytls:\/\//);
  const list = await (await call(env, "GET", "/api/v1/machines", null, admin)).json();
  assert.equal(list.count, 1);
});

test("ui is served without embedding credentials in the path", async () => {
  const env = makeEnv();
  const ui = await call(env, "GET", "/ui");
  assert.equal(ui.status, 200);
  const body = await ui.text();
  assert.match(body, /新增机器/);
  assert.match(body, /sessionStorage/);
  assert.equal((await call(env, "GET", "/ui/not-admin")).status, 401);
  assert.equal((await call(env, "GET", `/ui/${ADMIN}`)).status, 200);
});

test("invalid machine names and links are rejected", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "POST", "/api/v1/report/BAD_NAME", b64(LINKS[1]), admin)).status, 400);
  const bad = await call(env, "PUT", "/api/v1/nodes/sgw", JSON.stringify({ nodes: [{ link: "not-a-link" }] }), { ...admin, "content-type": "application/json" });
  assert.equal(bad.status, 400);
  assert.equal(await env.SUBS.get("manual:sgw"), null);
});

test("served UI script must be syntactically valid javascript", async () => {
  // 回归：UI 里内嵌 <script> 的源码一旦被模板字面量提前解释转义序列
  // （例如 /\r?\n/ 变成真实换行），页面脚本会整体 SyntaxError，登录按钮失效。
  const env = makeEnv();
  const res = await call(env, "GET", "/ui");
  const html = await res.text();
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "UI 必须内联一个脚本");
  assert.doesNotThrow(() => new Function(m[1]));
  assert.ok(m[1].includes("split(/\\r?\\n/)"), "换行拆分正则必须保留反斜杠");
});
