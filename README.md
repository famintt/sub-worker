# sub-worker

一个部署在 Cloudflare Workers 上的**固定订阅入口**：多台 singbox-manager 把各自的订阅上报到 Worker，客户端通过一个不会随服务器重启变化的 URL 获取订阅。

临时 `*.trycloudflare.com` 隧道在 cloudflared 重启后会换随机域名；本项目把订阅内容集中到固定 Worker 域名，解决这个问题。

## 特性

- 固定订阅 URL，重启/重新部署 Worker 不变；
- 一个 `TOKEN` 同时用于上报和读取；
- 每台机器一个 `machine` slug，支持单机和合并订阅；
- Cloudflare KV 存储，按内容 SHA-256 去重，相同内容不重复写；
- **WebUI 可以编辑节点链接、节点名称、机器顺序和节点顺序**；
- **自动适配 base64 / Clash / sing-box 订阅格式**；
- 手动编辑后，机器自动上报不会覆盖手动配置；
- 支持 `workers.dev` 默认域名和自定义域名；
- 自动从请求 `Origin` 推断对外域名，无需配置 `PUBLIC_BASE_URL`；
- 提供单文件 `worker.single.js`，可直接粘贴到 Cloudflare Dashboard；
- 提供一个多机上报脚本 `scripts/report.py`。

## 架构

```text
singbox-manager（每台 NAT 机）
  sbm sub / 订阅文件
        │  POST base64
        ▼
Cloudflare Worker（固定 workers.dev / 自定义域名）
        │  GET /sub/:machine/:token
        │  GET /sub/:token              # 全部机器合并
        ▼
客户端订阅
```

## 快速开始（Wrangler）

```bash
git clone https://github.com/famintt/sub-worker.git
cd sub-worker
pnpm install
```

### 1. 创建 KV namespace

```bash
pnpm exec wrangler kv namespace create SUBS
```

把输出的 namespace id 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "SUBS"
id = "你的 KV namespace id"
```

### 2. 设置 TOKEN

```bash
pnpm exec wrangler secret put TOKEN
```

`TOKEN` 是唯一认证凭证，上报和读取共用。建议使用 UUID v4 或 32 字节随机 URL-safe 字符串。

### 3. 部署

```bash
pnpm exec wrangler deploy
```

默认会得到一个固定地址：

```text
https://<worker-name>.<你的子域>.workers.dev
```

### 4. 绑定自定义域名（可选）

在 Cloudflare Dashboard：

```text
Workers & Pages → 你的 Worker → Settings → Domains & Routes → Add Custom Domain
```

填例如 `sub.example.com` 即可。Worker 会根据请求 `Origin` 自动识别域名，不需要改代码或加变量。

## Dashboard 单文件部署

不想用 Wrangler 时：

1. Workers & Pages → Create Worker；
2. 复制根目录的 `worker.single.js` 全部粘贴；
3. 新建 KV namespace，在 Worker 的 Settings → Bindings 绑定：
   - Variable name：`SUBS`
   - KV namespace：刚创建的那个；
4. Settings → Variables and Secrets 添加一个 Secret：
   - `TOKEN`：你的 token；
5. Deploy；
6. 需要自定义域名时，在 Domains & Routes 绑定。

## WebUI

部署后访问：

```text
https://<worker>/ui/<TOKEN>
```

界面支持：

- 选择机器；
- **机器列表上移/下移，保存合并订阅中的机器顺序**；
- 修改节点链接和显示名称；
- 上移、下移调整节点顺序；
- 添加、删除节点；
- 保存后订阅立即按新顺序生成；
- “恢复自动上报”会清除手动配置，重新采用最近一次上报内容。

手动保存后，机器继续自动上报也不会覆盖已编辑节点；需要恢复自动更新时点“恢复自动上报”。

## 订阅格式

客户端 `User-Agent` 会自动识别：

| 客户端 / 参数 | 格式 |
|---|---|
| V2RayN、默认 | base64 URI |
| Clash、Mihomo、Meta | Clash YAML |
| sing-box / singbox | sing-box JSON |

也可以显式指定：

```text
/sub/all/<TOKEN>?format=base64
/sub/all/<TOKEN>?format=clash
/sub/all/<TOKEN>?format=singbox
/sub/all/<TOKEN>?clash
/sub/all/<TOKEN>?singbox
```

支持转换的节点链接包括：

```text
vless://
anytls://
hysteria2://
tuic://
trojan://
ss://
vmess://
```

## 配置

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `SUBS` | KV binding | 是 | 存储订阅内容 |
| `TOKEN` | Secret | 是 | 上报和读取共用的认证 token |

不需要 `PUBLIC_BASE_URL`；Worker 根路径返回的 `subscription_base` 来自当前请求的 `Origin`。

### TOKEN 格式（重要）

Worker 对 `TOKEN` 做**精确字符串比较**，区分大小写，不会自动 trim，也不会把不同写法当作同一个 token。

推荐格式（任选一种）：

```text
UUID v4：550e8400-e29b-41d4-a716-446655440000
base64url：A-Za-z0-9_- 组成，建议 32 字节随机值
hex：0-9a-f，32 或 64 位
```

不建议在 token 中使用：空格、换行、引号、`/`、`?`、`#`、`&`、`%`、`+`、`=`。这些字符不是不能用，而是放进订阅 URL 路径时必须正确编码，部分客户端/代理会二次解码，容易“看起来一样但匹配不上”。

