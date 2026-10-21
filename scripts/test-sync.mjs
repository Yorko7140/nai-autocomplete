// 跨设备同步：加密、三方比较、WebDAV 往返。
//
//   node scripts/test-sync.mjs
//
// 测的是真正上线的那份 chunk —— js/shared/01-sync-core.js 与 js/background/11-sync.js
// 由 background 沙箱按构建顺序拼接后加载，WebDAV 用 fetch mock 顶。
// 这里要守住的两条底线：
//   1. 写到远端去的东西必须解不开（口令之外看不到 API Key）
//   2. 两端都改过的键不能被静默覆盖

import assert from 'node:assert/strict';
import { group, test, run, deepEqual, captureError } from './lib/tiny-test.mjs';
import { createBackgroundSandbox, jsonResponse, textResponse } from './lib/background-sandbox.mjs';

const box = createBackgroundSandbox();
const isSyncedKey = box.get('naiSyncIsSyncedKey');
const keyLabel = box.get('naiSyncKeyLabel');
const hash = box.get('naiSyncHash');
const encrypt = box.get('naiSyncEncrypt');
const decrypt = box.get('naiSyncDecrypt');
const compare = box.get('naiSyncCompare');
const compose = box.get('naiSyncCompose');
const nextBase = box.get('naiSyncNextBase');
const normalizeConfig = box.get('naiSyncNormalizeConfig');
const planForMode = box.get('naiSyncPlanForMode');
const runSync = box.get('runNaiSync');
const testConfig = box.get('testNaiSyncConfig');
const FORMAT = box.get('NAI_SYNC_FORMAT');

const PASSPHRASE = 'correct horse battery staple';

// ═══════════════════════ 1. 同步范围 ═══════════════════════

group('哪些键会被同步');

test('画师库、提示词库、预设、技能、模型设置都在范围内', () => {
  ['naiArtistTracker_v1', 'nai-shared-prompt-library', 'nai-llm-prompt-presets',
    'nai-agent-skills', 'nai-agent-active-skill', 'nai-llm-assistant-settings']
    .forEach((key) => assert.equal(isSyncedKey(key), true, key));
});

test('词典缓存、会话、布局、同步自己的配置都不在其中', () => {
  ['nai-ac-tags', 'nai-ac-tags-time', 'nai-agent-conversation', 'nai-llm-panel-layout',
    'nai-fab-position', 'nai-llm-drawer-layout', 'nai-sync-config', 'nai-sync-state']
    .forEach((key) => assert.equal(isSyncedKey(key), false, key));
});

test('按站点分键的提示词区块靠前缀认得出来', () => {
  assert.equal(isSyncedKey('nai-ac-prompt-blocks:https://nai.idlecloud.cc/main:0'), true);
  assert.equal(isSyncedKey('nai-ac-prompt-blocks:https://novelai.net/image:2'), true);
  assert.equal(isSyncedKey('nai-ac-prompt-blocks-other'), false);
});

test('给人看的标签带上站点路径', () => {
  assert.equal(keyLabel('naiArtistTracker_v1'), '画师记录本');
  assert.match(keyLabel('nai-ac-prompt-blocks:https://novelai.net/image:0'), /提示词区块.*novelai\.net\/image/);
});

// ═══════════════════════ 2. 哈希做基线 ═══════════════════════

group('哈希要能判断「变没变」');

test('对象键序不同不算变', () => {
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
});

test('嵌套对象也一样', () => {
  assert.equal(hash({ list: [{ x: 1, y: 2 }] }), hash({ list: [{ y: 2, x: 1 }] }));
});

test('值变了就变', () => {
  assert.notEqual(hash({ a: 1 }), hash({ a: 2 }));
  assert.notEqual(hash([1, 2]), hash([2, 1]));
});

// ═══════════════════════ 3. 加密 ═══════════════════════

group('远端文件必须是密文');

test('加密后能原样解回来', async () => {
  const payload = { format: FORMAT, entries: { naiArtistTracker_v1: { at: 1, value: { artists: [{ name: 'WLOP' }] } } } };
  const blob = await encrypt(payload, PASSPHRASE);
  assert.equal(blob.format, FORMAT);
  assert.equal(typeof blob.salt, 'string');
  assert.equal(typeof blob.iv, 'string');
  const restored = await decrypt(blob, PASSPHRASE);
  deepEqual(restored, payload);
});

