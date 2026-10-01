/***************************************
 * 中国联通 App Cookie 自动获取
 * 平台: QuantumultX (兼容 Loon / Surge 语法习惯)
 * 版本: 1.0.0
 * 更新: 2026-10-01
 * -------------------------------------
 * 【抓包来源】
 *   中国联通 iOS 客户端  iphone_c@12.1001 (build:6)
 *   UA: ChinaUnicom4.x/12.10.1 (com.chinaunicom.mobilebusiness; build:6; iOS) Alamofire/4.7.3
 *   登录域名: loginxx.10010.com / m.client.10010.com / m.10010.com / mxx.client.10010.com
 *
 * 【关键登录态 Cookie(抓包实测)】
 *   c_id        登录态唯一标识(64位hex)          —— 核心
 *   t3_token    会话令牌(32位hex)               —— 核心
 *   ecs_token   加密令牌(JWT样 base64)          —— 核心
 *   ecs_acc     加密手机号(与 enc_acc 同值)     —— 核心
 *   c_mobile    手机号 / u_account 手机号
 *   cw_mutual   风控校验串(128位hex)
 *   invalid_at  失效校验串(64位hex)
 *   login_type  登录方式(06=验证码/本机)
 *   PvSessionId / devicedId / d_deviceCode  设备会话
 *   city        号码归属(如 051|536|91413589|-99)
 *   channel     GGPD   c_version: iphone_c@12.1001
 *
 * 【工作方式】
 *   拦截请求头 Cookie → 与本地已存 Cookie 合并 → 核心字段齐全才入库
 *   → 仅当登录态指纹(c_id+t3_token+ecs_token)变化时写入并通知, 避免刷屏
 *
 * 【使用说明 · QuantumultX】
 *   1) [mitm] hostname 增加:
 *      loginxx.10010.com, m.client.10010.com, m.10010.com, mxx.client.10010.com, hlclient.10010.com
 *   2) [rewrite_local] 添加(任选, 推荐第 1 条即可覆盖登录全流程):
 *      ^https?:\/\/(loginxx|m|mxx)\.(client\.)?10010\.com\/ url script-request-header https://raw.githubusercontent.com/ning1168/vps/main/js/liantong_cookie.js
 *   3) 打开联通 App 触发一次请求即可自动抓取
 *
 * 【可选 · 远程推送】在 QX 中执行一次即可开启(把 Cookie POST 给你的服务器):
 *   $prefs.setValueForKey("https://your.host/api/unipush", "liantong_cookie_push")
 *   关闭: $prefs.setValueForKey("", "liantong_cookie_push")
 *
 * 【可选 · 查看已存 Cookie】浏览器/App 内访问任意一条命中域名的链接并带上:
 *   ?liantong_cookie_query=1
 *   脚本会直接返回已保存的 Cookie(JSON)
 ***************************************/

const LT_COOKIE_KEY = 'liantong_cookie';        // 完整 Cookie 存储键
const LT_META_KEY   = 'liantong_cookie_meta';   // 指纹/手机号/时间
const LT_PUSH_KEY   = 'liantong_cookie_push';   // 可选远程推送地址

const CORE_FIELDS = ['c_id', 't3_token', 'ecs_token'];   // 判定"已登录"的核心字段

// 输出顺序(其余字段自动追加在后面)
const KEEP_FIELDS = [
  'ecs_token', 't3_token', 'PvSessionId', 'devicedId', 'd_deviceCode',
  'cw_mutual', 'login_type', 'c_mobile', 'c_id', 'u_areaCode', 'c_version',
  'channel', 'wo_family', 'u_account', 'city', 'invalid_at', 'ecs_acc',
  'enc_acc', 'third_token', 'random_login', 'app_13_num', 'tag-service',
  'JSESSIONID', 'SHAREJSESSIONID', 'acw_tc'
];

/* ---------------- 存储适配(QX / Loon / Surge) ---------------- */
const store = {
  get(k) {
    try {
      if (typeof $prefs !== 'undefined' && $prefs.valueForKey) return $prefs.valueForKey(k);
      if (typeof $persistentStore !== 'undefined' && $persistentStore.read) return $persistentStore.read(k);
    } catch (e) {}
    return null;
  },
  set(v, k) {
    try {
      if (typeof $prefs !== 'undefined' && $prefs.setValueForKey) return $prefs.setValueForKey(v, k);
      if (typeof $persistentStore !== 'undefined' && $persistentStore.write) return $persistentStore.write(v, k);
    } catch (e) {}
    return false;
  }
};

function notify(title, sub, body) {
  try {
    if (typeof $notify !== 'undefined') { $notify(title, sub, body); return; }
    if (typeof $notification !== 'undefined') { $notification.post(title, sub, body); return; }
  } catch (e) {}
}

function log(msg) { console.log('[联通Cookie] ' + msg); }

/* ---------------- Cookie 工具 ---------------- */
function headerOf(headers, name) {
  if (!headers) return '';
  const hit = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
  return hit ? headers[hit] : '';
}

function parseCookie(str) {
  const map = {};
  String(str || '').split(';').forEach(item => {
    const s = item.trim();
    if (!s) return;
    const i = s.indexOf('=');
    if (i < 1) return;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim();
    if (k) map[k] = v;
  });
  return map;
}

