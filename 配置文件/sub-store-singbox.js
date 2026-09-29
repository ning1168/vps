/**
 * Sub-Store → sing-box 1.14.x 配置注入脚本【文件脚本 / 脚本位置：脚本操作】
 *
 * 用法（就是 Sub-Store 官方文档 file/scripts 里那套「用脚本生成整份配置」的做法）：
 *   1) 新建「文件」：内容/远程链接 = sing-box 完整模板（如 config-windows.json 全文）
 *   2) 该文件 → 脚本位置选「脚本操作」→ 脚本内容填本脚本（或用脚本链接引用它）
 *      脚本参数： { "name": "你的订阅名", "type": "1" }
 *   3) 客户端拉文件链接：http://<域名>/api/file/<文件名>
 *   用脚本链接时参数写在 # 片段里：
 *      https://.../substore-inject-file.js#name=我的机场&type=1#noCache
 *
 * 参数：
 *   name          必填：订阅名或组合订阅名（要和 Sub-Store 里显示的一致）
 *   type          选填：1 / collection / col → 组合订阅；0 / 省略 → 单个订阅
 *   file/template 选填：模板改从别的文件/网址取（默认用本文件的内容）
 *   placeholder   选填：模板里的占位节点标签，默认「节点-占位符」
 *   keepInfoNodes 选填：1 → 不过滤机场信息节点（默认过滤「剩余流量/到期时间/官网」这类）
 *
 * 前置：Node 自建后端必须设置 SUB_STORE_FRONTEND_BACKEND_PATH=/（否则脚本不执行）；
 *       文件「类型」不要选 mihomo 配置（那种类型 Sub-Store 会走自己的 YAML 合并分支）。
 */

// ===== 共用核心（本段与 substore-inject-response.js 逐字相同，改动请两边同步）=====

async function buildSingBoxConfig(incoming, args) {
  var LOG = function (msg) {
    try {
      console.log('[sing-box 注入] ' + msg);
    } catch (e) {}
  };
  args = args && typeof args === 'object' ? args : {};
  var PLACEHOLDER = args.placeholder ? String(args.placeholder) : '节点-占位符';
  var GROUP_TYPES = ['selector', 'urltest'];

  var nodeName = args.name || args.sub || args.collection;
  var templateText = '';
  var nodesInput = null;

  if (nodeName) {
    // 节点来自订阅/组合订阅；模板来自参数或本次输入
    if (args.file || args.template) templateText = await readTemplate(args);
    else templateText = incoming;
    nodesInput = await readNodes({
      name: String(nodeName),
      collection: args.collection != null || isCollectionType(args.type),
    });
  } else {
    if (!args.file && !args.template) {
      throw new Error(
        '缺少脚本参数：给节点来源就写 "#name=订阅名&type=1"；给模板来源就写 "#file=模板文件名" 或 "#template=模板地址"'
      );
    }
    templateText = await readTemplate(args);
    nodesInput = incoming;
  }

  if (!templateText) throw new Error('模板内容为空：检查文件的远程链接/内容，或 #file / #template 参数');
  var config = parseConfig(templateText);
  if (!config || typeof config !== 'object') throw new Error('模板不是合法的 JSON 对象');
  if (!config.inbounds || !config.route) {
    throw new Error('这份内容不像 sing-box 完整模板（缺少 inbounds / route），参数可能配反了');
  }

  var nodes = normalizeNodes(nodesInput);
  if (nodes.length === 0) throw new Error('订阅里没有解析出任何节点，已放弃注入（避免产出不可用配置）');

  // ---- 过滤机场信息节点（剩余流量 / 到期时间 / 官网 等，它们永远连不通，会拖垮自动测速）----
  var infoRe = /网址|网站|获取|订阅|流量|到期|余量|续费|过期|重置|套餐|官网|面板|剩余|更新|优惠|折扣|试用|防失联|加群|电报|通知|公告|说明|教程|客服|频道|群组|机场|expire|traffic|reset/i;
  if (!isTruthy(args.keepInfoNodes)) {
    var kept = nodes.filter(function (n) {
      return !infoRe.test(String(n.tag || ''));
    });
    if (kept.length > 0 && kept.length < nodes.length) {
      LOG('已过滤 ' + (nodes.length - kept.length) + ' 个机场信息节点');
      nodes = kept;
    } else if (kept.length === 0) {
      LOG('警告：所有节点标签都命中信息节点关键字，已放弃过滤');
    }
  }

  // ---- 标签去重（节点之间 + 与模板内置出站/endpoints 撞名）----
  var used = {};
  (config.outbounds || []).forEach(function (o) {
    if (o && o.tag) used[o.tag] = true;
  });
  (config.endpoints || []).forEach(function (o) {
    if (o && o.tag) used[o.tag] = true;
  });
  used[PLACEHOLDER] = true;

  var finalTags = [];
  var injected = nodes.map(function (node) {
    var base = node && node.tag ? String(node.tag) : '节点';
    var tag = base;
    var i = 1;
    while (used[tag]) tag = base + ' ' + ++i;
    used[tag] = true;
    finalTags.push(tag);
    var copy = {};
    for (var k in node) copy[k] = node[k];
    copy.tag = tag;
    return copy;
  });

  // WireGuard / Tailscale 在 sing-box 1.13.0 起只能作为 endpoint 放在 endpoints 里，
  // 放进 outbounds 会直接启动失败（outbound: WireGuard outbound is removed）。
  var injectedEndpoints = injected.filter(function (o) {
    return o.type === 'wireguard' || o.type === 'tailscale';
  });
  var injectedOutbounds = injected.filter(function (o) {
    return o.type !== 'wireguard' && o.type !== 'tailscale';
  });

  config.outbounds = (config.outbounds || []).filter(function (o) {
    return !(o && o.tag === PLACEHOLDER);
  });
  injectedOutbounds.forEach(function (o) {
    config.outbounds.push(o);
  });
  if (injectedEndpoints.length > 0) {
    config.endpoints = (config.endpoints || []).concat(injectedEndpoints);
  }

  // ---- 把分组里的占位标记展开成全部节点标签 ----
  var touched = 0;
  var groups = [];
  config.outbounds.forEach(function (o) {
    if (!o || GROUP_TYPES.indexOf(o.type) < 0 || !Array.isArray(o.outbounds)) return;
    if (o.outbounds.indexOf(PLACEHOLDER) >= 0) {
      o.outbounds = o.outbounds.reduce(function (acc, t) {
        return acc.concat(t === PLACEHOLDER ? finalTags : [t]);
      }, []);
      touched++;
      groups.push(o.tag + '(' + o.outbounds.length + ')');
    }
    if (o.default === PLACEHOLDER) o.default = finalTags[0];
  });
  if (touched === 0) {
    LOG('警告：模板分组里没有出现「' + PLACEHOLDER + '」，注入的节点不会被任何分组引用');
  }
  // 删掉占位节点后可能变成空分组
  config.outbounds = config.outbounds.filter(function (o) {
    return !(
      o &&
      GROUP_TYPES.indexOf(o.type) >= 0 &&
      Array.isArray(o.outbounds) &&
      o.outbounds.length === 0
    );
  });

  LOG(
    '节点 ' + injected.length + ' 个（含 endpoint ' + injectedEndpoints.length + ' 个）→ 分组 ' +
      (groups.join('、') || '无') + '；最终出站 ' + config.outbounds.length + ' 个' +
      (config.endpoints ? '、endpoint ' + config.endpoints.length + ' 个' : '')
  );
  return JSON.stringify(config, null, 2);
}