test('密文里搜不到 API Key 和画师名', async () => {
  const blob = await encrypt({
    entries: { 'nai-llm-assistant-settings': { at: 1, value: { apiKey: 'sk-super-secret-value', endpoint: 'https://api.example.com' } } },
  }, PASSPHRASE);
  const wire = JSON.stringify(blob);
  assert.equal(wire.includes('sk-super-secret-value'), false);
  assert.equal(wire.includes('apiKey'), false);
  assert.equal(wire.includes('api.example.com'), false);
});

test('同一份数据两次加密结果不同（salt/iv 每次新生成）', async () => {
  const payload = { entries: { a: 1 } };
  const first = await encrypt(payload, PASSPHRASE);
  const second = await encrypt(payload, PASSPHRASE);
  assert.notEqual(first.data, second.data);
  assert.notEqual(first.salt, second.salt);
});

test('口令不对要说人话', async () => {
  const blob = await encrypt({ entries: {} }, PASSPHRASE);
  const error = await captureError(() => decrypt(blob, 'wrong passphrase'));
  assert.match(String(error.message), /口令不对/);
});

test('空口令直接拒绝', async () => {
  const error = await captureError(() => encrypt({ entries: {} }, ''));
  assert.match(String(error.message), /口令不能为空/);
});

test('别的 JSON 文件不会被当成同步文件', async () => {
  const error = await captureError(() => decrypt({ hello: 'world' }, PASSPHRASE));
  assert.match(String(error.message), /同步文件/);
});

// ═══════════════════════ 4. 三方比较 ═══════════════════════

group('谁改过谁更新');

const LOCAL_ARTISTS = { artists: [{ name: 'WLOP' }] };
const REMOTE_ARTISTS = { artists: [{ name: 'Ciloranko' }] };

test('云端没有、本地有 → 推上去', () => {
  const plan = compare({ localValues: { naiArtistTracker_v1: LOCAL_ARTISTS }, remoteEntries: {}, base: {} });
  deepEqual(plan.push, ['naiArtistTracker_v1']);
  deepEqual(plan.pull, []);
});

test('本地没有、云端有 → 拉下来', () => {
  const plan = compare({
    localValues: {},
    remoteEntries: { naiArtistTracker_v1: { at: 1, value: REMOTE_ARTISTS } },
    base: {},
  });
  deepEqual(plan.pull, ['naiArtistTracker_v1']);
});

test('两边一样 → 谁都不用动', () => {
  const plan = compare({
    localValues: { naiArtistTracker_v1: LOCAL_ARTISTS },
    remoteEntries: { naiArtistTracker_v1: { at: 1, value: LOCAL_ARTISTS } },
    base: {},
  });
  deepEqual(plan.same, ['naiArtistTracker_v1']);
});

test('基线一致、只有本地改过 → 推', () => {
  const base = { naiArtistTracker_v1: { hash: hash(LOCAL_ARTISTS), at: 1 } };
  const plan = compare({
    localValues: { naiArtistTracker_v1: { artists: [{ name: 'WLOP2' }] } },
    remoteEntries: { naiArtistTracker_v1: { at: 1, value: LOCAL_ARTISTS } },
    base,
  });
  deepEqual(plan.push, ['naiArtistTracker_v1']);
});

test('基线一致、只有云端改过 → 拉', () => {
  const base = { naiArtistTracker_v1: { hash: hash(LOCAL_ARTISTS), at: 1 } };
  const plan = compare({
    localValues: { naiArtistTracker_v1: LOCAL_ARTISTS },
    remoteEntries: { naiArtistTracker_v1: { at: 2, value: REMOTE_ARTISTS } },
    base,
  });
  deepEqual(plan.pull, ['naiArtistTracker_v1']);
});

test('两端都改过 → 记成冲突，不擅自覆盖', () => {
  const base = { naiArtistTracker_v1: { hash: hash({ artists: [] }), at: 1 } };
  const plan = compare({
    localValues: { naiArtistTracker_v1: LOCAL_ARTISTS },
    remoteEntries: { naiArtistTracker_v1: { at: 2, value: REMOTE_ARTISTS } },
    base,
  });
  deepEqual(plan.conflicts, ['naiArtistTracker_v1']);
});

