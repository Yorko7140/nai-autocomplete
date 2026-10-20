// 往网页的 Character 栏里填提示词。
//
// V5 多角色是主力场景，但我们以前只能写主提示词，角色栏得用户自己一个个粘。
//
// 只填输入框，不碰「生成」——「不要加任何触发出图的功能」那条红线在这儿也算数。

const NAI_FIELD_SELECTOR = 'textarea, input[type="text"], [contenteditable="true"], [role="textbox"]';
const NAI_ADD_CHARACTER_PATTERN = /add\s*(a\s*)?character|添加角色|新增角色|追加角色/i;
// 角色栏最多试到 6 个：这是我们这边快捷位的数量，不是 NAI 的模型上限
const NAI_MAX_CHARACTER_SLOTS = 6;

function naiFieldSignals(element) {
  return [
    element?.id,
    element?.name,
    element?.className,
    element?.getAttribute?.('placeholder'),
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('data-testid'),
  ].join(' ').toLowerCase();
}

function isNaiEditableField(element) {
  if (!element || !element.isConnected) return false;
  if (element.disabled || element.readOnly) return false;
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName === 'INPUT') {
    return !['hidden', 'checkbox', 'radio', 'submit', 'button', 'range', 'file'].includes(
      String(element.type || '').toLowerCase(),
    );
  }
  return element.isContentEditable
    || element.getAttribute?.('contenteditable') === 'true'
    || element.getAttribute?.('role') === 'textbox';
}

// idlecloud 的负向框跟着 Tab 换 placeholder（Describe what should be avoided…），
// 角色卡里的排除框叫 Character exclusions，两种都要算负向，否则会被当成正向内容填进去。
function isNaiNegativeField(element) {
  return /negative|undesired|exclusion|\buc\b|avoid|反向|负面|不希望|排除/.test(naiFieldSignals(element));
}

