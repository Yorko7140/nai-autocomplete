// 跨设备同步：WebDAV 上一个加密文件，多台设备之间对齐数据。
//
// 为什么放在 background：content script 受页面 CORS 约束，WebDAV 服务器基本不会给网页
// 发 Access-Control-Allow-Origin，只有 background 能直接 fetch（host_permissions 是 <all_urls>）。
//
// 远端永远只有一个文件，整份 payload 加密后写出去 —— 文件里连键名都看不到，
// 只有一个 salt / iv / 密文。口令只存在本地 chrome.storage.local。

const NAI_SYNC_CONFIG_KEY = 'nai-sync-config';
const NAI_SYNC_STATE_KEY = 'nai-sync-state';
const NAI_SYNC_ALARM_NAME = 'nai-sync-auto';
const NAI_SYNC_TIMEOUT_MS = 25000;

function naiSyncStorageGet(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (result) => resolve(result || {}));
    } catch (error) {
      resolve({});
    }
  });
}

function naiSyncStorageSet(data) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(data, () => resolve(!chrome.runtime.lastError));
    } catch (error) {
      resolve(false);
    }
  });
}

async function readNaiSyncConfig() {
  const stored = await naiSyncStorageGet([NAI_SYNC_CONFIG_KEY]);
  const config = naiSyncNormalizeConfig(stored[NAI_SYNC_CONFIG_KEY]);
  if (!config.deviceId) {
    config.deviceId = typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `dev-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    await naiSyncStorageSet({ [NAI_SYNC_CONFIG_KEY]: config });
  }
  return config;
}

async function writeNaiSyncConfig(config) {
  const normalized = naiSyncNormalizeConfig(config);
  // 界面上的表单不带设备 ID；丢了它这台机器就会被当成新设备，基线全废
  if (!normalized.deviceId) {
    const previous = await readNaiSyncConfig();
    normalized.deviceId = previous.deviceId;
  }
  await naiSyncStorageSet({ [NAI_SYNC_CONFIG_KEY]: normalized });
  await refreshNaiSyncAlarm(normalized);
  return normalized;
}

async function readNaiSyncState() {
  const stored = await naiSyncStorageGet([NAI_SYNC_STATE_KEY]);
  const state = stored[NAI_SYNC_STATE_KEY];
  return state && typeof state === 'object' ? state : { base: {}, lastSyncAt: 0 };
}

async function refreshNaiSyncAlarm(config) {
  try {
    await chrome.alarms.clear(NAI_SYNC_ALARM_NAME);
    if (!config?.enabled || !config.url) return;
    chrome.alarms.create(NAI_SYNC_ALARM_NAME, {
      periodInMinutes: Math.max(5, Number(config.intervalMinutes) || 15),
    });
  } catch (error) {
    // 没有 alarms 权限时不该把同步功能整条拖垮，手动同步仍然可用
  }
}

function naiSyncBase64Utf8(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function naiSyncDavHeaders(config, extra = {}) {
  const headers = { ...extra };
  if (config.username || config.password) {
    headers.Authorization = `Basic ${naiSyncBase64Utf8(`${config.username}:${config.password}`)}`;
  }
  return headers;
}

function naiSyncDavUrl(config) {
  const base = String(config.url || '').replace(/\/+$/, '');
  const path = String(config.remotePath || '').startsWith('/') ? config.remotePath : `/${config.remotePath}`;
  return `${base}${path}`;
}

function naiSyncParentUrls(urlString) {
  // 逐级父目录，从最外层开始，用来挨个 MKCOL
  const url = new URL(urlString);
  const segments = url.pathname.split('/').filter(Boolean);
  const parents = [];
  segments.pop();
  let path = '';
  segments.forEach((segment) => {
    path += `/${segment}`;
    parents.push(`${url.origin}${path}/`);
  });
  return parents;
}

async function naiSyncFetch(urlString, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || NAI_SYNC_TIMEOUT_MS);
  try {
    const response = await fetch(urlString, { ...options, signal: controller.signal, credentials: 'omit' });
    const text = await response.text();
    return { status: response.status, ok: response.ok, text };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `请求超时（${Math.round((options.timeoutMs || NAI_SYNC_TIMEOUT_MS) / 1000)} 秒）` : String(error?.message || error);
    throw new Error(`连不上 WebDAV：${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

async function naiSyncEnsureRemoteDir(config) {
  for (const parent of naiSyncParentUrls(naiSyncDavUrl(config))) {
    // 405 / 409 / 301 = 目录已经在了（各家实现不一样，坚果云回 405）；401/403 权限问题交给后面的 PUT 报
    await naiSyncFetch(parent, { method: 'MKCOL', headers: naiSyncDavHeaders(config) });
  }
}

async function naiSyncReadRemote(config) {
  const target = naiSyncDavUrl(config);
  const response = await naiSyncFetch(target, { method: 'GET', headers: naiSyncDavHeaders(config) });
  // 404 = 文件不存在；409 = 父目录还不存在（坚果云对不存在的路径就是回 409），都按「第一次同步」处理
  if (response.status === 404 || response.status === 409) return null;
  if (response.status === 401 || response.status === 403) {
    throw new Error(`WebDAV 认证失败（${response.status}）：账号或应用密码不对，或者该目录没权限`);
  }
  if (!response.ok) {
    const hint = response.status === 409
      ? '（远端路径对应的目录不存在，或远端路径填成了目录）'
      : response.status === 507
        ? '（云端空间不足）'
        : '';
    throw new Error(`读取远端文件失败：HTTP ${response.status}${hint}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch (error) {
    throw new Error('远端文件不是合法 JSON：可能被别的程序写过，或同步路径填错了');
  }
  return naiSyncDecrypt(parsed, config.passphrase);
}

async function naiSyncWriteRemote(config, doc) {
  await naiSyncEnsureRemoteDir(config);
  const blob = await naiSyncEncrypt(doc, config.passphrase);
  const response = await naiSyncFetch(naiSyncDavUrl(config), {
    method: 'PUT',
    headers: naiSyncDavHeaders(config, { 'Content-Type': 'application/json; charset=utf-8' }),
    body: JSON.stringify(blob),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(`WebDAV 认证失败（${response.status}）：账号或应用密码不对，或者该目录只读`);
  }
  if (response.status === 507) throw new Error('WebDAV 空间不足（507）');
  if (!response.ok) throw new Error(`写入远端文件失败：HTTP ${response.status}`);
}

async function naiSyncCollectLocal() {
  const all = await naiSyncStorageGet(null);
  const values = {};
  Object.keys(all || {}).forEach((key) => {
    if (naiSyncIsSyncedKey(key)) values[key] = all[key];
  });
  return values;
}

// 只推 / 只拉 的语义：
//   push  本地为准，把远端较新的项也覆盖掉
//   pull  云端为准，本地改过的项让位（本地独有的是不删的）
//   both 三方比较，各取所需；冲突默认保留本地，并把冲突项报出来
function naiSyncPlanForMode(plan, mode) {
  if (mode === 'push') {
    return { same: [], pull: [], push: [...plan.pull, ...plan.push, ...plan.conflicts].sort(), conflicts: [] };
  }
  if (mode === 'pull') {
    return { same: plan.same, pull: [...plan.pull, ...plan.conflicts].sort(), push: [], conflicts: [] };
  }
  return plan;
}

async function runNaiSync({ mode = 'both', auto = false } = {}) {
  const config = await readNaiSyncConfig();
  if (!config.url) return { ok: false, error: '还没填 WebDAV 地址' };
  if (!config.passphrase) return { ok: false, error: '还没设同步口令，这可是加密用的，不能空着' };

  const localValues = await naiSyncCollectLocal();
  const remoteDoc = await naiSyncReadRemote(config);
  const remoteEntries = remoteDoc?.entries && typeof remoteDoc.entries === 'object' ? remoteDoc.entries : {};
  const state = await readNaiSyncState();

  const base = state.base || {};
  const firstSync = !state.lastSyncAt || !Object.keys(base).length;
  const rawPlan = naiSyncCompare({
    localValues,
    remoteEntries,
    base,
    // 第一次同步（没有基线）时，两端都有又不一样的值按"取云端"处理：
    // 手机上刚装好就点同步，期待的是拿到电脑那份配置，而不是被自己那份默认值挡住。
    firstSyncRemoteWins: firstSync && mode !== 'push',
  });
  const conflicts = rawPlan.conflicts.slice();
  const plan = naiSyncPlanForMode(rawPlan, mode);

  const composed = naiSyncCompose({
    localValues: { ...localValues },
    remoteEntries,
    plan: { pull: plan.pull, push: plan.push, conflicts: mode === 'both' ? conflicts : [] },
    conflictResolution: mode === 'pull' ? 'remote' : 'local',
    deviceId: config.deviceId,
  });

  const localWrites = composed.localWrites;
  if (Object.keys(localWrites).length) await naiSyncStorageSet(localWrites);

  let wrote = false;
  if (mode === 'pull') {
    // 云端为准时不必回写远端，只把基线对齐
    const nextBase = { ...(state.base || {}) };
    plan.pull.forEach((key) => {
      if (remoteEntries[key]) nextBase[key] = { hash: naiSyncHash(remoteEntries[key].value), at: remoteEntries[key].at || 0 };
    });
    await naiSyncStorageSet({ [NAI_SYNC_STATE_KEY]: { base: nextBase, lastSyncAt: Date.now() } });
  } else {
    await naiSyncWriteRemote(config, composed.doc);
    const nextBase = naiSyncNextBase(composed.doc);
    // 冲突项不记基线：记了下次就会被当成"一边改过"而单方面推上去，
    // 等于绕过用户的「以本机为准 / 以云端为准」选择。
    conflicts.forEach((key) => {
      delete nextBase[key];
    });
    await naiSyncStorageSet({ [NAI_SYNC_STATE_KEY]: { base: nextBase, lastSyncAt: Date.now() } });
    wrote = true;
  }

  const summary = naiSyncSummarize({ pull: plan.pull, push: plan.push, conflicts });
  const result = {
    ok: true,
    mode,
    firstSync: Boolean(firstSync),
    pushed: plan.push.length,
    pulled: plan.pull.length,
    conflicts,
    wroteRemote: wrote,
    summary,
    at: Date.now(),
  };

  await writeNaiSyncConfig({
    ...config,
    lastSyncAt: result.at,
    lastResult: conflicts.length && mode === 'both'
      ? `${summary}；冲突项已保留本地，需要云端版本请点「以云端为准」`
      : summary,
  });

  if (conflicts.length && mode === 'both') {
    return {
      ...result,
      ok: true,
      warning: `有 ${conflicts.length} 项两端都改过（${conflicts.map((key) => naiSyncKeyLabel(key)).join('、')}）。已保留本地，云端那份还在；要改用云端版本请点「以云端为准」。`,
    };
  }
  return result;
}

async function testNaiSyncConfig(config) {
  const normalized = naiSyncNormalizeConfig(config);
  if (!normalized.url) return { ok: false, error: '还没填 WebDAV 地址' };
  if (!/^https?:\/\//i.test(normalized.url)) return { ok: false, error: 'WebDAV 地址要以 http:// 或 https:// 开头' };
  try {
    const remote = await naiSyncReadRemote(normalized);
    if (!remote) {
      // 文件还不存在，看看能不能建目录 —— 只建目录，不写测试文件
      await naiSyncEnsureRemoteDir(normalized);
      return { ok: true, message: '连通正常，远端还没有同步文件（第一次同步会创建）' };
    }
    const count = Object.keys(remote.entries || {}).length;
    return { ok: true, message: `连通正常，远端已有 ${count} 项数据（${new Date(remote.updatedAt || Date.now()).toLocaleString()}）` };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'nai-sync-config-get') {
    (async () => {
      try {
        const config = await readNaiSyncConfig();
        const state = await readNaiSyncState();
        sendResponse({
          ok: true,
          config,
          lastSyncAt: state.lastSyncAt || config.lastSyncAt || 0,
          syncedKeys: NAI_SYNC_KEYS.map((item) => item.label),
        });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  }

  if (message.type === 'nai-sync-config-save') {
    (async () => {
      try {
        const config = await writeNaiSyncConfig(message.config || {});
        sendResponse({ ok: true, config });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  }

  if (message.type === 'nai-sync-test') {
    (async () => {
      try {
        sendResponse(await testNaiSyncConfig(message.config || (await readNaiSyncConfig())));
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  }

  if (message.type === 'nai-sync-run') {
    (async () => {
      try {
        sendResponse(await runNaiSync({ mode: message.mode || 'both', auto: Boolean(message.auto) }));
      } catch (error) {
        const failed = String(error?.message || error);
        const config = await readNaiSyncConfig();
        await writeNaiSyncConfig({ ...config, lastResult: `同步失败：${failed}` });
        sendResponse({ ok: false, error: failed });
      }
    })();
    return true;
  }

  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== NAI_SYNC_ALARM_NAME) return;
  runNaiSync({ mode: 'both', auto: true }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  readNaiSyncConfig().then((config) => refreshNaiSyncAlarm(config)).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  readNaiSyncConfig().then((config) => refreshNaiSyncAlarm(config)).catch(() => {});
});
