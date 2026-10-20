#!/usr/bin/env node
/**
 * 真实站点冒烟：在 nai.idlecloud.cc/main 上验证站点适配。
 *
 * 需要登录态：把 api.idlecloud.cc 的 session cookie 值放进 SESSION 环境变量。
 * 只做「读结构 + 往输入框写字」，不会点生成、不会上传图片。
 *
 *   SESSION=xxx node tests/real-site-smoke.mjs
 *
 * 站点带 devtools 检测（检测到就跳 /404），所以这里在导航前用
 * addScriptToEvaluateOnNewDocument 把 sessionStorage 的 debug-unlocked 置位。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROFILE = '/tmp/nai-real-profile';
const DEBUG_PORT = 9252;
const CHROME = process.env.CHROME_PATH
  || '/home/administrator/.cache/ms-playwright/chromium-1187/chrome-linux/chrome';
const SESSION = process.env.SESSION || '';

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createClient(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', reject);
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => {
    const id = nextId++;
    socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return { send, ready, close: () => socket.close() };
}

async function evaluate(client, sessionId, expression) {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || '页面脚本执行失败');
  return result.result.value;
}

async function main() {
  if (!SESSION) {
    console.error('缺少 SESSION 环境变量（api.idlecloud.cc 的 session cookie 值）');
    process.exit(1);
  }

  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1440,900',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE}`,
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const shots = [];
  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i += 1) {
      try {
        info = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
      } catch (error) {
        await sleep(250);
      }
    }
    const client = createClient(info.webSocketDebuggerUrl);
    await client.ready;

    const pageTarget = (await client.send('Target.getTargets')).targetInfos.find((item) => item.type === 'page');
    const { sessionId } = await client.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Page.enable', {}, sessionId);
    await client.send('Network.enable', {}, sessionId);

    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "try { sessionStorage.setItem('debug-unlocked', 'true'); } catch (error) {}",
    }, sessionId);
    for (const domain of ['api.idlecloud.cc', '.idlecloud.cc']) {
      await client.send('Network.setCookie', {
        name: 'session',
        value: SESSION,
        domain,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      }, sessionId);
    }

    await client.send('Page.navigate', { url: 'https://nai.idlecloud.cc/main' }, sessionId);

    let ready = null;
    for (let i = 0; i < 80; i += 1) {
      ready = await evaluate(client, sessionId, `({
        href: location.href,
        editors: document.querySelectorAll('.prompt-editor-input textarea').length,
        version: document.documentElement.dataset.naiAcVersion || '',
        fab: Boolean(document.querySelector('.nai-md3-fab')),
        toggle: Boolean(document.querySelector('button[aria-expanded]'))
      })`).catch(() => null);
      if (ready?.editors && ready?.version) break;
      await sleep(300);
    }
    if (!/\/main/.test(ready?.href || '') || !ready?.editors) {
      console.error(`\n页面停在 ${ready?.href || '未知地址'}，没进到绘图页 —— session cookie 多半已失效，先重新登录再复制一份。`);
      process.exitCode = 2;
      return;
    }
    check('停在绘图页 /main', true, ready.href);
    check('提示词编辑器已渲染', ready?.editors > 0, String(ready?.editors || 0));
    check('content bundle 注入', Boolean(ready?.version), ready?.version || '未注入');
    check('悬浮球出现', ready?.fab === true);

    // 站点层：可写框识别
    const siteSource = fs.readFileSync(path.join(ROOT, 'js/shared/00-site-profile.js'), 'utf8');
    await evaluate(client, sessionId, `(() => { ${siteSource}\n window.__site = { naiListPromptEditors, naiEnsurePositivePromptTab, naiIsImagePage }; })()`);
    const editors = await evaluate(client, sessionId, `window.__site.naiListPromptEditors().map((el) => ({
      readOnly: Boolean(el.readOnly), label: el.getAttribute('aria-label') || '', value: el.value.slice(0, 40)
    }))`);
    check('只交出 1 个可写提示词框', editors.length === 1, JSON.stringify(editors));
    check('认得出当前是 /main 绘图页', await evaluate(client, sessionId, `window.__site.naiIsImagePage(window)`));

    // 画师库全链路：从 service worker 写数据 → 面板 → 点卡片 → 落到真框
    const workerTarget = (await client.send('Target.getTargets')).targetInfos.find((item) => item.type === 'service_worker');
    const worker = await client.send('Target.attachToTarget', { targetId: workerTarget.targetId, flatten: true });
    const library = {
      artists: [{ id: 'smoke1', name: '冒烟画师', tag: 'artist:smoke_test', rating: 4, notes: '', categories: ['测试'] }],
      labels: ['测试'],
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

    await evaluate(client, sessionId, `document.querySelector('.nai-md3-fab')?.click()`);
    await sleep(600);
    let cardReady = false;
    for (let i = 0; i < 20 && !cardReady; i += 1) {
      await evaluate(client, sessionId, `document.querySelector('.nai-md3-panel [data-page="artists"]')?.click()`);
      await sleep(250);
      cardReady = await evaluate(client, sessionId, `Boolean(document.querySelector('.nai-artist-quick-card'))`);
    }
    check('面板画师页渲染出卡片', cardReady);

    const shot1 = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync('/tmp/real-site-panel.png', Buffer.from(shot1.data, 'base64'));
    shots.push('/tmp/real-site-panel.png');

    await evaluate(client, sessionId, `document.querySelector('.nai-artist-quick-card')?.click()`);
    await sleep(600);
    const inserted = await evaluate(client, sessionId, `(() => {
      const fields = Array.from(document.querySelectorAll('.prompt-editor-input textarea'));
      return {
        values: fields.map((el) => ({ readOnly: Boolean(el.readOnly), value: el.value })),
        positiveSelected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent || ''
      };
    })()`);
    const writable = inserted.values.filter((item) => !item.readOnly);
    check('画师串写进真提示词框', writable.some((item) => item.value.includes('artist:smoke_test')), JSON.stringify(writable));
    check('只读影子框没被写', inserted.values.filter((item) => item.readOnly).every((item) => item.value === 'x'));

    // 角色栏：折叠 → 自动展开 → 补位 → 写入
    const characterSource = fs.readFileSync(path.join(ROOT, 'js/assistant/21-nai-character-fields.js'), 'utf8');
    await evaluate(client, sessionId, `(() => { ${siteSource}\n ${characterSource}\n window.__char = { fillNaiCharacterFields, findNaiCharacterSectionToggle }; })()`);
    const charBefore = await evaluate(client, sessionId, `(() => {
      const toggle = window.__char.findNaiCharacterSectionToggle();
      return { found: Boolean(toggle), expanded: toggle?.getAttribute('aria-expanded') || '', text: toggle?.textContent?.slice(0, 40) || '' };
    })()`);
    check('找到 Character control 开关', charBefore.found === true, charBefore.text);

    const charFill = await evaluate(client, sessionId, `window.__char.fillNaiCharacterFields([{ slot: 1, prompt: '1girl, silver hair, red eyes' }])`);
    const charAfter = await evaluate(client, sessionId, `(() => {
      const toggle = window.__char.findNaiCharacterSectionToggle();
      const areas = Array.from(document.querySelectorAll('textarea'))
        .filter((el) => !el.readOnly && !el.closest('.prompt-editor-input'));
      return {
        expanded: toggle?.getAttribute('aria-expanded') || '',
        characterValues: areas.map((el) => el.value),
      };
    })()`);
    check('角色区被自动展开', charAfter.expanded === 'true', charBefore.expanded);
    check('角色提示词写进角色框', charAfter.characterValues.some((value) => /silver hair/.test(value)), JSON.stringify(charAfter.characterValues));
    check('填充结果自报 ok', charFill?.ok === true, JSON.stringify(charFill));

    const shot2 = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync('/tmp/real-site-filled.png', Buffer.from(shot2.data, 'base64'));
    shots.push('/tmp/real-site-filled.png');
  } finally {
    chrome.kill('SIGKILL');
  }

  const failed = results.filter((item) => !item.passed);
  console.log('');
  for (const shot of shots) console.log(`截图 ${shot}`);
  console.log(failed.length ? `✗ ${failed.length}/${results.length} 项失败` : `✓ 真实站点冒烟全部通过（${results.length} 项）`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
