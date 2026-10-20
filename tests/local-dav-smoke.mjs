// 跨设备同步的真实往返测试：本地起一个最小 WebDAV，扩展真的往它 PUT / 从它 GET。
//
//   node tests/local-dav-smoke.mjs
//
// 和 scripts/test-sync.mjs 的分工：那边用 fetch mock 测逻辑，这里测「真网络」——
// Basic 认证头、PUT 的请求体、目录创建顺序、GET 回来的密文能不能解开。
// 不连真坚果云：那要用户的账号，而且会把测试数据写进人家网盘。

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = '/tmp/nai-dav-build';
const PROFILE = '/tmp/nai-dav-profile';
const HOST = 'nai.idlecloud.cc';
const PORT = 8131;
const DAV_PORT = 8132;
const DEBUG_PORT = 9336;
const CHROME = process.env.CHROME_PATH
  || '/home/administrator/.cache/ms-playwright/chromium-1187/chrome-linux/chrome';

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed });
  console.log(`  ${passed ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 最小 WebDAV：只实现同步会用到的那几个方法 ──
const files = new Map();
const requests = [];

function startDav() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const auth = String(req.headers.authorization || '');
      requests.push({ method: req.method, url: req.url, auth, length: body.length });

      if (!/^Basic /.test(auth)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dav"' });
        res.end('unauthorized');
        return;
      }

      const decode = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      if (decode !== 'tester:app-password') {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dav"' });
        res.end('unauthorized');
        return;
      }

      if (req.method === 'PROPFIND') {
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        res.end('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>');
        return;
      }
      if (req.method === 'MKCOL') {
        if (files.has(req.url)) {
          res.writeHead(405);
          res.end();
          return;
        }
        files.set(req.url, null);
        res.writeHead(201);
        res.end();
        return;
      }
      if (req.method === 'PUT') {
        files.set(req.url, body);
        res.writeHead(201);
        res.end();
        return;
      }
      if (req.method === 'GET') {
        if (!files.has(req.url) || files.get(req.url) === null) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(files.get(req.url));
        return;
      }
      res.writeHead(405);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(DAV_PORT, '127.0.0.1', () => resolve(server)));
}

// ── 替身页 ──
const { IDLECLOUD_FIXTURE_HTML } = await import('./idlecloud-fixture.mjs');

function startFixture() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/fixture')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(IDLECLOUD_FIXTURE_HTML);
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

function prepareBuild() {
  fs.rmSync(BUILD, { recursive: true, force: true });
  execFileSync('rsync', ['-a', '--exclude', 'node_modules', '--exclude', '.git', '--exclude', 'tests', `${ROOT}/`, `${BUILD}/`]);
  const manifestPath = path.join(BUILD, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.content_scripts = manifest.content_scripts.map((entry) => ({
    ...entry,
    matches: Array.from(new Set([...(entry.matches || []), `http://${HOST}:${PORT}/*`])),
  }));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

