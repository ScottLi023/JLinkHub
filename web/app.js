/* ============================================================
   STM32 J-Link 调试控制台 — 前端逻辑
   - 级联芯片选择（系列 → 型号）
   - J-Link 连接 / 断开 / 复位
   - WebSocket 接收 RTT 日志（ANSI → 彩色渲染）
   - 固件上传与烧录（实时进度）
   - 上行输入发送到设备 RTT 通道 0
   ============================================================ */

'use strict';

/* ---------- DOM 引用 ---------- */
const $ = (id) => document.getElementById(id);

const comboFamilyEl = $('combo-family');
const comboModelEl = $('combo-model');
const selSpeed = $('sel-speed');
const selReset = $('sel-reset');
const btnConnect = $('btn-connect');
const btnDisconnect = $('btn-disconnect');
const btnReset = $('btn-reset');
const statusChip = $('status-chip');
const statusDot = $('status-dot');
const statusText = $('status-text');
const connInfo = $('conn-info');
const terminal = $('log-terminal');
const chkAutoscroll = $('chk-autoscroll');
const chkTimestamp = $('chk-timestamp');
const btnPause = $('btn-pause');
const btnClear = $('btn-clear');
const btnSaveLog = $('btn-save-log');
const logBytes = $('log-bytes');
const inputUplink = $('input-uplink');
const btnSend = $('btn-send');
const fileInput = $('file-firmware');
const fileName = $('file-name');
const selFwType = $('sel-fw-type');
const chkProgram = $('chk-program');
const chkErase = $('chk-erase');
const btnFlash = $('btn-flash');
const btnFlashLabel = $('btn-flash-label');
const regionList = $('region-list');
const btnAddRegion = $('btn-add-region');
const progressWrap = $('flash-progress-wrap');
const flashStage = $('flash-stage');
const flashPercent = $('flash-percent');
const flashFill = $('flash-fill');
const flashMessage = $('flash-message');
const btnHelp = $('btn-help');
const helpModal = $('help-modal');
const btnHelpClose = $('btn-help-close');

/* ---------- 状态 ---------- */
let ws = null;
let wsPort = 8765;
let wsRetryTimer = null;
let connected = false;
let selectedFile = null;
let uploadPath = null;
let paused = false;
let isFlashing = false;
let logLineCount = 0;
let totalBytes = 0;
const MAX_LINES = 5000;
// 日志接收速度可能远高于浏览器渲染速度。限制待渲染队列，避免暂停日志或
// 日志洪峰时 JavaScript 数组持续增长并最终耗尽浏览器内存。
const MAX_PENDING_LOG_LINES = 10000;
const MAX_PENDING_LOG_CHARS = 2 * 1024 * 1024;
const textEncoder = new TextEncoder();  // 统计真实字节数（UTF-8）

/* ---------- 会话标识（一对一日志隔离） ----------
   每个浏览器标签页一个唯一 sessionId，持久化到 localStorage：
   - 连接 J-Link 时携带 session，后端只把日志/进度推送给该会话
   - 其他打开的网页（不同 session）不会收到日志 */
const SESSION_KEY = 'jl_web_session';

