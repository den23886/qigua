/* Cloudflare Pages Function: /api/order
   环境变量：ADMIN_PASS（必填）、FEISHU_WEBHOOK（可选）、AUTO_FROM / AUTO_TO（可选）
   存储：KV 绑定 QIGUA_KV */

const PRICE = { A: '9.9', C: '19.9' };
const LABEL = { A: '每天8次（永久）', C: '继续追问（永久）' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json'
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: CORS });
}
function html(status, body) {
  return new Response(
    '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font:16px/1.8 -apple-system,sans-serif;padding:40px 20px;text-align:center;color:#222">' + body + '</div>',
    { status: status || 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
function secret(env) { return env.ADMIN_PASS || ''; }
async function hmacHex(msg, key) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function approveSig(id, env) {
  return (await hmacHex('approve:' + id, secret(env))).slice(0, 16);
}
async function inAutoWindow(env) {
  const from = Number(env.AUTO_FROM || 20);
  const to = Number(env.AUTO_TO || 8);
  if (from === to) return false;
  const h = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
  return from > to ? (h >= from || h < to) : (h >= from && h < to);
}
function newId() {
  const t = Date.now().toString(36).slice(-4).toUpperCase();
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return 'QG' + t + r;
}
async function kvGet(env, id) {
  return env.QIGUA_KV.get('order_' + id, 'json');
}
async function kvPut(env, o) {
  await env.QIGUA_KV.put('order_' + o.id, JSON.stringify(o));
}
async function pushFeishu(text, env) {
  const url = env.FEISHU_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } })
    });
  } catch (e) { /* 通知失败不影响下单 */ }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = url.searchParams;
  const action = q.get('action') || 'status';

  try {
    if (!env.QIGUA_KV) return json({ ok: false, msg: '服务端未绑定 KV（QIGUA_KV）' }, 500);

    if (action === 'approve') {
      if (!secret(env)) return html(500, '服务端未配置 ADMIN_PASS');
      const id = q.get('id') || '';
      if (!id || q.get('sig') !== (await approveSig(id, env))) return html(403, '链接无效，请到管理台手动开通');
      const o = await kvGet(env, id);
      if (!o) return html(404, '订单不存在');
      if (o.status !== 'approved') {
        o.status = 'approved';
        o.decidedAt = Date.now();
        o.by = 'link';
        await kvPut(env, o);
      }
      return html(200, '✅ 已开通<br><b>¥' + o.amount + ' · ' + (o.label || '') + '</b><br><span style="color:#888;font-size:13px">订单 ' + o.id + '</span>');
    }

    if (action === 'status') {
      const id = q.get('id') || '';
      if (!id) return json({ ok: false, msg: '缺少订单号' }, 400);
      const o = await kvGet(env, id);
      if (!o) return json({ ok: true, status: 'none' });
      return json({ ok: true, status: o.status, type: o.type });
    }

    return json({ ok: false, msg: '未知操作' }, 400);
  } catch (err) {
    return json({ ok: false, msg: '服务异常：' + (err && err.message ? err.message : String(err)) }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch (e) { /* ignore */ }
  const action = body.action || '';

  try {
    if (!env.QIGUA_KV) return json({ ok: false, msg: '服务端未绑定 KV（QIGUA_KV）' }, 500);

    if (action === 'create') {
      const type = body.type === 'C' ? 'C' : 'A';
      const id = newId();
      const auto = await inAutoWindow(env);
      const order = {
        id, type,
        amount: PRICE[type],
        label: LABEL[type],
        status: auto ? 'approved' : 'pending',
        createdAt: Date.now()
      };
      if (auto) { order.decidedAt = Date.now(); order.by = 'auto'; }
      await kvPut(env, order);

      const site = new URL(request.url).origin;
      const link = site + '/api/order?action=approve&id=' + id + '&sig=' + (await approveSig(id, env));
      await pushFeishu(
        '【起个卦】新订单 ¥' + order.amount + ' · ' + LABEL[type] + '\n订单号 ' + id + '\n' +
        (auto ? '夜间自动开通已生效，请核对是否到账。' : '点此一键开通：\n' + link),
        env
      );
      return json({ ok: true, id, amount: order.amount, auto });
    }

    const pass = secret(env);
    if (!pass) return json({ ok: false, msg: '服务端未配置 ADMIN_PASS' }, 500);
    if (String(body.pass || '') !== pass) return json({ ok: false, msg: '管理密码错误' }, 401);

    if (action === 'list') {
      const listed = await env.QIGUA_KV.list({ prefix: 'order_', limit: 200 });
      const out = [];
      for (const k of listed.keys) {
        const o = await env.QIGUA_KV.get(k.name, 'json');
        if (!o) continue;
        if (o.status === 'pending' || Date.now() - (o.createdAt || 0) < 1000 * 60 * 60 * 48) out.push(o);
      }
      out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return json({ ok: true, orders: out });
    }

    if (action === 'approve' || action === 'reject') {
      const o = await kvGet(env, body.id);
      if (!o) return json({ ok: false, msg: '订单不存在' }, 404);
      o.status = action === 'approve' ? 'approved' : 'rejected';
      o.decidedAt = Date.now();
      await kvPut(env, o);
      return json({ ok: true, status: o.status });
    }

    return json({ ok: false, msg: '未知操作' }, 400);
  } catch (err) {
    return json({ ok: false, msg: '服务异常：' + (err && err.message ? err.message : String(err)) }, 500);
  }
}