// 「角色名称」不是提示词栏，得先排掉 —— 它和角色提示词栏挨在一起，签名里都有 character
function isNaiCharacterField(element) {
  if (!element) return false;
  const signals = naiFieldSignals(element);
  if (/character[-_ ]?name|角色名称|角色名/.test(signals)) return false;
  // idlecloud 的角色卡把提示词框标成 "Character description"，排除框是 "Character exclusions"
  if (/character[-_ ]?prompt|char[-_ ]?caption|character[-_ ]?desc|character\s*\d|角色提示词|人物提示词|角色描述/.test(signals)) return true;
  // 站点只给了 placeholder：Describe the character’s appearance, clothing, and features…
  if (/describe\s+the\s+character|character[’'`]?s?\s+(appearance|clothing|feature|description)/.test(signals)) return true;

  // 站点没在字段上留签名时，退一步看它在不在角色卡片容器里
  const card = element.closest?.('[data-character-index], [data-testid*="character"], [class*="character-card"], [class*="CharacterCard"], [class*="characterPrompt"]');
  return Boolean(card) && /prompt|caption|提示词|描述/.test(signals);
}

// 角色区所在的折叠面板：idlecloud 默认收起，按钮上只有 aria-expanded，
// 文案是「Character control · 0 configured」这种，没有 aria-label。
function findNaiCharacterSectionToggle() {
  return Array.from(document.querySelectorAll('button[aria-expanded]')).find((button) => {
    const text = [
      button.innerText,
      button.textContent,
      button.getAttribute?.('aria-label'),
      button.getAttribute?.('title'),
    ].join(' ');
    if (!/character|角色|人物|キャラ/i.test(text)) return false;
    const controls = button.getAttribute?.('aria-controls');
    const region = controls ? document.getElementById(controls) : null;
    // 折叠区里连「添加角色」都摸不到的，不算角色区开关
    if (region && !NAI_ADD_CHARACTER_PATTERN.test(region.textContent || '')) return false;
    return true;
  }) || null;
}

async function ensureNaiCharacterSectionOpen() {
  const toggle = findNaiCharacterSectionToggle();
  if (!toggle) return null;
  if (toggle.getAttribute('aria-expanded') !== 'false') return toggle;

  toggle.click();
  // 站点的折叠面板带 300ms 左右的展开动画，点完立刻去点「Add character」会被 React 的
  // 重渲染吞掉，所以要等 aria-expanded 真的翻过来（而不是只等一两帧）
  for (let i = 0; i < 12; i += 1) {
    await waitNaiMs(50);
    if (toggle.getAttribute('aria-expanded') !== 'false') break;
  }
  return toggle;
}

function listNaiCharacterFields() {
  const all = Array.from(document.querySelectorAll(NAI_FIELD_SELECTOR))
    .filter((field) => isNaiEditableField(field) && !isNaiNegativeField(field) && isNaiCharacterField(field));
  // 页面上还藏着别的输入框（站点自绘的、AI Chat 的），优先只用看得见的那些；
  // 角色区整体折叠时一个都看不见，这时候退回去用全部，免得误判成「没有角色栏」
  const visible = all.filter((field) => naiElementIsVisible(field));
  return visible.length ? visible : all;
}

function findNaiAddCharacterButton() {
  return Array.from(document.querySelectorAll('button, [role="button"]')).find((button) => {
    if (button.disabled || button.getAttribute?.('aria-disabled') === 'true') return false;
    return NAI_ADD_CHARACTER_PATTERN.test([
      button.innerText,
      button.textContent,
      button.getAttribute?.('aria-label'),
      button.getAttribute?.('title'),
    ].join(' '));
  }) || null;
}

// React 不认直接赋值给 .value —— 它记的是自己那份 state，得走原生 setter 再派 input 事件
function setNaiFieldValue(field, value) {
  field.focus?.();
  if (field.tagName === 'TEXTAREA' || field.tagName === 'INPUT') {
    const prototype = field.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement?.prototype
      : window.HTMLInputElement?.prototype;
    const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(field, value);
    else field.value = value;
    field.setSelectionRange?.(value.length, value.length);
  } else {
    field.textContent = value;
  }
  field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

function nextNaiFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function waitNaiMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 点「添加角色」补足栏位。参考实现点完只 await 一个微任务就去数，React 还没重渲染完，
// 会漏数然后误判「加不上去了」。这里等一帧再数，并且连续两轮不涨就停 —— 不能无限点。
async function ensureNaiCharacterFields(count) {
  await ensureNaiCharacterSectionOpen();
  let fields = listNaiCharacterFields();
  let stalled = 0;

  while (fields.length < count && stalled < 2) {
    const button = findNaiAddCharacterButton();
    if (!button) break;

    const before = fields.length;
    button.click();
    // 新增角色卡是异步渲染的，等一帧再补一小段，否则会误判成「加不上去」
    await nextNaiFrame();
    await waitNaiMs(120);
    fields = listNaiCharacterFields();
    stalled = fields.length > before ? 0 : stalled + 1;
  }

  return fields;
}

// characters: [{ prompt, label?, slot? }]，slot 从 1 起
async function fillNaiCharacterFields(characters) {
  const desired = (Array.isArray(characters) ? characters : [])
    .map((entry, index) => ({
      slot: Math.max(1, Math.min(NAI_MAX_CHARACTER_SLOTS, Number(entry?.slot) || index + 1)),
      prompt: String(entry?.prompt || '').trim(),
    }))
    .filter((entry) => entry.prompt);

  if (!desired.length) {
    return { ok: false, filled: 0, reason: 'empty', message: '没有可填入的角色提示词。' };
  }

  const needed = Math.max(...desired.map((entry) => entry.slot));
  const fields = await ensureNaiCharacterFields(needed);

  if (!fields.length) {
    return {
      ok: false,
      filled: 0,
      reason: 'not-found',
      message: '当前页面上没有找到角色栏。请在绘图页先添加一个角色后重试。',
    };
  }

  if (fields.length < needed) {
    return {
      ok: false,
      filled: 0,
      reason: 'too-few',
      message: `当前页面只有 ${fields.length} 个角色栏，需要 ${needed} 个。请先在绘图页添加到 ${needed} 个角色。`,
    };
  }

  desired.forEach((entry) => setNaiFieldValue(fields[entry.slot - 1], entry.prompt));
  return { ok: true, filled: desired.length, message: `已填入 ${desired.length} 个角色栏` };
}
