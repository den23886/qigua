/* 订单与人工开通：/api/order
   环境变量：ADMIN_PASS（必填，管理台密码）、FEISHU_WEBHOOK（可选，新订单推送到飞书/手机） */

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const PRICE = { A: '9.9', C: '19.9' };
const LABEL = { A: '每天8次（永久）', C: '继续追问（永久）' };
const SITE = 'https://qigua-dl7k.netlify.app';

const baseHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json'
};

function json(code, obj) {
  return { statusCode: code, headers: baseHeaders, body: JSON.stringify(obj) };
}

function html(code, body) {
  return {
    statusCode: code,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<div style="font:16px/1.8 -apple-system,sans-serif;padding:40px 20px;text-align:center;color:#222">' + body + '</div>'
  };
}

/* 一键同意链接签名 */
function sign(id) {
  return crypto.createHmac('sha256', process.env.ADMIN_PASS || '').update('approve:' + id).digest('hex').slice(0, 16);
}

/* 夜间自动开通窗口（北京时间，默认 20:00 - 次日 08:00） */
function inAutoWindow() {
  const from = Number(process.env.AUTO_FROM || 20);
  const to = Number(process.env.AUTO_TO || 8);
  if (from === to) return false;
  const h = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
  return from > to ? (h >= from || h < to) : (h >= from && h < to);
}

function newId() {
  const t = Date.now().toString(36).slice(-4).toUpperCase();
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return 'QG' + t + r;
}

function store() {
  const opts = { name: 'qigua-orders', consistency: 'strong' };
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
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
  const q = event.queryStringParameters || {};
  const action = event.httpMethod === 'GET' ? (q.action || 'status') : (body.action || '');

  try {
    const s = store();

    /* 飞书里点「一键开通」直接走这里，不需要登录 */
    if (action === 'approve' && event.httpMethod === 'GET') {
      if (!process.env.ADMIN_PASS) return html(500, '服务端未配置 ADMIN_PASS');
      const id = q.id || '';
      if (!id || q.sig !== sign(id)) return html(403, '链接无效，请到管理台手动开通');
      const o = await s.get(id, { type: 'json' });
      if (!o) return html(404, '订单不存在');
      if (o.status !== 'approved') {
        o.status = 'approved';
        o.decidedAt = Date.now();
        o.by = 'link';
        await s.setJSON(id, o);
      }
      return html(200, '✅ 已开通<br><b>¥' + o.amount + ' · ' + (o.label || '') + '</b><br><span style="color:#888;font-size:13px">订单 ' + o.id + '</span>');
    }

    if (action === 'create') {
      const type = body.type === 'C' ? 'C' : 'A';
      const id = newId();
      const auto = inAutoWindow();
      const order = {
        id,
        type,
        amount: PRICE[type],
        label: LABEL[type],
        status: auto ? 'approved' : 'pending',
        createdAt: Date.now()
      };
      if (auto) { order.decidedAt = Date.now(); order.by = 'auto'; }
      await s.setJSON(id, order);

      const link = SITE + '/api/order?action=approve&id=' + id + '&sig=' + sign(id);
      await pushFeishu(
        '【起个卦】新订单 ¥' + order.amount + ' · ' + LABEL[type] + '\n订单号 ' + id + '\n' +
        (auto ? '夜间自动开通已生效，请核对是否到账。' : '点此一键开通：\n' + link)
      );
      return json(200, { ok: true, id, amount: order.amount, auto });
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
