// 零依赖本地服务：提供静态页面，并把大模型请求转发到兼容 OpenAI 接口的服务商。
// API Key 只保存在服务端的 .env 里，不会发到浏览器。
// 运行：node server.js   （需要 Node 18 及以上）
const http = require('http');
const fs = require('fs');
const path = require('path');

// 读取 .env（不依赖 dotenv）
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = Number(process.env.PORT) || 3000;
const BASE = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || '';
const AI_ON = !!(BASE && KEY && MODEL);
const ROOT = path.join(__dirname, 'public');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) { reject(new Error('请求太大')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleLLM(req, res) {
  if (!AI_ON) return send(res, 400, { error: '没有配置模型，请在 .env 中填写 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL' });
  try {
    const { messages } = JSON.parse(await readBody(req));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, messages, temperature: 0.2 }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, 502, { error: (data.error && data.error.message) || `模型服务返回 ${r.status}` });
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) return send(res, 502, { error: '模型没有返回内容' });
    send(res, 200, { content });
  } catch (e) {
    send(res, 502, { error: e.name === 'AbortError' ? '模型响应超时' : e.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/config') return send(res, 200, { aiEnabled: AI_ON, model: AI_ON ? MODEL : '' });
  if (url.pathname === '/api/llm' && req.method === 'POST') return handleLLM(req, res);

  let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT)) return send(res, 403, '禁止访问', 'text/plain; charset=utf-8');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, '没有找到这个文件', 'text/plain; charset=utf-8');
    send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
  });
});

server.listen(PORT, () => {
  console.log(`AI 产品工作台已启动：http://localhost:${PORT}`);
  console.log(AI_ON ? `已接入模型：${MODEL}` : '未配置模型，运行在演示模式（复制 .env.example 为 .env 并填写即可接入）');
});