function generateSessionId() {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

let sessionId = (() => {
  try {
    let s = localStorage.getItem(SESSION_KEY);
    if (!s) {
      s = generateSessionId();
      localStorage.setItem(SESSION_KEY, s);
    }
    return s;
  } catch {
    return generateSessionId();
  }
})();

/* ---------- 工具 ---------- */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- 可搜索下拉组件 ----------
   SearchableSelect — 原生 select 的增强替代：
   - 输入框支持模糊搜索（多关键词子串匹配）
   - 键盘导航：↑/↓ 移动高亮、Enter 选中、Esc 关闭
   - 匹配文本 <mark> 高亮，无匹配显示提示
   - ARIA: listbox/option/expanded/activedescendant
   用法:
     const combo = new SearchableSelect(rootEl, {
       placeholder: '…', onSelect: (item) => {}
     });
     combo.setItems([{ value, label, hint }]);
     combo.setValue('F1'); combo.getValue(); combo.clear();
   ------------------------------------------------------ */

class SearchableSelect {
  constructor(root, opts = {}) {
    this.root = root;
    this.placeholder = opts.placeholder || '搜索或选择…';
    this.onSelect = opts.onSelect || null;
    this.onClear = opts.onClear || null;
    this.items = [];
    this.selected = null;        // 当前选中项 {value,label,hint}
    this.filtered = [];          // 过滤后的显示项
    this.activeIdx = -1;         // 键盘高亮索引
    this.expanded = false;

    root.classList.add('combo');
    root.innerHTML =
      '<input type="text" class="combo-input" autocomplete="off" spellcheck="false" ' +
      'role="combobox" aria-expanded="false" aria-autocomplete="list">' +
      '<button type="button" class="combo-toggle" tabindex="-1" aria-label="展开/收起" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="6 9 12 15 18 9"/></svg></button>' +
      '<ul class="combo-list" role="listbox" hidden></ul>';

    this.input = root.querySelector('.combo-input');
    this.toggle = root.querySelector('.combo-toggle');
    this.list = root.querySelector('.combo-list');

    this._bindEvents();
    this.setPlaceholder(this.placeholder);
  }

  /* ---- 选项数据 ---- */
  setItems(items) {
    this.items = items || [];
    this.selected = null;
    this.activeIdx = -1;
    this.input.value = '';
    this.setPlaceholder(this.placeholder);
    this.list.innerHTML = '';
  }

  getValue() { return this.selected ? this.selected.value : null; }
  getItem() { return this.selected; }

  setValue(value) {
    const item = this.items.find(it => it.value === value);
    if (item) {
      this.selected = item;
      this.input.value = item.label;
      this.list.hidden = true;
    }
  }

  clear() {
    this.selected = null;
    this.input.value = '';
    this.setPlaceholder(this.placeholder);
  }

  setPlaceholder(text) { this.input.placeholder = text; }

  setDisabled(disabled) { this.input.disabled = disabled; }

  /* ---- 过滤与渲染 ---- */
  _filter(query) {
    const q = query.trim().toLowerCase();
    if (!q) return this.items.slice();
    const kws = q.split(/\s+/);
    return this.items.filter(it =>
      kws.every(kw => it.label.toLowerCase().includes(kw))
    );
  }

  _renderList() {
    this.list.innerHTML = '';
    if (!this.filtered.length) {
      const li = document.createElement('li');
      li.className = 'combo-empty';
      li.textContent = this.input.value.trim() ? '无匹配结果' : '无可用选项';
      this.list.appendChild(li);
      return;
    }
    const q = this.input.value.trim();
    this.filtered.forEach((item, idx) => {
      const li = document.createElement('li');
      li.className = 'combo-item' + (idx === this.activeIdx ? ' active' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', item === this.selected ? 'true' : 'false');
      li.dataset.idx = idx;
      li.innerHTML =
        `<span class="combo-label">${highlightText(item.label, q)}</span>` +
        (item.hint ? `<span class="combo-hint">${escapeHtml(item.hint)}</span>` : '');
      this.list.appendChild(li);
    });
  }

  _open() {
    this.expanded = true;
    this.input.setAttribute('aria-expanded', 'true');
    this.list.hidden = false;
    this.root.classList.add('open');
    this.filtered = this._filter(this.input.value);
    this.activeIdx = this.filtered.length ? 0 : -1;
    this._renderList();
    this._scrollActiveIntoView();
  }

  _close() {
    this.expanded = false;
    this.input.setAttribute('aria-expanded', 'false');
    this.list.hidden = true;
    this.root.classList.remove('open');
  }

  _choose(idx) {
    const item = this.filtered[idx];
    if (!item) return;
    this.selected = item;
    this.input.value = item.label;
    this._close();
    if (this.onSelect) this.onSelect(item);
  }

  _scrollActiveIntoView() {
    const active = this.list.querySelector('.combo-item.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  /* ---- 事件 ---- */
  _bindEvents() {
    this.input.addEventListener('focus', () => { this._open(); });

    this.input.addEventListener('input', () => {
      if (this.selected && this.input.value !== this.selected.label) this.selected = null;
      this.filtered = this._filter(this.input.value);
      this.activeIdx = this.filtered.length ? 0 : -1;
      if (!this.expanded) this._open();
      else { this._renderList(); this._scrollActiveIntoView(); }
    });

    this.input.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (!this.expanded) { this._open(); return; }
          if (this.filtered.length) {
            this.activeIdx = (this.activeIdx + 1) % this.filtered.length;
            this._renderList(); this._scrollActiveIntoView();
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (!this.expanded) { this._open(); return; }
          if (this.filtered.length) {
            this.activeIdx = (this.activeIdx - 1 + this.filtered.length) % this.filtered.length;
            this._renderList(); this._scrollActiveIntoView();
          }
          break;
        case 'Enter':
          e.preventDefault();
          if (this.expanded && this.activeIdx >= 0) this._choose(this.activeIdx);
          break;
        case 'Escape':
          e.preventDefault();
          this._close();
          break;
        case 'Tab':
          this._close();
          break;
      }
    });

    this.list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('.combo-item');
      if (li) {
        e.preventDefault();
        this._choose(parseInt(li.dataset.idx, 10));
      }
    });

    this.list.addEventListener('mouseover', (e) => {
      const li = e.target.closest('.combo-item');
      if (li) {
        this.activeIdx = parseInt(li.dataset.idx, 10);
        this.list.querySelectorAll('.combo-item').forEach((el, i) =>
          el.classList.toggle('active', i === this.activeIdx));
      }
    });

    // 点击外部关闭
    document.addEventListener('click', (e) => {
      if (!this.root.contains(e.target)) this._close();
    });
  }
}

/* 模糊搜索高亮：把 query 中每个关键词在 text 中的匹配处用 <mark> 包裹 */
function highlightText(text, query) {
  const kws = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!kws.length) return escapeHtml(text);
  const lower = text.toLowerCase();
  const ranges = [];
  for (const kw of kws) {
    let idx = lower.indexOf(kw);
    while (idx !== -1) {
      ranges.push([idx, idx + kw.length]);
      idx = lower.indexOf(kw, idx + kw.length);
    }
  }
  if (!ranges.length) return escapeHtml(text);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1]) last[1] = Math.max(last[1], ranges[i][1]);
    else merged.push(ranges[i]);
  }
  let html = '', pos = 0;
  for (const [s, e] of merged) {
    html += escapeHtml(text.slice(pos, s));
    html += `<mark>${escapeHtml(text.slice(s, e))}</mark>`;
    pos = e;
  }
  html += escapeHtml(text.slice(pos));
  return html;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function showToast(message, type = '') {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = message;
  wrap.appendChild(t);
  setTimeout(() => { t.remove(); }, 4000);
}

/* ---------- 芯片级联选择（可搜索下拉） ---------- */

let allFamilies = {};  // 缓存型号数据，避免重复请求