test('不在同步范围内的键完全不出现在计划里', () => {
  const plan = compare({
    localValues: { 'nai-ac-tags': { huge: true }, naiArtistTracker_v1: LOCAL_ARTISTS },
    remoteEntries: {},
    base: {},
  });
  deepEqual(plan.push, ['naiArtistTracker_v1']);
});

// ═══════════════════════ 5. 合并落盘 ═══════════════════════

group('合并之后谁写本地、谁写云端');

test('拉下来的项写进本地，推上去的项进云端文档', () => {
  const composed = compose({
    localValues: { naiArtistTracker_v1: LOCAL_ARTISTS },
    remoteEntries: { 'nai-shared-prompt-library': { at: 1, value: { entries: [] } } },
    plan: { pull: ['nai-shared-prompt-library'], push: ['naiArtistTracker_v1'], conflicts: [] },
    deviceId: 'dev-a',
  });
  assert.ok(composed.localWrites['nai-shared-prompt-library']);
  assert.equal(composed.doc.entries['naiArtistTracker_v1'].value.artists[0].name, 'WLOP');
  assert.equal(composed.doc.deviceId, 'dev-a');
});

test('冲突默认保留本地', () => {
  const composed = compose({
    localValues: { naiArtistTracker_v1: LOCAL_ARTISTS },
    remoteEntries: { naiArtistTracker_v1: { at: 2, value: REMOTE_ARTISTS } },
    plan: { pull: [], push: [], conflicts: ['naiArtistTracker_v1'] },
    conflictResolution: 'local',
  });
  assert.equal(composed.doc.entries['naiArtistTracker_v1'].value.artists[0].name, 'WLOP');
  assert.equal(composed.localWrites['naiArtistTracker_v1'], undefined);
});

test('明确选择云端时，冲突项取远端', () => {
  const composed = compose({
    localValues: { naiArtistTracker_v1: LOCAL_ARTISTS },
    remoteEntries: { naiArtistTracker_v1: { at: 2, value: REMOTE_ARTISTS } },
    plan: { pull: [], push: [], conflicts: ['naiArtistTracker_v1'] },
    conflictResolution: 'remote',
  });
  assert.equal(composed.localWrites['naiArtistTracker_v1'].artists[0].name, 'Ciloranko');
});

test('新基线把每个键的哈希都记上', () => {
  const doc = { entries: { naiArtistTracker_v1: { at: 5, value: LOCAL_ARTISTS } } };
  const base = nextBase(doc);
  assert.equal(base.naiArtistTracker_v1.hash, hash(LOCAL_ARTISTS));
  assert.equal(base.naiArtistTracker_v1.at, 5);
});

// ═══════════════════════ 6. 三种同步模式 ═══════════════════════

group('双向 / 只推 / 只拉');

const PLAN = { same: ['a'], push: ['b'], pull: ['c'], conflicts: ['d'] };

test('双向按计划走', () => {
  deepEqual(planForMode(PLAN, 'both'), PLAN);
});

test('以本机为准：该拉的也改成推', () => {
  const plan = planForMode(PLAN, 'push');
  deepEqual(plan.pull, []);
  deepEqual(plan.push, ['c', 'b', 'd'].sort((x, y) => (x < y ? -1 : 1)));
});

test('以云端为准：本地改过的让位，本地独有的不删', () => {
  const plan = planForMode(PLAN, 'pull');
  deepEqual(plan.push, []);
  deepEqual(plan.pull, ['c', 'd']);
});

// ═══════════════════════ 7. 配置归一 ═══════════════════════

group('同步配置');

test('地址尾部斜杠去掉，空路径给默认值', () => {
  const config = normalizeConfig({ url: 'https://dav.example.com/dav///', remotePath: '  ' });
  assert.equal(config.url, 'https://dav.example.com/dav');
  assert.equal(config.remotePath, '/nai-autocomplete/nai-autocomplete-sync.json');
});

