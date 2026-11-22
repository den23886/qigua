/* 订单与人工开通：/api/order
   环境变量：ADMIN_PASS（必填，管理台密码）、FEISHU_WEBHOOK（可选，新订单推送到飞书/手机） */

const { getStore } = require('@netlify/blobs');

const PRICE = { A: '9.9', C: '19.9' };
const LABEL = { A: '每天8次（永久）', C: '继续追问（永久）' };

const baseHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json'
};

function json(code, obj) {
  return { statusCode: code, headers: baseHeaders, body: JSON.stringify(obj) };
}

function newId() {
  const t = Date.now().toString(36).slice(-4).toUpperCase();
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return 'QG' + t + r;
}

function store() {
  return getStore({ name: 'qigua-orders', consistency: 'strong' });
}

async function pushFeishu(text) {
  const url = process.env.FEISHU_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } })
    });
  } catch (e) { /* 通知失败不影响下单 */ }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: baseHeaders, body: '' };

  let body = {};
  if (event.httpMethod === 'POST') {
    try { body = JSON.parse(event.body || '{}'); } catch (e) { /* ignore */ }
  }
  const action = event.httpMethod === 'GET' ? 'status' : (body.action || '');

  try {
    const s = store();

    if (action === 'create') {
      const type = body.type === 'C' ? 'C' : 'A';
      const id = newId();
      const order = {
        id,
        type,
        amount: PRICE[type],
        label: LABEL[type],
        status: 'pending',
        createdAt: Date.now()
      };
      await s.setJSON(id, order);
      pushFeishu('【起个卦】新订单 ¥' + order.amount + '｜' + LABEL[type] + '｜' + id +
        '\n手机打开管理台确认：https://qigua-dl7k.netlify.app/admin.html');
      return json(200, { ok: true, id, amount: order.amount });
    }

    if (action === 'status') {
      const id = (event.queryStringParameters && event.queryStringParameters.id) || '';
      if (!id) return json(400, { ok: false, msg: '缺少订单号' });
      const o = await s.get(id, { type: 'json' });
      if (!o) return json(200, { ok: true, status: 'none' });
      return json(200, { ok: true, status: o.status, type: o.type });
    }

    const pass = process.env.ADMIN_PASS || '';
    if (!pass) return json(500, { ok: false, msg: '服务端未配置 ADMIN_PASS' });
    if (String(body.pass || '') !== pass) return json(401, { ok: false, msg: '管理密码错误' });

    if (action === 'list') {
      const { blobs } = await s.list();
      const out = [];
      for (const b of blobs.slice(0, 200)) {
        const o = await s.get(b.key, { type: 'json' });
        if (!o) continue;
        if (o.status === 'pending' || Date.now() - (o.createdAt || 0) < 1000 * 60 * 60 * 48) out.push(o);
      }
      out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return json(200, { ok: true, orders: out });
    }

    if (action === 'approve' || action === 'reject') {
      const o = await s.get(body.id, { type: 'json' });
      if (!o) return json(404, { ok: false, msg: '订单不存在' });
      o.status = action === 'approve' ? 'approved' : 'rejected';
      o.decidedAt = Date.now();
      await s.setJSON(o.id, o);
      return json(200, { ok: true, status: o.status });
    }

    return json(400, { ok: false, msg: '未知操作' });
  } catch (err) {
    return json(500, { ok: false, msg: '服务异常：' + (err && err.message ? err.message : String(err)) });
  }
};
