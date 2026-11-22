/* Cloudflare Pages Function: /api/account
   环境变量：ADMIN_PASS（令牌签名密钥）
   存储：KV 绑定 QIGUA_KV */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Content-Type': 'application/json'
};
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: CORS });
}
const enc = new TextEncoder();
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hmacHex(msg, key) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function secret(env) { return env.ADMIN_PASS || 'qigua-default-secret'; }
async function tokenFor(phone, env) {
  return phone + '.' + (await hmacHex('acct:' + phone, secret(env))).slice(0, 24);
}
async function phoneOf(token, env) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return '';
  const phone = parts[0];
  if (!/^1\d{10}$/.test(phone)) return '';
  return (await tokenFor(phone, env)) === token ? phone : '';
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  if (!env.QIGUA_KV) return json({ ok: false, msg: '服务端未绑定 KV（QIGUA_KV）' }, 500);

  let body = {};
  try { body = await request.json(); } catch (e) { /* ignore */ }

  const phone = String(body.phone || '').trim();
  const pass = String(body.pass || '');
  const action = body.action || '';

  try {
    if (action === 'register' || action === 'login') {
      if (!/^1\d{10}$/.test(phone)) return json({ ok: false, msg: '请输入 11 位手机号' }, 400);
      if (pass.length < 6) return json({ ok: false, msg: '密码至少 6 位' }, 400);

      const key = 'acct_' + phone;
      const exist = await env.QIGUA_KV.get(key, 'json');

      if (action === 'register') {
        if (exist) return json({ ok: false, msg: '该手机号已注册，请直接登录' }, 409);
        const salt = Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2, '0')).join('');
        const acct = { phone, salt, hash: await sha256Hex(salt + ':' + pass), ent: {}, createdAt: Date.now() };
        await env.QIGUA_KV.put(key, JSON.stringify(acct));
        return json({ ok: true, token: await tokenFor(phone, env), ent: {}, phone });
      }

      if (!exist) return json({ ok: false, msg: '账号不存在，请先注册' }, 404);
      if ((await sha256Hex(exist.salt + ':' + pass)) !== exist.hash) return json({ ok: false, msg: '密码错误' }, 401);
      return json({ ok: true, token: await tokenFor(phone, env), ent: exist.ent || {}, phone });
    }

    const me = await phoneOf(body.token, env);
    if (!me) return json({ ok: false, msg: '登录已失效，请重新登录' }, 401);
    const key = 'acct_' + me;
    const acct = await env.QIGUA_KV.get(key, 'json');
    if (!acct) return json({ ok: false, msg: '账号不存在' }, 404);

    if (action === 'me') return json({ ok: true, phone: me, ent: acct.ent || {} });

    if (action === 'sync') {
      const inc = body.ent || {};
      const ent = acct.ent || {};
      if (inc.plus5) ent.plus5 = true;
      if (inc.chat) ent.chat = true;
      acct.ent = ent;
      await env.QIGUA_KV.put(key, JSON.stringify(acct));
      return json({ ok: true, ent, phone: me });
    }

    return json({ ok: false, msg: '未知操作' }, 400);
  } catch (err) {
    return json({ ok: false, msg: '服务异常：' + (err && err.message ? err.message : String(err)) }, 500);
  }
}
