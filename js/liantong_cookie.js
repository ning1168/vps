/******************************
 * 联通 Cookie 抓取 | 2026-10-01
 * App: 中国联通 iOS (iphone_c@12.1001)
 * 触发: 进「剩余话费 / 剩余流量」页面才弹通知
 * 通知: 正文显示完整 Cookie, 点击即复制, 不跳网页
 * 规则: 见同目录 liantong_cookie.conf
 ******************************/

const KEY = 'liantong_cookie';        // Cookie 存储键
const META = 'liantong_cookie_meta';  // 指纹/时间
const CORE = ['c_id', 't3_token', 'ecs_token'];  // 登录态核心字段
const GAP = 10 * 60 * 1000;           // 同一登录态 10 分钟内不重复弹

// 触发点: 点首页「剩余话费 / 剩余流量」进入时才会命中
const TRIGGER = [
  '/servicequerybusiness/balancenew/accountBalancenew.htm',
  '/servicequerybusiness/accountDay/check',
  '/mobileService/customer/getShareRedisInfo.htm'
];

const ORDER = [
  'ecs_token', 't3_token', 'PvSessionId', 'devicedId', 'cw_mutual',
  'login_type', 'c_mobile', 'c_id', 'u_areaCode', 'c_version', 'channel',
  'wo_family', 'u_account', 'city', 'invalid_at', 'ecs_acc', 'enc_acc',
  'third_token', 'random_login'
];

function get(k) {
  try { if (typeof $prefs !== 'undefined') return $prefs.valueForKey(k); } catch (e) {}
  try { if (typeof $persistentStore !== 'undefined') return $persistentStore.read(k); } catch (e) {}
  return null;
}
function set(v, k) {
  try { if (typeof $prefs !== 'undefined') return $prefs.setValueForKey(v, k); } catch (e) {}
  try { if (typeof $persistentStore !== 'undefined') return $persistentStore.write(v, k); } catch (e) {}
  return false;
}
function hdr(h, n) {
  if (!h) return '';
  const k = Object.keys(h).find(x => x.toLowerCase() === n.toLowerCase());
  return k ? h[k] : '';
}
function parse(str) {
  const m = {};
  String(str || '').split(';').forEach(it => {
    const s = it.trim(), i = s.indexOf('=');
    if (i > 0) m[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  });
  return m;
}
function parseSet(v) {
  const m = {};
  (Array.isArray(v) ? v : [v]).forEach(one => {
    const f = String(one || '').split(';')[0].trim(), i = f.indexOf('=');
    if (i > 0 && f.slice(i + 1).trim()) m[f.slice(0, i).trim()] = f.slice(i + 1).trim();
  });
  return m;
}
function build(m) {
  const ks = ORDER.filter(k => m[k]);
  Object.keys(m).forEach(k => {
    if (!m[k] || ks.includes(k)) return;
    if (/^(_pk_|tfstk|tianjin|SHOP_PROV_CITY|gipgeo|mallcity|ecs_cook|logHostIP$|JSESSIONID|acw_tc)/.test(k)) return;
    ks.push(k);
  });
  return ks.map(k => k + '=' + m[k]).join('; ');
}
function mask(p) {
  p = String(p || '');
  return p.length === 11 ? p.slice(0, 3) + '****' + p.slice(7) : (p || '未知');
}
function now() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

(async () => {
  try {
    const url = (typeof $request !== 'undefined' && $request && $request.url) || '';
    const inc = Object.assign(
      {},
      parse(hdr((typeof $request !== 'undefined' && $request && $request.headers) || {}, 'cookie')),
      parseSet(hdr((typeof $response !== 'undefined' && $response && $response.headers) || {}, 'set-cookie'))
    );
    if (!Object.keys(inc).length) { $done({}); return; }

    const m = Object.assign({}, parse(get(KEY)), inc);
    if (CORE.some(k => !m[k])) { console.log('[联通Cookie] 未登录, 跳过'); $done({}); return; }

    const cookie = build(m);
    let old = {};
    try { old = JSON.parse(get(META) || '{}'); } catch (e) {}

    // 有新内容就静默存下来, 保持 Cookie 新鲜(不弹通知)
    if (get(KEY) !== cookie) set(cookie, KEY);

    // 只在触发页 + (换了登录态 或 超过间隔) 时弹通知
    const hit = TRIGGER.some(t => url.indexOf(t) >= 0);
    if (!hit) { $done({}); return; }
    if (old.cid === m.c_id && Date.now() - (old.last || 0) < GAP) {
      console.log('[联通Cookie] 已是最新, 不重复提醒');
      $done({});
      return;
    }

    const phone = mask(m.c_mobile || m.u_account);
    const time = now();
    set(JSON.stringify({ cid: m.c_id, phone: phone, last: Date.now(), updated: time }), META);
    console.log('[联通Cookie] 已获取 ' + phone);

    // 通知正文 = 完整 Cookie; 点击通知复制到剪贴板, 不跳转网页
    try {
      $notify('联通 Cookie 已获取', phone + ' · ' + time + ' · 点击复制',
        cookie, { 'update-pasteboard': cookie });
    } catch (e) {}
  } catch (e) {
    console.log('[联通Cookie] 异常: ' + e);
  }
  $done({});
})();
