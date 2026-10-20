// 跨设备同步的内核：哪些键要同步、怎么加密、怎么判断谁更新。
//
// 这份 chunk 同时进 content / assistant / background 三个 bundle（见 scripts/build-modular.mjs
// 的 sharedDirs），所以符号一律带 nai 前缀，也不能依赖任何 UI 状态。
//
// 同步本身走 WebDAV：远端只有一个文件，整份 payload 加密后才写出去。加密是必须的 ——
// 设置里带着 API Key，而 WebDAV 那台服务器未必是自己的（坚果云、Nextcloud、公司盘都算）。
// 口令只存在本地，不写进远端文件。

const NAI_SYNC_FORMAT = 'nai-autocomplete-sync';
const NAI_SYNC_VERSION = 1;
const NAI_SYNC_FILE_NAME = 'nai-autocomplete-sync.json';

// 精确键。故意不含这些：
//   nai-ac-tags / nai-ac-tags-time        词典缓存，几 MB，各端自己下一份更快
//   nai-agent-conversation                正在进行的对话，换设备续不上反而奇怪
//   nai-llm-panel-layout / nai-fab-position / nai-llm-drawer-layout
//                                         都是屏幕尺寸相关的摆放位置
//   nai-sync-config / nai-sync-state      同步自己的配置与基线，天然不能同步
const NAI_SYNC_KEYS = [
  { key: 'naiArtistTracker_v1', label: '画师记录本' },
  { key: 'nai-shared-prompt-library', label: '提示词库' },
  { key: 'nai-llm-prompt-presets', label: '提示词预设' },
  { key: 'nai-agent-skills', label: '自定义技能' },
  { key: 'nai-agent-active-skill', label: '当前选中的技能' },
  { key: 'nai-llm-assistant-settings', label: '模型与界面设置（含 API Key）' },
];

// 每个站点/路径各存一份的键，靠前缀捞。
const NAI_SYNC_KEY_PREFIXES = [
  { prefix: 'nai-ac-prompt-blocks', label: '提示词区块' },
];

function naiSyncKeyLabel(key) {
  const exact = NAI_SYNC_KEYS.find((item) => item.key === key);
  if (exact) return exact.label;
  const prefixed = NAI_SYNC_KEY_PREFIXES.find((item) => String(key).startsWith(`${item.prefix}:`));
  return prefixed ? `${prefixed.label}（${String(key).slice(prefixed.prefix.length + 1)}）` : key;
}

function naiSyncIsSyncedKey(key) {
  if (NAI_SYNC_KEYS.some((item) => item.key === key)) return true;
  return NAI_SYNC_KEY_PREFIXES.some((item) => String(key).startsWith(`${item.prefix}:`));
}

// 递归按键名排序，保证同一份数据每次序列化出来都一样 —— 哈希要拿它做基准。
function naiSyncStableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => naiSyncStableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${naiSyncStableStringify(value[key])}`).join(',')}}`;
}