在 Cloudflare 设置 `TOKEN` 时：

- 只填 token 本身，不要带 `TOKEN=`、引号、前后空格或换行；
- 用 Secret 类型；
- `wrangler secret put TOKEN` 后直接粘贴原始值。

请求头里使用**原始 token**，不要 URL 编码：

```http
Authorization: Bearer <原始 TOKEN>
```

订阅 URL 路径里使用 **URL 编码后的 token**：

| 原始字符 | URL 编码 |
|---|---|
| `+` | `%2B` |
| `=` | `%3D` |
| `/` | `%2F`（不建议使用 `/`） |
| `?` | `%3F` |
| `#` | `%23` |
| `&` | `%26` |
| `%` | `%25` |
| 空格 | `%20` |

示例：

```text
原始 token：abc+def=ghi
URL 路径：  /sub/abc%2Bdef%3Dghi
请求头：    Authorization: Bearer abc+def=ghi
```

如果不想处理这些编码，直接用 UUID v4 最省事；Worker 不需要改代码。

## API

### 上报

```http
POST /api/v1/report/:machine
Authorization: Bearer <TOKEN>
Content-Type: text/plain
Body: base64 编码的订阅内容
```

`machine` 只允许：

```text
[a-z0-9][a-z0-9-]{0,63}
```

示例：

```bash
BODY=$(printf 'vless://example\nanytls://example2' | base64 -w0)

curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary "$BODY" \
  https://<worker>/api/v1/report/machine-a
```

### 读取

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/sub/:machine/:token` | 单机订阅 |
| `GET` | `/sub/:token` | 全部机器合并订阅（推荐） |
| `GET` | `/sub/all/:token` | 合并订阅的兼容旧路径 |
| `GET` | `/ui/:token` | WebUI 节点管理 |
| `GET` | `/api/v1/nodes/:machine` | 读取节点配置，Bearer `TOKEN` |
| `PUT` | `/api/v1/nodes/:machine` | 保存节点链接/名称/顺序，Bearer `TOKEN` |
| `GET` | `/api/v1/machines/order` | 读取机器顺序（也可从 machines 响应获取） |
| `PUT` | `/api/v1/machines/order` | 保存机器顺序，Bearer `TOKEN` |
| `POST` | `/api/v1/machines/:machine/reset` | 恢复自动上报，Bearer `TOKEN` |
| `GET` | `/api/v1/machines` | 查看已上报机器，Bearer `TOKEN` |
| `DELETE` | `/api/v1/machines/:machine` | 删除机器，Bearer `TOKEN` |
| `GET` | `/health` | 健康检查，无需认证 |

路径中的 token 建议使用 URL-safe 格式。UUID 可直接使用；如果 token 含 `+`、`=` 等字符，请做 URL 编码。

### 保存节点示例

```bash
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"nodes":[{"link":"vless://...","name":"节点 A"},{"link":"tuic://...","name":"节点 B"}]}' \
  https://<worker>/api/v1/nodes/machine-a
