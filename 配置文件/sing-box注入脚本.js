#!/usr/bin/env node
/**
 * merge-singbox.js — 把 Sub-Store 输出的订阅节点注入 sing-box 配置模板
 *
 * 工作流程：
 *   1. 调用 Sub-Store 下载 API（target=sing-box），拿到订阅节点的 sing-box 出站配置
 *   2. 从输出中抽取代理节点出站（ss/vmess/vless/trojan/hysteria2/tuic 等）
 *   3. 替换模板中的 "$SUB_STORE_NODES$" 占位符：
 *      - 顶层 outbounds 数组：插入节点出站对象
 *      - “自动选择”(urltest) / “手动选择”(selector) 的 outbounds：替换为节点 tag 列表
 *   4. 输出最终配置；可选调用 sing-box check 校验
 *
 * 用法：
 *   node merge-singbox.js --template config.windows.json \
 *        --sub "http://127.0.0.1:3000/download/我的订阅?target=sing-box" \
 *        [--token <Sub-Store API Token>] \
 *        [--out final.windows.json] \
 *        [--check "C:\Tools\sing-box\sing-box.exe"] \
 *        [--mock]        # 不接订阅，注入一个示例节点（仅用于本地校验配置结构）
 *
 * 依赖：Node.js 18+（使用内置 fetch），无需安装任何 npm 包。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PLACEHOLDER = '$SUB_STORE_NODES$';

// sing-box 代理类出站类型（1.14）。selector/urltest/direct/block/dns 不算节点。
// 注意：sing-box 1.12 起 Shadowsocks 出站类型由 "ss" 更名为 "shadowsocks"，脚本会自动转换；
// "ssr" 已被 sing-box 移除，无法注入，遇到时跳过并警告。
const PROXY_OUTBOUND_TYPES = new Set([
  'shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2',
  'tuic', 'ssh', 'anytls', 'shadowtls', 'socks', 'http', 'naive', 'snell', 'tor',
]);
const RENAMED_TYPES = { ss: 'shadowsocks' };
const REMOVED_TYPES = new Set(['ssr']);
// 1.11+ WireGuard 已从出站迁移为 endpoint
const ENDPOINT_TYPES = new Set(['wireguard']);

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') args.mock = true;
    else if (a === '--template') args.template = argv[++i];
    else if (a === '--sub') args.sub = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--check') args.check = argv[++i];
    else if (a === '--token') args.token = argv[++i];
    else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  if (!args.template) {
    console.error('缺少 --template <模板文件>');
    process.exit(2);
  }
  if (!args.sub && !args.mock) {
    console.error('缺少 --sub <Sub-Store 订阅链接>（或使用 --mock 注入示例节点）');
    process.exit(2);
  }
  if (!args.out) {
    const t = path.basename(args.template);
    args.out = 'final.' + t;
  }
  return args;
}

// ---------- 剥离 JSON 注释（sing-box 配置支持 // 与 /* */ 注释） ----------
function stripJsonComments(text) {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; i++; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function readJsonc(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(stripJsonComments(raw));
}

// ---------- 从 Sub-Store 输出抽取节点 ----------
function extractProxies(subJson) {
  const nodes = [];
  const endpoints = [];
  const candidates = Array.isArray(subJson) ? subJson : [subJson];
  for (const obj of candidates) {
    if (!obj || typeof obj !== 'object') continue;
    for (const ob of obj.outbounds ?? []) {
      if (!ob || typeof ob !== 'object' || !ob.tag) continue;
      if (REMOVED_TYPES.has(ob.type)) {
        console.warn(`警告: 节点 "${ob.tag}" 的类型 ${ob.type} 已被 sing-box 移除，已跳过`);
        continue;
      }
      const type = RENAMED_TYPES[ob.type] ?? ob.type;
      if (PROXY_OUTBOUND_TYPES.has(type)) {
        nodes.push({ ...ob, type });
      }
    }
    for (const ep of obj.endpoints ?? []) {
      if (ep && typeof ep === 'object' && ENDPOINT_TYPES.has(ep.type) && ep.tag) {
        endpoints.push(ep);
      }
    }
  }
  return { nodes, endpoints };
}

// tag 去重
function dedupeTags(items) {
  const seen = new Map();
  for (const it of items) {
    if (!seen.has(it.tag)) { seen.set(it.tag, 0); continue; }
    const n = seen.get(it.tag) + 1;
    seen.set(it.tag, n);
    it.tag = `${it.tag} #${n + 1}`;
  }
  return items;
}

// ---------- 注入占位符 ----------
function inject(config, nodes, endpoints) {
  const tags = nodes.map((n) => n.tag);

  // 1) 顶层 outbounds：移除占位符字符串，在原位置插入节点
  const outbounds = config.outbounds;
  const idx = outbounds.indexOf(PLACEHOLDER);
  if (idx === -1) {
    throw new Error('模板顶层 outbounds 中找不到占位符 ' + PLACEHOLDER);
  }
  outbounds.splice(idx, 1, ...nodes);

  // 2) 所有引用占位符的 outbounds 列表（策略组/urltest）替换为节点 tag
  let replaced = 0;
  const walk = (value) => {
    if (Array.isArray(value)) {
      const p = value.indexOf(PLACEHOLDER);
      if (p !== -1) {
        value.splice(p, 1, ...tags);
        replaced++;
      }
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(config);

  // 3) WireGuard endpoint（如订阅包含）：插入顶层 endpoints
  if (endpoints.length > 0) {
    config.endpoints = [...(config.endpoints ?? []), ...endpoints];
    console.log(`提示：注入了 ${endpoints.length} 个 WireGuard endpoint（endpoint 不参与策略组筛选）。`);
  }

  if (tags.length === 0) {
    throw new Error('订阅中未抽取到任何节点，请检查 Sub-Store 链接与 target=sing-box 参数');
  }
  if (replaced === 0) {
    throw new Error('模板策略组中未找到占位符，注入不完整');
  }
  return { config, count: tags.length };
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv);

  const config = readJsonc(args.template);
  console.log(`已读取模板: ${args.template}`);

  let nodes = [];
  let endpoints = [];

  if (args.sub) {
    const headers = {};
    if (args.token) headers['X-API-Token'] = args.token;
    console.log(`正在拉取 Sub-Store: ${args.sub}`);
    const res = await fetch(args.sub, { headers });
    if (!res.ok) {
      throw new Error(`Sub-Store 请求失败: HTTP ${res.status} ${res.statusText}`);
    }
    const subJson = await res.json();
    ({ nodes, endpoints } = extractProxies(subJson));
    console.log(`从 Sub-Store 输出中抽取到 ${nodes.length} 个节点、${endpoints.length} 个 endpoint`);
  }

  if (args.mock) {
    nodes.push({
      type: 'shadowsocks',
      tag: '示例节点',
      server: '192.0.2.10',
      server_port: 8388,
      method: 'aes-128-gcm',
      password: 'example-password',
    });
    console.log('已注入 1 个示例节点（--mock）');
  }

  if (nodes.length === 0 && endpoints.length === 0) {
    throw new Error('没有可注入的节点');
  }
  dedupeTags(nodes);

  const { config: finalConfig, count } = inject(config, nodes, endpoints);

  fs.writeFileSync(args.out, JSON.stringify(finalConfig, null, 2), 'utf8');
  console.log(`✅ 已生成最终配置: ${args.out}（共 ${count} 个节点）`);

  if (args.check) {
    const exe = path.resolve(args.check);
    console.log(`正在执行校验: "${exe}" check -c "${args.out}"`);
    const r = spawnSync(exe, ['check', '-c', args.out], { stdio: 'pipe', encoding: 'utf8' });
    if (r.status === 0) {
      console.log('✅ sing-box check 校验通过');
    } else {
      console.error('❌ sing-box check 校验失败:');
      console.error(r.stderr || r.stdout || (r.error && r.error.message) || '（无输出，退出码 ' + r.status + '）');
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error('❌ ' + (err && err.message ? err.message : err));
  process.exit(1);
});
