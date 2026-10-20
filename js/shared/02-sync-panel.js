// 跨设备同步的卡片本体。
//
// 放在 shared 里是因为它要被两处复用：
//   · 反推助手面板里的工作台（assistant bundle）
//   · 独立画师记录本页 pages/artist-library.html（artist bundle）
// 所以这里只依赖 chrome.runtime / 原生 DOM，不碰两边各自的作用域对象。
// 符号统一 naiSync 前缀，避免和别的 chunk 撞名。

const NAI_SYNC_PANEL_FIELD_ATTR = 'data-sync-field';
const NAI_SYNC_PANEL_TIMEOUT_MS = 20000;

function naiSyncPanelSendMessage(message, timeoutMs = NAI_SYNC_PANEL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('同步服务没有响应（超时），请重试一次'));
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

function naiSyncPanelMarkup() {
  return `
        <div class="nai-library-settings-group" data-sync-root>
          <div class="nai-library-settings-title">跨设备同步</div>
          <div class="nai-library-note">把画师记录本、提示词库、预设、自定义技能和模型设置（含 API Key）加密后放到你自己的 WebDAV 上。手机和电脑装同一个扩展，填同一套配置就能共用。远端只有一个加密文件，服务器看不到内容；口令只留在本机。</div>
          <label class="nai-library-field">
            <span>WebDAV 地址</span>
            <input ${NAI_SYNC_PANEL_FIELD_ATTR}="url" type="text" placeholder="https://dav.jianguoyun.com/dav/" autocomplete="off" spellcheck="false" />
          </label>
          <div class="nai-library-settings-grid">
            <label class="nai-library-field">
              <span>用户名</span>
              <input ${NAI_SYNC_PANEL_FIELD_ATTR}="username" type="text" autocomplete="off" spellcheck="false" />
            </label>
            <label class="nai-library-field">
              <span>应用密码</span>
              <input class="nai-md3-secret" ${NAI_SYNC_PANEL_FIELD_ATTR}="password" type="text" autocomplete="off" spellcheck="false" />
            </label>
          </div>
          <div class="nai-library-note">坚果云：地址填 https://dav.jianguoyun.com/dav/，用户名是登录邮箱，「应用密码」在账户信息 → 安全选项里生成（不是登录密码）。</div>
          <label class="nai-library-field">
            <span>远端文件路径</span>
            <input ${NAI_SYNC_PANEL_FIELD_ATTR}="remotePath" type="text" placeholder="/nai-autocomplete/nai-autocomplete-sync.json" autocomplete="off" spellcheck="false" />
          </label>
          <label class="nai-library-field">
            <span>同步口令（端到端加密用，两台设备必须一致）</span>
            <input class="nai-md3-secret" ${NAI_SYNC_PANEL_FIELD_ATTR}="passphrase" type="text" autocomplete="off" spellcheck="false" placeholder="自己定一句，丢了就只能重新同步" />
          </label>
          <div class="nai-library-settings-grid">
            <label class="nai-library-field">
              <span>自动同步间隔（分钟）</span>
              <input ${NAI_SYNC_PANEL_FIELD_ATTR}="intervalMinutes" type="number" min="5" max="1440" step="5" />
            </label>
            <label class="nai-library-field">
              <span>开启自动同步</span>
              <span class="nai-md3-switch"><input ${NAI_SYNC_PANEL_FIELD_ATTR}="enabled" type="checkbox" /><span></span></span>
            </label>
          </div>
          <div class="nai-library-settings-actions">
            <button type="button" data-action="sync-save">保存同步设置</button>
            <button type="button" data-action="sync-test">测试连接</button>
          </div>
          <div class="nai-library-settings-actions">
            <button type="button" class="nai-md3-primary" data-action="sync-both">立即同步（双向）</button>
            <button type="button" data-action="sync-push">以本机为准推送</button>
            <button type="button" data-action="sync-pull">以云端为准拉取</button>
          </div>
          <div class="nai-library-note" data-sync-status>还没读取同步配置</div>
        </div>`;
}

function naiSyncPanelRoot(scope = document) {
  const found = scope.querySelector('[data-sync-root]');
  return found || null;
}

function naiSyncPanelInput(root, field) {
  return root ? root.querySelector(`[${NAI_SYNC_PANEL_FIELD_ATTR}="${field}"]`) : null;
}

function naiSyncPanelSetStatus(root, text, tone = '') {
  const target = root?.querySelector('[data-sync-status]');
  if (!target) return;
  target.textContent = text;
  target.dataset.tone = tone;
}

function naiSyncPanelFill(root, config) {
  if (!root || !config) return;
  const set = (field, value) => {
    const input = naiSyncPanelInput(root, field);
    if (!input) return;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value == null ? '' : String(value);
  };
  set('url', config.url);
  set('username', config.username);
  set('password', config.password);
  set('remotePath', config.remotePath);
  set('passphrase', config.passphrase);
  set('intervalMinutes', config.intervalMinutes);
  set('enabled', config.enabled);
  root.dataset.deviceId = config.deviceId || '';
}

