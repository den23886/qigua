/* Netlify Serverless Function：/.netlify/functions/chat
   前端不再持有 API Key，Key 只放在环境变量 DS_KEY 里 */

const UPSTREAM = 'https://api.deepseek.com/v1/chat/completions';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: { message: '只支持 POST' } }) };
  }

  const key = process.env.DS_KEY;
  if (!key) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: { message: '服务端未配置 DS_KEY' } }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { /* ignore */ }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: { message: 'messages 不能为空' } }) };
  }

  const payload = {
    model: body.model || 'deepseek-chat',
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.85,
    stream: false, // Netlify Functions 不支持流式响应，强制非流式
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
    return {
      statusCode: upstream.status,
      headers: { ...headers, 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
      body: text
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: { message: '上游请求失败：' + msg } })
    };
  }
};