// 从 Set-Cookie(可能是数组)中提取 名=值
function parseSetCookie(val) {
  const map = {};
  if (!val) return map;
  const list = Array.isArray(val) ? val : [val];
  list.forEach(one => {
    const first = String(one).split(';')[0].trim();
    const i = first.indexOf('=');
    if (i > 0) {
      const k = first.slice(0, i).trim();
      const v = first.slice(i + 1).trim();
      // 过滤无意义的空占位(如 logHostIP=)
      if (k && v) map[k] = v;
    }
  });
  return map;
}

function buildCookie(map) {
  const keys = [];
  KEEP_FIELDS.forEach(k => { if (map[k] !== undefined && map[k] !== '' && !keys.includes(k)) keys.push(k); });
  Object.keys(map).forEach(k => {
    // 跳过设备本地/统计类噪音字段
    if (/^(_pk_|tfstk|tianjin|SHOP_PROV_CITY|gipgeo|mallcity|ecs_cook|logHostIP$)/.test(k)) return;
    if (map[k] !== '' && !keys.includes(k)) keys.push(k);
  });
  return keys.map(k => k + '=' + map[k]).join('; ');
}

function fingerprint(map) {
  return [map.c_id, map.t3_token, map.ecs_token, map.c_mobile, map.invalid_at]
    .map(v => v || '-').join('|');
}

function short(v, n) {
  v = String(v || '');
  return v.length > n ? v.slice(0, n) + '…' : v;
}

function nowStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 东八区
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/* ---------------- 主流程 ---------------- */
(async () => {
  const url = ($request && $request.url) || '';

  // ===== 查询模式: ?liantong_cookie_query=1 =====
  if (/liantong_cookie_query/.test(url)) {
    const cookie = store.get(LT_COOKIE_KEY) || '';
    let meta = {};
    try { meta = JSON.parse(store.get(LT_META_KEY) || '{}'); } catch (e) {}
    const body = JSON.stringify({
      code: cookie ? 0 : -1,
      msg: cookie ? 'ok' : '尚未获取到联通 Cookie, 请打开联通 App 触发一次请求',
      phone: meta.phone || '',
      updated: meta.updated || '',
      cookie: cookie
    });
    $done({
      status: 'HTTP/1.1 200 OK',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: body
    });
    return;
  }

  try {
    const reqHeaders = (typeof $request !== 'undefined' && $request && $request.headers) || {};
    const respHeaders = (typeof $response !== 'undefined' && $response && $response.headers) || {};
    const reqMap = parseCookie(headerOf(reqHeaders, 'cookie'));
    const respMap = parseSetCookie(headerOf(respHeaders, 'set-cookie'));
    const incoming = Object.assign({}, reqMap, respMap);
    const got = Object.keys(incoming).length;
    if (!got) { log('本次未携带 Cookie, 跳过'); $done({}); return; }

    // 与本地已存 Cookie 合并(新旧互补, 新值优先)
    const merged = Object.assign({}, parseCookie(store.get(LT_COOKIE_KEY)));
    Object.keys(incoming).forEach(k => { if (incoming[k] !== '') merged[k] = incoming[k]; });

    // 登录态校验
    const missing = CORE_FIELDS.filter(k => !merged[k]);
    if (missing.length) {
      log('未登录完成, 缺少核心字段: ' + missing.join(', '));
      $done({});
      return;
    }

    // 指纹比对: 登录态未变化则只做静默更新(刷新 JSESSIONID 等易变字段), 不重复通知
    const fp = fingerprint(merged);
    let old = {};
    try { old = JSON.parse(store.get(LT_META_KEY) || '{}'); } catch (e) {}

    const cookie = buildCookie(merged);

    if (old.fp === fp && store.get(LT_COOKIE_KEY)) {
      if (store.get(LT_COOKIE_KEY) !== cookie) {
        store.set(cookie, LT_COOKIE_KEY);
        old.updated = nowStr();
        store.set(JSON.stringify(old), LT_META_KEY);
        log('登录态未变化, 已静默更新易变字段');
      } else {
        log('登录态未变化, 跳过');
      }
      $done({});
      return;
    }

    const phone = merged.c_mobile || merged.u_account || '';
    const meta = { fp: fp, phone: phone, updated: nowStr(), count: (old.count || 0) + 1 };

    store.set(cookie, LT_COOKIE_KEY);
    store.set(JSON.stringify(meta), LT_META_KEY);

    log('✅ Cookie 已更新 (' + (meta.count) + ' 次) 手机号: ' + phone);
    log('c_id=' + short(merged.c_id, 16) + ' t3_token=' + merged.t3_token);

    notify(
      '联通 Cookie 获取成功',
      '账号: ' + (phone || '未知') + '  ' + meta.updated,
      'c_id: ' + short(merged.c_id, 24) + '\nt3_token: ' + merged.t3_token
    );

    // ===== 可选: 远程推送 =====
    const pushUrl = store.get(LT_PUSH_KEY);
    if (pushUrl && /^https?:\/\//.test(pushUrl) && typeof $task !== 'undefined') {
      $task.fetch({
        url: pushUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({ phone: phone, cookie: cookie, updated: meta.updated })
      }).then(
        r => log('远程推送完成: HTTP ' + (r && r.statusCode)),
        e => log('远程推送失败: ' + e)
      );
    }
  } catch (e) {
    log('脚本异常: ' + e);
  }

  $done({});
})();
