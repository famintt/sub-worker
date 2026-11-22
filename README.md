# sub-worker

一个部署在 Cloudflare Workers 上的**固定订阅入口**：多台 singbox-manager 把各自的订阅上报到 Worker，客户端通过一个不会随服务器重启变化的 URL 获取订阅。

临时 `*.trycloudflare.com` 隧道在 cloudflared 重启后会换随机域名；本项目把订阅内容集中到固定 Worker 域名，解决这个问题。

## 特性

- 固定订阅 URL，重启/重新部署 Worker 不变；
- **凭据分权**：`ADMIN_TOKEN` 管管理、`READ_TOKEN` 只管读订阅、每台机器还能有独立上报密钥，三者互不越权；
- 每台机器一个 `machine` slug，支持单机和合并订阅；
- **WebUI 可以直接新增机器**，不依赖机器先上报；
- Cloudflare KV 存储，按内容 SHA-256 去重，相同内容不重复写；
- **WebUI 可以编辑节点链接、节点名称、机器顺序和节点顺序**；
- **自动适配 base64 / Clash / sing-box 订阅格式**；格式表达不了的节点（证书指纹 pin、xhttp 传输）会明确返回 501，不静默降级；
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

### 2. 设置密钥（只设一个）

```bash
pnpm exec wrangler secret put TOKEN      # 粘一个 UUID v4
```

就这一个。它同时是三件事的钥匙：

| 用途 | 怎么用 |
|---|---|
| 管理后台 | 打开 `https://<worker>/ui`，粘贴同一个 token |
| 订阅 | `https://<worker>/sub/<TOKEN>`（`?format=clash` / `?format=singbox` 可选） |
| 机器上报 | 请求头 `Authorization: Bearer <TOKEN>`，或每台机器用 WebUI“密钥”单独发的按机密钥 |

按机密钥是可选的：WebUI 机器行右侧“密钥”生成，Worker 只存它的 SHA-256，适合“某台机器只该写自己”的场景；不想管就全机队共用 `TOKEN`。
`TOKEN` 不要设 `ALLOW_LEGACY_TOKEN=0`，否则这把唯一的钥匙也会失效（除非另配了独立密钥，见下面的进阶拆分）。

#### 进阶：拆成三套独立凭据（可选）

只有当你想“订阅泄露也不影响管理”“某台机器被入侵只影响自己”时才需要：

| 密钥 | 能做什么 | 是否出现在订阅 URL |
|---|---|---|
| `ADMIN_TOKEN` | WebUI、增删机器、改节点、生成按机密钥 | 否 |
| `READ_TOKEN` | 只读订阅（`/sub/...`） | 是（订阅 URL 的 token） |
| 每机上报密钥 | 只能给授权的那台机器上报 | 否（放在上报请求头） |
| `REPORT_TOKEN` | 可选：给所有机器上报 | 否 |
| `TOKEN` | 兜底主密钥；设了 `ADMIN_TOKEN`/`READ_TOKEN` 后它们优先 | 是 |

拆分时三个值都要不同，并且只有在都配好之后才能把 `ALLOW_LEGACY_TOKEN` 设为 `0`。

#### `ALLOW_LEGACY_TOKEN` 在哪里设置

它不是密钥，是一个**普通变量**（值是 `1` / `0`），所以用 Dashboard 的 “Text” 类型或 `wrangler` 的 `vars` 都行，
只有 `wrangler.toml` 里的 `[vars]` 才算“随部署一起下发”。

Dashboard：

```text
Workers & Pages → sbsub → Settings → Variables and Secrets → Add
  Type: Text（不要选 Secret）
  Variable name: ALLOW_LEGACY_TOKEN
  Value: 0
→ Save and deploy
```

命令行（变量不是敏感信息，但用 secret 也能被 `env` 读到）：

```bash
pnpm exec wrangler secret put ALLOW_LEGACY_TOKEN   # 输入 0
```

或者在 `wrangler.toml` 里固定下来，随每次 `deploy` 生效：

```toml
[vars]
ALLOW_LEGACY_TOKEN = "0"
```

判断逻辑很简单：只有值**恰好等于 `"0"`** 才算关闭旧 token；不设、空值、`"false"`、`"off"` 都仍按“开启兼容”处理。
改完访问 `https://<worker>/health`，`roles.legacy_token` 应该变成 `false`。

#### 单 token 模式（想少记几个串就选它）

如果不想区分三套凭据，把三个位置都设成同一个值即可，权限仍是“都能干”，但只需要记一串：

```bash
U=你的UUID
printf '%s' "$U" | pnpm exec wrangler secret put ADMIN_TOKEN
printf '%s' "$U" | pnpm exec wrangler secret put READ_TOKEN
printf '%s' "$U" | pnpm exec wrangler secret put TOKEN      # 上报用，兼容期
```

之后这一串同时适用于：

- WebUI 登录：`https://<worker>/ui`
- 订阅地址：`https://<worker>/sub/<UUID>`
- 机器上报：`Authorization: Bearer <UUID>`

`/health` 里 `roles` 全为 `true` 就说明生效了。缺点是这台 token 一旦泄露，读写和上报一起丢，适合自己的单人机队；
想收紧时再按上面的“迁移顺序”换成三套独立凭据，代码不用改。

#### 迁移顺序（重要）

`ALLOW_LEGACY_TOKEN=0` 会**同时切断**旧 `TOKEN` 的读取和上报。现在机队还在用旧 token 上报，直接关掉会立刻停更，所以按这个顺序：

