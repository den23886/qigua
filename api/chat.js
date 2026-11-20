/* 服务端代理：/api/chat
   前端不再持有 API Key，Key 只放在环境变量 DS_KEY 里 */

const UPSTREAM = 'https://api.deepseek.com/v1/chat/completions';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: '只支持 POST' } });

  const key = process.env.DS_KEY;
  if (!key) return res.status(500).json({ error: { message: '服务端未配置 DS_KEY' } });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return res.status(400).json({ error: { message: 'messages 不能为空' } });

  const payload = {
    model: body.model || 'deepseek-chat',
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.85,
    stream: body.stream !== false,
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

    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');

    if (payload.stream && upstream.body && typeof upstream.body.getReader === 'function') {
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    }

    const text = await upstream.text();
    return res.end(text);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return res.status(502).json({ error: { message: '上游请求失败：' + msg } });
  }
};
