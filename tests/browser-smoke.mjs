#!/usr/bin/env node
/**
 * 浏览器冒烟：在本地替身页上验证站点适配层（不依赖登录态、不发出图请求）。
 *
 * 验证三件事：
 *   1. 扩展在 idlecloud 域名上真的注入了 content / assistant 两个 bundle
 *   2. 站点层能在一堆长得一样的 textarea 里挑出「真正可写的那个」（不是只读影子框）
 *   3. 角色区折叠时能自己展开、点「Add character」补位、并把提示词写进去
 *
 * 用法：node tests/browser-smoke.mjs [--keep]
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IDLECLOUD_FIXTURE_HTML } from './idlecloud-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD = '/tmp/nai-smoke-build';
const PROFILE = '/tmp/nai-smoke-profile';
const PORT = 8126;
// 用真实域名 + host-resolver-rules 指到本机：站点层按 hostname 认站点，
// 换成 127.0.0.1 就测不到 idlecloud 那条分支了。
const HOST = 'nai.idlecloud.cc';
const PAGE_URL = `http://${HOST}:${PORT}/fixture`;
const DEBUG_PORT = 9333;
const CHROME = process.env.CHROME_PATH
  || '/home/administrator/.cache/ms-playwright/chromium-1187/chrome-linux/chrome';

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 扩展文件摊平到 /tmp，只改 manifest 的 matches（真实构建产物一个字不动）
function prepareBuild() {
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });
  const items = ['manifest.json', 'background.js', 'official-chunk-bridge.js', 'artist-studio-bridge.js', 'js', 'styles', 'icons', 'pages'];
  for (const item of items) {
    const from = path.join(ROOT, item);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(BUILD, item), { recursive: true });
  }
  const manifestPath = path.join(BUILD, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const origin = `http://${HOST}:${PORT}/*`;
  for (const entry of manifest.content_scripts) {
    if (!entry.matches.includes(origin)) entry.matches.push(origin);
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function startServer() {
  const server = http.createServer((request, response) => {
    if (request.url === '/fixture' || request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(IDLECLOUD_FIXTURE_HTML);
      return;
    }
    response.writeHead(404).end('not found');
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
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
  throw new Error('浏览器没起来');
}

function createClient(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', reject);
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    events.push(message);
  });
  const send = (method, params = {}, sessionId) => {
    const id = nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return { send, events, ready, close: () => socket.close() };
}

async function evaluate(client, sessionId, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || '页面脚本执行失败');
  }
  return result.result.value;
}

async function main() {
  const manifest = prepareBuild();
  const server = await startServer();

  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    // 本机有系统级代理（mihomo），代理会把「映射到本机的域名」也拦下来
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

    // 等扩展的 service worker 起来，顺便拿到扩展 id
    let extensionId = '';
    for (let i = 0; i < 40 && !extensionId; i += 1) {
      const { targetInfos } = await client.send('Target.getTargets');
      const worker = targetInfos.find((info) => info.url.startsWith('chrome-extension://'));
      if (worker) extensionId = new URL(worker.url).host;
      else await sleep(250);
    }
    check('扩展 service worker 已启动', Boolean(extensionId), extensionId || '未找到');

    // 找到 fixture 标签页并附着
    let pageTarget = null;
    for (let i = 0; i < 40 && !pageTarget; i += 1) {
      const { targetInfos } = await client.send('Target.getTargets');
      pageTarget = targetInfos.find((info) => info.type === 'page');
      if (!pageTarget) await sleep(250);
    }
    if (process.env.DEBUG) {
      const { targetInfos } = await client.send('Target.getTargets');
      console.log('  targets:', targetInfos.map((info) => `${info.type} ${info.url}`).join(' | '));
    }
    if (!pageTarget) throw new Error('fixture 页面没打开');

    const { sessionId } = await client.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Page.enable', {}, sessionId);

    // 手动导航：命令行带 URL 时拿到的执行上下文可能还停在初始的 about:blank
    const navigation = await client.send('Page.navigate', { url: PAGE_URL }, sessionId);
    if (navigation.errorText) throw new Error(`导航失败: ${navigation.errorText}`);
    let navigated = false;
    for (let i = 0; i < 60 && !navigated; i += 1) {
      const href = await evaluate(client, sessionId, `location.href`).catch(() => '');
      navigated = String(href).includes('/fixture');
      if (!navigated) await sleep(250);
    }
    check('替身页加载完成', navigated);

    // 等 content / assistant 两个 bundle 都跑完
    let injected = null;
    for (let i = 0; i < 60; i += 1) {
      injected = await evaluate(client, sessionId, `({
        version: document.documentElement.dataset.naiAcVersion || '',
        assistant: Boolean(window.__naiAssistantV4Loaded),
        fab: Boolean(document.querySelector('.nai-md3-fab'))
      })`);
      if (injected.version && injected.assistant) break;
      await sleep(250);
    }
    if (process.env.DEBUG) {
      console.log('  debug:', await evaluate(client, sessionId, `({ url: location.href, title: document.title, ready: document.readyState, body: document.body?.innerText?.slice(0, 80) })`));
    }
    check('content bundle 在 idlecloud 域名注入', Boolean(injected.version), injected.version || '未注入');
    check('悬浮球渲染', injected.fab === true);

    // assistant bundle 跑在隔离世界，window 上那个标志页面主世界看不见，
    // 所以用「点开悬浮球 → 面板出现」来证明它完整可用
    await evaluate(client, sessionId, `document.querySelector('.nai-md3-fab').click()`);
    let panelOpen = false;
    for (let i = 0; i < 20 && !panelOpen; i += 1) {
      panelOpen = await evaluate(client, sessionId, `Boolean(document.querySelector('.nai-md3-panel')?.offsetWidth)`);
      if (!panelOpen) await sleep(150);
    }
    check('assistant 面板可以打开', panelOpen);
    await evaluate(client, sessionId, `document.querySelector('.nai-md3-fab')?.click()`);
    await sleep(300);

    // —— 站点层：可写框识别
    const siteProfileSource = fs.readFileSync(path.join(ROOT, 'js/shared/00-site-profile.js'), 'utf8');
    await evaluate(client, sessionId, `(() => { ${siteProfileSource}\n window.__site = { naiListPromptEditors, naiResolvePromptEditor, naiIsImagePage, naiCurrentSiteProfile, naiEnsurePositivePromptTab }; })()`);

    const editors = await evaluate(client, sessionId, `(() => {
      const list = window.__site.naiListPromptEditors();
      return list.map((el) => ({
        tag: el.tagName,
        readOnly: Boolean(el.readOnly),
        value: el.value,
        label: el.getAttribute('aria-label') || '',
      }));
    })()`);
    check('只交出 1 个可写提示词框（影子框被排除）', editors.length === 1, JSON.stringify(editors));
    check('交出的框带真实 aria-label', /Describe the image/.test(editors[0]?.label || ''), editors[0]?.label || '');

    // 切到 Negative 后，站点层要能认出「当前在负向」并切回正向
    await evaluate(client, sessionId, `document.querySelector('[data-prompt-tab="negative"]').click()`);
    await sleep(120);
    const negativeLabel = await evaluate(client, sessionId, `document.getElementById('_r_17_-input').getAttribute('aria-label')`);
    const switched = await evaluate(client, sessionId, `(async () => {
      const field = window.__site.naiListPromptEditors()[0];
      const did = await window.__site.naiEnsurePositivePromptTab(field);
      return { did, selected: document.querySelector('[data-prompt-tab="positive"]').getAttribute('aria-selected') };
    })()`);
    check('负向 Tab 下会先切回正向', switched.did === true && switched.selected === 'true', `${negativeLabel} → ${JSON.stringify(switched)}`);

    // —— 角色栏：折叠展开 + 补位 + 写入（用真实 chunk 源码，不经 UI）
    const characterSource = fs.readFileSync(path.join(ROOT, 'js/assistant/21-nai-character-fields.js'), 'utf8');
    await evaluate(client, sessionId, `(() => { ${siteProfileSource}\n ${characterSource}\n window.__char = { fillNaiCharacterFields, listNaiCharacterFields, findNaiCharacterSectionToggle }; })()`);

    const beforeOpen = await evaluate(client, sessionId, `document.getElementById('_r_16_-toggle').getAttribute('aria-expanded')`);
    const filled = await evaluate(client, sessionId, `window.__char.fillNaiCharacterFields([
      { slot: 1, prompt: '1girl, silver hair, red eyes' }
    ])`);
    const after = await evaluate(client, sessionId, `({
      expanded: document.getElementById('_r_16_-toggle').getAttribute('aria-expanded'),
      cards: document.querySelectorAll('.character-card textarea').length,
      value: document.querySelector('.character-card textarea')?.value || '',
      shadow: document.querySelectorAll('.prompt-editor-input textarea')[1].value
    })`);

    check('角色区默认是折叠的', beforeOpen === 'false');
    check('填角色时自动展开了角色区', after.expanded === 'true');
    check('自动补出一个角色栏', after.cards === 1, String(after.cards));
    check('角色提示词写进角色框', /silver hair/.test(after.value), after.value);
    check('填充结果自报 ok', filled?.ok === true, JSON.stringify(filled));
    check('整个过程没碰只读影子框', after.shadow === 'x', after.shadow);

    // —— 画师库全链路：从扩展侧写入数据 → 面板画师页 → 点卡片 → 落到真 textarea
    const workerTarget = (await client.send('Target.getTargets')).targetInfos
      .find((info) => info.type === 'service_worker');
    const worker = await client.send('Target.attachToTarget', { targetId: workerTarget.targetId, flatten: true });
    await client.send('Runtime.enable', {}, worker.sessionId);

    const library = {
      artists: [{ id: 'a1', name: '测试画师', tag: 'artist:test_artist', rating: 4.5, notes: '', categories: ['厚涂'] }],
      labels: ['厚涂'],
      artistStrings: [],
      pages: [{ id: 'default', name: '我的画师库' }],
      activePageId: 'default',
    };
    await client.send('Runtime.evaluate', {
      expression: `chrome.storage.local.set({ naiArtistTracker_v1: ${JSON.stringify(JSON.stringify(library))} })`,
      awaitPromise: true,
      returnByValue: true,
    }, worker.sessionId);
    await sleep(300);

    await evaluate(client, sessionId, `document.querySelector('.nai-md3-fab').click()`);
    await sleep(400);
    await evaluate(client, sessionId, `document.querySelector('.nai-md3-panel [data-page="artists"]')?.click()`);
    let cardReady = false;
    for (let i = 0; i < 25 && !cardReady; i += 1) {
      cardReady = await evaluate(client, sessionId, `Boolean(document.querySelector('.nai-artist-quick-card'))`);
      if (!cardReady) {
        await evaluate(client, sessionId, `document.querySelector('.nai-md3-panel [data-page="artists"]')?.click()`);
        await sleep(250);
      }
    }
    check('画师库卡片渲染', cardReady);

    await evaluate(client, sessionId, `document.querySelector('.nai-artist-quick-card')?.click()`);
    await sleep(500);
    const afterInsert = await evaluate(client, sessionId, `({
      main: document.getElementById('_r_17_-input').value,
      shadow: document.querySelectorAll('.prompt-editor-input textarea')[1].value,
      status: document.querySelector('.nai-md3-panel [data-status]')?.textContent || ''
    })`);
    check('点画师卡写进真提示词框', /artist:test_artist/.test(afterInsert.main), afterInsert.main);
    check('画师串没有写进只读影子框', afterInsert.shadow === 'x', afterInsert.shadow);

    const consoleErrors = await evaluate(client, sessionId, `window.__naiSmokeErrors ? window.__naiSmokeErrors.length : 0`);
    check('页面没有未捕获异常', !consoleErrors, String(consoleErrors));

    if (process.env.DEBUG) {
      const shot = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.writeFileSync('/tmp/nai-smoke.png', Buffer.from(shot.data, 'base64'));
      console.log('截图 /tmp/nai-smoke.png');
    }
  } finally {
    if (!process.argv.includes('--keep')) chrome.kill('SIGKILL');
    server.close();
  }

  const failed = results.filter((item) => !item.passed);
  console.log('');
  console.log(failed.length ? `✗ ${failed.length}/${results.length} 项失败` : `✓ 浏览器冒烟全部通过（${results.length} 项）`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
