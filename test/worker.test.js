import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

class MockKV {
  constructor() {
    this.map = new Map();
  }
  async get(key, opts = {}) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    return opts.type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) {
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
  async list({ prefix = "" } = {}) {
    return {
      keys: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
    };
  }
}

const TOKEN = "test-token";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");

function makeEnv() {
  return { SUBS: new MockKV(), TOKEN };
}

function call(env, method, path, body, headers = {}) {
  return worker.fetch(
    new Request(`https://sub.example.workers.dev${path}`, {
      method,
      body,
      headers,
    }),
    env,
  );
}

test("health", async () => {
  const res = await call(makeEnv(), "GET", "/health");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
});

test("report requires auth and validates base64", async () => {
  const env = makeEnv();
  let res = await call(env, "POST", "/api/v1/report/sgw", b64("vless://x"));
  assert.equal(res.status, 401);

  res = await call(env, "POST", "/api/v1/report/sgw", "not base64!", {
    authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(res.status, 400);
});

test("report, dedupe, read and list", async () => {
  const env = makeEnv();
  const body = b64("vless://one\nanytls://two");
  let res = await call(env, "POST", "/api/v1/report/sgw", body, {
    authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(res.status, 200);
  let data = await res.json();
  assert.equal(data.changed, true);

  res = await call(env, "POST", "/api/v1/report/sgw", body, {
    authorization: `Bearer ${TOKEN}`,
  });
  data = await res.json();
  assert.equal(data.changed, false);

  res = await call(env, "GET", `/sub/sgw/${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(unb64(await res.text()), "anytls://two\nvless://one");

  res = await call(env, "GET", `/sub/sgw/wrong`);
  assert.equal(res.status, 401);

  res = await call(env, "GET", `/api/v1/machines`, null, {
    authorization: `Bearer ${TOKEN}`,
  });
  data = await res.json();
  assert.equal(data.count, 1);
  assert.equal(data.machines[0].machine, "sgw");
});

test("missing variables return config error", async () => {
  const env = { SUBS: new MockKV() };
  let res = await call(env, "POST", "/api/v1/report/cfg", b64("vless://x"), {
    authorization: "Bearer anything",
  });
  assert.equal(res.status, 500);
  res = await call(env, "GET", "/sub/cfg/anything");
  assert.equal(res.status, 500);
});

test("special characters in TOKEN work when URL-encoded", async () => {
  const env = { SUBS: new MockKV(), TOKEN: "a+b=c" };
  const body = b64("vless://special");
  let res = await call(env, "POST", "/api/v1/report/special", body, {
    authorization: "Bearer a+b=c",
  });
  assert.equal(res.status, 200);
  res = await call(env, "GET", "/sub/special/a%2Bb%3Dc");
  assert.equal(res.status, 200);
  assert.equal(unb64(await res.text()), "vless://special");
});

test("all merges machines and delete works", async () => {
  const env = makeEnv();
  for (const [machine, text] of [
    ["sgw", "vless://a"],
    ["sjc", "vless://b"],
  ]) {
    const res = await call(env, "POST", `/api/v1/report/${machine}`, b64(text), {
      authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(res.status, 200);
  }
  let res = await call(env, "GET", `/sub/all/${TOKEN}`);
  const merged = unb64(await res.text());
  assert.match(merged, /vless:\/\/a/);
  assert.match(merged, /vless:\/\/b/);

  res = await call(env, "GET", `/sub/${TOKEN}`);
  const shortMerged = unb64(await res.text());
  assert.match(shortMerged, /vless:\/\/a/);
  assert.match(shortMerged, /vless:\/\/b/);

  res = await call(env, "DELETE", "/api/v1/machines/sgw", null, {
    authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(res.status, 200);
  res = await call(env, "GET", `/sub/sgw/${TOKEN}`);
  assert.equal(res.status, 404);
});

const SAMPLE_LINKS = [
  "vless://11111111-1111-4111-8111-111111111111@example.com:443?security=reality&sni=pypi.org&pbk=abc123&sid=deadbeef&fp=chrome&flow=xtls-rprx-vision&type=tcp#Reality-Node",
  "anytls://secret@example.org:8443?sni=rubygems.org&insecure=1#AnyTLS-Node",
  "tuic://22222222-2222-4222-8222-222222222222:pass@example.net:443?sni=deb.debian.org&allow_insecure=1#TUIC-Node",
  "hysteria2://hysecret@example.io:443?sni=addons.mozilla.org&insecure=1#HY2-Node",
];

test("webui is served with token auth", async () => {
  const env = makeEnv();
  let res = await call(env, "GET", `/ui/${TOKEN}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /connect-src 'self'/);
  const page = await res.text();
  assert.match(page, /节点管理/);
  assert.match(page, /机器排序/);
  assert.match(page, /background:#ffffff/);

  res = await call(env, "GET", "/ui/wrong");
  assert.equal(res.status, 401);
});

test("machine order controls merged subscription order", async () => {
  const env = makeEnv();
  for (const [machine, text] of [
    ["machine-a", "vless://a"],
    ["machine-b", "tuic://b"],
    ["machine-c", "anytls://c"],
  ]) {
    const res = await call(env, "POST", `/api/v1/report/${machine}`, b64(text), {
      authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(res.status, 200);
  }
  let res = await call(env, "PUT", "/api/v1/machines/order", JSON.stringify({ machines: ["machine-c", "machine-a", "machine-b"] }), {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  });
  assert.equal(res.status, 200);

  res = await call(env, "GET", "/api/v1/machines", null, { authorization: `Bearer ${TOKEN}` });
  const data = await res.json();
  assert.deepEqual(data.machines.map((m) => m.machine), ["machine-c", "machine-a", "machine-b"]);

  res = await call(env, "GET", `/sub/all/${TOKEN}`);
  const merged = unb64(await res.text()).split("\n");
  assert.deepEqual(merged, ["anytls://c", "vless://a", "tuic://b"]);
});

test("default machine order follows region proximity and default node order follows protocol", async () => {
  const env = makeEnv();
  const machines = ["au-aws", "ca-oracle-nat", "de-dandan", "hk-opt", "in-amd", "jp-dandan-tky", "kr-dandan", "nl-ams", "sg-dandan", "us-sje"];
  for (const machine of machines) {
    const res = await call(env, "POST", `/api/v1/report/${machine}`, b64("vless://one"), {
      authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(res.status, 200);
  }
  let res = await call(env, "GET", "/api/v1/machines", null, { authorization: `Bearer ${TOKEN}` });
  const data = await res.json();
  assert.deepEqual(data.machines.map((m) => m.machine), ["hk-opt", "kr-dandan", "jp-dandan-tky", "sg-dandan", "in-amd", "us-sje", "de-dandan", "nl-ams", "ca-oracle-nat", "au-aws"]);

  const links = [
    "tuic://22222222-2222-4222-8222-222222222222:pass@example.net:443?sni=deb.debian.org#TUIC",
    "hysteria2://hysecret@example.io:443?sni=addons.mozilla.org#HY2",
    "socks5://user:pass@example.org:1080#SOCKS5",
    "vless://11111111-1111-4111-8111-111111111111@example.com:443?security=reality&sni=pypi.org&pbk=abc&sid=dead&type=tcp#Reality",
    "vless://33333333-3333-4333-8333-333333333333@example.com:443?security=tls&type=ws&host=node.trycloudflare.com&path=%2Fargo&sni=node.trycloudflare.com#Node-Argo",
    "vless://44444444-4444-4444-8444-444444444444@example.com:443?security=tls&type=ws&host=cdn.example.com&path=%2Fcdn&sni=cdn.example.com#Node-CDN",
    "anytls://secret@example.org:8443?sni=rubygems.org#AnyTLS",
  ];
  res = await call(env, "POST", "/api/v1/report/order-proto", b64(links.join("\n")), {
    authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(res.status, 200);
  res = await call(env, "GET", "/api/v1/nodes/order-proto", null, { authorization: `Bearer ${TOKEN}` });
  const nodeData = await res.json();
  assert.deepEqual(nodeData.nodes.map((n) => n.name), ["Reality", "AnyTLS", "Node-Argo", "Node-CDN", "HY2", "TUIC", "SOCKS5"]);
});

test("subscription formats adapt from query and user-agent", async () => {
  const env = makeEnv();
  await call(env, "POST", "/api/v1/report/fmt", b64(SAMPLE_LINKS.join("\n")), {
    authorization: `Bearer ${TOKEN}`,
  });

  let res = await call(env, "GET", `/sub/fmt/${TOKEN}?format=clash`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /yaml/);
  const clash = await res.text();
  assert.match(clash, /^proxies:/);
  assert.match(clash, /type: vless/);
  assert.match(clash, /type: anytls/);
  assert.match(clash, /type: tuic/);
  assert.match(clash, /type: hysteria2/);

  res = await call(env, "GET", `/sub/fmt/${TOKEN}?format=singbox`);
  assert.equal(res.status, 200);
  const singbox = JSON.parse(await res.text());
  assert.equal(singbox.outbounds.length, 4);
  assert.equal(singbox.outbounds[0].type, "vless");
  assert.equal(singbox.outbounds[1].type, "anytls");
  assert.equal(singbox.outbounds[2].type, "hysteria2");
  assert.equal(singbox.outbounds[3].type, "tuic");

  res = await call(env, "GET", `/sub/fmt/${TOKEN}`, null, { "user-agent": "clash-meta/1.0" });
  assert.match(await res.text(), /^proxies:/);
  res = await call(env, "GET", `/sub/fmt/${TOKEN}`, null, { "user-agent": "sing-box/1.13" });
  assert.equal(JSON.parse(await res.text()).outbounds.length, 4);
});

test("webui can edit links/order and reports do not overwrite manual config", async () => {
  const env = makeEnv();
  await call(env, "POST", "/api/v1/report/edit", b64("vless://original@example.com:443?sni=pypi.org#Original"), {
    authorization: `Bearer ${TOKEN}`,
  });

  const body = JSON.stringify({
    nodes: [
      { link: SAMPLE_LINKS[1], name: "第二" },
      { link: SAMPLE_LINKS[0], name: "第一" },
    ],
  });
  let res = await call(env, "PUT", "/api/v1/nodes/edit", body, {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  });
  assert.equal(res.status, 200);
  let data = await res.json();
  assert.equal(data.manual, true);
  assert.equal(data.nodes[0].name, "第二");

  res = await call(env, "GET", "/api/v1/nodes/edit", null, { authorization: `Bearer ${TOKEN}` });
  data = await res.json();
  assert.equal(data.nodes.length, 2);
  assert.equal(data.nodes[0].link, SAMPLE_LINKS[1]);

  // 新的自动上报不应覆盖手动配置
  res = await call(env, "POST", "/api/v1/report/edit", b64("vless://new@example.com:443?sni=deb.debian.org#New"), {
    authorization: `Bearer ${TOKEN}`,
  });
  data = await res.json();
  assert.equal(data.manual, true);
  res = await call(env, "GET", "/api/v1/nodes/edit", null, { authorization: `Bearer ${TOKEN}` });
  data = await res.json();
  assert.equal(data.nodes.length, 2);
  assert.equal(data.nodes[0].link, SAMPLE_LINKS[1]);

  // 合并订阅按保存顺序返回
  res = await call(env, "GET", `/sub/all/${TOKEN}`);
  const merged = unb64(await res.text());
  assert.ok(merged.indexOf(SAMPLE_LINKS[1]) < merged.indexOf(SAMPLE_LINKS[0]));

  // reset 后恢复自动上报内容
  res = await call(env, "POST", "/api/v1/machines/edit/reset", null, { authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 200);
  data = await res.json();
  assert.equal(data.manual, false);
  assert.equal(data.nodes.length, 1);
});