const familyCombo = new SearchableSelect(comboFamilyEl, {
  placeholder: '输入系列关键词，如 F1、M3、72MHz…',
  onSelect: (item) => {
    populateModels();
    enableConnectBtn();
  },
  onClear: () => {
    modelCombo.clear();
    $('model-info').textContent = '先选择系列，再搜索型号';
    enableConnectBtn();
  }
});

const modelCombo = new SearchableSelect(comboModelEl, {
  placeholder: '输入型号关键词，如 F103、C8T6…',
  onSelect: () => {
    updateModelInfo();
    enableConnectBtn();
    updateFullRegionEnd();
  },
  onClear: () => {
    $('model-info').textContent = '';
    enableConnectBtn();
  }
});

async function loadDevices() {
  try {
    const data = await api('/api/devices');
    allFamilies = data.families || {};

    const entries = Object.entries(allFamilies);
    familyCombo.setItems(entries.map(([key, fam]) => ({
      value: key,
      label: `${key} · ${fam.label || ''}`,
      hint: `${fam.models.length} 个型号`
    })));

    // 不预填系列，由用户自行选择
    modelCombo.setItems([]);
    $('model-info').textContent = '先选择系列，再搜索型号';
    enableConnectBtn();
  } catch (e) {
    showToast('加载芯片型号失败: ' + e.message, 'err');
  }
}

function populateModels() {
  const key = familyCombo.getValue();
  if (!key) {
    modelCombo.setItems([]);
    $('model-info').textContent = '先选择系列，再搜索型号';
    return;
  }
  const fam = allFamilies[key];
  if (!fam) return;
  modelCombo.setItems(fam.models.map(m => ({
    value: m.name,
    label: m.name,
    hint: `${m.flash} Flash / ${m.ram} RAM`
  })));
  modelCombo.setPlaceholder('输入型号关键词，如 F103、C8T6…');
}

function updateModelInfo() {
  const item = modelCombo.getItem();
  $('model-info').textContent = item && item.hint
    ? `Flash: ${item.hint.replace(' Flash / ', ' · RAM: ')}`
    : '';
}

function enableConnectBtn() {
  btnConnect.disabled = !(familyCombo.getValue() && modelCombo.getValue());
}

/* ---------- WebSocket ---------- */

function connectWs() {
  if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
  const url = `ws://${location.hostname}:${wsPort}`;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    scheduleWsRetry();
    return;
  }

  ws.onopen = () => {
    // 声明本会话 ID，后端据此做一对一日志隔离
    try { ws.send(JSON.stringify({ type: 'hello', session: sessionId })); } catch {}
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleWsMessage(msg);
  };

  ws.onclose = () => {
    scheduleWsRetry();
  };

  ws.onerror = () => { try { ws.close(); } catch {} };
}

function scheduleWsRetry() {
  if (wsRetryTimer) return;
  wsRetryTimer = setTimeout(() => { wsRetryTimer = null; connectWs(); }, 3000);
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'status':
      applyStatus(msg);
      break;
    case 'log':
      appendLog(msg.data);
      break;
    case 'flash':
      updateFlashProgress(msg);
      break;
    case 'flash_done':
      finalizeFlash(msg);
      break;
    case 'error':
      showToast(msg.message, 'err');
      break;
    case 'pong':
      break;
  }
}

/* ---------- 状态 ---------- */

function applyStatus(s) {
  connected = !!s.connected;
  statusChip.className = 'status-badge ' + (connected ? 'connected' : '');
  statusText.textContent = connected ? '已连接' : '未连接';
  btnConnect.disabled = connected || !(familyCombo.getValue() && modelCombo.getValue());
  btnDisconnect.disabled = !connected;
  btnReset.disabled = !connected;
  updateFlashButton();

  if (connected) {
    connInfo.textContent =
      `芯片: ${s.chip || '-'}\n` +
      `速率: ${s.speed || '-'} kHz\n` +
      `探针SN: ${s.probe_sn || '-'}`;
  } else {
    connInfo.textContent = '';
  }
}

/* ---------- ANSI 解析 ---------- */

