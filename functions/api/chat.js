/* Cloudflare Pages Function: /api/chat
   前端不持有 Key，Key 只放在环境变量 DS_KEY 里 */

const UPSTREAM = 'https://api.deepseek.com/v1/chat/completions';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Content-Type': 'application/json'
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: CORS });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const key = env.DS_KEY;
  if (!key) return json({ error: { message: '服务端未配置 DS_KEY' } }, 500);

  let body = {};
  try { body = await request.json(); } catch (e) { /* ignore */ }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return json({ error: { message: 'messages 不能为空' } }, 400);

  const payload = {
    model: body.model || 'deepseek-chat',
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.85,
    stream: false,
    messages
  };

  try {
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key
      },
      body: JSON.stringify(payload)
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: Object.assign({}, CORS, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json'
      })
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return json({ error: { message: '上游请求失败：' + msg } }, 502);
  }
}