1. 先给每台机器在 WebUI 生成按机密钥（机器行右侧“密钥”），只显示一次，存好；
2. 把这些机器的上报密钥换成新值（`sub_report_token` / 上报脚本的 `Authorization`），确认 `/api/v1/machines` 里 `updated_at` 还在更新；
3. 把客户端订阅 URL 从 `/sub/<旧TOKEN>` 换成 `/sub/<READ_TOKEN>`；
4. 最后才设 `ALLOW_LEGACY_TOKEN=0`，并删除 Worker 里的旧 `TOKEN` secret：

```bash
pnpm exec wrangler secret delete TOKEN
```

需要回滚时，删掉这个变量（或设为 `1`）即可恢复旧 token，无需改代码。

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
4. Settings → Variables and Secrets 添加 Secrets：
   - `ADMIN_TOKEN`：管理密钥；
   - `READ_TOKEN`：订阅读取密钥；
5. Deploy；
6. 需要自定义域名时，在 Domains & Routes 绑定。

## WebUI

部署后访问：

```text
https://<worker>/ui
```

首次打开输入 `ADMIN_TOKEN`，只存在浏览器 `sessionStorage`，不再把凭据放进 URL。
旧路径 `/ui/<ADMIN_TOKEN>` 仍可用（要求是管理密钥）。

界面支持：

- **新增机器**（机器名 + 每行一个链接，可直接粘贴，也可以先建空机器）；
- 为任意机器生成/轮换按机上报密钥（只显示一次）；
- 选择机器；
- **机器列表上移/下移，保存合并订阅中的机器顺序**；
- 修改节点链接和显示名称；
- 上移、下移调整节点顺序；
- 添加、删除节点；
- 清空某台机器的节点（空数组也是有效的手动覆盖，不会被自动上报“复活”）；
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
| `ADMIN_TOKEN` | Secret | 是 | 管理密钥（WebUI / 管理接口） |
| `READ_TOKEN` | Secret | 是 | 订阅读取密钥 |
| `REPORT_TOKEN` | Secret | 否 | 全局上报密钥（迁移期用） |
| `ALLOW_LEGACY_TOKEN` | Var | 否 | 默认 `1`；设为 `0` 后旧 `TOKEN` 完全失效 |
| `TOKEN` | Secret | 否 | 旧版共享密钥，兼容用，建议迁移后删除 |

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
Authorization: Bearer <该机器上报密钥 | ADMIN_TOKEN | REPORT_TOKEN>
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
| `GET` | `/ui` | WebUI（登录时输入 `ADMIN_TOKEN`） |
| `GET` | `/ui/:admin_token` | 兼容旧路径，要求管理密钥 |
| `GET` | `/api/v1/settings` | 读取 `read_token` 供 UI 拼订阅 URL，Bearer `ADMIN_TOKEN` |
| `POST` | `/api/v1/machines/:machine` | 新建机器（写空的手动覆盖），Bearer `ADMIN_TOKEN` |
| `POST` | `/api/v1/machines/:machine/token` | 生成/轮换该机上报密钥，只返回一次明文 |
| `GET` | `/api/v1/machines/:machine/token` | 查询是否已有上报密钥 |
| `DELETE` | `/api/v1/machines/:machine/token` | 吊销上报密钥 |
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

内置完整的 ISO 3166-1 alpha-2 国家/地区代码、常用 alpha-3 代码和城市别名（如 FRA、PHX、DXB、AMS、HKG）；未知前缀自动归入“其他”。

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

- `ADMIN_TOKEN`、`READ_TOKEN`、按机上报密钥都是 bearer secret，用 Secret 类型，不要提交到仓库；
- 管理接口只接受 `ADMIN_TOKEN`；只读 token 读不了机器列表，也改不了节点；
- 按机上报密钥的明文只在生成时返回一次，KV 里只有 SHA-256；泄露后点“密钥”重新生成即可（旧密钥立即失效）；
- 订阅内容包含节点 UUID/密码，`READ_TOKEN` 必须不可猜；`READ_TOKEN` 泄露时轮换它，旧订阅 URL 立即失效；
- 读取与上报分离后，把 `READ_TOKEN` 交给客户端不会连带给出写入权限；
- 完成迁移后设 `ALLOW_LEGACY_TOKEN=0`，旧 `TOKEN` 的读写权限一起关闭；
- Worker 请求路径可能进日志，生产环境限制日志访问权限。

## 已知限制

- Cloudflare KV 的 `list()` 是最终一致的：刚上报后立刻访问 `/sub/:token` 或 `/sub/all/:token` 可能短暂为空，通常十几秒后出现；单机 `/sub/:machine/:token` 通常立即可用；
- WebUI 用 `ADMIN_TOKEN` 登录，不要把管理密钥发给他人（旧 `/ui/<token>` 路径同样要求管理密钥）；
- 手动编辑后不会自动合并新上报节点，需要点“恢复自动上报”才会恢复；
- `workers.dev` 域名在部分地区可能不可达，建议绑定自定义域名；
- 免费 KV 有写入次数限制，本项目已做内容 hash 去重。

## 开发

```bash
pnpm install
pnpm test                 # Node 内置测试
pnpm dev --local --var ADMIN_TOKEN:admin-token --var READ_TOKEN:read-token
pnpm run build:single     # 生成 worker.single.js
pnpm exec wrangler deploy --dry-run --outdir dist
```

本地测试：

```bash
BODY=$(printf 'vless://test\nanytls://test2' | base64 -w0)

curl -X POST \
  -H 'Authorization: Bearer admin-token' \
  --data-binary "$BODY" \
  http://127.0.0.1:8787/api/v1/report/machine-a

curl http://127.0.0.1:8787/sub/machine-a/read-token
curl http://127.0.0.1:8787/sub/read-token
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
