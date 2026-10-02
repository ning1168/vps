// ============================================================
// sing-box 节点注入脚本（Sub-Store 快捷脚本，挂在「文件」条目上用）
//
// 用法：
// 1. Sub-Store 新建「文件」条目，内容 = sing-box 配置模板
//    （直接粘贴模板，或填 GitHub raw 模板链接，支持 // 注释）
// 2. 给该文件条目添加「脚本操作」→ 模式"快捷脚本"→ 粘贴本脚本
// 3. 指定订阅（两种方式任选）：
//    - 脚本操作「参数」填：{"sub":"订阅名"}
//    - 或在文件链接后面加 #sub=订阅名
//      多个参数用 & 连接（不要用多个 #，第二个 # 后会被丢弃）：
//      #sub=订阅名&type=collection&noCache
//      type=collection 表示组合订阅（不写先按单条订阅找，找不到会自动再按组合订阅找一次）
//      noCache = 强制重新拉取订阅不读缓存
// 4. 预览/下载该文件 = 注入节点后的最终配置
// ============================================================

// ↓↓↓ 未传参数时的默认订阅（请改成你的订阅/组合订阅名称）↓↓↓
const SUB_NAME = ($arguments && ($arguments.sub || $arguments.name)) || '我的订阅';
// 'sub' = 单条订阅；'collection' = 组合订阅
const SUB_TYPE = ($arguments && $arguments.type) || 'sub';
// noCache = 强制重新拉取订阅（noCache=false 关闭）
const SB_NO_CACHE =
    !!($arguments && $arguments.noCache) && $arguments.noCache !== 'false';

// sing-box 代理类出站白名单（1.14，selector/urltest/direct 等不算节点）
const SB_PROXY_TYPES = [
    'shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2',
    'tuic', 'ssh', 'anytls', 'shadowtls', 'socks', 'http', 'naive', 'snell', 'tor',
];
const PLACEHOLDER = '$SUB_STORE_NODES$';

// 剥离 JSON 注释（sing-box 模板支持 // 与 /* */ 注释）
function sbStripComments(text) {
    let out = '';
    let i = 0;
    let inString = false;
    while (i < text.length) {
        const ch = text[i];
        if (inString) {
            out += ch;
            if (ch === '\\') { out += text[i + 1] || ''; i += 2; continue; }
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

// 本脚本必须挂在「文件」条目上（作用域里有 $content）
if (typeof $content !== 'string' || $content.trim() === '') {
    throw new Error(
        '本脚本需挂在「文件」条目上使用：文件内容 = sing-box 模板（含 $SUB_STORE_NODES$ 占位符）',
    );
}

// 1) 解析模板
const sbConfig = JSON.parse(sbStripComments($content));

// 2) 拉取订阅节点（Sub-Store 原生 sing-box 转换，输出 {outbounds, endpoints}）
//    名字是精确匹配（区分大小写）；单条订阅找不到时自动回退尝试组合订阅

// 容错读取 Sub-Store 里的订阅名单，用于报错提示（拿不到就不提示，不影响主流程）
function sbListNames(key) {
    try {
        if (typeof $substore === 'undefined' || !$substore.read) return null;
        const list = $substore.read(key);
        if (!Array.isArray(list)) return null;
        return list.map((x) => x && x.name).filter(Boolean);
    } catch (e) {
        return null;
    }
}

function sbNotFound(detail) {
    const subs = sbListNames('#sub-store-subs');
    const cols = sbListNames('#sub-store-collections');
    let hint = '';
    if (subs && subs.length) hint += '\n现有单条订阅: ' + subs.join(' | ');
    if (cols && cols.length) hint += '\n现有组合订阅: ' + cols.join(' | ');
    if (hint) {
        hint += '\n请按上面的名单核对名称（区分大小写）';
    }
    return new Error(
        '找不到订阅「' + SUB_NAME + '」（' + detail + '）' + hint,
    );
}

const SB_FETCH = {
    name: SUB_NAME,
    platform: 'sing-box',
    noCache: SB_NO_CACHE,
};
let sbUsedType = SUB_TYPE;
let sbProduced;
try {
    sbProduced = JSON.parse(
        await produceArtifact(Object.assign({ type: sbUsedType }, SB_FETCH)),
    );
} catch (e1) {
    const msg1 = String((e1 && e1.message) || e1);
    if (SUB_TYPE === 'sub' && msg1.indexOf('找不到订阅') !== -1) {
        sbUsedType = 'collection';
        try {
            sbProduced = JSON.parse(
                await produceArtifact(
                    Object.assign({ type: sbUsedType }, SB_FETCH),
                ),
            );
        } catch (e2) {
            const msg2 = String((e2 && e2.message) || e2);
            throw sbNotFound('按单条订阅和组合订阅各找了一次: ' + msg2);
        }
    } else {
        throw e1;
    }
}

const sbNodes = [];
const sbEndpoints = Array.isArray(sbProduced.endpoints)
    ? sbProduced.endpoints.filter((e) => e && e.tag)
    : [];
for (const ob of sbProduced.outbounds || []) {
    if (!ob || typeof ob !== 'object' || !ob.tag) continue;
    if (ob.type === 'ssr') continue; // sing-box 已移除 ssr，跳过
    const type = ob.type === 'ss' ? 'shadowsocks' : ob.type;
    if (SB_PROXY_TYPES.indexOf(type) === -1) continue; // 跳过 direct/selector/urltest 等
    sbNodes.push(Object.assign({}, ob, { type }));
}
if (sbNodes.length === 0 && sbEndpoints.length === 0) {
    throw new Error(
        '订阅「' + SUB_NAME + '」(' + sbUsedType + ') 未获取到任何节点',
    );
}

// 3) 节点 tag 去重
const sbSeen = Object.create(null);
for (const n of sbNodes) {
    if (sbSeen[n.tag]) {
        let k = 2;
        while (sbSeen[n.tag + ' #' + k]) k++;
        n.tag = n.tag + ' #' + k;
    }
    sbSeen[n.tag] = true;
}
const sbTags = sbNodes.map((n) => n.tag);

// 4) 注入模板：顶层 outbounds 占位符 → 节点对象；策略组占位符 → 节点 tag
if (!Array.isArray(sbConfig.outbounds)) {
    throw new Error('模板缺少 outbounds 数组');
}
const sbIdx = sbConfig.outbounds.indexOf(PLACEHOLDER);
if (sbIdx === -1) {
    throw new Error('模板 outbounds 中找不到 $SUB_STORE_NODES$ 占位符');
}
sbConfig.outbounds.splice(sbIdx, 1, ...sbNodes);

let sbGroupHits = 0;
const sbWalk = (v) => {
    if (Array.isArray(v)) {
        const p = v.indexOf(PLACEHOLDER);
        if (p !== -1) {
            v.splice(p, 1, ...sbTags);
            sbGroupHits++;
        }
        v.forEach(sbWalk);
    } else if (v && typeof v === 'object') {
        Object.keys(v).forEach((k) => sbWalk(v[k]));
    }
};
sbWalk(sbConfig);
if (sbGroupHits === 0) {
    throw new Error('模板策略组中未找到 $SUB_STORE_NODES$ 占位符');
}
if (sbEndpoints.length > 0) {
    sbConfig.endpoints = (sbConfig.endpoints || []).concat(sbEndpoints);
}

// 5) 写回最终配置
$content = JSON.stringify(sbConfig, null, 2);
