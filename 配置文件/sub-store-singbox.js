// sing-box 配置注入脚本（Sub-Store 文件功能 · 脚本操作）
// 适用：Sub-Store 后端（Node.js 环境）「文件」流程，目标平台 sing-box
// 用法：在 Sub-Store「文件」中新建一个文件（来源为 sing-box 配置模板 JSON），
//       给该文件添加「脚本操作」，脚本内容为本文件全文，
//       脚本参数（# 后）示例：#sub=机场订阅名&template=https://你的模板地址/config.json
// 接口出处（Sub-Store 官方仓库 master 分支，均已核对）：
//   $arguments        —— scripts/demo.js 及 backend/src/core/proxy-utils/processors/index.js（createDynamicFunction 注入）
//   $files / $content —— backend/src/core/proxy-utils/processors/index.js 文件脚本包裹（$files 为数组，$content 为字符串）
//   produceArtifact   —— backend/src/restful/sync.js（export 的全局函数，脚本环境注入见 processors/index.js）
//   ProxyUtils.JSON5  —— backend/src/core/proxy-utils/index.js（容忍模板中的尾逗号等 JSON5 语法）
//   $substore         —— backend/src/vendor/open-api.js（$.http / $.read / $.write 等）
// 失败处理原则：任何一步失败都 throw 明确原因，Sub-Store 会将错误透出到响应，绝不静默返回未注入的模板。

const {
  sub = '',       // 订阅名或组合订阅名（Sub-Store「订阅管理」里的 name）
  template = ''   // 模板地址；留空则用文件自身内容（$files[0] / $content）作为模板
} = $arguments;

if (!sub || typeof sub !== 'string') {
  throw new Error('sing-box 注入脚本：缺少脚本参数 sub（订阅名/组合订阅名），请在脚本链接 # 后加 sub=xxx');
}

// 1. 取模板：优先用 #template= 指定的远程地址，其次用文件自身内容
let tplRaw = '';
if (template) {
  const resp = await $substore.http.get(template);
  tplRaw = (resp && (resp.body ?? resp.rawBody)) ?? '';
  if (!tplRaw) throw new Error(`sing-box 注入脚本：模板下载为空或失败：${template}`);
} else {
  // 文件流程：多来源时取第一个文件内容；单文件时 $content 即模板字符串
  tplRaw = (Array.isArray($files) && $files[0]) || $content || '';
  if (!tplRaw) throw new Error('sing-box 注入脚本：文件内容为空，请检查 Sub-Store 文件的来源配置');
}

// 2. 解析模板（JSON5 容忍尾逗号；解析失败给出定位提示）
let config;
try {
  config = (ProxyUtils.JSON5 || JSON).parse(tplRaw);
} catch (e) {
  throw new Error(`sing-box 注入脚本：模板不是合法 JSON/JSON5：${e.message ?? e}`);
}
if (!config || typeof config !== 'object' || Array.isArray(config)) {
  throw new Error('sing-box 注入脚本：模板根节点必须是 JSON 对象');
}

// 3. 拉取订阅节点（internal 产出 = sing-box 出站对象数组）
//    先按单条订阅拉取；失败再按组合订阅拉取；都失败则报出真实原因
let produced = null;
let lastErr = '';
for (const type of ['subscription', 'collection']) {
  try {
    produced = await produceArtifact({ type, name: sub, platform: 'sing-box', produceType: 'internal' });
    if (Array.isArray(produced)) break;
  } catch (e) {
    lastErr = `${type}: ${e.message ?? e}`;
    produced = null;
  }
}
if (!Array.isArray(produced)) {
  throw new Error(`sing-box 注入脚本：拉取订阅「${sub}」失败（${lastErr || '未知原因'}），请确认订阅名拼写及订阅是否可正常解析`);
}

