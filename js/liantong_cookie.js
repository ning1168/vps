/******************************
 * 联通 Cookie 抓取 | 2026-10-01
 * App: 中国联通 iOS (iphone_c@12.1001)
 * 平台: QuantumultX
 * 说明: 抓到登录态后存 $prefs, 点击通知自动复制 Cookie
 * 规则: 见同目录 liantong_cookie.conf
 ******************************/

const CKEY = 'liantong_cookie';       // 完整 Cookie
const MKEY = 'liantong_cookie_meta';  // 手机号/时间/指纹
const PKEY = 'liantong_cookie_push';  // 可选: 远程推送地址
const CORE = ['c_id', 't3_token', 'ecs_token'];
const ORDER = [
  'ecs_token', 't3_token', 'PvSessionId', 'devicedId', 'd_deviceCode',
  'cw_mutual', 'login_type', 'c_mobile', 'c_id', 'u_areaCode', 'c_version',
  'channel', 'wo_family', 'u_account', 'city', 'invalid_at', 'ecs_acc',
  'enc_acc', 'third_token', 'random_login'
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
function hdr(h, name) {
  if (!h) return '';
  const k = Object.keys(h).find(x => x.toLowerCase() === name.toLowerCase());
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
function now() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

(async () => {
  const url = (typeof $request !== 'undefined' && $request && $request.url) || '';

  // 复制页: m.10010.com/lt_cookie_copy
  if (/lt_cookie_copy/.test(url)) {
    const ck = get(CKEY) || '';
    let meta = {};
    try { meta = JSON.parse(get(MKEY) || '{}'); } catch (e) {}
    const esc = ck.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>联通 Cookie</title></head><body style="font:15px -apple-system;padding:16px">' +
      '<h3 style="margin:0 0 6px">联通 Cookie</h3>' +
      '<p style="color:#888;font-size:13px;margin:0 0 10px">' +
      (ck ? '账号: ' + (meta.phone || '未知') + ' · 更新: ' + (meta.updated || '') : '尚未获取到 Cookie, 请打开联通 App 触发一次请求') +
      '</p><textarea readonly style="width:100%;height:65vh;font:12px monospace;box-sizing:border-box;padding:8px">' +
      esc + '</textarea></body></html>';
    $done({ status: 'HTTP/1.1 200 OK', headers: { 'Content-Type': 'text/html;charset=UTF-8' }, body: html });
    return;
  }

  try {
    const incoming = Object.assign(
      {},
      parse(hdr((typeof $request !== 'undefined' && $request && $request.headers) || {}, 'cookie')),
      parseSet(hdr((typeof $response !== 'undefined' && $response && $response.headers) || {}, 'set-cookie'))
    );
    if (!Object.keys(incoming).length) { $done({}); return; }

    const m = Object.assign({}, parse(get(CKEY)));
    Object.keys(incoming).forEach(k => { if (incoming[k]) m[k] = incoming[k]; });

    const miss = CORE.filter(k => !m[k]);
    if (miss.length) { console.log('[联通Cookie] 未登录, 缺少 ' + miss.join(',')); $done({}); return; }

    const cookie = build(m);
    const fp = [m.c_id, m.t3_token, m.ecs_token, m.c_mobile, m.invalid_at].join('|');
    let old = {};
    try { old = JSON.parse(get(MKEY) || '{}'); } catch (e) {}

    // 登录态未变: 只静默刷新易变字段
    if (old.fp === fp && get(CKEY)) {
      if (get(CKEY) !== cookie) { set(cookie, CKEY); old.updated = now(); set(JSON.stringify(old), MKEY); }
      $done({});
      return;
    }

    const phone = m.c_mobile || m.u_account || '';
    const meta = { fp: fp, phone: phone, updated: now(), count: (old.count || 0) + 1 };
    set(cookie, CKEY);
    set(JSON.stringify(meta), MKEY);
    console.log('[联通Cookie] 更新成功 ' + phone + ' | ' + m.t3_token);

    // 通知: 点击通知即复制 Cookie 到剪贴板
    try {
      $notify('联通 Cookie 获取成功', '账号 ' + phone + ' · ' + meta.updated,
        '点击本通知自动复制 Cookie',
        { 'update-pasteboard': cookie, 'open-url': 'https://m.10010.com/lt_cookie_copy' });
    } catch (e) {}

    const push = get(PKEY);
    if (push && /^https?:\/\//.test(push) && typeof $task !== 'undefined') {
      $task.fetch({
        url: push, method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({ phone: phone, cookie: cookie, updated: meta.updated })
      }).then(r => console.log('[联通Cookie] 推送 ' + (r && r.statusCode)), e => console.log('[联通Cookie] 推送失败'));
    }
  } catch (e) {
    console.log('[联通Cookie] 异常: ' + e);
  }
  $done({});
})();
