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
  assert.equal(unb64(await res.text()), "vless://one\nanytls://two");

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