test('间隔有下限，太小的抬到 5 分钟', () => {
  assert.equal(normalizeConfig({ intervalMinutes: 1 }).intervalMinutes, 5);
  assert.equal(normalizeConfig({ intervalMinutes: 30 }).intervalMinutes, 30);
  assert.equal(normalizeConfig({ intervalMinutes: 99999 }).intervalMinutes, 1440);
});

test('默认不开自动同步', () => {
  assert.equal(normalizeConfig({}).enabled, false);
});

// ═══════════════════════ 8. 走 WebDAV 全流程 ═══════════════════════

group('WebDAV 往返');

function davConfig(extra = {}) {
  return normalizeConfig({
    enabled: false,
    url: 'https://dav.example.com/dav',
    username: 'yorko@example.com',
    password: 'app-password',
    remotePath: '/nai-autocomplete/nai-autocomplete-sync.json',
    passphrase: PASSPHRASE,
    ...extra,
  });
}

group('第一次同步：云端什么都没有');

test('PUT 出去的是一份密文，明文只留在本地', async () => {
  box.setStorage({ 'nai-sync-config': davConfig(), naiArtistTracker_v1: LOCAL_ARTISTS, 'nai-sync-state': { base: {}, lastSyncAt: 0 } });
  // GET 说文件不存在，MKCOL / PUT 按成功走
  const calls = box.mockFetch((call) => (call.options.method === 'GET'
    ? textResponse('not found', { status: 404 })
    : textResponse('', { status: 201 })));
  const result = await runSync({ mode: 'both' });
  // 404 之后才会 MKCOL + PUT
  const put = calls.find((call) => call.options.method === 'PUT');
  assert.ok(put, '应该发出了一次 PUT');
  assert.match(String(put.url), /nai-autocomplete-sync\.json$/);
  assert.match(put.headers.Authorization, /^Basic /);
  const wire = String(put.rawBody);
  assert.equal(wire.includes('WLOP'), false);
  assert.equal(result.ok, true);
  assert.equal(result.pushed >= 1, true);
});

test('第一次同步后本地存了基线', () => {
  const state = box.chrome.store['nai-sync-state'];
  assert.ok(state?.base?.naiArtistTracker_v1?.hash);
});

test('坚果云对不存在的路径回 409，也当成云端为空', async () => {
  box.setStorage({ 'nai-sync-config': davConfig(), naiArtistTracker_v1: LOCAL_ARTISTS, 'nai-sync-state': { base: {}, lastSyncAt: 0 } });
  const calls = box.mockFetch((call) => {
    if (call.options.method === 'GET') return textResponse('directory not found', { status: 409 });
    if (call.options.method === 'MKCOL') return textResponse('already exists', { status: 405 });
    return textResponse('', { status: 201 });
  });
  const result = await runSync({ mode: 'both' });
  assert.equal(result.ok, true);
  assert.equal(result.pushed >= 1, true);
  assert.ok(calls.some((call) => call.options.method === 'PUT'), '409 之后仍然应该写入');
});

group('第二次同步：云端有另一台设备的数据');

test('远端较新时把内容拉进本地 storage', async () => {
  const remoteDoc = {
    format: FORMAT, version: 1, deviceId: 'dev-phone', updatedAt: Date.now(),
    entries: {
      naiArtistTracker_v1: { at: Date.now() + 1000, value: REMOTE_ARTISTS },
    },
  };
  const blob = await encrypt(remoteDoc, PASSPHRASE);
  // 先让本地基线认为「本地没改过」，再把远端换成更新的一份
  box.setStorage({
    'nai-sync-config': davConfig(),
    'nai-sync-state': { base: { naiArtistTracker_v1: { hash: hash(LOCAL_ARTISTS), at: 1 } }, lastSyncAt: 1 },
  });
  box.mockFetch(() => jsonResponse(blob));
  const result = await runSync({ mode: 'both' });
  assert.equal(result.ok, true);
  assert.equal(result.pulled >= 1, true);
  assert.equal(box.chrome.store.naiArtistTracker_v1.artists[0].name, 'Ciloranko');
});

