// 云端 provider 维度自动识别：不依赖 STELLAR_EMBED_CLOUD_DIMENSION。
// 用一个 1536 维的假 OpenAI 兼容服务，验证 runtime 不再硬编码 1024。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-cloud-dim-'));
const discovery = path.join(temp, 'embedding-service.json');
const port = 20000 + Math.floor(Math.random() * 20000);
const cloudPort = 20000 + Math.floor(Math.random() * 20000);

const fake = http.createServer((req, res) => {
  if (req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [] }));
    return;
  }
  if (req.url !== '/v1/embeddings') { res.writeHead(404); res.end('no'); return; }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      model: payload.model,
      data: inputs.map((_, index) => ({
        object: 'embedding',
        index,
        embedding: Array.from({ length: 1536 }, (__, i) => (i === index ? 1 : 0)),
      })),
      usage: { prompt_tokens: inputs.length },
    }));
  });
});
await new Promise((resolve) => fake.listen(cloudPort, '127.0.0.1', resolve));

const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'plugins', 'stellar', 'runtime', 'embedding-service.mjs')], {
  env: {
    ...process.env,
    STELLAR_EMBED_PORT: String(port),
    STELLAR_EMBED_TOKEN: 'test-token',
    STELLAR_EMBED_DISCOVERY: discovery,
    STELLAR_EMBED_PID_FILE: path.join(temp, 'service.pid'),
    STELLAR_EMBED_OLLAMA_URL: `http://127.0.0.1:${cloudPort}`,
    STELLAR_EMBED_CLOUD_ENDPOINT: `http://127.0.0.1:${cloudPort}/v1/embeddings`,
    STELLAR_EMBED_CLOUD_MODEL: 'test-cloud',
    STELLAR_EMBED_CLOUD_SPACE: 'test-cloud@1536-cloud-v1',
    STELLAR_EMBED_API_KEY: 'test-key',
    STELLAR_EMBED_ALLOW_REMOTE: 'true',
    STELLAR_EMBED_CLOUD_DIMENSION: '',
    STELLAR_EMBED_DEFAULT_MODEL: 'test-cloud',
  },
  stdio: 'ignore',
  windowsHide: true,
});

async function waitDiscovery(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fs.existsSync(discovery)) {
      try { return JSON.parse(fs.readFileSync(discovery, 'utf8')); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('runtime discovery 超时');
}

try {
  await waitDiscovery();
  const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ model: 'test-cloud', input: ['你好', '世界'] }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.dimension, 1536);
  assert.equal(body.model_space, 'test-cloud@1536-cloud-v1');
  assert.equal(body.data.length, 2);
  assert.equal(body.data[0].embedding.length, 1536);
  console.log('cloud dimension auto-detect: pass');
} finally {
  child.kill('SIGTERM');
  fake.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
}
