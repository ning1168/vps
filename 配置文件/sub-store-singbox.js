/**
 * Sub-Store sing-box 注入脚本（文件/File 型，远程引用）
 * ------------------------------------------------------------------
 * 与常见做法一致：脚本读取一份"底模"配置（$files[0]，纯 JSON 无注释），
 * 用 produceArtifact 拉取订阅/组合的节点，注入「手动选择 / 自动选择」两个组，
 * 普通协议进 outbounds；wireguard / tailscale 进顶层 endpoints（sing-box 1.14 语法）。
 *
 * 在 Sub-Store 里的用法（远程脚本 + 参数写在 URL 末尾的 # 里）：
 *   https://.../sing-box-sub-store.js#name=你的订阅名&type=0
 *   参数：
 *     name  = 订阅或组合名称（必填）
 *     type  = 0/sub/subscription 表示订阅；1/col/collection 表示组合（默认订阅）
 *   并在"脚本操作/文件"里绑定底模：$files[0] = singbox-windows.json（或 android/ios）
 *
 * 说明：底模必须是纯 JSON（本仓库 config/*.json 已去掉注释），
 *       因为这里用 JSON.parse 读取，标准 JSON.parse 不支持注释。
 */

const { name, type } = $arguments;

// COMPATIBLE 兜底出口：订阅为空时，避免 urltest/selector 出现空 outbounds（非法）
const compatibleOutbound = { tag: 'COMPATIBLE', type: 'direct' };

// 1) 读取底模
if (!$files || !$files[0]) {
    throw new Error('未绑定底模文件：$files[0] 为空，请在脚本操作里绑定 config/*.json');
}
let config;
try {
    config = JSON.parse($files[0]);
} catch (e) {
    throw new Error('底模 JSON 解析失败（请确认为纯 JSON、无注释）：' + e.message);
}
if (!Array.isArray(config.outbounds)) {
    throw new Error('底模缺少 outbounds 数组');
}
if (!name) {
    throw new Error('缺少 $arguments.name（订阅/组合名称）');
}

// 2) 拉取节点（sing-box 出站对象数组）
const artifactType =
    type === '1' || /^col(lection)?$/i.test(String(type || ''))
        ? 'collection'
        : 'subscription';

let produced = await produceArtifact({
    name,
    type: artifactType,
    platform: 'sing-box',
    produceType: 'internal',
});
if (!Array.isArray(produced)) {
    throw new Error('produceArtifact 未返回数组，请检查订阅是否可用');
}

// 3) 过滤机场信息节点（流量/到期/官网等非真实节点）
const infoKeywords =
    /网址|网站|获取|订阅|流量|到期|余量|续费|过期|重置|套餐|官网|面板|剩余|更新|expire|traffic|reset|plan|manual|通知|公告|说明|教程|客服|频道|群组/i;

// 底模中已存在的 tag（策略组名、direct 等），避免节点与之重名
const reserved = new Set(
    []
        .concat(config.outbounds || [])
        .concat(config.endpoints || [])
        .map((o) => o && o.tag)
        .filter(Boolean),
);

const seen = new Set();
const nodeOutbounds = [];
const nodeEndpoints = [];

for (const item of produced) {
    if (!item || typeof item !== 'object' || !item.type || !item.tag) continue;
    const tag = String(item.tag).trim();
    if (!tag || infoKeywords.test(tag)) continue; // 过滤信息节点
    if (seen.has(tag) || reserved.has(tag)) continue; // 去重 + 避免撞名
    seen.add(tag);
    item.tag = tag;
    // wireguard / tailscale 属于 endpoint，必须放顶层 endpoints
    if (item.type === 'wireguard' || item.type === 'tailscale') {
        nodeEndpoints.push(item);
    } else {
        nodeOutbounds.push(item);
    }
}

const proxyTags = [
    ...nodeOutbounds.map((o) => o.tag),
    ...nodeEndpoints.map((o) => o.tag),
];

// 4) 写入节点本体
config.outbounds.push(...nodeOutbounds);
if (nodeEndpoints.length > 0) {
    if (!Array.isArray(config.endpoints)) config.endpoints = [];
    config.endpoints.push(...nodeEndpoints);
}

// 5) 注入到「手动选择」(selector) 与「自动选择」(urltest)
for (const outbound of config.outbounds) {
    if (!outbound || !Array.isArray(outbound.outbounds)) continue;
    if (outbound.type === 'selector' && outbound.tag === '手动选择') {
        const exist = new Set(outbound.outbounds);
        for (const t of proxyTags) if (!exist.has(t)) outbound.outbounds.push(t);
    }
    if (outbound.type === 'urltest' && outbound.tag === '自动选择') {
        outbound.outbounds = [...proxyTags]; // 测速组只放真实节点
    }
}

// 6) 空组兜底：任何 outbounds 为空的 selector/urltest 补 COMPATIBLE
let needCompatible = false;
for (const outbound of config.outbounds) {
    if (
        (outbound.type === 'urltest' || outbound.type === 'selector') &&
        Array.isArray(outbound.outbounds) &&
        outbound.outbounds.length === 0
    ) {
        outbound.outbounds.push(compatibleOutbound.tag);
        needCompatible = true;
    }
}
if (needCompatible && !config.outbounds.some((o) => o.tag === 'COMPATIBLE')) {
    config.outbounds.push(compatibleOutbound);
}

// 7) 调试信息（Sub-Store 日志可见）
console.log(
    `[sing-box inject] type=${artifactType} name=${name} outbounds=${nodeOutbounds.length} endpoints=${nodeEndpoints.length}`,
);

$content = JSON.stringify(config, null, 2);