async function encryptForDav(payload, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const keyMaterial = await crypto.webcrypto.subtle.importKey('raw', Buffer.from(passphrase, 'utf8'), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ciphertext = await crypto.webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    Buffer.from(JSON.stringify(payload), 'utf8'),
  );
  return {
    format: 'nai-autocomplete-sync',
    version: 1,
    alg: 'AES-GCM',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    data: Buffer.from(ciphertext).toString('base64'),
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  return response.json();
}

async function waitForDebugger() {
  for (let i = 0; i < 60; i += 1) {
    try {
      return await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    } catch (error) {
      await sleep(250);
    }
  }
  throw new Error('Chrome 调试端口没起来');
}

function createClient(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  return {
    ready,
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(client, sessionId, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function main() {
  const manifest = prepareBuild();
  const dav = await startDav();
  const fixture = await startFixture();
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-proxy-server',
    '--hide-scrollbars',
    '--window-size=1440,900',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
    `--user-data-dir=${PROFILE}`,
    `--disable-extensions-except=${BUILD}`,
    `--load-extension=${BUILD}`,
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    const version = await waitForDebugger();
    const client = createClient(version.webSocketDebuggerUrl);
    await client.ready;

    let extensionId = '';
    for (let i = 0; i < 40 && !extensionId; i += 1) {
      const { targetInfos } = await client.send('Target.getTargets');
      const worker = targetInfos.find((info) => info.url.startsWith('chrome-extension://'));
      if (worker) extensionId = new URL(worker.url).host;
      else await sleep(250);
    }
    check('扩展已启动', Boolean(extensionId), extensionId);

    // 直接开独立画师记录本页——同步抽屉在那里，不依赖站点
    const created = await client.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/pages/artist-library.html`,
    });
    const page = await client.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    await client.send('Runtime.enable', {}, page.sessionId);
    await client.send('Page.enable', {}, page.sessionId);

    let loaded = false;
    for (let i = 0; i < 40 && !loaded; i += 1) {
      loaded = await evaluate(client, page.sessionId, `Boolean(document.querySelector('[data-action="toggleSyncPanel"]'))`);
      if (!loaded) await sleep(250);
    }
    check('画师记录本页加载', loaded);

    // artist 页的 bundle 是同步脚本，解析会卡在 script 标签上；等它彻底加载完再点
    for (let i = 0; i < 60; i += 1) {
      const ready = await evaluate(client, page.sessionId, `document.readyState === 'complete' && Boolean(document.getElementById('syncPanelSlot'))`);
      if (ready) break;
      await sleep(200);
    }
    await evaluate(client, page.sessionId, `document.querySelector('[data-action="toggleSyncPanel"]').click()`);
    let mounted = false;
    for (let i = 0; i < 30 && !mounted; i += 1) {
      mounted = await evaluate(client, page.sessionId, `Boolean(document.querySelector('#syncPanelSlot [data-sync-field="url"]'))`);
      if (!mounted) await sleep(200);
    }
    check('同步抽屉挂载', mounted);

    const fill = await evaluate(client, page.sessionId, `(() => {
      const set = (field, value) => {
        const input = document.querySelector('[data-sync-field="' + field + '"]');
        if (!input) return false;
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      };
      return [
        set('url', 'http://127.0.0.1:${DAV_PORT}/dav/'),
        set('username', 'tester'),
        set('password', 'app-password'),
        set('remotePath', '/nai-autocomplete/nai-autocomplete-sync.json'),
        set('passphrase', 'smoke passphrase'),
      ].every(Boolean);
    })()`);
    check('同步配置填得进去', fill === true);

    // 先在本地放一条画师数据，确认真的会被推上去
    await evaluate(client, page.sessionId, `new Promise((resolve) => chrome.storage.local.set({
      naiArtistTracker_v1: JSON.stringify({ artists: [{ id: 'x1', name: 'DAV 测试画师', tag: 'artist:dav_test', rating: 4, notes: '', categories: [] }], labels: [], artistStrings: [], pages: [{ id: 'default', name: '画师库' }], activePageId: 'default' })
    }, resolve))`);

    await evaluate(client, page.sessionId, `document.querySelector('[data-action="sync-test"]').click()`);
    let statusText = '';
    for (let i = 0; i < 60; i += 1) {
      statusText = await evaluate(client, page.sessionId, `document.querySelector('[data-sync-status]')?.textContent || ''`);
      if (statusText && !/正在测试连接/.test(statusText)) break;
      await sleep(200);
    }
    check('测试连接能通到本地 DAV', /远端还没有同步文件|连接正常/.test(statusText), statusText);

    await evaluate(client, page.sessionId, `document.querySelector('[data-action="sync-both"]').click()`);
    for (let i = 0; i < 80; i += 1) {
      statusText = await evaluate(client, page.sessionId, `document.querySelector('[data-sync-status]')?.textContent || ''`);
      if (/同步完成|同步失败/.test(statusText)) break;
      await sleep(200);
    }
    check('第一次同步推送成功', /同步完成/.test(statusText), statusText);

    const put = requests.filter((item) => item.method === 'PUT').pop();
    check('服务端真的收到了 PUT', Boolean(put), put ? `${put.url} ${put.length}B` : '没有');
    const remoteBody = put ? String(files.get(put.url)) : '';
    check('PUT 上去的是密文（没有明文画师名）', Boolean(remoteBody) && !remoteBody.includes('DAV 测试画师') && !remoteBody.includes('artist:dav_test'));
    let parsed = null;
    try { parsed = JSON.parse(remoteBody); } catch (error) { parsed = null; }
    check('远端文件是同步格式', parsed?.format === 'nai-autocomplete-sync' && Boolean(parsed?.data), JSON.stringify(parsed?.format));
    check('请求带 Basic 认证', put?.auth?.startsWith('Basic ') === true);

    // 模拟另一台设备：云端换成一份更新的、含别的画师的数据
    const encrypted = await evaluate(client, page.sessionId, `new Promise((resolve) => {
      chrome.storage.local.get('nai-sync-config', (result) => resolve(Boolean(result['nai-sync-config']?.passphrase)));
    })`);
    check('口令存在本地', encrypted === true);

    // 第二次同步：把远端文件改成"另一台设备写的"（用同一口令加密），确认能拉下来
    const remoteDoc = {
      format: 'nai-autocomplete-sync',
      version: 1,
      deviceId: 'device-phone',
      updatedAt: Date.now() + 5000,
      entries: {
        'nai-shared-prompt-library': { at: Date.now() + 5000, value: { entries: [{ id: 'p1', name: '手机上的词条' }] } },
      },
    };
    // 测试端自己按同一套算法加密（core 在 bundle 的 IIFE 里，页面主世界拿不到）
    const blob = await encryptForDav(remoteDoc, 'smoke passphrase');
    const putUrl = put.url;
    files.set(putUrl, Buffer.from(JSON.stringify(blob)));
    // 让基线认为「本地从没同步过」，否则会被判成均未变更
    await evaluate(client, page.sessionId, `new Promise((resolve) => chrome.storage.local.set({ 'nai-sync-state': { base: {}, lastSyncAt: 0 } }, resolve))`);

    // 清掉上一次的结果，否则轮询会立刻读到旧文案
    await evaluate(client, page.sessionId, `document.querySelector('[data-sync-status]').textContent = ''`);
    await evaluate(client, page.sessionId, `document.querySelector('[data-action="sync-pull"]').click()`);
    for (let i = 0; i < 80; i += 1) {
      statusText = await evaluate(client, page.sessionId, `document.querySelector('[data-sync-status]')?.textContent || ''`);
      if (/同步完成|同步失败/.test(statusText)) break;
      await sleep(200);
    }
    check('从云端拉取成功', /同步完成/.test(statusText), statusText);

    const pulled = await evaluate(client, page.sessionId, `new Promise((resolve) => chrome.storage.local.get('nai-shared-prompt-library', (r) => resolve(JSON.stringify(r['nai-shared-prompt-library'] || null))))`);
    check('远端数据落进了本地 storage', String(pulled).includes('手机上的词条'), String(pulled).slice(0, 120));

    const errors = await evaluate(client, page.sessionId, `window.__naiSmokeErrors ? window.__naiSmokeErrors.length : 0`);
    check('页面没有未捕获异常', !errors, String(errors));
  } finally {
    if (!process.argv.includes('--keep')) chrome.kill('SIGKILL');
    dav.close();
    fixture.close();
  }

  const failed = results.filter((item) => !item.passed);
  console.log('');
  console.log(failed.length ? `✗ ${failed.length}/${results.length} 项失败` : `✓ 本地 WebDAV 往返全部通过（${results.length} 项）`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