const ANSI_RE = /\x1b\[([0-9;]*)m/g;

const ANSI_STD = {
  30: [0,0,0], 31: [255,0,0], 32: [0,255,0], 33: [255,255,0],
  34: [0,0,255], 35: [255,0,255], 36: [0,255,255], 37: [255,255,255],
  90: [128,128,128], 91: [255,128,128], 92: [128,255,128], 93: [255,255,128],
  94: [128,128,255], 95: [255,128,255], 96: [128,255,255], 97: [255,255,255]
};

/**
 * 把含 ANSI 转义序列的文本转换为 HTML（文本均已转义）。
 * 支持服务器生成的 38;2 真彩色与标准 16 色；其余序列被剥离。
 */
function ansiToHtml(text) {
  let html = '';
  let lastIndex = 0;
  let fg = null;
  ANSI_RE.lastIndex = 0;
  let match;
  while ((match = ANSI_RE.exec(text)) !== null) {
    html += wrapSegment(text.slice(lastIndex, match.index), fg);
    const codes = match[1].split(';').filter(c => c !== '').map(Number);
    // 标准的重置序列是单独的 \x1b[0m；RGB 中的 0 不能误判为重置
    if (codes.length === 1 && codes[0] === 0) {
      fg = null;
    } else {
      // 真彩色: 38;2;R;G;B
      for (let i = 0; i < codes.length; i++) {
        if (codes[i] === 38 && codes[i + 1] === 2) {
          const r = codes[i + 2], g = codes[i + 3], b = codes[i + 4];
          if (r !== undefined && g !== undefined && b !== undefined) {
            fg = [r, g, b];
          }
          break;
        }
      }
      if (!fg) {
        for (const c of codes) {
          if (ANSI_STD[c]) { fg = ANSI_STD[c]; break; }
        }
      }
    }
    lastIndex = match.index + match[0].length;
  }
  html += wrapSegment(text.slice(lastIndex), fg);
  return html;
}

function wrapSegment(seg, fg) {
  if (!seg) return '';
  const esc = escapeHtml(seg);
  return fg
    ? `<span style="color:rgb(${fg[0]},${fg[1]},${fg[2]})">${esc}</span>`
    : `<span class="plain">${esc}</span>`;
}

/* ---------- 日志渲染 ---------- */

let pendingLogs = [];
let pendingLogChars = 0;
let pendingDropNoticeQueued = false;
let renderTimer = null;
let programScroll = false;            // 程序性滚动标记（区分用户滚动）
let autoScrollPausedUntil = 0;        // 用户主动滚动后暂停跟随的截止时间戳
const RENDER_BUDGET = 400;            // 每帧最多渲染的行数，防止高吞吐时卡 UI
const SCROLL_NEAR_BOTTOM = 80;        // 距底部 <80px 视为"在底部"
const AUTO_SCROLL_PAUSE_MS = 4000;    // 用户上翻查看历史时暂停跟随的时长

/* 级别颜色兼容：无 BDSCOL 颜色标签的日志，仅 INFO/WARNING/ERROR 三档着色，
   支持大小写与首字母 [I]/[W]/[E]。若对方已兼容 BDSCOL 颜色渲染（日志带 ANSI 颜色），
   不在此检测。 */
const LEVEL_COLORS = {
  'I': [34, 197, 94], 'INFO': [34, 197, 94],          // 绿 #22C55E
  'W': [245, 158, 11], 'WARNING': [245, 158, 11],     // 黄 #F59E0B
  'E': [239, 68, 68], 'ERROR': [239, 68, 68],         // 红 #EF4444
};
const LEVEL_PAT = /^\s*(?:\[([A-Za-z]+)\]|([A-Za-z]+):)/i;

function detectLevelColor(line) {
  const m = line.match(LEVEL_PAT);
  if (!m) return null;
  const key = (m[1] || m[2]).toUpperCase();
  return LEVEL_COLORS[key] || null;
}

function appendLog(text) {
  totalBytes += textEncoder.encode(text).length;  // UTF-8 真实字节数
  logBytes.textContent = `(${formatBytes(totalBytes)})`;

  const lines = text.split('\n');
  for (const line of lines) {
    if (line === '') continue;
    pendingLogs.push(line);
    pendingLogChars += line.length;
  }

  // 如果输入速度超过渲染速度，丢弃队列中较早的行，只保留最近内容。
  // splice 一次性删除，避免逐条 shift 在高压下产生额外 O(n) 开销。
  let dropCount = 0;
  let dropChars = 0;
  while (pendingLogs.length - dropCount > MAX_PENDING_LOG_LINES ||
         pendingLogChars - dropChars > MAX_PENDING_LOG_CHARS) {
    const line = pendingLogs[dropCount];
    if (line === undefined) break;
    dropCount++;
    dropChars += line.length;
  }
  if (dropCount > 0) {
    pendingLogs.splice(0, dropCount);
    pendingLogChars -= dropChars;
    if (!pendingDropNoticeQueued) {
      const notice = `[JLinkHub] 日志洪峰，已丢弃 ${dropCount} 条待渲染日志\n`;
      pendingLogs.push(notice);
      pendingLogChars += notice.length;
      pendingDropNoticeQueued = true;
    }
  }
  scheduleRender();
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function formatNow(d) {
  d = d || new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.` +
         String(d.getMilliseconds()).padStart(3, '0');
}

function saveLog() {
  const text = terminal.innerText;
  if (!text.trim()) { showToast('日志为空，无可保存内容', 'err'); return; }
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rtt_log_${formatNow().replace(/[:.]/g, '-')}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('日志已保存: ' + a.download);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function scheduleRender() {
  if (renderTimer || paused) return;
  renderTimer = requestAnimationFrame(() => {
    renderTimer = null;
    flushLogs();
  });
}

function flushLogs() {
  if (!pendingLogs.length) return;
  const frag = document.createDocumentFragment();
  const tsPrefix = chkTimestamp.checked ? `[${formatNow()}] ` : '';
  let rendered = 0;

  // 渲染预算：每帧最多渲染 RENDER_BUDGET 行，其余留到下一帧，
  // 避免 RTT 日志洪峰时单帧创建上千 DOM 节点导致页面卡死
  while (pendingLogs.length && rendered < RENDER_BUDGET) {
    const line = pendingLogs.shift();
    pendingLogChars -= line.length;
    if (line.startsWith('[JLinkHub] 日志洪峰，')) pendingDropNoticeQueued = false;
    const div = document.createElement('div');
    div.className = 'log-line';
    appendLineContent(div, line, tsPrefix);
    frag.appendChild(div);
    logLineCount++;
    rendered++;
  }

  terminal.appendChild(frag);
  trimLines();

  // 自动滚动：无条件贴合最新一条日志。
  // 日志洪峰时 scrollHeight 快速增大，不能依赖"接近底部"判断（一旦落后就再也跟不上）；
  // 仅在用户主动上翻后暂停 AUTO_SCROLL_PAUSE_MS，到期自动恢复贴合。
  if (chkAutoscroll.checked && !paused && Date.now() >= autoScrollPausedUntil) {
    programScroll = true;                  // 标记程序滚动，scroll 事件里不当作用户操作
    terminal.scrollTop = terminal.scrollHeight;
  }

  // 队列还有剩余 → 下一帧继续处理
  if (pendingLogs.length) scheduleRender();
}

function appendLineContent(div, line, tsPrefix) {
  // 时间戳独立灰色节点，不参与正文颜色
  if (tsPrefix) {
    const ts = document.createElement('span');
    ts.className = 'log-ts';
    ts.textContent = tsPrefix;
    div.appendChild(ts);
  }

  // 快路径：纯文本（无 ANSI 转义序列）——绝大多数日志无颜色，走 textContent 免 HTML 解析
  if (line.indexOf('\x1b[') === -1) {
    const color = detectLevelColor(line);
    if (color) {
      div.insertAdjacentHTML('beforeend',
        `<span style="color:rgb(${color[0]},${color[1]},${color[2]})">${escapeHtml(line)}</span>`);
    } else {
      div.appendChild(document.createTextNode(line));
    }
    return;
  }

  // 含 ANSI：正常解析颜色
  div.insertAdjacentHTML('beforeend', ansiToHtml(line));
}

function trimLines() {
  if (logLineCount <= MAX_LINES) return;
  const excess = logLineCount - MAX_LINES;
  let removed = 0;
  while (removed < excess && terminal.firstChild) {
    terminal.removeChild(terminal.firstChild);
    removed++;
  }
  logLineCount -= removed;
}

/* 用户滚动检测：
   - 程序性滚动（scrollToBottom 触发）带 programScroll 标记，直接忽略，不会误停自动跟随
   - 真实用户滚动（拖动滑块/滚轮/键盘/触摸）离开底部 → 暂停自动跟随 4 秒，供查看历史
   - 用户滚回底部附近 → 立即恢复跟随 */
terminal.addEventListener('scroll', () => {
  if (programScroll) { programScroll = false; return; }
  if (!chkAutoscroll.checked || paused) return;
  const nearBottom = terminal.scrollTop + terminal.clientHeight >=
                     terminal.scrollHeight - SCROLL_NEAR_BOTTOM;
  if (nearBottom) {
    autoScrollPausedUntil = 0;   // 滚回底部附近 → 立即恢复贴合
  } else {
    autoScrollPausedUntil = Date.now() + AUTO_SCROLL_PAUSE_MS;
  }
});

/* ---------- 连接 / 断开 / 复位 ---------- */

async function doConnect() {
  const chip = modelCombo.getValue();
  const speed = parseInt(selSpeed.value, 10);
  const reset = selReset.value === '1';
  if (!chip) { showToast('请选择芯片型号', 'err'); return; }

  statusChip.className = 'status-badge connecting';
  statusText.textContent = '连接中…';
  btnConnect.disabled = true;

  try {
    const r = await api('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chip, speed, reset, session: sessionId })
    });
    if (r.ok) {
      showToast('已连接 ' + (r.device || chip));
    } else {
      statusChip.className = 'status-badge error';
      statusText.textContent = '连接失败';
      showToast(r.error || '连接失败', 'err');
    }
  } catch (e) {
    statusChip.className = 'status-badge error';
    statusText.textContent = '连接失败';
    showToast('连接请求失败: ' + e.message, 'err');
  }
}

async function doDisconnect() {
  try {
    await api('/api/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: sessionId })
    });
    showToast('已断开');
  } catch (e) {
    showToast('断开失败: ' + e.message, 'err');
  }
}

async function doReset() {
  try {
    const r = await api('/api/reset', { method: 'POST' });
    showToast(r.ok ? '已复位 MCU' : ('复位失败: ' + (r.error || '')), r.ok ? '' : 'err');
  } catch (e) {
    showToast('复位失败: ' + e.message, 'err');
  }
}

/* ---------- 固件上传与烧录 ---------- */

/* 烧录区域配置：
   - 「全量整片」内置预设不可删除，结束地址随所选型号 Flash 容量自动更新
   - 「固件区域」随所选 ELF/AXF/HEX 固件自动解析生成（用于擦除）
   - 自定义区域持久化到 localStorage，跨会话保留 */
const FLASH_BASE = 0x08000000;
const FLASH_HIGH = 0x20000000;   // RAM 起始地址，作为 Flash 地址区间上界
const REGIONS_KEY = 'jl_web_regions';
const FILE_REGION_ID = 'file';   // 自动解析的固件区域 id

let fullRegion = { id: 'full', name: '全量整片', start: FLASH_BASE, end: FLASH_BASE + 0x100000, full: true };
let regions = [];              // 用户自定义区域 {id, name, start, end}
let selectedRegionId = 'full'; // 'full' / FILE_REGION_ID / 自定义区域 id
let editingRegion = false;     // 是否正在显示「添加区域」编辑行
let fileRange = null;          // 选中固件解析出的地址范围 {start, end}（BIN 为 null）

function parseFlashBytes(str) {
  const m = String(str || '').trim().match(/^(\d+(?:\.\d+)?)\s*(KB|MB|K|M|B)?$/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const unit = (m[2] || 'B').toUpperCase();
  if (unit === 'KB' || unit === 'K') return Math.round(v * 1024);
  if (unit === 'MB' || unit === 'M') return Math.round(v * 1024 * 1024);
  return Math.round(v);
}

function updateFullRegionEnd() {
  // 从内置型号数据取 Flash 容量，更新「全量整片」结束地址
  const model = modelCombo.getValue();
  let flashStr = null;
  if (model) {
    for (const fam of Object.values(allFamilies)) {
      const m = (fam.models || []).find(x => x.name === model);
      if (m) { flashStr = m.flash; break; }
    }
  }
  const bytes = parseFlashBytes(flashStr);
  if (bytes) fullRegion.end = FLASH_BASE + bytes;
  renderRegions();
}

function hex8(n) { return '0x' + n.toString(16).toUpperCase().padStart(8, '0'); }

/* ---------- 固件内嵌地址解析 ----------
   选择固件后自动解析其烧录地址范围（只统计 Flash 区间 0x08000000~0x20000000，
   RAM 段如 0x20000000 的数据初始化段不纳入显示）：
   - ELF/AXF：读程序头 PT_LOAD 段的 p_paddr ~ p_paddr+filesz
   - HEX：Intel HEX 数据记录地址（含扩展线性/段地址）
   - BIN：无内嵌地址，返回 null */

function parseElfRange(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 64) return null;
  const isElf = dv.getUint8(0) === 0x7f && dv.getUint8(1) === 0x45 &&
                dv.getUint8(2) === 0x4c && dv.getUint8(3) === 0x46;
  if (!isElf || dv.getUint8(5) !== 1) return null; // 仅支持小端
  const is64 = dv.getUint8(4) === 2;
  const phoff = dv.getUint32(is64 ? 32 : 28, true);
  const phentsize = dv.getUint16(is64 ? 54 : 42, true);
  const phnum = dv.getUint16(is64 ? 56 : 44, true);
  if (!phentsize || !phnum) return null;
  const segs = [];
  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phentsize;
    if (off + (is64 ? 36 : 20) > buf.byteLength) break;
    if (dv.getUint32(off, true) !== 1) continue;   // PT_LOAD
    const paddr = dv.getUint32(off + (is64 ? 16 : 12), true);
    const filesz = dv.getUint32(off + (is64 ? 32 : 16), true);
    if (filesz > 0) segs.push({ start: paddr, end: paddr + filesz });
  }
  if (!segs.length) return null;
  // 优先 Flash 段；无 Flash 段（异常文件）则退回全部段
  const flash = segs.filter(s => s.start < FLASH_HIGH && s.end > FLASH_BASE);
  const use = flash.length ? flash : segs;
  return {
    start: Math.min(...use.map(s => s.start)),
    end: Math.max(...use.map(s => s.end)),
  };
}

function parseHexRange(buf) {
  const lines = new TextDecoder('ascii').decode(buf).split(/\r?\n/);
  let base = 0, min = Infinity, max = 0;
  for (const line of lines) {
    const s = line.trim();
    if (!s || s[0] !== ':') continue;
    const bytes = [];
    for (let i = 1; i + 1 < s.length; i += 2) {
      const b = parseInt(s.substr(i, 2), 16);
      if (isNaN(b)) { bytes.length = 0; break; }
      bytes.push(b);
    }
    if (bytes.length < 5) continue;
    const reclen = bytes[0];
    const addr = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    if (bytes.length < 4 + reclen) continue;
    const data = bytes.slice(4, 4 + reclen);
    if (type === 0x04) {                 // 扩展线性地址（高 16 位）
      base = ((data[0] << 8) | data[1]) << 16;
    } else if (type === 0x02) {          // 扩展段地址
      base = ((data[0] << 8) | data[1]) << 4;
    } else if (type === 0x00) {          // 数据记录
      const a = base + addr;
      if (a >= FLASH_BASE && a + reclen <= FLASH_HIGH) {
        if (a < min) min = a;
        if (a + reclen > max) max = a + reclen;
      }
    } else if (type === 0x01) {          // EOF
      break;
    }
  }
  if (!isFinite(min)) return null;
  return { start: min, end: max };
}

function parseFirmwareRange(buf, type) {
  if (type === 'hex') return parseHexRange(buf);
  if (type === 'elf' || type === 'axf') return parseElfRange(buf);
  return null;   // BIN 无内嵌地址
}

function loadRegions() {
  try {
    const saved = JSON.parse(localStorage.getItem(REGIONS_KEY) || '[]');
    regions = Array.isArray(saved) ? saved.filter(r => r && r.name) : [];
  } catch { regions = []; }
  for (const r of regions) {
    r.id = 'r' + Math.random().toString(36).slice(2, 8);
    if (typeof r.start !== 'number') r.start = FLASH_BASE;
    if (typeof r.end !== 'number') r.end = FLASH_BASE + 0x10000;
  }
}

function saveRegions() {
  try {
    localStorage.setItem(REGIONS_KEY,
      JSON.stringify(regions.map(r => ({ name: r.name, start: r.start, end: r.end }))));
  } catch { /* localStorage 不可用时忽略持久化 */ }
}

function getFileRegion() {
  if (!fileRange) return null;
  return {
    id: FILE_REGION_ID,
    name: selectedFile ? selectedFile.name : '固件解析',
    start: fileRange.start,
    end: fileRange.end,
    full: false,
    file: true,
  };
}

function getSelectedRegion() {
  if (selectedRegionId === 'full') return fullRegion;
  if (selectedRegionId === FILE_REGION_ID) {
    const fr = getFileRegion();
    if (fr) return fr;
  }
  return regions.find(r => r.id === selectedRegionId) || fullRegion;
}

function buildRegionEditRow() {
  const row = document.createElement('div');
  row.className = 'region-row region-edit';
  const nameInp = document.createElement('input');
  nameInp.className = 'input region-name-input';
  nameInp.placeholder = '名称（如 Bootloader）';
  const startInp = document.createElement('input');
  startInp.className = 'input region-addr-input';
  startInp.placeholder = '起始地址 0x08000000';
  startInp.value = hex8(FLASH_BASE);
  const endInp = document.createElement('input');
  endInp.className = 'input region-addr-input';
  endInp.placeholder = '结束地址 0x0800FFFF';
  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'btn btn-primary btn-sm';
  okBtn.textContent = '保存';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost btn-sm';
  cancelBtn.textContent = '取消';

  okBtn.addEventListener('click', () => {
    const name = nameInp.value.trim() || ('区域 ' + (regions.length + 1));
    let start, end;
    try {
      start = parseInt(startInp.value.trim(), 16);
      if (isNaN(start) || start < 0) throw new Error();
    } catch { showToast('起始地址格式错误（应为十六进制）', 'err'); return; }
    try {
      end = parseInt(endInp.value.trim(), 16);
      if (isNaN(end) || end <= start) throw new Error();
    } catch { showToast('结束地址需大于起始地址', 'err'); return; }
    const reg = { id: 'r' + Date.now().toString(36), name, start, end };
    regions.push(reg);
    selectedRegionId = reg.id;
    editingRegion = false;
    saveRegions();
    renderRegions();
  });
  cancelBtn.addEventListener('click', () => { editingRegion = false; renderRegions(); });

  row.append(nameInp, startInp, endInp, okBtn, cancelBtn);
  return row;
}

function renderRegions() {
  const frag = document.createDocumentFragment();
  const all = [fullRegion, ...(getFileRegion() ? [getFileRegion()] : []), ...regions];
  for (const r of all) {
    const row = document.createElement('div');
    row.className = 'region-row' + (r.id === selectedRegionId ? ' selected' : '');

    const radio = document.createElement('label');
    radio.className = 'region-radio';
    const inp = document.createElement('input');
    inp.type = 'radio';
    inp.name = 'region';
    inp.checked = r.id === selectedRegionId;
    inp.addEventListener('change', () => {
      selectedRegionId = r.id;
      renderRegions();
    });
    radio.appendChild(inp);

    const info = document.createElement('div');
    info.className = 'region-info';
    const name = document.createElement('span');
    name.className = 'region-name';
    name.textContent = r.name;
    const range = document.createElement('span');
    range.className = 'region-range';
    range.textContent = `${hex8(r.start)} ~ ${hex8(r.end)}（${formatBytes(r.end - r.start)}）`;
    info.append(name, range);

    row.appendChild(radio);
    row.appendChild(info);

    if (!r.full && !r.file) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-ghost btn-sm region-del';
      del.textContent = '✕';
      del.title = '删除区域';
      del.addEventListener('click', () => {
        regions = regions.filter(x => x.id !== r.id);
        if (selectedRegionId === r.id) selectedRegionId = 'full';
        saveRegions();
        renderRegions();
      });
      row.appendChild(del);
    }
    frag.appendChild(row);
  }

  if (editingRegion) frag.appendChild(buildRegionEditRow());
  regionList.innerHTML = '';
  regionList.appendChild(frag);
}

fileInput.addEventListener('change', onFileSelected);

async function onFileSelected() {
  selectedFile = fileInput.files[0] || null;
  if (!selectedFile) {
    fileName.textContent = '未选择文件';
    uploadPath = null;
    fileRange = null;
    if (selectedRegionId === FILE_REGION_ID) selectedRegionId = 'full';
    updateFlashButton();
    renderRegions();
    return;
  }
  fileName.textContent = selectedFile.name;
  fileName.title = selectedFile.name;
  uploadPath = null;
  // 按扩展名自动识别固件类型（用户仍可手动调整）
  const ext = (selectedFile.name.split('.').pop() || '').toLowerCase();
  if (['bin', 'hex', 'elf', 'axf'].includes(ext)) selFwType.value = ext;

  // 自动解析固件内嵌地址（ELF/AXF/HEX），生成「固件区域」并选中；BIN 无内嵌地址
  fileRange = null;
  if (['elf', 'axf', 'hex'].includes(ext)) {
    try {
      const buf = await selectedFile.arrayBuffer();
      fileRange = parseFirmwareRange(buf, ext);
    } catch { fileRange = null; }
  }
  if (fileRange) {
    selectedRegionId = FILE_REGION_ID;
  } else if (selectedRegionId === FILE_REGION_ID) {
    selectedRegionId = 'full';
  }
  updateFlashButton();
  renderRegions();
  flashMessage.textContent = '';
}

async function uploadFirmware() {
  const fd = new FormData();
  fd.append('file', selectedFile);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '上传失败');
  return data;
}

function fwTypeFromFile() {
  const t = selFwType.value;
  if (t !== 'auto') return t;
  if (!selectedFile) return 'bin';
  const ext = (selectedFile.name.split('.').pop() || '').toLowerCase();
  return ['bin', 'hex', 'elf', 'axf'].includes(ext) ? ext : 'bin';
}

function updateFlashButtonLabel() {
  if (isFlashing) { btnFlashLabel.textContent = '执行中…'; return; }
  const program = chkProgram.checked;
  const erase = chkErase.checked;
  btnFlashLabel.textContent = erase && program ? '擦除并烧录' : erase ? '开始擦除' : '开始烧录';
}

/* 按钮可用性：烧录需要已选择的固件文件（上传在点击时进行）；仅擦除时无需文件 */
function updateFlashButton() {
  updateFlashButtonLabel();
  const needsFile = chkProgram.checked;
  btnFlash.disabled = isFlashing || !connected || (needsFile && !selectedFile);
}

async function doFlash() {
  if (isFlashing) { showToast('擦除/烧录正在进行中，请等待完成', 'err'); return; }
  if (!connected) { showToast('请先连接 J-Link', 'err'); return; }

  const program = chkProgram.checked;
  const erase = chkErase.checked;
  if (!program && !erase) { showToast('请至少勾选擦除或烧录', 'err'); return; }
  if (program && !selectedFile) { showToast('请先选择固件文件', 'err'); return; }

  const fileType = fwTypeFromFile();
  const sel = getSelectedRegion();

  isFlashing = true;
  btnFlash.disabled = true;
  updateFlashButtonLabel();

  try {
    // 仅擦除时不需要上传固件
    let fwPath = null;
    if (program) {
      const up = await uploadFirmware();
      fwPath = up.path;
      uploadPath = up.path;
      showToast('固件已上传，开始执行…');
    } else {
      showToast('开始执行…');
    }

    const r = await api('/api/flash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: fwPath,
        file_type: fileType,
        erase: erase,
        program: program,
        region: { name: sel.name, start: sel.start, end: sel.end },
        full_chip: sel.id === 'full',
        session: sessionId
      })
    });
    if (!r.ok) {
      showToast(r.error || '操作启动失败', 'err');
      flashMessage.className = 'flash-message err';
      flashMessage.textContent = r.error || '操作启动失败';
      isFlashing = false;
      updateFlashButton();
    }
    // 擦除/烧录进度通过 WebSocket 推送（flash / flash_done），完成后 finalizeFlash 复位
  } catch (e) {
    showToast('操作请求失败: ' + e.message, 'err');
    isFlashing = false;
    updateFlashButton();
  }
}

function updateFlashProgress(msg) {
  progressWrap.hidden = false;
  flashStage.textContent = msg.stage || '执行中';
  const p = Math.min(100, Math.max(0, msg.percent || 0));
  flashPercent.textContent = `${p}%`;
  flashFill.style.width = `${p}%`;
  flashFill.className = 'progress-fill';
  if (msg.message) flashMessage.textContent = msg.message;
}

function finalizeFlash(msg) {
  progressWrap.hidden = false;
  flashFill.className = 'progress-fill ' + (msg.ok ? 'ok' : 'err');
  flashMessage.className = 'flash-message ' + (msg.ok ? 'ok' : 'err');
  flashMessage.textContent = msg.message || (msg.ok ? '操作完成' : '操作失败');
  showToast(msg.message || (msg.ok ? '操作完成' : '操作失败'), msg.ok ? 'ok' : 'err');
  isFlashing = false;
  updateFlashButton();
}

/* ---------- 日志工具栏 ---------- */

btnPause.addEventListener('click', () => {
  paused = !paused;
  btnPause.textContent = paused ? '继续' : '暂停';
  btnPause.classList.toggle('btn-accent', paused);
  if (!paused) {
    autoScrollPausedUntil = 0;
    flushLogs();
  }
});

// 重新勾选自动滚动 → 恢复跟随并立即滚到底
chkAutoscroll.addEventListener('change', () => {
  if (chkAutoscroll.checked) {
    autoScrollPausedUntil = 0;
    terminal.scrollTop = terminal.scrollHeight;
  }
});

btnClear.addEventListener('click', () => {
  terminal.innerHTML = '';
  logLineCount = 0;
  totalBytes = 0;
  logBytes.textContent = '';
  pendingLogs.length = 0;
  pendingLogChars = 0;
  pendingDropNoticeQueued = false;
});

btnSaveLog.addEventListener('click', saveLog);

/* ---------- 上行输入 ---------- */

function sendUplink() {
  const text = inputUplink.value;
  if (!text) return;
  if (!connected) { showToast('未连接，无法发送', 'err'); return; }
  api('/api/uplink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: text + '\n' })
  }).catch(e => showToast('发送失败: ' + e.message, 'err'));
  inputUplink.value = '';
  inputUplink.focus();
}

btnSend.addEventListener('click', sendUplink);
inputUplink.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendUplink();
});

/* ---------- 帮助弹层 ---------- */

btnHelp.addEventListener('click', () => { helpModal.hidden = false; });
btnHelpClose.addEventListener('click', () => { helpModal.hidden = true; });
helpModal.addEventListener('click', (e) => { if (e.target === helpModal) helpModal.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') helpModal.hidden = true; });

/* ---------- 事件绑定 ---------- */

btnConnect.addEventListener('click', doConnect);
btnDisconnect.addEventListener('click', doDisconnect);
btnReset.addEventListener('click', doReset);
btnFlash.addEventListener('click', doFlash);
chkProgram.addEventListener('change', updateFlashButton);
chkErase.addEventListener('change', updateFlashButton);
btnAddRegion.addEventListener('click', () => {
  if (editingRegion) { showToast('请先保存或取消当前编辑', 'err'); return; }
  editingRegion = true;
  renderRegions();
});

/* ---------- 初始化 ---------- */

(async function init() {
  // 获取 WebSocket 端口
  try {
    const cfg = await api('/api/config');
    wsPort = cfg.ws_port || 8765;
  } catch { /* 保持默认 */ }

  await loadDevices();
  loadRegions();
  renderRegions();

  // 拉取一次当前状态
  try {
    const s = await api('/api/status');
    applyStatus(s);
  } catch { }

  connectWs();
})();
