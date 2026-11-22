/* 账号与权益同步：/api/account
   环境变量复用：ADMIN_PASS（令牌签名密钥）、BLOBS_SITE_ID / BLOBS_TOKEN */

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const baseHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Content-Type': 'application/json'
};
function json(code, obj) {
  return { statusCode: code, headers: baseHeaders, body: JSON.stringify(obj) };
}
function store() {
  const opts = { name: 'qigua-accounts', consistency: 'strong' };
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}
function secret() { return process.env.ADMIN_PASS || 'qigua-default-secret'; }
function hashPass(pass, salt) {
  return crypto.createHash('sha256').update(salt + ':' + pass).digest('hex');
}
function tokenFor(phone) {
  const sig = crypto.createHmac('sha256', secret()).update('acct:' + phone).digest('hex').slice(0, 24);
  return phone + '.' + sig;
}
function phoneOf(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return '';
  const phone = parts[0];
  if (!/^1\d{10}$/.test(phone)) return '';
  return tokenFor(phone) === token ? phone : '';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: baseHeaders, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, msg: '只支持 POST' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { /* ignore */ }

  const phone = String(body.phone || '').trim();
  const pass = String(body.pass || '');
  const action = body.action || '';

  try {
    const s = store();

    if (action === 'register' || action === 'login') {
      if (!/^1\d{10}$/.test(phone)) return json(400, { ok: false, msg: '请输入 11 位手机号' });
      if (pass.length < 6) return json(400, { ok: false, msg: '密码至少 6 位' });

      const key = 'acct_' + phone;
      const exist = await s.get(key, { type: 'json' });

      if (action === 'register') {
        if (exist) return json(409, { ok: false, msg: '该手机号已注册，请直接登录' });
        const salt = crypto.randomBytes(8).toString('hex');
        const acct = { phone, salt, hash: hashPass(pass, salt), ent: {}, createdAt: Date.now() };
        await s.setJSON(key, acct);
        return json(200, { ok: true, token: tokenFor(phone), ent: acct.ent, phone });
      }

      if (!exist) return json(404, { ok: false, msg: '账号不存在，请先注册' });
      if (hashPass(pass, exist.salt) !== exist.hash) return json(401, { ok: false, msg: '密码错误' });
      return json(200, { ok: true, token: tokenFor(phone), ent: exist.ent || {}, phone });
    }

    const me = phoneOf(body.token);
    if (!me) return json(401, { ok: false, msg: '登录已失效，请重新登录' });
    const key = 'acct_' + me;
    const acct = await s.get(key, { type: 'json' });
    if (!acct) return json(404, { ok: false, msg: '账号不存在' });

    if (action === 'me') {
      return json(200, { ok: true, phone: me, ent: acct.ent || {} });
    }

    if (action === 'sync') {
      const inc = body.ent || {};
      const ent = acct.ent || {};
      if (inc.plus5) ent.plus5 = true;
      if (inc.chat) ent.chat = true;
      acct.ent = ent;
      await s.setJSON(key, acct);
      return json(200, { ok: true, ent, phone: me });
    }

    return json(400, { ok: false, msg: '未知操作' });
  } catch (err) {
    return json(500, { ok: false, msg: '服务异常：' + (err && err.message ? err.message : String(err)) });
  }
};