```

节点数组的顺序就是订阅顺序。

默认排序：

```text
机器：HK → KR → JP → SG → 其他亚洲 → US → DE → 其他欧洲 → 其他美洲 → 其他
节点：Reality → AnyTLS → Argo → CDN → HY2 → TUIC → SOCKS5
```

手动保存机器顺序或节点顺序后会覆盖默认排序。

### 响应示例

```bash
curl https://<worker>/sub/machine-a/<TOKEN>
```

默认返回 `text/plain` 的 base64 订阅内容；带 `?format=clash` 或 `?format=singbox` 返回对应格式。

## 多机上报

`scripts/report.py` 读取机器名到订阅 URL 的映射，先拉取本地临时订阅，再上报到 Worker：

```bash
python3 scripts/report.py \
  --base https://<worker> \
  --token "$TOKEN" \
  --file machines.json
```

`machines.json`：

```json
{
  "machine-a": "https://sub-a.example.com/sub.txt",
  "machine-b": "https://sub-b.example.com/sub.txt"
}
```

也可以直接传：

```bash
python3 scripts/report.py \
  --base https://<worker> \
  --token "$TOKEN" \
  --machine "machine-a=https://sub-a.example.com/sub.txt"
```

脚本依赖 `curl`，避免部分 Python 默认 User-Agent 被 Cloudflare 安全策略拦截。

## 与 singbox-manager 集成

管理器生成订阅后调用上报接口即可。建议的约定：

```bash
sub=1
sub_mode=worker
sub_report_url='https://<worker>'
sub_token='<TOKEN>'
sub_machine='machine-a'
```

- 启动或 watchdog 发现内容变化时上报；
- 内容 hash 不变时 Worker 不写 KV；
- Argo 临时隧道重启导致节点域名变化时，管理器重新生成并上报，客户端重新拉订阅即可。

## 安全

- `TOKEN` 是 bearer secret，建议使用 Secret 类型，不要提交到仓库；
- 订阅内容包含节点 UUID/密码，读取 URL 的 token 必须不可猜；
- 不要使用公开 GitHub Gist 存放订阅；
- token 泄露后：在 Worker 中轮换 `TOKEN`，所有旧订阅 URL 会立即失效，再通知客户端更新；
- Worker 日志/分析中可能记录请求路径，生产环境应限制日志访问权限；
- 如需更细的权限控制，可扩展为每台机器单独 token。

## 已知限制

- Cloudflare KV 的 `list()` 是最终一致的：刚上报后立刻访问 `/sub/:token` 或 `/sub/all/:token` 可能短暂为空，通常十几秒后出现；单机 `/sub/:machine/:token` 通常立即可用；
- WebUI 采用 `TOKEN` 路径认证，请勿把 `/ui/<TOKEN>` 发给他人；
- 手动编辑后不会自动合并新上报节点，需要点“恢复自动上报”才会恢复；
- `workers.dev` 域名在部分地区可能不可达，建议绑定自定义域名；
- 免费 KV 有写入次数限制，本项目已做内容 hash 去重。

## 开发

```bash
pnpm install
pnpm test                 # Node 内置测试
pnpm dev --local --var TOKEN:test-token
pnpm run build:single     # 生成 worker.single.js
pnpm exec wrangler deploy --dry-run --outdir dist
```

本地测试：

```bash
BODY=$(printf 'vless://test\nanytls://test2' | base64 -w0)

curl -X POST \
  -H 'Authorization: Bearer test-token' \
  --data-binary "$BODY" \
  http://127.0.0.1:8787/api/v1/report/machine-a

curl http://127.0.0.1:8787/sub/machine-a/test-token
curl http://127.0.0.1:8787/sub/test-token
```

## 目录

```text
src/index.js            Worker 源码
worker.single.js        单文件构建产物（Dashboard 可直接粘贴）
scripts/report.py       多机订阅上报工具
scripts/build-single.mjs 生成单文件版本
test/worker.test.js     单元测试
wrangler.toml           Wrangler 配置
```

## License

MIT