function isCollectionType(type) {
  var t = String(type == null ? '' : type).toLowerCase();
  return t === '1' || t === 'true' || t === 'collection' || t === 'col';
}

function isTruthy(v) {
  if (v === undefined || v === null || v === '' || v === false) return false;
  var s = String(v).toLowerCase();
  return !(s === '0' || s === 'false' || s === 'no');
}

async function readTemplate(args) {
  if (args.file) return await produceArtifact({ type: 'file', name: String(args.file) });
  return await ProxyUtils.download(String(args.template));
}

async function readNodes(opts) {
  return await produceArtifact({
    type: opts.collection ? 'collection' : 'subscription',
    name: opts.name,
    platform: 'sing-box',
    produceType: 'internal',
  });
}

/** 把 produceArtifact 的结果统一成节点数组（internal 格式本来就是数组，字符串格式做兜底）*/
function normalizeNodes(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object') {
    if (Array.isArray(input.outbounds) || Array.isArray(input.endpoints)) {
      return [].concat(input.outbounds || [], input.endpoints || []);
    }
    return [input];
  }
  if (typeof input === 'string') {
    var parsed = parseConfig(input);
    if (parsed && (Array.isArray(parsed.outbounds) || Array.isArray(parsed.endpoints))) {
      return [].concat(parsed.outbounds || [], parsed.endpoints || []);
    }
  }
  return [];
}

/** 解析配置：优先用 Sub-Store 自带的 JSON5（能吃注释），失败再自己去掉注释 */
function parseConfig(text) {
  var raw = String(text == null ? '' : text);
  if (ProxyUtils && ProxyUtils.JSON5 && typeof ProxyUtils.JSON5.parse === 'function') {
    try {
      return ProxyUtils.JSON5.parse(raw);
    } catch (e) {
      /* 落到下面 */
    }
  }
  return JSON.parse(stripComments(raw));
}

/** 去掉 // 与块注释（跳过字符串内部），即使用户往模板里写了注释也不会炸 */
function stripComments(text) {
  var out = '';
  var inString = false;
  var esc = false;
  var inLine = false;
  var inBlock = false;
  for (var i = 0; i < text.length; i++) {
    var c = text.charAt(i);
    var n = text.charAt(i + 1);
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

// ===== 入口（文件脚本：Sub-Store 会把 $content / $files 放在作用域里，赋值 $content 即输出）=====

if (typeof $files !== 'undefined' || typeof $content !== 'undefined') {
  const __args = $arguments && typeof $arguments === 'object' ? $arguments : {};
  const __incoming = $content != null ? $content : ($files || [])[0];
  $content = await buildSingBoxConfig(__incoming, __args);
  if (Array.isArray($files)) $files = [$content];
}
