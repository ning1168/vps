/**
 * sub-store-merge.mjs
 * ------------------------------------------------------------------
 * 用 Sub-Store 生成的 sing-box 节点自动注入本地 sing-box 配置模板。
 *
 * 原理（依据 Sub-Store 源码 producers/sing-box.js）：
 *   GET /download/<订阅名>?target=sing-box
 *   只返回 { "outbounds": [...节点...], "endpoints": [...wireguard/tailscale...] }
 *   —— 不含 dns/route/inbounds，也不会填充 selector/urltest 分组。
 *   因此需要本脚本把节点合并进模板，并把节点 tag 注入到策略组里。
 *
 * 用法：
 *   node sub-store-merge.mjs
 * 环境变量（可选）：
 *   SUB_STORE   Sub-Store 后端地址        默认 http://127.0.0.1:3000
 *   SUB_NAME    订阅 / 组合订阅名称        默认 MySub
 *   SUB_KIND    single | collection       默认 single
 *   TEMPLATE    模板配置路径              默认 ./config-windows.json
 *   OUT         输出最终配置路径          默认 ./config.final.json
 * ------------------------------------------------------------------
 */
import fs from "node:fs";

const SUB_STORE = process.env.SUB_STORE || "http://127.0.0.1:3000";
const SUB_NAME = process.env.SUB_NAME || "MySub";
const SUB_KIND = process.env.SUB_KIND || "single";
const TEMPLATE = process.env.TEMPLATE || "./config-windows.json";
const OUT = process.env.OUT || "./config.final.json";

// 模板中占位节点的 tag：注入时会被真实节点替换并删除
const PLACEHOLDER = "节点-占位符";
// selector / urltest 会被注入节点的策略组
const GROUP_TYPES = new Set(["selector", "urltest"]);

/** 从 Sub-Store 拉取 sing-box 格式（仅 outbounds/endpoints） */
async function fetchNodes() {
  const base =
    SUB_KIND === "collection"
      ? `${SUB_STORE}/download/collection/${encodeURIComponent(SUB_NAME)}`
      : `${SUB_STORE}/download/${encodeURIComponent(SUB_NAME)}`;
  const url = `${base}?target=sing-box&includeUnsupportedProxy=true`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Sub-Store 请求失败: ${resp.status} ${url}`);
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Sub-Store 返回的不是合法 JSON：\n${text.slice(0, 300)}`);
  }
  return {
    outbounds: Array.isArray(data.outbounds) ? data.outbounds : [],
    endpoints: Array.isArray(data.endpoints) ? data.endpoints : [],
  };
}

/** 把节点注入到模板 */
export function inject(config, { outbounds = [], endpoints = [] }) {
  config.outbounds = config.outbounds || [];
  config.endpoints = config.endpoints || [];

  // 模板里已存在的、需要保护的 tag（分组名、direct 等），节点若同名则改名，避免冲突
  const reserved = new Set(config.outbounds.map((o) => o.tag));
  const rename = (o) => {
    let tag = o.tag;
    let n = 1;
    while (reserved.has(tag) && tag !== PLACEHOLDER) tag = `${o.tag} ${++n}`;
    reserved.add(tag);
    return { ...o, tag };
  };
  const realOutbounds = outbounds.map(rename);
  const realEndpoints = endpoints.map(rename);

  if (realOutbounds.length === 0 && realEndpoints.length === 0) {
    throw new Error("Sub-Store 未返回任何节点，终止注入（避免生成空策略组）。");
  }

  const nodeTags = [...realOutbounds, ...realEndpoints].map((o) => o.tag);

  // 1) 删除占位节点，追加真实节点
  config.outbounds = config.outbounds.filter((o) => o.tag !== PLACEHOLDER);
  config.outbounds.push(...realOutbounds);
  if (realEndpoints.length) config.endpoints.push(...realEndpoints);

  // 2) 策略组里把占位符替换成真实节点 tag（并清理残留占位符）
  for (const g of config.outbounds) {
    if (!GROUP_TYPES.has(g.type) || !Array.isArray(g.outbounds)) continue;
    g.outbounds = g.outbounds.flatMap((t) =>
      t === PLACEHOLDER ? nodeTags : [t]
    );
    // default 指向占位符时，改指向第一个真实节点
    if (g.default === PLACEHOLDER) g.default = nodeTags[0];
  }

  // endpoints 为空则删除该键，保持配置整洁
  if (config.endpoints.length === 0) delete config.endpoints;

  return config;
}

async function main() {
  const nodes = await fetchNodes();
  const config = JSON.parse(fs.readFileSync(TEMPLATE, "utf8"));
  inject(config, nodes);
  fs.writeFileSync(OUT, JSON.stringify(config, null, 2));
  const count = nodes.outbounds.length + nodes.endpoints.length;
  console.log(`已写入 ${OUT}，注入节点 ${count} 个。`);
}

// 允许作为库被 import（供测试），直接运行时执行 main()
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
