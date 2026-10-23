import fs from "node:fs";

const source = fs.readFileSync("src/index.js", "utf8");
const banner = `// sub-worker single-file build
// 直接粘贴到 Cloudflare Dashboard -> Workers & Pages -> 你的 Worker -> Edit code。
// 变量模式：在 Settings -> Variables and Secrets 设置一个 TOKEN（Secret）。
// 对外域名由请求 Origin 自动决定，无需配置。
// KV 绑定变量名必须是 SUBS。

`;
fs.writeFileSync("worker.single.js", banner + source);
console.log("worker.single.js generated");