test('口令不对时报错，而不是把远端内容当空覆盖本地', async () => {
  box.setStorage({ 'nai-sync-config': davConfig() });
  const blob = await encrypt({ format: FORMAT, entries: {} }, 'another-passphrase');
  box.mockFetch(() => jsonResponse(blob));
  const before = JSON.stringify(box.chrome.store.naiArtistTracker_v1);
  const error = await captureError(() => runSync({ mode: 'both' }));
  assert.match(String(error.message), /口令不对/);
  assert.equal(JSON.stringify(box.chrome.store.naiArtistTracker_v1), before);
});

test('401 时说清楚是账号或应用密码的问题', async () => {
  box.setStorage({ 'nai-sync-config': davConfig() });
  box.mockFetch(() => textResponse('unauthorized', { status: 401 }));
  const error = await captureError(() => runSync({ mode: 'both' }));
  assert.match(String(error.message), /认证失败/);
});

test('地址没填时给的是人话', async () => {
  box.setStorage({ 'nai-sync-config': davConfig({ url: '' }) });
  const result = await runSync({ mode: 'both' });
  assert.equal(result.ok, false);
  assert.match(result.error, /WebDAV 地址/);
});

group('测试连接');

test('文件还不存在也算连通（第一次同步会去创建）', async () => {
  const config = davConfig();
  box.mockFetch(() => textResponse('not found', { status: 404 }));
  const result = await testConfig(config);
  assert.equal(result.ok, true);
  assert.match(result.message, /还没有同步文件/);
});

test('测试连接遇到 409 也说「还没有同步文件」', async () => {
  box.mockFetch(() => textResponse('directory not found', { status: 409 }));
  const result = await testConfig(davConfig());
  assert.equal(result.ok, true);
  assert.match(result.message, /还没有同步文件/);
});

test('能看到远端已有多少项', async () => {
  const blob = await encrypt({
    format: FORMAT, version: 1, updatedAt: Date.now(),
    entries: { naiArtistTracker_v1: { at: 1, value: LOCAL_ARTISTS } },
  }, PASSPHRASE);
  box.mockFetch(() => jsonResponse(blob));
  const result = await testConfig(davConfig());
  assert.equal(result.ok, true);
  assert.match(result.message, /远端已有 1 项/);
});

// ═══════════════════════ 9. 消息路由 ═══════════════════════

group('content / assistant 发来的消息');

test('config-get 会顺手发一个设备 ID', async () => {
  box.chrome.store['nai-sync-config'] = undefined;
  const response = await box.sendMessage({ type: 'nai-sync-config-get' });
  assert.equal(response.ok, true);
  assert.equal(typeof response.config.deviceId, 'string');
  assert.ok(response.config.deviceId.length > 0);
});

test('config-save 存下来并排上定时器', async () => {
  const before = box.chrome.calls.filter((call) => call.method === 'alarms.create').length;
  const response = await box.sendMessage({
    type: 'nai-sync-config-save',
    config: davConfig({ enabled: true, intervalMinutes: 20 }),
  });
  assert.equal(response.ok, true);
  assert.equal(response.config.enabled, true);
  const created = box.chrome.calls.filter((call) => call.method === 'alarms.create');
  assert.equal(created.length > before, true);
  const [, options] = created[created.length - 1].args;
  assert.equal(options.periodInMinutes, 20);
});

test('关掉自动同步会把定时器清掉', async () => {
  await box.sendMessage({ type: 'nai-sync-config-save', config: davConfig({ enabled: false }) });
  const clears = box.chrome.calls.filter((call) => call.method === 'alarms.clear');
  assert.equal(clears.length > 0, true);
});

test('run 的返回里有拉取/推送的条数，方便界面直接显示', async () => {
  box.chrome.store['nai-sync-config'] = davConfig();
  box.setStorage({ naiArtistTracker_v1: LOCAL_ARTISTS });
  box.mockFetch((call) => (call.options.method === 'GET'
    ? textResponse('not found', { status: 404 })
    : textResponse('', { status: 201 })));
  const response = await box.sendMessage({ type: 'nai-sync-run', mode: 'both' });
  assert.equal(response.ok, true);
  assert.equal(typeof response.pulled, 'number');
  assert.equal(typeof response.pushed, 'number');
});

await run('跨设备同步');
