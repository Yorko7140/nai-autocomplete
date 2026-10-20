// 站点配置层：content 与 assistant 两个 bundle 共用（构建时前置进两边）。
//
// 为什么要有这一层：content 脚本和 assistant 脚本是两个互不可见的 IIFE，
// 站点差异（提示词框选择器、绘图层判定、角色区结构）如果各写一份，
// 迟早会出现「补全认得出、写到框里却写错」这种两边不一致的问题。
// 所以站点相关的事实只在这里定义一次。
//
// 支持的站点：
//   novelai    — 官方 novelai.net，提示词框是 ProseMirror（富文本）
//   idlecloud  — 中转站 nai.idlecloud.cc，提示词框是 MUI TextareaAutosize（真 textarea + 只读影子 textarea）

const NAI_SITE_PROFILES = {
  novelai: {
    id: 'novelai',
    label: 'NovelAI',
    hostnames: ['novelai.net'],
    // ProseMirror 是富文本编辑器；comfy-multiline-input 是本地 ComfyUI 的文本框
    promptEditorSelector: '.ProseMirror, textarea.comfy-multiline-input',
    imagePagePattern: /^\/image\/?$/,
    hasOfficialBridge: true,
  },
  idlecloud: {
    id: 'idlecloud',
    label: 'IdleCloud',
    hostnames: ['nai.idlecloud.cc'],
    // 容器里有两个 textarea：真正可写的那个带 aria-label，另一个是 MUI 用来量高度的
    // 只读影子框（value 常常是 "x"）。选择器只负责圈范围，取舍交给 naiIsWritablePromptEditor。
    promptEditorSelector: '.prompt-editor-input, textarea[aria-label]',
    imagePagePattern: /^\/(main|image)\/?$/,
    hasOfficialBridge: false,
  },
};

function naiSiteProfileList() {
  return Object.keys(NAI_SITE_PROFILES).map((key) => NAI_SITE_PROFILES[key]);
}

function naiHostMatches(profile, hostname) {
  const host = String(hostname || '').toLowerCase();
  return Boolean(host) && profile.hostnames.some((name) => host === name || host.endsWith(`.${name}`));
}

// 传入 win 时用它的 location（background/测试里可能传别的窗口对象）
function naiCurrentSiteProfile(win) {
  const scope = win || (typeof window === 'undefined' ? null : window);
  const host = scope?.location?.hostname;
  return naiSiteProfileList().find((profile) => naiHostMatches(profile, host)) || null;
}

function naiPromptEditorSelector(win) {
  const profile = naiCurrentSiteProfile(win) || NAI_SITE_PROFILES.novelai;
  return profile.promptEditorSelector;
}

function naiElementIsVisible(element) {
  if (!element || !element.isConnected) return false;
  const rects = element.getClientRects?.();
  return Boolean(rects && rects.length);
}

// 可写的提示词输入框：排除只读影子框、disabled、以及纯隐藏的元素
function naiIsWritablePromptEditor(element, options = {}) {
  if (!element || !element.isConnected) return false;
  if (element.disabled || element.readOnly) return false;
  const tag = String(element.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    if (tag === 'INPUT' && String(element.type || '').toLowerCase() === 'hidden') return false;
    if (options.requireVisible !== false && !naiElementIsVisible(element)) return false;
    return true;
  }
  return element.isContentEditable || element.getAttribute?.('contenteditable') === 'true';
}

// 从任意节点（通常是 input 事件里的 e.target）解析出「真正该写的那个框」。
// idlecloud 上事件可能来自影子框，所以要回到容器里挑可写的那个。
function naiResolvePromptEditor(element, win) {
  const selector = naiPromptEditorSelector(win);
  const hit = element?.closest?.(selector) || null;
  if (!hit) return null;
  if (naiIsWritablePromptEditor(hit, { requireVisible: false })) return hit;

  const container = hit.closest?.('.prompt-editor-input') || hit.parentElement;
  if (container) {
    const writable = Array.from(container.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]'))
      .find((field) => naiIsWritablePromptEditor(field, { requireVisible: false }));
    if (writable) return writable;
  }
  return hit;
}

function naiListPromptEditors(root = (typeof document === 'undefined' ? null : document)) {
  if (!root) return [];
  const editors = [];
  for (const element of Array.from(root.querySelectorAll(naiPromptEditorSelector()))) {
    const resolved = naiResolvePromptEditor(element) || element;
    if (!editors.includes(resolved)) editors.push(resolved);
  }
  return editors;
}

// 是不是「绘图页」：扩展图标的行为、工作台入口都按这个判断
function naiIsImagePage(win, url) {
  const scope = win || (typeof window === 'undefined' ? null : window);
  if (!scope) return false;
  const target = url || scope.location;
  if (!target) return false;
  const profile = naiCurrentSiteProfile(scope);
  if (!profile) return false;
  return naiHostMatches(profile, target.hostname) && profile.imagePagePattern.test(target.pathname || '');
}

// 主提示词框在正/负两个 Tab 之间复用时（idlecloud），同一个 textarea 的
// placeholder 会跟着 Tab 变。往「正向」写之前必须先确认当前停在正向 Tab，
// 否则画师串会写进负向提示词里。
function naiPromptTablist(field) {
  const scope = field?.closest?.('section, [role="region"], form') || field?.parentElement || null;
  return scope?.querySelector?.('[role="tablist"]') || null;
}

async function naiEnsurePositivePromptTab(field) {
  if (!field) return false;
  const signals = [field.getAttribute?.('placeholder'), field.getAttribute?.('aria-label')]
    .join(' ')
    .toLowerCase();
  if (!/avoid|negative|undesired|负面|反向|不希望/.test(signals)) return false;

  const tablist = naiPromptTablist(field);
  if (!tablist) return false;

  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
  const positiveTab = tabs.find((tab) => {
    const text = [tab.innerText, tab.textContent, tab.getAttribute?.('aria-label')].join(' ');
    return /positive|正向|正面/i.test(text) && !/negative|负向|反向/i.test(text);
  });
  if (!positiveTab) return false;
  if (positiveTab.getAttribute('aria-selected') === 'true') return false;

  positiveTab.click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  return true;
}

// background 里没有 document，只能拿字符串判断（见 js/background/01-action.js）
function naiIsImageUrl(urlString) {
  let parsed = null;
  try {
    parsed = new URL(urlString);
  } catch (error) {
    return false;
  }
  const profile = naiSiteProfileList().find((item) => naiHostMatches(item, parsed.hostname));
  return Boolean(profile) && profile.imagePagePattern.test(parsed.pathname || '');
}
