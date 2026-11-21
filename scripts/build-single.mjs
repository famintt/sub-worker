import fs from "node:fs";

const source = fs.readFileSync("src/index.js", "utf8");
const banner = `// sub-worker single-file build
// 直接粘贴到 Cloudflare Dashboard -> Workers & Pages -> 你的 Worker -> Edit code。
// Secrets：ADMIN_TOKEN（管理）、READ_TOKEN（订阅），可选 REPORT_TOKEN。
// 迁移期可保留旧 TOKEN；设 ALLOW_LEGACY_TOKEN=0 后旧 TOKEN 失效。
// 对外域名由请求 Origin 自动决定，无需配置。
// KV 绑定变量名必须是 SUBS。

`;
fs.writeFileSync("worker.single.js", banner + source);
console.log("worker.single.js generated");