function naiSyncPanelRead(root) {
  const read = (field) => {
    const input = naiSyncPanelInput(root, field);
    return input ? input.value : '';
  };
  return {
    // 表单里没有设备 ID 这一栏，但丢了它下游会当成新设备、基线全废
    deviceId: root?.dataset.deviceId || '',
    url: read('url'),
    username: read('username'),
    password: read('password'),
    remotePath: read('remotePath'),
    passphrase: read('passphrase'),
    intervalMinutes: Number(read('intervalMinutes')) || 15,
    enabled: Boolean(naiSyncPanelInput(root, 'enabled')?.checked),
  };
}

async function naiSyncPanelLoad(root) {
  if (!root) return;
  try {
    const response = await naiSyncPanelSendMessage({ type: 'nai-sync-config-get' });
    if (!response?.ok) {
      naiSyncPanelSetStatus(root, `读取同步配置失败：${response?.error || '未知错误'}`, 'error');
      return;
    }
    naiSyncPanelFill(root, response.config);
    const when = response.config.lastSyncAt
      ? new Date(response.config.lastSyncAt).toLocaleString()
      : '还没同步过';
    const tail = response.config.lastResult ? ` · ${response.config.lastResult}` : '';
    naiSyncPanelSetStatus(
      root,
      `上次同步：${when}${tail}`,
      String(response.config.lastResult || '').startsWith('同步失败') ? 'error' : '',
    );
  } catch (error) {
    naiSyncPanelSetStatus(root, `读取同步配置失败：${String(error?.message || error)}`, 'error');
  }
}

async function naiSyncPanelSave(root) {
  const response = await naiSyncPanelSendMessage({
    type: 'nai-sync-config-save',
    config: naiSyncPanelRead(root),
  });
  if (!response?.ok) {
    naiSyncPanelSetStatus(root, `保存失败：${response?.error || '未知错误'}`, 'error');
    return null;
  }
  naiSyncPanelSetStatus(root, '同步设置已保存', 'ok');
  if (root) root.dataset.deviceId = response.config?.deviceId || root.dataset.deviceId || '';
  return response.config;
}

function naiSyncPanelSummary(result) {
  if (!result) return '没有返回结果';
  if (result.error) return `同步失败：${result.error}`;
  const parts = [`拉取 ${result.pulled || 0} 项`, `推送 ${result.pushed || 0} 项`];
  if (result.conflicts?.length) parts.push(`冲突 ${result.conflicts.length} 项`);
  return parts.join('，');
}

async function naiSyncPanelHandle(root, action) {
  try {
    if (action === 'sync-save') {
      await naiSyncPanelSave(root);
      return;
    }

    const config = naiSyncPanelRead(root);
    if (!config.url.trim()) {
      naiSyncPanelSetStatus(root, '还没填 WebDAV 地址', 'error');
      return;
    }

    if (action === 'sync-test') {
      naiSyncPanelSetStatus(root, '正在测试连接…');
      const response = await naiSyncPanelSendMessage({ type: 'nai-sync-test', config });
      naiSyncPanelSetStatus(
        root,
        response?.ok ? response.message : `连接失败：${response?.error || '未知错误'}`,
        response?.ok ? 'ok' : 'error',
      );
      return;
    }

    const modes = { 'sync-both': 'both', 'sync-push': 'push', 'sync-pull': 'pull' };
    const mode = modes[action];
    if (!mode) return;

    const saved = await naiSyncPanelSave(root);
    if (!saved) return;
    naiSyncPanelSetStatus(root, '正在同步…');
    const response = await naiSyncPanelSendMessage({ type: 'nai-sync-run', mode });
    if (!response?.ok) {
      naiSyncPanelSetStatus(root, `同步失败：${response?.error || '未知错误'}`, 'error');
      return;
    }
    const summary = naiSyncPanelSummary(response);
    const conflictNote = response.conflicts?.length ? '（冲突项保留了本机版本）' : '';
    naiSyncPanelSetStatus(root, `同步完成：${summary}${conflictNote}`, 'ok');
    if (typeof root?.dataset.onSynced === 'string') {
      try {
        root.dispatchEvent(new CustomEvent('nai-sync-completed', { bubbles: true, detail: response }));
      } catch (error) {
        /* 自定义事件失败不影响同步结果 */
      }
    }
  } catch (error) {
    naiSyncPanelSetStatus(root, `操作失败：${String(error?.message || error)}`, 'error');
  }
}

function naiSyncMountPanel(root) {
  if (!root || root.dataset.syncBound === '1') return;
  root.dataset.syncBound = '1';
  root.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-action]');
    if (!button || !root.contains(button)) return;
    const action = button.dataset.action || '';
    if (!action.startsWith('sync-')) return;
    event.preventDefault();
    event.stopPropagation();
    naiSyncPanelHandle(root, action);
  });
  naiSyncPanelLoad(root);
}
