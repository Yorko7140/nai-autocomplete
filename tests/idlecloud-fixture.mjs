/**
 * 本地替身页：复刻 nai.idlecloud.cc/main 的提示词区与角色区结构。
 *
 * 照着真实站点截图与 DOM 探测结果搭的，用来在没有登录态的情况下验证
 * 站点适配层（提示词框识别、画师串写入、角色区折叠展开与补位）。
 *
 * 与真实站点的对应关系：
 *   · .prompt-editor-input 里两个 textarea：可写的带 aria-label，另一个是只读影子框（值恒为 "x"）
 *   · Positive / Negative / Translate 三个 Tab 复用同一个 textarea，切换时换 value 与 placeholder
 *   · Character control 按钮默认 aria-expanded="false"，内容区折叠时仍在 DOM 里
 *   · 每个角色卡里是 Character prompt / Character exclusions 两个 Tab，复用同一个 textarea
 */
export const IDLECLOUD_FIXTURE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>IdleCloud 替身页</title>
<style>
  body { margin: 0; background: #1b1b1f; color: #e6e6e6; font: 14px/1.5 system-ui, sans-serif; }
  main { display: flex; gap: 16px; padding: 16px; align-items: flex-start; }
  section { background: #232329; border: 1px solid #33333a; border-radius: 10px; padding: 12px; }
  #stage { flex: 1; min-height: 520px; }
  #panel { width: 420px; }
  [role="tablist"] { display: flex; gap: 6px; margin-bottom: 8px; }
  [role="tab"] { background: #2c2c34; color: #cfcfe0; border: 1px solid #3a3a44; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  [role="tab"][aria-selected="true"] { background: #3a3a48; color: #fff; }
  .prompt-editor-input { position: relative; }
  .prompt-editor-input textarea { width: 100%; box-sizing: border-box; min-height: 180px; background: #1b1b1f; color: #e6e6e6; border: 1px solid #3a3a44; border-radius: 8px; padding: 8px; font: 13px/1.6 ui-monospace, monospace; }
  .prompt-editor-input textarea:last-child { position: absolute; left: 0; top: 0; height: 0; min-height: 0; opacity: 0; pointer-events: none; }
  #cc-content[hidden] { display: none; }
  .character-card { border: 1px solid #3a3a44; border-radius: 8px; padding: 8px; margin-top: 8px; }
  .character-card textarea { width: 100%; box-sizing: border-box; min-height: 70px; background: #1b1b1f; color: #e6e6e6; border: 1px solid #3a3a44; border-radius: 6px; padding: 6px; }
  button { font: inherit; }
</style>
</head>
<body>
<main>
  <section id="stage">
    <h3>Generated results will appear here</h3>
  </section>

  <section id="panel">
    <div role="tablist" id="prompt-tabs">
      <button role="tab" aria-selected="true" data-prompt-tab="positive">Positive</button>
      <button role="tab" aria-selected="false" data-prompt-tab="negative">Negative</button>
      <button role="tab" aria-selected="false" data-prompt-tab="translate">Translate</button>
    </div>

    <div class="prompt-editor-input">
      <textarea id="_r_17_-input" aria-label="Describe the image you want to generate…"
        placeholder="Describe the image you want to generate…"></textarea>
      <textarea readonly tabindex="-1" aria-hidden="true">x</textarea>
    </div>

    <div class="prompt-editor-actions">
      <button aria-label="Expand positive-prompt editor">⤢</button>
      <button aria-label="Copy positive prompt">⧉</button>
    </div>

    <hr>

    <button id="_r_16_-toggle" aria-expanded="false" aria-controls="_r_16_-content">
      Character control <span id="cc-count">0 configured · 0 enabled</span>
    </button>
    <div role="region" id="_r_16_-content" aria-labelledby="_r_16_-toggle" hidden>
      <button type="button" data-add-character>Add character</button>
      <p id="cc-empty">No characters added yet</p>
      <div id="cc-list"></div>
    </div>
  </section>
</main>

<script>
  // —— 站点行为模拟（够用就行：React 受控组件的关键特征是 value 由事件驱动重渲染）
  const PROMPTS = {
    positive: { text: '', placeholder: 'Describe the image you want to generate…' },
    negative: { text: '', placeholder: 'Describe what should be avoided…' },
    translate: { text: '', placeholder: 'Translate between Chinese and English…' },
  };
  const input = document.getElementById('_r_17_-input');
  const tabs = Array.from(document.querySelectorAll('#prompt-tabs [role="tab"]'));

  function applyPromptTab(kind) {
    tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.promptTab === kind)));
    input.placeholder = PROMPTS[kind].placeholder;
    input.setAttribute('aria-label', PROMPTS[kind].placeholder);
    input.value = PROMPTS[kind].text;
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => applyPromptTab(tab.dataset.promptTab));
  });

  input.addEventListener('input', () => {
    const kind = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.dataset.promptTab || 'positive';
    PROMPTS[kind].text = input.value;
  });

  const toggle = document.getElementById('_r_16_-toggle');
  const content = document.getElementById('_r_16_-content');
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    content.hidden = open;
  });

  let characterCount = 0;

  function addCharacterCard() {
    characterCount += 1;
    const index = characterCount;
    const card = document.createElement('div');
    card.className = 'character-card';
    card.innerHTML = \`
      <div role="tablist">
        <button role="tab" aria-selected="true" data-char-tab="prompt">Character prompt</button>
        <button role="tab" aria-selected="false" data-char-tab="avoid">Character exclusions</button>
      </div>
      <textarea class="character-prompt" aria-label="Character description" placeholder="Character description"></textarea>
    \`;
    const textarea = card.querySelector('textarea');
    const charTabs = Array.from(card.querySelectorAll('[role="tab"]'));
    const values = { prompt: '', avoid: '' };
    charTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const current = charTabs.find((item) => item.getAttribute('aria-selected') === 'true');
        if (current) values[current.dataset.charTab] = textarea.value;
        charTabs.forEach((item) => item.setAttribute('aria-selected', String(item === tab)));
        textarea.value = values[tab.dataset.charTab];
        const label = tab.dataset.charTab === 'avoid' ? 'Character exclusions' : 'Character description';
        textarea.setAttribute('aria-label', label);
        textarea.placeholder = label;
      });
    });
    textarea.addEventListener('input', () => {
      const current = charTabs.find((item) => item.getAttribute('aria-selected') === 'true');
      if (current) values[current.dataset.charTab] = textarea.value;
    });

    document.getElementById('cc-list').appendChild(card);
    const empty = document.getElementById('cc-empty');
    if (empty) empty.remove();
    document.getElementById('cc-count').textContent = \`\${index} configured · \${index} enabled\`;
  }

  document.querySelector('[data-add-character]').addEventListener('click', addCharacterCard);

  // 给测试用：预置正向提示词
  window.__fixtureSetPrompt = (kind, text) => {
    PROMPTS[kind].text = text;
    applyPromptTab(kind);
  };
  window.__fixturePromptState = () => ({
    ...PROMPTS,
    domValue: input.value,
    shadowValue: document.querySelectorAll('.prompt-editor-input textarea')[1].value,
    characters: characterCount,
  });
</script>
</body>
</html>
`;