// FNV-1a 32 位。只用来判断「这份数据跟上次比变没变」，不需要抗碰撞强度。
function naiSyncHash(value) {
  const text = naiSyncStableStringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function naiSyncBytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function naiSyncBase64ToBytes(text) {
  const binary = atob(String(text || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const NAI_SYNC_PBKDF2_ITERATIONS = 120000;

async function naiSyncDeriveKey(passphrase, salt) {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', encoder.encode(String(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: NAI_SYNC_PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// 远端文件的形状：{ format, version, alg, salt, iv, data }。
// salt / iv 每次推送都重新生成，同一份数据两次推出去的密文也不同。
async function naiSyncEncrypt(payload, passphrase) {
  if (!String(passphrase || '')) throw new Error('同步口令不能为空');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await naiSyncDeriveKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    format: NAI_SYNC_FORMAT,
    version: NAI_SYNC_VERSION,
    alg: `AES-GCM-256/PBKDF2-SHA256-${NAI_SYNC_PBKDF2_ITERATIONS}`,
    salt: naiSyncBytesToBase64(salt),
    iv: naiSyncBytesToBase64(iv),
    data: naiSyncBytesToBase64(new Uint8Array(cipher)),
  };
}

async function naiSyncDecrypt(blob, passphrase) {
  if (!blob || blob.format !== NAI_SYNC_FORMAT) throw new Error('这不是本扩展的同步文件');
  if (!String(passphrase || '')) throw new Error('同步口令不能为空');
  const key = await naiSyncDeriveKey(passphrase, naiSyncBase64ToBytes(blob.salt));
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: naiSyncBase64ToBytes(blob.iv) }, key, naiSyncBase64ToBytes(blob.data));
  } catch (error) {
    throw new Error('口令不对，解不开远端文件');
  }
  const parsed = JSON.parse(new TextDecoder().decode(plain));
  if (!parsed || parsed.format !== NAI_SYNC_FORMAT) throw new Error('远端文件内容已损坏');
  return parsed;
}

function naiSyncEmptyDoc(deviceId) {
  return {
    format: NAI_SYNC_FORMAT,
    version: NAI_SYNC_VERSION,
    deviceId: String(deviceId || ''),
    updatedAt: Date.now(),
    entries: {},
  };
}

// 三方比较：local 是本地当前的键值，remote 是远端的 entries（{at, value}），
// base 是上次同步成功时每个键的哈希。谁跟 base 不一样，就是谁改过。
function naiSyncCompare({ localValues = {}, remoteEntries = {}, base = {} } = {}) {
  const result = { same: [], push: [], pull: [], conflicts: [] };
  const keys = new Set([...Object.keys(localValues), ...Object.keys(remoteEntries)]);
  keys.forEach((key) => {
    if (!naiSyncIsSyncedKey(key)) return;
    const hasLocal = Object.prototype.hasOwnProperty.call(localValues, key);
    const remoteEntry = remoteEntries[key];
    const localHash = hasLocal ? naiSyncHash(localValues[key]) : '';
    const remoteHash = remoteEntry ? naiSyncHash(remoteEntry.value) : '';

    if (!remoteEntry) {
      // 云端没有：本地有就推上去
      if (hasLocal) result.push.push(key);
      return;
    }
    if (!hasLocal) {
      result.pull.push(key);
      return;
    }
    if (localHash === remoteHash) {
      result.same.push(key);
      return;
    }

    const known = base[key];
    const localChanged = !known || known.hash !== localHash;
    const remoteChanged = !known || known.hash !== remoteHash;
    if (localChanged && !remoteChanged) result.push.push(key);
    else if (!localChanged && remoteChanged) result.pull.push(key);
    else if (!localChanged && !remoteChanged) result.same.push(key);
    else result.conflicts.push(key);
  });
  result.same.sort();
  result.push.sort();
  result.pull.sort();
  result.conflicts.sort();
  return result;
}

// 把「该拉的」和「该推的」落到一份新的 entries 上：返回新 entries 与写入本地的数据。
function naiSyncCompose({ localValues = {}, remoteEntries = {}, plan, conflictResolution = 'local', deviceId = '' } = {}) {
  const now = Date.now();
  const entries = { ...remoteEntries };
  const localWrites = {};

  (plan.pull || []).forEach((key) => {
    localWrites[key] = remoteEntries[key].value;
    localValues[key] = remoteEntries[key].value;
  });

  (plan.push || []).forEach((key) => {
    entries[key] = { at: now, value: localValues[key] };
  });

  // 冲突：默认保留本地（不静默丢自己的数据），远端那份留到用户明确选择再用。
  (plan.conflicts || []).forEach((key) => {
    if (conflictResolution === 'remote') {
      localWrites[key] = remoteEntries[key].value;
      localValues[key] = remoteEntries[key].value;
      return;
    }
    entries[key] = { at: now, value: localValues[key] };
  });

  // 本地的名字也要落到 entries 里：第一次同步时云端是空的，全靠这一条铺开
  Object.keys(localValues).forEach((key) => {
    if (!naiSyncIsSyncedKey(key)) return;
    if (!entries[key] || naiSyncHash(entries[key].value) !== naiSyncHash(localValues[key])) {
      entries[key] = { at: now, value: localValues[key] };
    }
  });

  return {
    doc: {
      format: NAI_SYNC_FORMAT,
      version: NAI_SYNC_VERSION,
      deviceId: String(deviceId || ''),
      updatedAt: now,
      entries,
    },
    localWrites,
  };
}

// 新基线：同步成功后，每个键的哈希与时间。
function naiSyncNextBase(doc) {
  const base = {};
  Object.keys(doc.entries || {}).forEach((key) => {
    if (!naiSyncIsSyncedKey(key)) return;
    base[key] = { hash: naiSyncHash(doc.entries[key].value), at: doc.entries[key].at || Date.now() };
  });
  return base;
}

function naiSyncSummarize(plan) {
  const list = (keys) => (keys || []).map((key) => naiSyncKeyLabel(key)).join('、') || '无';
  return `拉取 ${plan.pull.length} 项（${list(plan.pull)}）、推送 ${plan.push.length} 项（${list(plan.push)}）、冲突 ${plan.conflicts.length} 项（${list(plan.conflicts)}）`;
}

function naiSyncConfigDefaults() {
  return {
    enabled: false,
    url: '',
    username: '',
    password: '',
    remotePath: '/nai-autocomplete/nai-autocomplete-sync.json',
    passphrase: '',
    intervalMinutes: 15,
    lastSyncAt: 0,
    lastResult: '',
    deviceId: '',
  };
}

function naiSyncNormalizeConfig(raw) {
  const defaults = naiSyncConfigDefaults();
  const input = raw && typeof raw === 'object' ? raw : {};
  const interval = Number(input.intervalMinutes);
  return {
    ...defaults,
    ...input,
    enabled: Boolean(input.enabled),
    url: String(input.url || '').trim().replace(/\/+$/, ''),
    username: String(input.username || ''),
    password: String(input.password || ''),
    remotePath: String(input.remotePath || defaults.remotePath).trim() || defaults.remotePath,
    passphrase: String(input.passphrase || ''),
    // 太短的间隔会把 WebDAV 打出 429，抬到 5 分钟；上限一天一次，再长就不如手动点
    intervalMinutes: Number.isFinite(interval) ? Math.min(1440, Math.max(5, Math.round(interval))) : defaults.intervalMinutes,
    lastSyncAt: Number(input.lastSyncAt) || 0,
    lastResult: String(input.lastResult || ''),
    deviceId: String(input.deviceId || ''),
  };
}
