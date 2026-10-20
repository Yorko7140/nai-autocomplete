// 跨设备同步卡片：本体在 shared/02-sync-panel.js，两个 bundle 共用。
//
// 这里只负责在助手面板的工作台设置页里挂一次，别把逻辑写回两份。

function syncSettingsMarkup() {
  return naiSyncPanelMarkup();
}

function applySyncSettingsToInputs() {
  const scope = ui.library?.settingsPanel || document;
  naiSyncMountPanel(naiSyncPanelRoot(scope));
}