// 4. 只保留真正的出站对象（带 type 字段），endpoints（wireguard/tailscale）不注入 outbounds
const TYPE_WHITELIST = ['shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'shadowtls', 'anytls', 'socks', 'http', 'ssh', 'direct'];
const raw = produced.filter(p => p && typeof p === 'object' && typeof p.type === 'string' && TYPE_WHITELIST.includes(p.type));
const droppedByType = produced.length - raw.length;

// 5. 过滤机场信息节点（流量、到期、官网等非节点条目）——按名称特征，不区分协议
const INFO_RE = /(剩余流量|流量|套餐|到期|过期|官网|官方网站|官方|工单|客服|群|TG|Telegram|地址|节点|更新|订阅|公告|说明|距离|重置|运营|倍率|限速|加油|续费|购买|邀请)/i;
const nodes = [];
const droppedInfo = [];
for (const p of raw) {
  const name = `${p.tag ?? p.name ?? ''}`;
  if (INFO_RE.test(name)) { droppedInfo.push(name); continue; }
  nodes.push(p);
}

if (nodes.length === 0) {
  throw new Error(`sing-box 注入脚本：订阅「${sub}」解析出 0 个可用节点（原始 ${produced.length} 条，类型不符 ${droppedByType} 条，信息节点过滤 ${droppedInfo.length} 条）。请检查订阅内容或联系机场。`);
}

// 6. 收集模板中已存在的出站 tag，避免与内置组重名导致节点被覆盖
const builtinTags = new Set((config.outbounds || []).map(o => o && o.tag).filter(Boolean));
const RESERVED = ['手动选择', '自动选择', '苹果服务', '微软服务', '谷歌服务', '直连', '代理'];
for (const r of RESERVED) builtinTags.add(r);

// 7. 重命名：节点与内置 tag 冲突，或节点之间重名，一律加后缀，不丢节点
const seen = new Map(); // tag -> 已用次数
const finalNodes = [];
const renamed = [];
for (const p of nodes) {
  const oldTag = `${p.tag ?? p.name ?? ''}`.trim();
  if (!oldTag) { renamed.push('(无名节点，已跳过)'); continue; }
  let newTag = oldTag;
  if (builtinTags.has(newTag) || seen.has(newTag)) {
    let n = seen.get(oldTag) ?? 1;
    do { n += 1; newTag = `${oldTag} ${n}`; } while (builtinTags.has(newTag) || seen.has(newTag));
    renamed.push(`${oldTag} → ${newTag}`);
  }
  seen.set(oldTag, (seen.get(oldTag) ?? 0) + 1);
  seen.set(newTag, 1);
  p.tag = newTag;
  delete p.name;
  // 域名型服务器需要 domain_resolver 指向模板内已定义的 DNS 服务器，否则 1.14 起可能报错
  if (typeof p.server === 'string' && !/^(\d{1,3}\.){3}\d{1,3}$/.test(p.server) && !p.server.includes(':')) {
    p.domain_resolver = p.domain_resolver ?? '阿里DNS';
  }
  finalNodes.push(p);
}

if (finalNodes.length === 0) {
  throw new Error(`sing-box 注入脚本：全部节点均无有效名称，无法注入（共 ${nodes.length} 条）`);
}

const nodeTags = finalNodes.map(p => p.tag);

// 8. 写回 outbounds：替换模板中的占位符，并填充策略组
const outbounds = Array.isArray(config.outbounds) ? config.outbounds : [];
const result = [];
let injectedNodes = false;
let filledManual = false, filledAuto = false;

for (const o of outbounds) {
  if (!o || typeof o !== 'object') { result.push(o); continue; }
  if (o.tag === '__NODES__') {           // 节点占位符：展开为全部节点
    result.push(...finalNodes);
    injectedNodes = true;
    continue;
  }
  if (o.type === 'selector' && o.tag === '手动选择' && Array.isArray(o.outbounds)) {
    o.outbounds = o.outbounds.flatMap(t => (t === '__NODES__' ? nodeTags : [t]));
    filledManual = true;
  }
  if (o.type === 'urltest' && o.tag === '自动选择' && Array.isArray(o.outbounds)) {
    o.outbounds = o.outbounds.flatMap(t => (t === '__NODES__' ? nodeTags : [t]));
    filledAuto = true;
  }
  result.push(o);
}

if (!injectedNodes) throw new Error('sing-box 注入脚本：模板 outbounds 中未找到 {"tag":"__NODES__"} 占位符，节点无处注入');
if (!filledManual)   throw new Error('sing-box 注入脚本：模板中未找到 tag 为「手动选择」的 selector 出站，或其 outbounds 不含 "__NODES__"');
if (!filledAuto)     throw new Error('sing-box 注入脚本：模板中未找到 tag 为「自动选择」的 urltest 出站，或其 outbounds 不含 "__NODES__"');

config.outbounds = result;

// 9. 输出（必须是字符串；同时把处理摘要写进 Sub-Store 日志，便于排查）
const summary = [
  `订阅「${sub}」：原始 ${produced.length} 条`,
  droppedByType ? `类型不符/端点跳过 ${droppedByType} 条` : null,
  droppedInfo.length ? `信息节点过滤 ${droppedInfo.length} 条（${droppedInfo.slice(0, 3).join('、')}${droppedInfo.length > 3 ? '…' : ''}）` : null,
  renamed.length ? `重名/内置冲突改名 ${renamed.length} 条（${renamed.slice(0, 3).join('、')}${renamed.length > 3 ? '…' : ''}）` : null,
  `最终注入 ${finalNodes.length} 个节点`
].filter(Boolean).join('；');
$substore.info(`[sing-box 注入] ${summary}`);

$content = JSON.stringify(config, null, 2);
