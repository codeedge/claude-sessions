'use strict';

/* ------------------------------------------------------------------ utils */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function truncate(s, n) {
  const r = Array.from(String(s ?? ''));
  return r.length > n ? r.slice(0, n).join('') + '…' : r.join('');
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return n.toFixed(1) + ' ' + units[i];
}

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

// 精确到秒：同年省略年份，跨年才带
function shortDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '';
  const p2 = (n) => String(n).padStart(2, '0');
  const md = `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

function rel(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  const d = (Date.now() - t) / 1000;
  if (d < 45) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
  return new Date(iso).toLocaleDateString('zh-CN');
}

function abs(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  if (isNaN(t.getTime()) || t.getFullYear() < 2000) return '';
  return t.toLocaleString('zh-CN', { hour12: false });
}

function projLabel(p) {
  if (!p) return '(未知项目)';
  if (!p.includes('/')) return p;
  const parts = String(p).split('/').filter(Boolean);
  return parts.slice(-1).join('/') || p;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { /* non-json */ } }
  if (!res.ok) throw new Error((data && data.error) || `请求失败 (HTTP ${res.status})`);
  return data;
}

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, isErr ? 5200 : 2600);
}

function toastUndo(msg, label, fn) {
  const el = $('#toast');
  el.className = 'toast';
  el.hidden = false;
  el.innerHTML = `<span>${esc(msg)}</span><button class="toast-action" type="button">${esc(label)}</button>`;
  el.querySelector('.toast-action').addEventListener('click', async () => {
    el.hidden = true;
    clearTimeout(toast._t);
    try { await fn(); } catch (err) { toast('操作失败: ' + err.message, true); }
  });
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 9000);
}

// opts.check：给了就先渲染一个勾选框，勾上之前「确定」是禁用的（防止手滑删掉东西）
function confirmDialog(title, body, okLabel = '确定', opts = {}) {
  const dlg = $('#confirm-dialog');
  const ok = $('#cf-ok');
  const wrap = $('#cf-check-wrap');
  const box = $('#cf-check');
  $('#cf-title').textContent = title;
  $('#cf-body').textContent = body;
  ok.textContent = okLabel;

  const needCheck = !!opts.check;
  wrap.hidden = !needCheck;
  box.checked = false;
  if (needCheck) $('#cf-check-label').textContent = opts.check;
  const sync = () => { ok.disabled = needCheck && !box.checked; };
  box.onchange = sync;
  sync();

  return new Promise((resolve) => {
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      box.onchange = null;
      ok.disabled = false;
      wrap.hidden = true;
      resolve(dlg.returnValue === 'ok');
    };
    dlg.addEventListener('close', onClose);
    dlg.returnValue = 'cancel';
    dlg.showModal();
  });
}

/* ------------------------------------------------------------ markdown */
function inlineMd(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return t;
}

function md(src) {
  const lines = String(src ?? '').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flush = () => {
    if (!para.length) return;
    out.push('<p>' + inlineMd(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
    para = [];
  };
  const splitRow = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }
    if (/^\s*$/.test(line)) { flush(); i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const lvl = Math.min(h[1].length + 2, 6);
      out.push(`<h${lvl}>${inlineMd(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map((t) => '<li>' + inlineMd(t) + '</li>').join('') + `</${tag}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push('<blockquote>' + inlineMd(buf.join('\n')).replace(/\n/g, '<br>') + '</blockquote>');
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out.join('\n');
}

/** Wrap every match of q inside text nodes of root with <mark>. */
function highlightDOM(root, q, opts = {}) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle || !root) return 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const v = node.nodeValue;
      if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (p && /^(SCRIPT|STYLE|MARK|SUMMARY)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
      // 只高亮指定区域（会话内搜索只扫"问"和"答"，不扫思考过程/工具输出）
      if (opts.only && (!p || !p.closest(opts.only))) return NodeFilter.FILTER_REJECT;
      return v.toLowerCase().includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let count = 0;
  for (const node of nodes) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let cursor = 0;
    let at;
    while ((at = lower.indexOf(needle, cursor)) !== -1) {
      if (at > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, at)));
      const mark = document.createElement('mark');
      mark.className = 'hl';
      mark.textContent = text.slice(at, at + needle.length);
      frag.appendChild(mark);
      count++;
      cursor = at + needle.length;
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    node.parentNode.replaceChild(frag, node);
  }
  return count;
}

function clearHighlight(root) {
  if (!root) return;
  $$('mark.hl', root).forEach((m) => {
    const parent = m.parentNode;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  });
}

/* ----------------------------------------------------------------- state */
const STAR_FILLED = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.94 5.96 6.58.96-4.76 4.64 1.12 6.55L12 17.62l-5.88 3.09 1.12-6.55L2.48 9.52l6.58-.96z" fill="currentColor"/></svg>';
const STAR_OUTLINE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.3l2.35 4.77 5.26.77-3.81 3.71.9 5.24L12 16.32l-4.7 2.47.9-5.24-3.81-3.71 5.26-.77z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';

// 当前会话的聊天状态：SSE 连接、流式内容、待确认的权限请求
const CHAT = {
  es: null,
  id: null,
  live: null, // { el, textEl, thinkEl, tools: [] }
  pending: null,
  models: [],
};

// 服务端下发的默认选项（模型/强度/权限）
const DEFAULTS = { model: '', effort: '', permissionMode: '', cli: {}, overrides: {}, root: false };

const EFFORT_LEVELS = [
  ['', '默认强度'], ['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '很高'], ['max', '最高'],
];

const S = {
  stats: null,
  projects: [],
  items: [],
  total: 0,
  q: '',
  project: '',
  sort: localStorage.getItem('cs-sort') || 'recent',
  asc: localStorage.getItem('cs-sort-asc') === '1',
  totalSize: 0,
  selected: new Set(),
  marks: {},
  starOnly: false,
  globalCount: null,
  booted: false,
  pointer: null,
  listLoading: false,

  detailId: null,
  agent: null,
  detail: null,
  turns: [],
  from: 0,
  count: 25,
  pageSize: 25,
  forkOpen: new Set(JSON.parse(localStorage.getItem('forkOpen') || '[]')), // 展开了分支的父会话
  liveTimer: null,
  liveRev: 0,
  liveSlow: 0, // 连续刷新太慢就自动退避
  totalTurns: 0,
  convQuery: '',
  convHits: [],
  convHitIdx: 0,

  trashItems: [],
  trashSelected: new Set(),
};

// 旁注（/btw）：答案只显示在这里，不写进会话，刷新就没了
const BTW = [];

// 待发送的附件（粘贴的截图、拖进来的文件）
const ATTACH = [];
const ATTACH_MAX_TOTAL = 20 << 20; // 20MB

const PAGE_SIZE = 200;

/* ------------------------------------------------------------------ boot */
let serverBuild = null;
let buildLabel = '';

// The footer is owned by renderFoot so an async stats load cannot wipe the
// build stamp that checkBuild adds.
function renderFoot() {
  const f = $('#side-foot');
  if (!f || !S.stats) return;
  const bits = [`${S.stats.sessions} 个会话`, fmtBytes(S.stats.bytes), `索引 ${S.stats.scanMs}ms`];
  f.innerHTML = bits.map(esc).join(' · ') +
    (S.stats.running ? `<br>${S.stats.running} 个进程运行中` : '') +
    `<br><span title="${esc(S.stats.home)}">${esc(S.stats.home)}</span>` +
    (buildLabel ? `<br>构建 ${esc(buildLabel)}` : '');
}

// 页面"闲着"才允许自动刷新：没有正在跑的回复、输入框是空的、没有弹窗
function canAutoReload() {
  if (CHAT.live) return false;
  if (document.querySelector('dialog[open]')) return false;
  const ta = $('#c-input');
  if (ta && ta.value.trim()) return false;
  if (ATTACH.length) return false;
  return true;
}

async function checkBuild() {
  try {
    const v = await api('/api/version');
    if (!serverBuild) {
      serverBuild = v.build;
      buildLabel = v.build;
      renderFoot();
      return;
    }
    if (v.build !== serverBuild) {
      // 服务端重启后前端还是旧的：页面闲着就自动刷新，省得对着旧代码报 bug；
      // 正在聊天 / 有没发出去的输入 / 有弹窗开着，就只提示不打扰
      if (canAutoReload()) {
        serverBuild = v.build;
        location.reload();
        return;
      }
      $('#stale-bar').hidden = false;
    }
  } catch {
    /* 服务重启中，忽略 */
  }
}

function init() {
  const savedTheme = localStorage.getItem('cs-theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;

  initComposer();
  initPermissionDialog();
  initNewSession();
  initSettings();
  for (const id of ['#new-dialog', '#perm-dialog', '#fav-dialog', '#rename-dialog', '#confirm-dialog', '#settings-dialog']) {
    enableBackdropClose($(id));
  }
  loadSettings();

  $('#search').addEventListener('input', debounce(onSearchInput, 160));
  $('#clear-search').addEventListener('click', () => {
    $('#search').value = '';
    onSearchInput();
    $('#search').focus();
  });
  $('#sort').addEventListener('change', (e) => {
    S.sort = e.target.value;
    localStorage.setItem('cs-sort', S.sort);
    loadSessions();
  });
  $('#sort-dir').addEventListener('click', toggleSortDir);
  $('#rescan').addEventListener('click', rescan);
  $('#trash-btn').addEventListener('click', openTrash);
  $('#trash-back').addEventListener('click', () => { setView('list'); loadSessions(); });
  $('#theme-btn').addEventListener('click', toggleTheme);
  $('#brand').addEventListener('click', goHome);
  $('#stale-reload').addEventListener('click', () => location.reload());
  $('#back').addEventListener('click', closeDetail);
  $('#turns-toggle').addEventListener('click', toggleAllDetails);
  $('#sessions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toggle-forks]');
    if (!btn) return;
    e.stopPropagation();
    const id = btn.dataset.toggleForks;
    const box = document.querySelector(`[data-fork-of="${CSS.escape(id)}"]`);
    const willOpen = !(box && !box.hidden);
    if (willOpen) S.forkOpen.add(id); else S.forkOpen.delete(id);
    try { localStorage.setItem('forkOpen', JSON.stringify([...S.forkOpen])); } catch {}
    if (box) box.hidden = !willOpen;
    btn.classList.toggle('open', willOpen);
    const caret = btn.querySelector('.caret');
    if (caret) caret.textContent = willOpen ? '▾' : '▸';
  });

  $('#sessions').addEventListener('click', async (e) => {
    const el = e.target.closest('[data-copy-id]');
    if (!el) return;
    e.stopPropagation();
    const id = el.dataset.copyId;
    try {
      await navigator.clipboard.writeText(id);
      toast('已复制会话 ID');
    } catch {
      toast('复制失败: ' + id, true);
    }
  });
  // 图片文件被系统清掉后（临时目录会清理），别留个裂图，换成一行提示
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    const box = img.closest('.turn-img');
    if (!box) return;
    box.outerHTML = '<div class="imgblk">[图片文件已不在磁盘上]</div>';
  }, true);

  $('#conv').addEventListener('click', onGapClick);
  $('#conv').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-img]');
    if (btn) { e.preventDefault(); openImageViewer(btn.dataset.img, btn.dataset.num); }
  });
  // 点灯箱里任何位置（图片本身或空白）都关闭
  $('#img-viewer').addEventListener('click', () => closeImageViewer());
  $('#panel-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-panel]');
    if (btn) togglePanel(btn.dataset.panel);
  });
  $('#panel-close').addEventListener('click', closePanel);
  $('#panel-expand').addEventListener('click', () => {
    if (!PANEL.agent || !S.detailId) return;
    const id = S.detailId;
    const agent = PANEL.agent;
    closePanel();
    openDetail(id, agent, 0);
  });
  $('#d-meta').addEventListener('click', (e) => {
    const agentBtn = e.target.closest('.subagent-btn');
    if (agentBtn) {
      openDetail(S.detailId, agentBtn.dataset.agent, 0);
      return;
    }
  });
  $('#d-branch').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open-session]');
    if (btn) openDetail(btn.dataset.openSession);
  });
  $('#d-meta').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open-session]');
    if (btn) openDetail(btn.dataset.openSession);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeImageViewer(); closePanel(); }
  });
  $('#jump-top').addEventListener('click', () => $('#main').scrollTo({ top: 0, behavior: 'auto' }));
  $('#jump-bottom').addEventListener('click', () => {
    const m = $('#main');
    m.scrollTo({ top: m.scrollHeight, behavior: 'auto' });
  });
  $('#main').addEventListener('scroll', updateJumpNav, { passive: true });
  window.addEventListener('resize', updateJumpNav);
  $('#copy-resume').addEventListener('click', copyResume);
  $('#open-terminal').addEventListener('click', openInTerminal);
  $('#d-rename').addEventListener('click', () => openRenameDialog(S.detailId));
  $('#export-md').addEventListener('click', exportMd);
  $('#delete-one').addEventListener('click', () => deleteOne());
  $('#load-more').addEventListener('click', loadMoreTurns);
  $('#select-all').addEventListener('change', onSelectAll);
  $('#bulk-delete').addEventListener('click', bulkDelete);
  $('#update-chip').addEventListener('click', () => {
    $('#update-chip').hidden = true;
    loadSessions({ fresh: true });
    loadProjects();
    loadStats();
  });
  $('#bulk-star').addEventListener('click', () => bulkStar(true));
  $('#bulk-unstar').addEventListener('click', () => bulkStar(false));
  $('#d-star').addEventListener('click', () => { if (S.detailId) toggleStar(S.detailId); });
  $('#conv-search').addEventListener('input', debounce(onConvSearch, 240));
  $('#conv-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); jumpNextHit(); }
  });

  $('#sessions').addEventListener('click', onListClick);
  $('#sessions').addEventListener('pointerover', onRowPointerOver);
  document.addEventListener('pointermove', (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
  }, { passive: true });
  // The title bar never hosts the card, so touching it dismisses immediately.
  document.querySelector('.topbar').addEventListener('pointerenter', hideHoverCard);
  document.addEventListener('mouseleave', hideHoverCard);

  $('#hovercard').addEventListener('click', onHoverCardClick);
  $('#hovercard').addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  $('#main').addEventListener('scroll', hideHoverCard, { passive: true });
  $('#sessions').addEventListener('change', onListCheck);
  $('#trash-list').addEventListener('click', onTrashClick);
  $('#trash-list').addEventListener('change', onTrashCheck);
  $('#trash-all').addEventListener('change', (e) => {
    S.trashSelected.clear();
    if (e.target.checked) S.trashItems.forEach((t) => S.trashSelected.add(t.id));
    renderTrash();
  });
  $('#trash-restore').addEventListener('click', () => {
    const ids = Array.from(S.trashSelected);
    if (ids.length) restoreIDs(ids);
  });
  $('#trash-purge').addEventListener('click', () => {
    const ids = Array.from(S.trashSelected);
    if (!ids.length) return;
    const size = S.trashItems.filter((t) => ids.includes(t.id)).reduce((a, t) => a + (t.size || 0), 0);
    purgeIDs(ids, '彻底删除所选',
      `${ids.length} 个会话（${fmtBytes(size)}）将被永久删除，无法恢复。`, '永久删除');
  });
  $('#trash-empty').addEventListener('click', () => {
    const ids = S.trashItems.map((t) => t.id);
    if (!ids.length) return;
    const size = S.trashItems.reduce((a, t) => a + (t.size || 0), 0);
    purgeIDs(ids, '清空回收站',
      `回收站里 ${ids.length} 个会话（${fmtBytes(size)}）将被永久删除，无法恢复。`, '全部删除');
  });
  $('#conv').addEventListener('click', onConvClick);
  $('#outline-list').addEventListener('click', onOutlineClick);
  $('#main').addEventListener('scroll', debounce(syncOutline, 90));
  $('#projects').addEventListener('click', onProjectClick);

  document.addEventListener('keydown', onKeydown);


  loadStats();
  loadProjects();
  loadMarks();
  loadSessions();
  document.body.dataset.tab = 'sessions';
  $('#sort').value = S.sort;
  renderSortDir();
  checkBuild();
  setInterval(checkBuild, 8000);
  setInterval(pollForChanges, 10000);
}

async function loadStats() {
  try {
    S.stats = await api('/api/stats');
    if (S.globalCount === null) S.globalCount = S.stats.sessions;
    renderFoot();
    if (S.stats.scanError) toast('扫描告警: ' + S.stats.scanError, true);
  } catch (err) {
    toast('读取状态失败: ' + err.message, true);
  }
}

async function loadProjects() {
  try {
    S.projects = await api('/api/projects') || [];
    renderProjects();
  } catch (err) {
    toast('读取项目失败: ' + err.message, true);
  }
}

function starCount() {
  return Object.values(S.marks || {}).filter((m) => m.starred).length;
}

function renderProjects() {
  const total = S.projects.reduce((a, p) => a + p.count, 0);
  $('#project-count').textContent = S.projects.length;

  const rows = [`<button class="proj star-filter" data-star-filter="1" aria-current="${S.starOnly}">
      <span class="proj-name">★ 收藏</span><span class="proj-n">${starCount()}</span>
    </button>`,
    `<button class="proj all" data-project="" aria-current="${!S.starOnly && S.project === ''}">
      <span class="proj-name">全部会话</span><span class="proj-n">${total}</span>
    </button>`];

  for (const p of S.projects) {
    rows.push(`<div class="proj-row">
      <button class="proj" data-project="${esc(p.path)}" title="${esc(p.path)}" aria-current="${!S.starOnly && S.project === p.path}">
        <span class="proj-name">${esc(projLabel(p.path))}</span>
        <span class="proj-n">${p.count}</span>
      </button>
      <button class="proj-new" data-new-in="${esc(p.path)}" title="在 ${esc(p.path)} 里新建会话">＋</button>
    </div>`);
  }

  $('#projects').innerHTML = rows.join('');
}

/* ----------------------------------------------------------- hover card */
let hoverTimer = null;
let hideTimer = null;
let hideWatch = null;
let lastPointer = { x: 0, y: 0 };
let previewSeq = 0;
const previewCache = new Map();

const HIDE_DELAY = 480; // how long the card survives once the pointer is away

function hideHoverCard() {
  clearTimeout(hoverTimer);
  clearTimeout(hideTimer);
  hideTimer = null;
  stopHideWatch();
  const card = $('#hovercard');
  card.hidden = true;
  card.dataset.id = '';
}

// Hiding is driven by a poll of elementFromPoint rather than by pointerout
// bookkeeping: re-rendered rows and repositioned cards drop events, which used
// to leave the card on screen forever.
function startHideWatch() {
  stopHideWatch();
  hideWatch = setInterval(checkPointerAway, 150);
  checkPointerAway();
}

function stopHideWatch() {
  if (hideWatch) {
    clearInterval(hideWatch);
    hideWatch = null;
  }
}

function checkPointerAway() {
  const card = $('#hovercard');
  if (card.hidden) { stopHideWatch(); return; }

  const el = document.elementFromPoint(lastPointer.x, lastPointer.y);
  if (!el) return;
  if (el.closest('.topbar')) { hideHoverCard(); return; }

  const overCard = !!el.closest('#hovercard');
  const overRow = !!el.closest('#sessions .row');
  if (overCard) {
    // Reaching for the buttons must not swap the card to whatever row the
    // pointer crossed on the way here.
    clearTimeout(hoverTimer);
    hoverTimer = null;
    clearTimeout(hideTimer);
    hideTimer = null;
    return;
  }
  if (overRow) {
    clearTimeout(hideTimer);
    hideTimer = null;
    return;
  }
  if (!hideTimer) {
    hideTimer = setTimeout(hideHoverCard, HIDE_DELAY);
  }
}

async function showHoverCard(row) {
  const id = row.dataset.id;
  const item = S.items.find((i) => i.id === id);
  if (!item) return;

  const card = $('#hovercard');
  card.dataset.id = id;
  card.hidden = false;
  card.innerHTML = hoverCardHTML(item, previewCache.get(id) ?? null);
  positionHoverCard(row);
  startHideWatch();

  if (previewCache.has(id)) return;

  const seq = ++previewSeq;
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(id)}/preview`);
    previewCache.set(id, data);
    if (seq !== previewSeq || card.hidden || card.dataset.id !== id) return;
    card.innerHTML = hoverCardHTML(item, data);
    positionHoverCard(row);
  } catch {
    previewCache.set(id, null);
  }
}

function hoverCardHTML(item, data) {
  const meta = [
    `${item.userMsgs + item.asstMsgs} 条消息`,
    `${fmtNum(item.in + item.out)} tok`,
    fmtBytes(item.size),
    rel(item.updatedAt),
  ].join(' · ');
  const live = item.running ? '<span class="badge live">运行中</span>' : '';

  let body = '<div class="hc-loading">正在读取会话内容…</div>';
  if (data) {
    const items = data.recent || [];
    const lines = items.map((it) => {
      const isUser = it.role === 'user';
      let time = '';
      if (isUser && it.ts) {
        const d = new Date(it.ts);
        if (!isNaN(d.getTime())) {
          time = `<span class="hc-time">${d.toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)}</span>`;
        }
      }
      return `<div class="hc-line${isUser ? ' u-row' : ''}">
        <span class="hc-role ${isUser ? 'u' : 'a'}">${isUser ? '你' : '助手'}</span>
        <span class="hc-text">${esc(truncate(it.text, 260))}</span>${time}
      </div>`;
    }).join('');
    const label = data.hasMore ? `最近 ${items.length} 条 · 滚动查看` : `最近 ${items.length} 条`;
    body = (data.first ? `<div class="hc-first"><span class="hc-lbl">开场</span>${esc(truncate(data.first, 170))}</div>` : '') +
      (lines ? `<div class="hc-recent"><span class="hc-lbl">${label}</span>${lines}</div>` : '<div class="hc-empty">没有可显示的对话内容</div>');
  }

  const starred = !!(item.starred || (S.marks[item.id] && S.marks[item.id].starred));
  const noteLine = item.note ? `<div class="hc-note">✎ ${esc(truncate(item.note, 160))}</div>` : '';

  return `<div class="hc-head">
      <div class="hc-title">
        <button class="star-btn${starred ? ' on' : ''}" type="button" data-hc-star="${esc(item.id)}" title="${starred ? '取消收藏' : '收藏'}">${starred ? STAR_FILLED : STAR_OUTLINE}</button>
        <span class="hc-name">${esc(item.title || '(无标题会话)')}</span>
        <button class="icon-btn hc-rename" type="button" data-hc-rename="${esc(item.id)}" title="重命名（写入会话文件，和 CLI 的 /rename 一致）">
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path d="M4 20h4l10-10a2.1 2.1 0 0 0-3-3L5 17v3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
            <path d="M13.5 6.5l3 3" fill="none" stroke="currentColor" stroke-width="1.7"/>
          </svg>
        </button>
      </div>
      <div class="hc-path">${esc(item.cwd || item.project || '')}${item.branch ? ' · ' + esc(item.branch) : ''}</div>
      <div class="hc-meta">${esc(meta)} ${live}</div>
      ${noteLine}
    </div>
    <div class="hc-body">${body}</div>
    <div class="hc-actions">
      <button class="btn" type="button" data-hc-open="${esc(item.id)}">打开会话</button>
      <button class="btn ghost" type="button" data-hc-note="${esc(item.id)}" title="只写备注，不影响收藏">备注</button>
      <button class="btn danger" type="button" data-hc-del="${esc(item.id)}" ${starred ? 'disabled title="已收藏，取消收藏后才能删除"' : ''}>删除</button>
      <span class="hc-hint">${starred ? '★ 已收藏' : '可撤销'}</span>
    </div>`;
}

function positionHoverCard(row) {
  const card = $('#hovercard');
  const r = row.getBoundingClientRect();
  const bar = document.querySelector('.topbar');
  const minTop = (bar ? bar.getBoundingClientRect().bottom : 0) + 10;
  const maxBottom = window.innerHeight - 12;
  const gap = 8;

  const width = Math.min(460, window.innerWidth - 24);
  card.style.width = width + 'px';

  // The card must never overlap the hovered row. Otherwise moving the mouse a
  // little inside that row would put it over the card, and the card would look
  // stuck even though the pointer "left" the row as far as the eye can tell.
  const below = r.bottom + gap;
  const above = r.top - gap;
  const spaceBelow = maxBottom - below;
  const spaceAbove = above - minTop;
  const placeBelow = spaceBelow >= spaceAbove;

  const room = Math.max(160, placeBelow ? spaceBelow : spaceAbove);
  card.style.maxHeight = Math.min(room, Math.round(window.innerHeight * 0.74), 560) + 'px';
  const height = card.offsetHeight || 240;

  let top = placeBelow ? below : above - height;
  top = Math.max(minTop, Math.min(top, maxBottom - height));

  const p = S.pointer || { x: r.left + 200, y: r.top + 18 };
  let left = p.x + 22;
  if (left + width > window.innerWidth - 12) left = p.x - width - 22;
  left = Math.max(12, Math.min(left, window.innerWidth - width - 12));

  card.style.left = left + 'px';
  card.style.top = top + 'px';
}

function onHoverCardClick(e) {
  const noteBtn = e.target.closest('[data-hc-note]');
  if (noteBtn) {
    hideHoverCard();
    openNoteDialog(noteBtn.dataset.hcNote);
    return;
  }
  const starBtn = e.target.closest('[data-hc-star]');
  if (starBtn) {
    hideHoverCard();
    toggleStar(starBtn.dataset.hcStar);
    return;
  }
  const openBtn = e.target.closest('[data-hc-open]');
  if (openBtn) {
    hideHoverCard();
    openDetail(openBtn.dataset.hcOpen);
    return;
  }
  const renameBtn = e.target.closest('[data-hc-rename]');
  if (renameBtn) {
    hideHoverCard();
    openRenameDialog(renameBtn.dataset.hcRename);
    return;
  }
  const delBtn = e.target.closest('[data-hc-del]');
  if (delBtn) {
    hideHoverCard();
    quickDelete(delBtn.dataset.hcDel);
  }
}

// Soft-delete one session from the list, with an undo affordance instead of a
// blocking confirm dialog (nothing is destroyed, it goes to the trash).
async function quickDelete(id) {
  const item = S.items.find((i) => i.id === id);
  if (item && (item.starred || (S.marks[id] && S.marks[id].starred))) {
    toast('已收藏，取消收藏后才能删除', true);
    return;
  }
  try {
    const res = await api('/api/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    const errs = Object.values(res.errors || {});
    if (errs.length) { toast(errs[0], true); return; }

    previewCache.delete(id);
    S.items = S.items.filter((i) => i.id !== id);
    S.total = Math.max(0, S.total - 1);
    S.selected.delete(id);
    renderList();
    loadStats();
    loadProjects();

    toastUndo(`已移入回收站：${truncate(item?.title || id, 36)}`, '撤销', async () => {
      await api('/api/trash/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
      previewCache.clear();
      await Promise.all([loadSessions(), loadStats(), loadProjects()]);
    });
  } catch (err) {
    toast('删除失败: ' + err.message, true);
  }
}

/* ------------------------------------------------------------- list view */
function onSearchInput() {
  const v = $('#search').value.trim();
  S.q = v;
  $('#clear-search').hidden = !v;
  S.selected.clear();
  loadSessions();
}

async function loadSessions(opts = {}) {
  setView('list');
  S.listLoading = true;
  try {
    const params = new URLSearchParams({
      q: S.q, project: S.project, sort: S.sort, limit: String(PAGE_SIZE), offset: '0',
    });
    if (S.asc) params.set('asc', '1');
    if (!S.booted || opts.fresh) params.set('fresh', '1');
    if (S.starOnly) params.set('star', '1');
    const res = await api('/api/sessions?' + params.toString());
    S.items = res.items || [];
    S.total = res.total || 0;
    S.booted = true;
    if (S.stats) S.globalCount = S.stats.sessions;
    $('#update-chip').hidden = true;
    S.totalSize = (res.items || []).reduce((a, it) => a + (it.size || 0), 0);
    renderList();
  } catch (err) {
    toast('加载会话失败: ' + err.message, true);
  } finally {
    S.listLoading = false;
  }
}

// 分叉出来的会话挂在父会话下面，二级列表、可折叠
function renderRowsTree() {
  const byId = new Map(S.items.map((i) => [i.id, i]));
  const children = new Map();
  for (const it of S.items) {
    if (it.forkOf && byId.has(it.forkOf)) {
      if (!children.has(it.forkOf)) children.set(it.forkOf, []);
      children.get(it.forkOf).push(it);
    }
  }
  // 搜索时全部展开，否则命中的子会话会被藏起来
  const expandedAll = !!S.q;

  const seen = new Set();
  const build = (it, depth) => {
    if (seen.has(it.id)) return '';
    seen.add(it.id);
    const kids = children.get(it.id) || [];
    const open = depth > 0 || expandedAll || S.forkOpen.has(it.id);
    const toggle = kids.length
      ? `<button class="fork-toggle${open ? ' open' : ''}" data-toggle-forks="${esc(it.id)}" title="展开/收起 ${kids.length} 个分支会话">分支 ${kids.length}<span class="caret">${open ? '▾' : '▸'}</span></button>`
      : '';
    let html = rowHTML(it, depth > 0, kids.length > 0);
    if (toggle) {
      // 把折叠按钮插到标题行末尾
      html = html.replace(/(<div class="row-title">[\s\S]*?)(<\/div>\s*<div class="row-meta-line">)/, `$1${toggle}$2`);
    }
    if (kids.length) {
      html += `<div class="fork-children" data-fork-of="${esc(it.id)}"${open ? '' : ' hidden'}>` +
        kids.map((k) => build(k, depth + 1)).join('') + '</div>';
    }
    return html;
  };

  const roots = S.items.filter((it) => !it.forkOf || !byId.has(it.forkOf));
  return roots.map((it) => build(it, 0)).join('');
}

// 把「父 → 子」关系记下来，详情页横幅要用
function indexBranchChildren() {
  const map = new Map();
  for (const it of S.items) {
    if (!it.forkOf) continue;
    if (!map.has(it.forkOf)) map.set(it.forkOf, []);
    map.get(it.forkOf).push(it);
  }
  S.branchChildren = map;
}

function renderList() {
  const box = $('#sessions');
  const summary = $('#list-summary');
  const empty = $('#empty');

  const filters = [];
  if (S.starOnly) filters.push('<b>★ 收藏</b>');
  if (S.project) filters.push(`项目 <b>${esc(projLabel(S.project))}</b>`);
  const scope = filters.length ? ' · ' + filters.join(' + ') : '';
  if (S.q) {
    summary.innerHTML = `匹配 <b>${S.total}</b> 个会话${scope}`;
  } else {
    summary.innerHTML = `<b>${S.total}</b> 个会话${scope} · ${fmtBytes(S.totalSize)}`;
  }

  if (!S.items.length) {
    box.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = S.q
      ? `<h3>没有匹配「${esc(truncate(S.q, 40))}」的会话</h3><div>试试更短的关键词，或切换项目范围</div>`
      : '<h3>磁盘上没有会话</h3><div>确认 Claude Code 至少用过一次，然后点右上角 ⟳ 重新扫描</div>';
  } else {
    empty.hidden = true;
    indexBranchChildren();
    box.innerHTML = renderRowsTree();
  }
  updateBulkBar();
}

function rowHTML(it, nested = false, hideForked = false) {
  const selected = S.selected.has(it.id);
  const live = it.running ? '<span class="badge live">运行中</span>' : '';
  const snippet = it.snippet
    ? `<div class="row-snippet">${hlText(it.snippet, S.q)}</div>`
    : (it.firstPrompt && !S.q ? `<div class="row-snippet">${esc(truncate(it.firstPrompt, 180))}</div>` : '');
  const branch = it.branch ? `<span class="badge">${esc(it.branch)}</span>` : '';
  const subs = (it.subagents && it.subagents.length)
    ? `<span class="badge" title="子代理会话">↳${it.subagents.length}</span>` : '';
  const fork = it.forkOf
    ? `<span class="badge fork" title="分支自：${esc(it.forkOfTitle || it.forkOf)}">分支</span>` : '';
  const forked = (!it.forkOf && it.forkCount && !hideForked)
    ? `<span class="badge" title="被分支了 ${it.forkCount} 次">分支 ${it.forkCount}</span>` : '';
  const starred = !!(it.starred || (S.marks[it.id] && S.marks[it.id].starred));
  const star = `<button class="star-btn${starred ? ' on' : ''}" data-star="${esc(it.id)}" title="${starred ? '已收藏 · 点击编辑备注' : '收藏（可填备注）'}" aria-pressed="${starred}">${starred ? STAR_FILLED : STAR_OUTLINE}</button>`;
  // 收藏的备注跟在标题后面：标题【备注】
  const note = (starred && it.note) ? `<span class="row-note-inline" title="${esc(it.note)}">【${esc(truncate(it.note, 80))}】</span>` : '';

  // 一行统计：创建 · 活跃 · 条数 · token · 体积 · 工具 · 上下文
  const bits = [];
  bits.push(`<span class="sid" data-copy-id="${esc(it.id)}" title="点击复制会话 ID">${esc(it.id)}</span>`);
  bits.push(`<span title="最后活动 ${esc(abs(it.updatedAt))}">活跃 ${esc(rel(it.updatedAt))}</span>`);
  bits.push(`${it.userMsgs + it.asstMsgs} 条`);
  bits.push(`${fmtNum(it.in + it.out)} tok`);
  bits.push(fmtBytes(it.size));
  if (it.toolCalls) bits.push(`${it.toolCalls} 工具`);
  if (it.contextTokens && it.contextLimit) {
    const pct = Math.round((it.contextTokens / it.contextLimit) * 100);
    const cls = pct >= 90 ? ' high' : pct >= 70 ? ' warn' : '';
    bits.push(`<span class="ctx${cls}" title="上下文占用 ${it.contextTokens.toLocaleString()} / ${it.contextLimit.toLocaleString()} tokens">上下文 ${pct}%</span>`);
  }
  if (it.createdAt) {
    bits.push(`<span class="created" title="创建于 ${esc(abs(it.createdAt))}">创建 ${esc(shortDateTime(it.createdAt))}</span>`);
  }
  const meta = `<div class="row-meta-line">${bits.join(' · ')}</div>`;

  return `<div class="row${selected ? ' selected' : ''}${starred ? ' starred' : ''}" data-id="${esc(it.id)}">
    <div class="chk-cell"><input type="checkbox" data-check="${esc(it.id)}" ${selected ? 'checked' : ''} aria-label="选择会话"></div>
    <div class="row-main">
      <div class="row-title">
        ${star}
        <span class="t">${hlText(it.title || '(无标题)', S.q)}</span>
        ${note}
        ${live}${branch}${subs}${fork}${forked}
      </div>
      ${meta}
      <div class="row-path" title="${esc(it.cwd || it.project)}">${esc(it.cwd || it.project || '')}</div>
      ${snippet}
    </div>
  </div>`;
}

function hlText(text, q) {
  const e = esc(text ?? '');
  if (!q) return e;
  try {
    return e.replace(new RegExp(escRe(esc(q)), 'gi'), (m) => '<mark>' + m + '</mark>');
  } catch {
    return e;
  }
}

function onRowPointerOver(e) {
  if (e.pointerType && e.pointerType !== 'mouse') return;
  const row = e.target.closest('.row');
  if (!row || !row.dataset.id) return;
  if (e.target.closest('input, button, a')) return;
  if (!document.getElementById('hovercard').hidden &&
      document.getElementById('hovercard').dataset.id === row.dataset.id) {
    clearTimeout(hideTimer);
    return;
  }
  clearTimeout(hoverTimer);
  clearTimeout(hideTimer);
  S.pointer = { x: e.clientX, y: e.clientY };

  // Switching to another row takes a deliberate pause. The path from a row to
  // the card crosses the next row, so a short delay would swap the card out
  // from under the pointer while the user is reaching for its delete button.
  const open = !document.getElementById('hovercard').hidden;
  hoverTimer = setTimeout(() => {
    const el = document.elementFromPoint(lastPointer.x, lastPointer.y);
    const over = el && el.closest('#sessions .row');
    if (!over || over.dataset.id !== row.dataset.id) return; // pointer moved on
    showHoverCard(row);
  }, open ? 620 : 380);
}

function onListClick(e) {
  if (e.target.closest('input[type=checkbox]')) return;
  // 折叠按钮、会话 ID 复制：不要顺带打开详情
  if (e.target.closest('[data-toggle-forks]') || e.target.closest('[data-copy-id]')) return;

  const starBtn = e.target.closest('[data-star]');
  if (starBtn) {
    e.stopPropagation();
    toggleStar(starBtn.dataset.star);
    return;
  }
  const row = e.target.closest('.row');
  if (!row) return;
  openDetail(row.dataset.id);
}

function onListCheck(e) {
  const box = e.target.closest('input[data-check]');
  if (!box) return;
  const id = box.dataset.check;
  if (box.checked) S.selected.add(id); else S.selected.delete(id);
  box.closest('.row').classList.toggle('selected', box.checked);
  updateBulkBar();
}

function updateBulkBar() {
  const n = S.selected.size;
  $('#select-all-wrap').hidden = S.items.length === 0;
  $('#bulk-delete').hidden = n === 0;
  $('#bulk-star').hidden = n === 0;
  $('#bulk-unstar').hidden = n === 0;
  $('#bulk-count').textContent = n ? `(${n})` : '';
  const all = S.items.length > 0 && S.items.every((it) => S.selected.has(it.id));
  $('#select-all').checked = all;
}

function onSelectAll(e) {
  if (e.target.checked) S.items.forEach((it) => S.selected.add(it.id));
  else S.items.forEach((it) => S.selected.delete(it.id));
  renderList();
}

async function bulkStar(starred) {
  const ids = Array.from(S.selected);
  if (!ids.length) return;
  try {
    await api('/api/marks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, starred }),
    });
    for (const id of ids) applyMark(id, { ...(S.marks[id] || {}), starred });
    toast(starred ? `已收藏 ${ids.length} 个会话` : `已取消收藏 ${ids.length} 个`);
  } catch (err) {
    toast('保存标记失败: ' + err.message, true);
  }
}

async function bulkDelete() {
  const ids = Array.from(S.selected);
  if (!ids.length) return;
  const ok = await confirmDialog('删除所选会话', `将 ${ids.length} 个会话移入回收站，可随时恢复。`, '移入回收站');
  if (!ok) return;
  try {
    let res = await api('/api/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    S.selected.clear();
    const errs = Object.values(res.errors || {});
    await Promise.all([loadStats(), loadProjects(), loadSessions()]);
    const blockedN = (res.blocked || []).length;
    if (blockedN) {
      toast(`已删除 ${res.deleted.length} 个；${blockedN} 个已收藏，取消收藏后才能删除`, true);
    } else if (errs.length) {
      toast(`已删除 ${res.deleted.length} 个，${errs.length} 个失败: ${errs[0]}`, true);
    } else {
      const ids = res.deleted || [];
      toastUndo(`已移入回收站 ${ids.length} 个会话`, '撤销', async () => {
        await api('/api/trash/restore', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        await Promise.all([loadSessions(), loadStats(), loadProjects()]);
      });
    }
  } catch (err) {
    toast('删除失败: ' + err.message, true);
  }
}

async function rescan() {
  const btn = $('#rescan');
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await api('/api/rescan', { method: 'POST' });
    await Promise.all([loadStats(), loadProjects(), loadSessions()]);
    toast(`重新扫描完成，共 ${S.stats ? S.stats.sessions : '?'} 个会话`);
  } catch (err) {
    toast('扫描失败: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '⟳';
  }
}

function renderSortDir() {
  const btn = $('#sort-dir');
  btn.textContent = S.asc ? '↑' : '↓';
  btn.classList.toggle('on', S.asc);
  btn.title = S.asc ? '当前：升序（点击改为倒序）' : '当前：倒序（点击改为升序）';
  btn.setAttribute('aria-pressed', String(S.asc));
}

function toggleSortDir() {
  S.asc = !S.asc;
  localStorage.setItem('cs-sort-asc', S.asc ? '1' : '0');
  renderSortDir();
  loadSessions();
}

function onProjectClick(e) {
  const btn = e.target.closest('.proj');
  if (!btn) return;
  S.selected.clear();
  if (btn.dataset.starFilter) {
    S.starOnly = !S.starOnly;
  } else {
    S.project = btn.dataset.project || '';
    S.starOnly = false;
  }
  renderProjects();
  loadSessions();
}

async function loadMarks() {
  try {
    const res = await api('/api/marks');
    S.marks = res.marks || {};
    renderProjects();
  } catch {
    /* 标记不是关键路径，失败时静默 */
  }
}

// 重命名：只写本程序的 marks.json，不碰 ~/.claude 里的会话文件
function openRenameDialog(id) {
  if (!id) return;
  const item = (S.detail && S.detail.id === id) ? S.detail : S.items.find((i) => i.id === id);
  const m = S.marks[id] || {};
  const dlg = $('#rename-dialog');

  // 预填当前名字，方便在原基础上改
  $('#rename-input').value = (item && item.title) || '';
  $('#rename-sub').textContent = item && item.cwd ? item.cwd : '';
  dlg.returnValue = 'cancel';
  dlg.showModal();
  $('#rename-input').focus();
  $('#rename-input').select();

  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'ok') return;
    const title = $('#rename-input').value.trim();
    if (!title) {
      toast('名字不能为空', true);
      return;
    }
    try {
      await api('/api/rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, title }),
      });
      // 会话文件里已经多了一条 custom-title，重扫后再渲染
      const it = S.items.find((i) => i.id === id);
      if (it) it.title = title;
      if (S.detail && S.detail.id === id) {
        S.detail.title = title;
        $('#d-title').textContent = title;
      }
      renderList();
      renderOutline();
      toast(`已重命名为「${truncate(title, 24)}」`);
    } catch (err) {
      toast('改名失败: ' + err.message, true);
    }
  }, { once: true });
}

// 收藏只是收藏：只改 starred，不碰备注
async function toggleStar(id) {
  const cur = (S.marks[id] && S.marks[id].starred) || (S.items.find((i) => i.id === id) || {}).starred;
  const starred = !cur;
  try {
    await api('/api/marks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: [{ id, starred }] }),
    });
    applyMark(id, { starred });
    toast(starred ? '已收藏' : '已取消收藏');
  } catch (err) {
    toast('保存失败: ' + err.message, true);
  }
}

function applyMark(id, patch) {
  const existing = S.marks[id] || {};
  const merged = { ...existing, ...patch };
  const clean = !merged.starred && !(merged.tags || []).length && !merged.note;
  if (clean) delete S.marks[id];
  else S.marks[id] = merged;

  const it = S.items.find((i) => i.id === id);
  if (it) {
    it.starred = !!merged.starred;
    it.tags = merged.tags || [];
    it.note = merged.note || '';
  }
  if (S.detail && S.detail.id === id) {
    S.detail.starred = !!merged.starred;
    S.detail.tags = merged.tags || [];
    S.detail.note = merged.note || '';
    syncDetailStar();
  }
  renderList();
  renderProjects();
  const card = $('#hovercard');
  if (!card.hidden && card.dataset.id === id) {
    const row = document.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
    if (row) {
      card.innerHTML = hoverCardHTML(S.items.find((i) => i.id === id), previewCache.get(id) ?? null);
      positionHoverCard(row);
    }
  }
}

/* ----------------------------------------------------------- detail view */
function setHash(id, agent, turn) {
  const p = new URLSearchParams();
  if (agent) p.set('agent', agent);
  if (turn) p.set('turn', String(turn));
  const qs = p.toString();
  history.replaceState(null, '', '#/session/' + encodeURIComponent(id) + (qs ? '?' + qs : ''));
}
async function openDetail(id, agent = null, turn = 0) {
  S.detailId = id;
  S.agent = agent;
  S.isNew = false;
  S.forkFrom = '';
  BTW.length = 0;
  clearAttachments();
  S.turns = [];
  S.from = 0;
  S.convQuery = '';
  S.convHits = [];
  S.convHitIdx = 0;
  $('#conv-search').value = '';
  $('#conv-search-count').textContent = '';
  setView('detail');
  $('#main').scrollTop = 0;
  $('#conv').innerHTML = '<div class="empty">正在解析会话…</div>';
  $('#outline-list').innerHTML = '';
  $('#d-title').textContent = '';
  $('#d-sub').textContent = '';
  $('#d-meta').innerHTML = '';

  try {
    setHash(id, agent, turn);
    // 先取一小批（任何体积都安全），拿到 totalTurns / size 后再决定补齐多少：
    // 小会话一次加载完，默认不需要点「加载更多」；大会话保持分页，避免拖垮渲染。
    const qs = new URLSearchParams({ from: '0', count: '5' });
    if (agent) qs.set('agent', agent);
    let d;
    try {
      d = await api(`/api/sessions/${encodeURIComponent(id)}?` + qs.toString());
    } catch (firstErr) {
      const retry = new URLSearchParams({ from: '0', count: '25' });
      if (agent) retry.set('agent', agent);
      d = await api(`/api/sessions/${encodeURIComponent(id)}?` + retry.toString());
    }
    S.detail = d;
    S.totalTurns = d.totalTurns || 0;
    S.turns = d.turns || [];
    S.from = S.turns.length;

    const mb = (d.size || 0) / 1048576;
    S.pageSize = mb > 40 ? 50 : mb > 12 ? 100 : 1000;
    if (mb <= 12) {
      // 小会话：直接补齐全部，不需要点任何按钮
      let guard = 0;
      while (S.from < S.totalTurns && S.turns.length < 4000 && guard < 10) {
        await loadMoreTurns();
        guard++;
      }
    } else if (S.totalTurns > S.turns.length) {
      // 大会话：首屏 5 条 + 末尾 5 条，中间留占位按需加载
      const tailCount = Math.min(5, S.totalTurns);
      const tail = await api(
        `/api/sessions/${encodeURIComponent(id)}?from=${S.totalTurns - tailCount}&count=${tailCount}` +
        (agent ? `&agent=${encodeURIComponent(agent)}` : ''),
      );
      for (const t of tail.turns || []) {
        if (!S.turns.some((x) => x.index === t.index)) S.turns.push(t);
      }
      S.turns.sort((a, b) => a.index - b.index);
    }
    renderDetail();
    startLiveWatch(id);
    startChatStream(id);
    startHUD(id);
    startAgeTimer();
    loadChatModels();
    // 默认停在最底部（最新一轮），除非明确指定了要跳的轮次
    if (turn) await jumpToTurn(turn, false);
    else requestAnimationFrame(() => { $('#main').scrollTop = $('#main').scrollHeight; });
  } catch (err) {
    $('#conv').innerHTML = `<div class="empty"><h3>无法打开会话</h3><div>${esc(err.message)}</div></div>`;
  }
}

function closeDetail() {
  if (document.body.dataset.view !== 'detail') return;
  stopLiveWatch();
  stopChatStream();
  stopHUD();
  stopAgeTimer();
  closePanel();
  S.detailId = null;
  S.detail = null;
  history.replaceState(null, '', location.pathname + location.search);
  setView('list');
  $('#main').scrollTop = 0;
  loadSessions().then(() => { $('#main').scrollTop = 0; });
}

function renderDetail() {
  const d = S.detail;
  if (!d) return;

  const title = d.subagent ? `${d.title} · 子代理 ${d.agentType || ''}` : d.title;
  $('#d-title').textContent = title || '(无标题会话)';
  $('#d-sub').textContent = (d.cwd || d.project || '') + (d.branch ? '  ·  ' + d.branch : '');

  renderBranchBanner();
  renderPanelTabs();
  renderChatStatus();
  $('#composer').hidden = !!d.subagent;
  const backMain = $('#d-back-main');
  if (backMain) {
    backMain.hidden = !d.subagent;
    backMain.onclick = () => openDetail(d.id, null, 0);
  }

  const bits = [
    ['会话 ID', d.subagent ? `${d.id} / ${d.agentType}` : d.id],
    ['模型', d.model || '—'],
    ['创建', abs(d.createdAt) || '—'],
    ['最后活动', abs(d.updatedAt) || '—'],
    ['轮次', String(S.totalTurns)],
    ['消息', `${d.userMsgs} 用户 / ${d.asstMsgs} 助手`],
    ['工具调用', String(d.toolCalls)],
    ['Token', `入 ${fmtNum(d.in)} · 出 ${fmtNum(d.out)} · 缓存 ${fmtNum(d.cacheRead)}`],
    ['文件', fmtBytes(d.size)],
    ['版本', d.version || '—'],
  ];
  // subagent transcripts are switchable from the meta bar
  let subs = '';
  if (!d.subagent && d.subagents && d.subagents.length) {
    subs = d.subagents.map((a) => `<button class="btn ghost subagent-btn" data-agent="${esc(a.id)}" title="${esc(a.description || '')}">↳ ${esc(a.agentType)} · ${a.msgs} 条</button>`).join('');
  }
  const noteChip = d.note ? `<span class="detail-note">✎ ${esc(d.note)}</span>` : '';
  if (d.forkOf) {
    bits.unshift(['分支自', `<button class="link-btn" data-open-session="${esc(d.forkOf)}">${esc(truncate(d.forkOfTitle || d.forkOf, 40))}</button>`]);
  }
  if (d.forkCount) {
    bits.push(['被分支', String(d.forkCount)]);
  }
  $('#d-meta').innerHTML = bits.map(([k, v]) => `<span><span class="k">${esc(k)}</span> <b>${v}</b></span>`).join('') +
    (noteChip ? `<span class="detail-mark">${noteChip}</span>` : '') + subs;

  syncDetailStar();

  renderTurns();
  renderOutline();
}

// ---------- 运行中的会话：静默增量刷新 ----------
// 只轮询 /revision（几十微秒），文件变了才重新取最后一段并局部替换 DOM
const LIVE_INTERVAL = 2500;

function stopLiveWatch() {
  if (S.liveTimer) {
    clearTimeout(S.liveTimer);
    S.liveTimer = null;
  }
}

// 新会话/新分支的第一轮：等它进索引（服务端会在进程退出时重扫），再整页载入
async function loadFirstTurn(id) {
  // 新会话的第一轮要等进程退出 + 索引重扫，图大的时候可能要几十秒
  for (let i = 0; i < 25; i++) {
    if (S.detailId !== id) return;
    try {
      const d = await api(`/api/sessions/${encodeURIComponent(id)}?from=0&count=5`);
      if (d && d.turns && d.turns.length) { await openDetail(id); return; }
    } catch { /* 还没扫到，继续等 */ }
    await new Promise((r) => setTimeout(r, 1200));
  }
}

function startLiveWatch(id) {
  stopLiveWatch();
  S.liveRev = 0;
  S.liveSlow = 0;
  const tick = async () => {
    if (document.body.dataset.view !== 'detail' || S.detailId !== id) return stopLiveWatch();
    // 页面在后台时不轮询，回来时立刻补一次
    if (document.hidden) {
      S.liveTimer = setTimeout(tick, LIVE_INTERVAL);
      return;
    }
    try {
      const rev = await api(`/api/sessions/${encodeURIComponent(id)}/revision`);
      const key = rev.mtime + ':' + rev.size;
      if (!S.liveRev) {
        S.liveRev = key;
      } else if (key !== S.liveRev) {
        S.liveRev = key;
        const t0 = performance.now();
        await refreshTail();
        const cost = performance.now() - t0;
        S.liveSlow = cost > 400 ? Math.min(S.liveSlow + 1, 3) : 0;
      }
    } catch {
      /* 轮询失败不打扰用户 */
    }
    S.liveTimer = setTimeout(tick, LIVE_INTERVAL * (1 + S.liveSlow * 2));
  };
  S.liveTimer = setTimeout(tick, LIVE_INTERVAL);
}

// 只重取「最后一轮 + 之后新增的」，避免整页重渲染导致滚动跳动
async function refreshTail() {
  if (!S.detailId || !S.turns.length) return;
  const from = Math.max(0, S.turns.length - 1);
  const qs = new URLSearchParams({ from: String(from), count: String(Math.max(S.pageSize || 50, 50)) });
  if (S.agent) qs.set('agent', S.agent);
  const d = await api(`/api/sessions/${encodeURIComponent(S.detailId)}?` + qs.toString());
  const fresh = d.turns || [];
  if (!fresh.length) return;

  const main = $('#main');
  const atBottom = main.scrollHeight - main.clientHeight - main.scrollTop < 80;
  const keep = main.scrollTop;
  const lastIdx = S.turns[S.turns.length - 1].index;
  const replaced = new Map(fresh.map((t) => [t.index, t]));

  if (replaced.has(lastIdx)) {
    const oldEl = document.getElementById('t-' + lastIdx);
    const idx = S.turns.findIndex((t) => t.index === lastIdx);
    S.turns[idx] = replaced.get(lastIdx);
    if (oldEl) oldEl.outerHTML = turnHTML(replaced.get(lastIdx));
    replaced.delete(lastIdx);
  }

  const appended = [...replaced.values()].filter((t) => t.index > lastIdx).sort((a, b) => a.index - b.index);
  if (appended.length) {
    for (const t of appended) S.turns.push(t);
    $('#conv').insertAdjacentHTML('beforeend', appended.map((t) => turnHTML(t)).join(''));
    $('#outline-list').insertAdjacentHTML('beforeend', appended.map((t) => `<button class="outline-item" data-jump="${t.index}" title="${esc(truncate(turnLabel(t), 120))}${t.ts ? "  ·  " + esc(turnTime(t.ts)) : ""}">
      <span class="n">${t.index}</span><span class="p">${esc(truncate(turnLabel(t), 34))}</span></button>`).join(''));
  }

  if (d.title && S.detail && d.title !== S.detail.title) {
    S.detail.title = d.title;
    $('#d-title').textContent = d.title;
  }
  if (d.totalTurns) S.totalTurns = d.totalTurns;
  // 终端里新起的子代理 / 后台 shell 也要跟着冒出来，不用手动刷新
  if (S.detail) {
    const sig = (xs) => (xs || []).map((x) => x.id + ':' + (x.msgs ?? x.status ?? '')).join(',');
    if (sig(d.subagents) !== sig(S.detail.subagents) || sig(d.shells) !== sig(S.detail.shells)) {
      S.detail.subagents = d.subagents || [];
      S.detail.shells = d.shells || [];
      renderPanelTabs();
    }
  }
  S.from = S.turns.length;
  if (atBottom) main.scrollTop = main.scrollHeight;
  else main.scrollTop = keep;
  syncDetailToggle();
  updateJumpNav();
  dropLiveBubble();
}

// 真内容已经渲染好了，就把这一轮结束时的临时气泡删掉
function dropLiveBubble() {
  const els = document.querySelectorAll('#conv .live-turn');
  els.forEach((el) => el.remove());
  if (CHAT.live && els.length) CHAT.live = null;
}

// 会话底部列出子代理和后台 shell，点一下在右侧抽屉里看内容，再点关闭
const PANEL = { open: null, agent: null };
const FORKS = []; // /subtask 起的子任务（不产生会话，结果只在这个面板里）

function renderPanelTabs() {
  const d = S.detail || {};
  const box = $('#panel-tabs');
  if (!box) return;
  const subs = (d.subagent ? [] : (d.subagents || []));
  const shells = (d.subagent ? [] : (d.shells || []));
  if (!subs.length && !shells.length && !FORKS.length && !BTW.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  const chips = [
    `<button class="panel-chip main${PANEL.open ? '' : ' on'}" data-panel="main" title="当前会话">● main</button>`,
  ];
  for (const b of BTW) {
    const state = b.a === null ? '回答中' : '已答';
    chips.push(`<button class="panel-chip btw" data-panel="btw:${esc(b.id)}" title="旁注：${esc(b.q)}">
        <span class="pc-kind">旁注</span>
        <span class="pc-name">${esc(truncate(b.q, 22))}</span>
        <span class="pc-n">${esc(state)}</span>
      </button>`);
  }
  for (const f of FORKS) {
    const secs = f.status === 'running' ? ((Date.now() - f.startedAt) / 1000).toFixed(0) + 's' : '结束';
    chips.push(`<button class="panel-chip fork${f.status === 'running' ? ' running' : ''}" data-panel="fork:${esc(f.id)}" title="子任务：${esc(f.task)}">
        <span class="pc-kind">子任务</span>
        <span class="pc-name">${esc(truncate(f.task, 24))}</span>
        <span class="pc-n">${esc(secs)}</span>
      </button>`);
  }
  subs.forEach((a, i) => {
    // 名字用它的描述（派发时写的那句话），比清一色的 "fork" 有用
    const label = (a.description || '').trim() || a.agentType || 'agent';
    const when = a.startedAt ? abs(a.startedAt) : '';
    const tip = `第 ${i + 1} 个（按派发时间排）· ${when ? when + ' 派发 · ' : ''}${a.agentType || 'agent'} · ${a.msgs} 条消息`;
    chips.push(`<button class="panel-chip" data-panel="agent:${esc(a.id)}" title="${esc(tip)}">
        <span class="pc-idx">${i + 1}</span>
        <span class="pc-kind">子代理</span>
        <span class="pc-name">${esc(truncate(label, 20))}</span>
        <span class="pc-n">${a.msgs}</span>
      </button>`);
  });
  for (const sh of shells) {
    chips.push(`<button class="panel-chip shell" data-panel="shell:${esc(sh.id)}" title="${esc(sh.command || '')}">
        <span class="pc-kind">shell</span>
        <span class="pc-name">${esc(truncate(sh.description || sh.command || sh.id, 28))}</span>
        <span class="pc-n">${sh.status === 'done' ? '已结束' : '后台'}</span>
      </button>`);
  }
  box.innerHTML = chips.join('');
  // 保持打开状态高亮
  if (PANEL.open) {
    const btn = box.querySelector(`[data-panel="${CSS.escape(PANEL.open)}"]`);
    if (btn) btn.classList.add('on');
    else closePanel();
  }
}

function closePanel() {
  PANEL.open = null;
  const p = $('#side-panel');
  if (p) p.hidden = true;
  document.querySelectorAll('.panel-chip.on').forEach((el) => el.classList.remove('on'));
  updateJumpNav();
}

function togglePanel(key) {
  if (PANEL.open === key) {
    closePanel();
    return;
  }
  openPanel(key);
}

// 打开右侧面板并切到 key 对应的内容（chip 高亮跟着走）
function openPanel(key) {
  PANEL.open = key;
  const panel = $('#side-panel');
  if (panel) panel.hidden = false;
  document.querySelectorAll('.panel-chip.on').forEach((el) => el.classList.remove('on'));
  const btn = document.querySelector(`.panel-chip[data-panel="${CSS.escape(key)}"]`);
  if (btn) btn.classList.add('on');
  renderPanelBody();
  updateJumpNav();
}

async function renderPanelBody() {
  const key = PANEL.open;
  if (!key) return;
  const body = $('#panel-body');
  const title = $('#panel-title');
  if (!body || !title) return;
  body.innerHTML = '<div class="pick-empty">加载中…</div>';

  const [kind, id] = key.split(':');
  const d = S.detail || {};
  PANEL.agent = kind === 'agent' ? id : null;
  $('#panel-expand').hidden = kind !== 'agent';

  if (kind === 'main') {
    closePanel();
    return;
  }

  if (kind === 'btw') {
    const b = BTW.find((x) => x.id === id);
    title.textContent = '旁注（不影响当前会话）';
    if (!b) { body.innerHTML = '<div class="pick-empty">找不到这条旁注</div>'; return; }
    body.innerHTML = `<div class="panel-sec"><div class="panel-label">问题</div>
        <div class="btw-q">${esc(b.q)}</div></div>
      <div class="panel-sec"><div class="panel-label">回答</div>
        ${b.a === null ? '<div class="btw-a muted">正在回答…</div>' : `<div class="btw-a">${md(b.a)}</div>`}</div>`;
    return;
  }

  if (kind === 'fork') {
    const f = FORKS.find((x) => x.id === id);
    title.textContent = f && f.status === 'running' ? '子任务（运行中）' : '子任务';
    if (!f) { body.innerHTML = '<div class="pick-empty">找不到这个任务</div>'; return; }
    const head = `<div class="panel-sec"><div class="panel-label">任务</div><pre class="panel-pre">${esc(f.task)}</pre></div>`;
    if (f.status === 'running') {
      body.innerHTML = head + '<div class="pick-empty">还在后台跑，结束后这里会显示它的结果</div>';
      return;
    }
    // 子任务不落盘（跟 CLI 一致），内容只能从内存里拿
    const text = (f.text || '').trim();
    body.innerHTML = head + (text
      ? `<div class="panel-sec"><div class="panel-label">结果</div><div class="panel-text">${esc(text)}</div></div>`
      : '<div class="pick-empty">这个子任务没有输出</div>');
    return;
  }

  if (kind === 'shell') {
    const sh = (d.shells || []).find((x) => x.id === id);
    if (!sh) { body.innerHTML = '<div class="pick-empty">找不到这条 shell</div>'; return; }
    title.textContent = sh.status === 'done' ? '后台 shell（已结束）' : '后台 shell';
    body.innerHTML = `
      <div class="panel-sec">
        <div class="panel-label">命令</div>
        <pre class="panel-pre">${esc(sh.command || '')}</pre>
      </div>
      <div class="panel-sec">
        <div class="panel-label">输出</div>
        <pre class="panel-pre">${esc(sh.output || '（暂无输出）')}</pre>
      </div>`;
    return;
  }

  // 子代理：取它的对话渲染
  title.textContent = '子代理';
  IMG_CTX = { sid: d.id, agent: id };
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(d.id)}?agent=${encodeURIComponent(id)}&from=0&count=200`);
    const turns = r.turns || [];
    const sub = (d.subagents || []).find((a) => a.id === id);
    const label = ((sub && sub.description) || r.agentType || '').trim();
    title.textContent = `子代理${label ? ' · ' + truncate(label, 22) : ''} · ${r.totalTurns || turns.length} 轮`;
    // fork 出来的子代理会把父会话历史整段继承下来，默认折叠，避免一进来全是旧内容
    let inherited = 0;
    let own = 0;
    const isInherited = (t) => {
      const p = (t.prompt || '') + '\n' + (t.command || '');
      return p.includes('<fork-boilerplate>') || p.includes('You are a worker fork') ||
        p.includes('inherited reference') || p.includes('This call started a fork');
    };
    const parts = turns.map((t) => {
      if (isInherited(t)) { inherited++; return `<div data-inherited>${turnHTML(t)}</div>`; }
      own++;
      return turnHTML(t);
    });
    if (inherited) {
      body.innerHTML = `<details class="inherited-block"><summary>继承自父会话的历史（${inherited} 轮，点开查看）</summary>
          <div class="inherited-body">${parts.filter((_, i) => isInherited(turns[i])).join('')}</div>
        </details>` +
        turns.map((t, i) => (isInherited(t) ? '' : parts[i])).join('');
    } else {
      body.innerHTML = parts.join('') || '<div class="pick-empty">这个子代理没有内容</div>';
    }
  } catch (err) {
    body.innerHTML = `<div class="pick-empty">${esc(err.message)}</div>`;
  } finally {
    IMG_CTX = null;
  }
}

// 顶部状态行：直接跑 Claude Code 的 statusLine 命令（这台机器上是 OMC 的 HUD），
// 所以模型、版本、更新提示、上下文占用都和终端里一模一样
let hudTimer = null;
async function loadHUD(id) {
  const box = $('#hud');
  if (!box) return;
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(id)}/hud`);
    const wrap = $('#hud-wrap');
  if (!r.enabled || !r.html) {
      if (wrap) wrap.hidden = true;
      box.innerHTML = '';
      return;
    }
    if (wrap) wrap.hidden = false;
    box.innerHTML = r.html;
    box.scrollLeft = 0;
  } catch {
    box.hidden = true;
  }
}

function startHUD(id) {
  stopHUD();
  loadHUD(id);
  hudTimer = setInterval(() => {
    if (document.body.dataset.view === 'detail' && S.detailId === id) loadHUD(id);
    else stopHUD();
  }, 20000);
}

function stopHUD() {
  if (hudTimer) {
    clearInterval(hudTimer);
    hudTimer = null;
  }
  const wrap = $('#hud-wrap');
  if (wrap) wrap.hidden = true;
}

// 详情页顶部的分支提示：标明自己是分支，或标明自己有几个分支
function renderBranchBanner() {
  const d = S.detail;
  const box = $('#d-branch');
  if (!d || !box) return;
  const kids = S.branchChildren && S.branchChildren.get(d.id);
  if (d.forkOf) {
    box.hidden = false;
    box.innerHTML = `<span class="bb-icon">↳</span>
      <span class="bb-text">这是一个<b>分支会话</b>，来自</span>
      <button class="bb-link" type="button" data-open-session="${esc(d.forkOf)}">${esc(truncate(d.forkOfTitle || d.forkOf, 60))}</button>
      <span class="bb-hint">点标题回到主会话</span>`;
  } else if (d.forkCount) {
    const names = (kids || []).map((k) => `<button class="bb-link" type="button" data-open-session="${esc(k.id)}">${esc(truncate(k.title || k.id, 32))}</button>`).join('、');
    box.hidden = false;
    box.innerHTML = `<span class="bb-icon">↳</span>
      <span class="bb-text">主会话，有 <b>${d.forkCount}</b> 个分支：</span>${names}`;
  } else {
    box.hidden = true;
    box.innerHTML = '';
  }
}

// 详情页星标跟着收藏状态走（点星标、在别处取消收藏都要同步）
function syncDetailStar() {
  const d = S.detail;
  const btn = $('#d-star');
  if (!d || !btn) return;
  const starred = !!(d.starred || (S.marks[d.id] && S.marks[d.id].starred));
  btn.innerHTML = starred ? STAR_FILLED : STAR_OUTLINE;
  btn.classList.toggle('on', starred);
  btn.title = starred ? '已收藏 · 点击取消' : '收藏';
  btn.setAttribute('aria-pressed', String(starred));
}

function renderTurns() {
  const box = $('#conv');
  if (!S.turns.length) {
    box.innerHTML = '<div class="empty">这个会话没有可显示的对话内容（可能只有系统事件）。</div>';
    $('#load-more').hidden = true;
    return;
  }
  const sorted = [...S.turns].sort((a, b) => a.index - b.index);
  const parts = [];
  let expect = 1;
  for (const t of sorted) {
    if (t.index > expect) parts.push(gapHTML(expect, t.index - 1));
    parts.push(turnHTML(t));
    expect = t.index + 1;
  }
  if (S.totalTurns >= expect) parts.push(gapHTML(expect, S.totalTurns));
  box.innerHTML = parts.join('');
  $('#load-more').hidden = true; // 缺口由占位块负责，底部按钮不再使用

  if (S.convQuery) {
    highlightDOM(box, S.convQuery, { only: CONV_SEARCH_SCOPE });
    // 重渲染会丢 open 状态，把当前命中那轮的折叠块重新展开
    const hit = S.convHits && S.convHits[S.convHitIdx];
    if (hit) {
      const el = document.getElementById('t-' + hit.turn);
      if (el) {
        for (let i = 0; i < 4; i++) {
          let opened = 0;
          el.querySelectorAll('details:not([open])').forEach((d) => {
            if (d.querySelector('mark.hl')) { d.open = true; opened++; }
          });
          if (!opened) break;
        }
      }
    }
  }
  syncDetailToggle();
  updateJumpNav();
  renderOutline();
}

// 未加载的轮次区间：占位 + 按需加载按钮
function gapHTML(from, to) {
  const n = to - from + 1;
  const step = Math.min(S.pageSize || 50, n);
  return `<div class="turn-gap" data-gap-from="${from}" data-gap-to="${to}">
    <span class="turn-gap-text">中间还有 ${n} 轮</span>
    <button class="btn ghost turn-gap-btn" type="button" data-gap-load="${from}">加载 ${step} 轮</button>
  </div>`;
}

function turnLabel(t) {
  const p = oneLine(t.prompt || '');
  if (t.command) return p ? `${t.command} ${p}` : t.command;
  return p || '(无输入)';
}

// 线性阅读流：一轮就是一屏内容，不再套卡片、不再整轮折叠。
// 只有「思考」和「工具调用」压成一行摘要，点开才看细节。
// 提问时间：当天只显示时分，同年显示月-日 时:分，跨年带年份
function turnTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p2 = (n) => String(n).padStart(2, '0');
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hm;
  const md = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

// 从技能正文里拿技能名（技能后来被删了，这里仍然能显示）
function skillName(note) {
  const m = /Base directory for this skill:\s*(\S+)/.exec(note || '');
  if (!m) return '';
  const seg = m[1].replace(/\/+$/, '').split('/').pop();
  return seg || '';
}

function turnHTML(t) {
  const ts = turnTime(t.ts);
  const tsChip = ts ? `<span class="prompt-ts" title="${esc(abs(t.ts))}">${esc(ts)}</span>` : '';
  const promptBlock = t.command
    ? `<div class="prompt-box cmd"><span class="lbl">命令</span><span class="cmd-chip">${esc(t.command)}</span>${tsChip}` +
      `<div class="cmd-args${t.prompt ? '' : ' dim'}">${esc(t.prompt || '（无参数）')}</div></div>`
    : (t.prompt ? `<div class="prompt-box"><span class="lbl">用户</span>${esc(t.prompt)}${tsChip}</div>` : '');
  const notes = (t.notes || []).map((n) => {
    const skill = skillName(n);
    const label = skill ? `技能内容 · ${skill}` : (n.includes('Base directory for this skill:') ? '技能内容' : '系统上下文');
    return `<details class="think note"><summary>${esc(label)} · ${Array.from(n).length} 字</summary><div>${esc(n)}</div></details>`;
  }).join('');
  const empty = t.command ? '（该命令没有产生回复）' : '（本轮没有助手回复，可能被中断）';
  // 提示里写了 [Image #1] 但这一轮没有任何图片块：说明当时截图没存进会话（也没送到模型）
  const lostImg = /\[Image #\d+\]/.test(t.prompt || '') && !(t.images || []).length
    ? '<div class="imgblk">这条消息里的截图没有存进会话文件，当时模型也没看到它</div>'
    : '';

  // 把整轮的内容块拍平：工具调用（assistant）和它的结果（user）分属两条消息，
  // 拍平后才能合并成一行摘要。
  const flat = [];
  for (const m of t.messages || []) {
    for (const b of m.blocks || []) flat.push(b);
  }
  const body = renderBlocks(flat);

  const del = t.uuid
    ? `<button class="turn-del" data-del-turn="${esc(t.uuid)}" title="删除这一块（整轮，删前会备份）">✕</button>`
    : '';
  return `<article class="turn" id="t-${t.index}" data-turn="${t.index}">
    ${del}
    ${promptBlock}
    ${lostImg}
    ${(t.images || []).length ? `<div class="turn-images">${t.images.map((b) => imgHTML(b.detail, b.imageIndex, b.source)).join('')}</div>` : ''}
    ${notes}
    ${body || `<div class="imgblk">${empty}</div>`}
  </article>`;
}

// 顺序渲染内容块，连续的工具块聚合成一个可展开的摘要行
function renderBlocks(blocks) {
  const out = [];
  let group = [];
  const flush = () => {
    if (group.length) { out.push(activityHTML(group)); group = []; }
  };
  for (const b of blocks) {
    if (b.kind === 'tool_use' || b.kind === 'tool_result') { group.push(b); continue; }
    flush();
    const html = blockHTML(b);
    if (html) out.push(html);
  }
  flush();
  return out.join('');
}

// 点图在当前页放大，点空白处或 Esc 关掉
function openImageViewer(src, num) {
  const box = $('#img-viewer');
  $('#img-viewer-img').src = src;
  $('#img-viewer-num').textContent = num ? '#' + num : '';
  box.hidden = false;
  document.body.classList.add('viewer-open');
}

function closeImageViewer() {
  const box = $('#img-viewer');
  if (box.hidden) return;
  box.hidden = true;
  document.body.classList.remove('viewer-open');
  $('#img-viewer-img').src = '';
}

// 会话里的图片：按需向服务端要，滚动到可见时才加载
// 渲染图片地址时用哪个会话/子代理：默认是当前详情页。
// 右侧抽屉里看子代理记录时要临时指到那个 agent 的文件，否则会取错图。
let IMG_CTX = null;

function imgHTML(media, index, source) {
  const ctx = IMG_CTX || { sid: S.detailId, agent: S.agent };
  if (index === undefined || index === null || !ctx.sid) {
    return `<div class="imgblk">[图片 ${esc(media || '')}]</div>`;
  }
  const qs = new URLSearchParams({ i: String(index) });
  if (ctx.agent) qs.set('agent', ctx.agent);
  if (source === 'file') qs.set('file', '1'); // 图片是磁盘上的文件，不是内嵌 base64
  const src = `/api/sessions/${encodeURIComponent(ctx.sid)}/image?` + qs.toString();
  const n = index + 1;
  return `<button class="turn-img" type="button" data-img="${esc(src)}" data-num="${n}" title="第 ${n} 张 · 点击放大">
    <span class="turn-img-no">#${n}</span>
    <img loading="lazy" src="${src}" alt="${esc(media || '图片')}">
  </button>`;
}

function oneLine(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// 一组工具调用压成一行：Read ×2 · Bash ×1，失败标红
function activityHTML(blocks) {
  const counts = new Map();
  let fails = 0;
  for (const b of blocks) {
    if (b.kind === 'tool_use') {
      const n = b.name || 'tool';
      counts.set(n, (counts.get(n) || 0) + 1);
    }
    if (b.kind === 'tool_result' && b.isError) fails++;
  }
  const parts = [...counts.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
  const summary = parts.join(' · ') || '工具调用';
  const body = blocks.map(blockHTML).join('');
  return `<details class="activity${fails ? ' has-fail' : ''}">
    <summary>${esc(summary)}${fails ? ` · <span class="fail">${fails} 失败</span>` : ''}</summary>
    <div class="activity-body">${body}</div>
  </details>`;
}

function blockHTML(b) {
  switch (b.kind) {
    case 'text':
      return `<div class="blk-text">${md(b.text)}</div>`;
    case 'thinking':
      return `<details class="think"><summary>思考过程 · ${Array.from(b.text || '').length} 字</summary><div>${esc(b.text)}</div></details>`;
    case 'tool_use': {
      const input = b.input ? JSON.stringify(b.input, null, 2) : (b.detail || '');
      return `<details class="tool">
        <summary class="tool-head"><span class="tool-name">${esc(b.name || 'tool')}</span>
        <span class="tool-sum">${esc(b.summary || '')}</span></summary>
        ${input ? `<pre>${esc(input)}</pre>` : ''}
      </details>`;
    }
    case 'tool_result': {
      const text = b.text || '';
      const first = text.split('\n').find((l) => l.trim()) || '(空结果)';
      return `<details class="result${b.isError ? ' error' : ''}">
        <summary>${esc(truncate(oneLine(first), 170))}${b.isError ? ' · 失败' : ''}</summary>
        <pre>${esc(text)}</pre>
      </details>`;
    }
    case 'image':
      return imgHTML(b.detail, b.imageIndex, b.source);
    default:
      return '';
  }
}

// 删除会话里的某一整块（用户那一轮到下一条用户消息之前的所有内容）
async function deleteTurnBlock(uuid) {
  const t = (S.turns || []).find((x) => x.uuid === uuid);
  const preview = t ? truncate((t.prompt || t.command || '').replace(/\s+/g, ' '), 60) : '';
  const ok = await confirmDialog(
    '删除这一块',
    `这一轮${preview ? '（用户：' + preview + '）' : ''}会从会话文件里整轮删掉，` +
    '它的助手回复和工具调用也一起删，删完消息链会自动接上，CLI 里还能继续 resume。',
    '删除这一块',
    { check: '我知道这一块删掉就找不回来了' },
  );
  if (!ok) return;
  try {
    const res = await api(`/api/session/${encodeURIComponent(S.detailId)}/prune`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuids: [uuid] }),
    });
    toast(`已删除 ${res.removedTurns} 块（${res.removedLines} 行），剩 ${res.remainTurns} 轮`);
    previewCache.clear();
    await openDetail(S.detailId, S.agent, 0);
  } catch (err) {
    toast('删除失败: ' + err.message, true);
  }
}

function onConvClick(e) {
  const delBtn = e.target.closest('[data-del-turn]');
  if (delBtn) {
    e.preventDefault();
    e.stopPropagation();
    deleteTurnBlock(delBtn.dataset.delTurn);
    return;
  }
  const agentBtn = e.target.closest('.subagent-btn');
  if (agentBtn) {
    openDetail(S.detailId, agentBtn.dataset.agent, 0);
    return;
  }
  const head = e.target.closest('.turn-head');
  if (head) {
    head.parentElement.classList.toggle('open');
  }
}

// 点击「加载 N 轮」把缺口补上一段
async function onGapClick(e) {
  const btn = e.target.closest('[data-gap-load]');
  if (!btn || btn.disabled) return;
  const gap = btn.closest('.turn-gap');
  const from = Number(btn.dataset.gapLoad);
  const to = Number(gap.dataset.gapTo);
  const count = Math.min(S.pageSize || 50, to - from + 1);
  btn.disabled = true;
  btn.textContent = '加载中…';
  try {
    const qs = new URLSearchParams({ from: String(from - 1), count: String(count) });
    if (S.agent) qs.set('agent', S.agent);
    const d = await api(`/api/sessions/${encodeURIComponent(S.detailId)}?` + qs.toString());
    for (const t of d.turns || []) {
      if (!S.turns.some((x) => x.index === t.index)) S.turns.push(t);
    }
    const keep = $('#main').scrollTop;
    renderTurns();
    $('#main').scrollTop = keep;
  } catch (err) {
    toast('加载失败：' + err.message, true);
    btn.disabled = false;
    btn.textContent = '重试';
  }
}

// 一个开关：控制所有细节块（思考 / 工具调用）展开或折叠
function setAllDetails(open) {
  $$('#conv details').forEach((d) => { d.open = open; });
  syncDetailToggle();
}

// 在系统终端里直接打开：Windows → Terminal，macOS → Terminal.app，Linux → 首个可用终端
async function openInTerminal() {
  if (!S.detailId) return;
  const btn = $('#open-terminal');
  btn.disabled = true;
  try {
    const r = await api('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: S.detailId }),
    });
    toast(`已在 ${r.terminal} 中打开`);
  } catch (err) {
    toast(`打开失败：${err.message}（可以改用「复制 resume」手动执行）`, true);
  } finally {
    btn.disabled = false;
  }
}

function toggleAllDetails() {
  const anyOpen = $$('#conv details').some((d) => d.open);
  setAllDetails(!anyOpen);
}

// 详情页右下角的回到顶部 / 回到底部
// 位置按大纲的实际右边缘算，避免压住大纲文字；大纲隐藏时退回窗口右下角
function positionJumpNav(nav) {
  // 抽屉会盖住右下角，打开时把跳转按钮收起来
  const panel = $('#side-panel');
  if (panel && !panel.hidden) {
    nav.style.visibility = 'hidden';
    return;
  }
  nav.style.visibility = '';
  nav.style.right = '16px';
  nav.style.bottom = '26px';
}

function updateJumpNav() {
  const nav = $('#jump-nav');
  if (!nav) return;
  if (document.body.dataset.view !== 'detail') {
    nav.hidden = true;
    document.body.classList.remove('jump-inside');
    return;
  }
  const m = $('#main');
  const max = m.scrollHeight - m.clientHeight;
  nav.hidden = max < 240; // 内容不够长就不用显示
  if (nav.hidden) {
    document.body.classList.remove('jump-inside');
    return;
  }
  positionJumpNav(nav);
  $('#jump-top').disabled = m.scrollTop < 40;
  $('#jump-bottom').disabled = m.scrollTop > max - 40;
}

function syncDetailToggle() {
  const btn = $('#turns-toggle');
  if (!btn) return;
  const details = $$('#conv details');
  btn.disabled = details.length === 0;
  if (!details.length) return;
  const anyOpen = details.some((d) => d.open);
  btn.textContent = anyOpen ? '⊟ 折叠细节' : '⊞ 展开细节';
  btn.title = anyOpen ? '折叠所有思考与工具调用' : '展开所有思考与工具调用';
}

function renderOutline() {
  const items = S.turns.map((t) => `<button class="outline-item" data-jump="${t.index}" title="${esc(truncate(turnLabel(t), 120))}${t.ts ? "  ·  " + esc(turnTime(t.ts)) : ""}">
    <span class="n">${t.index}</span>
    <span class="p">${esc(truncate(turnLabel(t), 34))}</span>
  </button>`).join('');
  $('#outline-list').innerHTML = items;
  syncOutline();
}

function syncOutline() {
  const main = $('#main');
  const turns = $$('.turn', $('#conv'));
  if (!turns.length) return;
  const top = main.getBoundingClientRect().top + 130;
  let active = turns[0];
  for (const t of turns) {
    if (t.getBoundingClientRect().top <= top) active = t;
    else break;
  }
  const idx = active.dataset.turn;
  $$('.outline-item').forEach((el) => {
    el.setAttribute('aria-current', String(el.dataset.jump === idx));
  });
}

async function onOutlineClick(e) {
  const btn = e.target.closest('[data-jump]');
  if (!btn) return;
  await jumpToTurn(Number(btn.dataset.jump));
}

async function jumpToTurn(n, smooth = true) {
  const find = () => document.getElementById('t-' + n);
  let el = find();
  if (!el && S.detailId && n >= 1 && n <= S.totalTurns) {
    // 该轮次还没加载（大会话的中间段），单独取这一条
    const qs = new URLSearchParams({ from: String(n - 1), count: '1' });
    if (S.agent) qs.set('agent', S.agent);
    const d = await api(`/api/sessions/${encodeURIComponent(S.detailId)}?` + qs.toString());
    for (const t of d.turns || []) {
      if (!S.turns.some((x) => x.index === t.index)) S.turns.push(t);
    }
    const keep = $('#main').scrollTop;
    renderTurns();
    $('#main').scrollTop = keep;
    el = find();
  }
  if (!el) return;
  // Scroll manually: the sticky header and meta bar would otherwise cover the
  // turn header we just jumped to.
  const main = $('#main');
  const offset = el.getBoundingClientRect().top - main.getBoundingClientRect().top;
  const top = main.scrollTop + offset - 128;
  // 平滑滚动是按距离算时长的，跳几百轮那种一次要滚一两秒；
  // 距离远就直接落位，近的才用平滑动画
  const far = Math.abs(top - main.scrollTop) > 1200;
  main.scrollTo({ top, behavior: smooth && !far ? 'smooth' : 'auto' });
  if (S.detailId) setHash(S.detailId, S.agent, n);
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

async function loadMoreTurns() {
  if (!S.detailId || S.from >= S.totalTurns) return;
  const qs = new URLSearchParams({ from: String(S.from), count: String(S.pageSize || S.count) });
  if (S.agent) qs.set('agent', S.agent);
  const d = await api(`/api/sessions/${encodeURIComponent(S.detailId)}?` + qs.toString());
  const more = d.turns || [];
  S.from += more.length;
  for (const t of more) {
    if (!S.turns.some((x) => x.index === t.index)) S.turns.push(t);
  }
}

// 会话内搜索只扫"用户问的"和"助手正文"，思考过程/工具调用/工具输出都不算
const CONV_SEARCH_SCOPE = '.prompt-box, .blk-text';

// 把当前这轮里命中位置露出来：折叠块（思考过程/工具输出）默认是收起的，
// 里面的命中既看不见也没滚动到，看起来就像"搜不到"。
function revealMatches(q, turnEl) {
  const box = $('#conv');
  if (!q || !box) return;
  clearHighlight(box);
  highlightDOM(box, q, { only: CONV_SEARCH_SCOPE });
  const scope = turnEl || box;
  // 折叠块可能嵌套，多开几轮直到没有新的被打开
  for (let i = 0; i < 4; i++) {
    let opened = 0;
    scope.querySelectorAll('details:not([open])').forEach((d) => {
      if (d.querySelector('mark.hl')) { d.open = true; opened++; }
    });
    if (!opened) break;
  }
  const first = scope.querySelector('mark.hl');
  if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function onConvSearch() {
  const q = $('#conv-search').value.trim();
  S.convQuery = q;
  S.convHitIdx = 0;
  clearHighlight($('#conv'));
  const counter = $('#conv-search-count');
  if (!q) { counter.textContent = ''; S.convHits = []; return; }

  const local = highlightDOM($('#conv'), q, { only: CONV_SEARCH_SCOPE });
  counter.textContent = '…';
  try {
    const qs = new URLSearchParams({ q });
    if (S.agent) qs.set('agent', S.agent);
    const res = await api(`/api/sessions/${encodeURIComponent(S.detailId)}/search?` + qs.toString());
    S.convHits = res.items || [];
    counter.textContent = S.convHits.length ? `${S.convHits.length} 轮` : local ? `${local} 处` : '无';
    if (S.convHits.length) {
      await jumpToTurn(S.convHits[0].turn);
      revealMatches(q, document.getElementById('t-' + S.convHits[0].turn));
    } else {
      revealMatches(q);
    }
  } catch {
    counter.textContent = local ? `${local} 处` : '无';
  }
}

async function jumpNextHit() {
  if (!S.convHits.length) return;
  S.convHitIdx = (S.convHitIdx + 1) % S.convHits.length;
  const turn = S.convHits[S.convHitIdx].turn;
  await jumpToTurn(turn);
  revealMatches(S.convQuery, document.getElementById('t-' + turn));
  $('#conv-search-count').textContent = `${S.convHitIdx + 1}/${S.convHits.length} 轮`;
}

function resumeCmd() {
  const d = S.detail;
  if (!d) return '';
  return `cd ${d.cwd || d.project} && claude --resume ${d.id}`;
}

async function copyResume() {
  const cmd = resumeCmd();
  if (!cmd) return;
  try {
    await navigator.clipboard.writeText(cmd);
    toast('已复制: ' + cmd);
  } catch {
    toast('复制失败，命令: ' + cmd, true);
  }
}

function exportMd() {
  if (!S.detailId) return;
  const qs = S.agent ? '?agent=' + encodeURIComponent(S.agent) : '';
  window.location.href = `/api/sessions/${encodeURIComponent(S.detailId)}/export${qs}`;
}

async function deleteOne() {
  const d = S.detail;
  if (!d) return;
  if (S.isNew) { toast('这条会话还没写入磁盘，发一条消息之后才能删除'); return; }
  const warn = d.running
    ? '\n注意：该会话的进程还在运行，删除后 CLI 会继续往已移走的副本里写，直到退出。'
    : '';
  const ok = await confirmDialog('删除会话', `「${truncate(d.title || d.id, 60)}」将被移入回收站，可随时恢复。${warn}`, '移入回收站');
  if (!ok) return;
  try {
    const res = await api('/api/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [S.detailId] }),
    });
    const errs = Object.values(res.errors || {});
    if (errs.length) { toast(errs[0], true); return; }
    toast('已移入回收站');
    closeDetail();
    await Promise.all([loadStats(), loadProjects()]);
  } catch (err) {
    toast('删除失败: ' + err.message, true);
  }
}

/* ------------------------------------------------------------ mark dialog */
function openNoteDialog(id) {
  const item = (S.detail && S.detail.id === id) ? S.detail : S.items.find((i) => i.id === id);
  const m = S.marks[id] || {};
  const dlg = $('#fav-dialog');

  $('#fav-title').textContent = '备注';
  $('#fav-sub').textContent = truncate(item?.title || id, 64);
  $('#fav-note').value = m.note || (item && item.note) || '';
  $('#fav-ok').textContent = '保存';
  $('#fav-unstar').hidden = true;

  dlg.returnValue = 'cancel';
  dlg.showModal();
  $('#fav-note').focus();
  $('#fav-note').select();

  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'ok') return;
    const note = $('#fav-note').value.trim();
    try {
      await api('/api/marks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: [{ id, note }] }),
      });
      applyMark(id, { note });
      toast(note ? '备注已保存' : '备注已清空');
    } catch (err) {
      toast('保存失败: ' + err.message, true);
    }
  }, { once: true });
}

/* ----------------------------------------------------------------- trash */
async function openTrash() {
  setView('trash');
  try {
    const res = await api('/api/trash');
    S.trashItems = res.items || [];
    const alive = new Set(S.trashItems.map((t) => t.id));
    for (const id of Array.from(S.trashSelected)) {
      if (!alive.has(id)) S.trashSelected.delete(id);
    }
    renderTrash();
  } catch (err) {
    toast('读取回收站失败: ' + err.message, true);
  }
}

function renderTrash() {
  const total = S.trashItems.reduce((a, t) => a + (t.size || 0), 0);
  $('#trash-summary').innerHTML = `<b>${S.trashItems.length}</b> 个已删除会话 · ${fmtBytes(total)} · 可恢复或彻底删除`;

  const box = $('#trash-list');
  if (!S.trashItems.length) {
    box.innerHTML = '<div class="empty"><h3>回收站是空的</h3><div>被删除的会话会先放在这里，随时可以恢复</div></div>';
    updateTrashBar();
    return;
  }

  box.innerHTML = S.trashItems.map((t) => {
    const sel = S.trashSelected.has(t.id);
    return `<div class="row trash-row${sel ? ' selected' : ''}" data-trash-id="${esc(t.id)}">
    <div class="chk-cell">
      <input type="checkbox" data-trash-check="${esc(t.id)}" ${sel ? 'checked' : ''} aria-label="选择会话">
    </div>
    <div class="row-main">
      <div class="row-title"><span class="t">${esc(t.title || t.id)}</span></div>
      <div class="row-path">${esc(t.cwd || t.project || '')}</div>
      <div class="trash-note">删除于 ${esc(abs(t.deletedAt))} · ${fmtBytes(t.size)} · <span class="mono">${esc(t.id)}</span></div>
    </div>
    <div class="row-meta trash-actions">
      <button class="btn" data-restore="${esc(t.id)}">恢复</button>
      <button class="btn danger" data-purge="${esc(t.id)}">彻底删除</button>
    </div>
  </div>`;
  }).join('');
  updateTrashBar();
}

function updateTrashBar() {
  const n = S.trashSelected.size;
  const total = S.trashItems.length;
  $('#trash-all-wrap').hidden = total === 0;
  const all = $('#trash-all');
  all.checked = total > 0 && n === total;
  all.indeterminate = n > 0 && n < total;

  $('#trash-restore').hidden = n === 0;
  $('#trash-purge').hidden = n === 0;
  $('#trash-restore').textContent = `恢复所选 (${n})`;
  $('#trash-purge').textContent = `彻底删除 (${n})`;
  $('#trash-empty').disabled = total === 0;
  $('#trash-empty').textContent = total ? `清空回收站 (${total})` : '清空回收站';
}

function onTrashCheck(e) {
  const box = e.target.closest('input[data-trash-check]');
  if (!box) return;
  const id = box.dataset.trashCheck;
  if (box.checked) S.trashSelected.add(id);
  else S.trashSelected.delete(id);
  const row = box.closest('.row');
  if (row) row.classList.toggle('selected', box.checked);
  updateTrashBar();
}

async function restoreIDs(ids) {
  try {
    const res = await api('/api/trash/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
    });
    const errs = Object.values(res.errors || {});
    if (errs.length) toast(`${errs.length} 个恢复失败：${errs[0]}`, true);
    else toast(`已恢复 ${ids.length} 个会话`);
    ids.forEach((id) => S.trashSelected.delete(id));
    await Promise.all([loadStats(), loadProjects(), openTrash()]);
  } catch (err) {
    toast('恢复失败: ' + err.message, true);
  }
}

async function purgeIDs(ids, confirmTitle, confirmBody, okLabel) {
  const ok = await confirmDialog(confirmTitle, confirmBody, okLabel);
  if (!ok) return;
  try {
    const res = await api('/api/trash/purge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
    });
    const errs = Object.values(res.errors || {});
    if (errs.length) toast(`${errs.length} 个删除失败：${errs[0]}`, true);
    else toast(`已彻底删除 ${ids.length} 个会话`);
    ids.forEach((id) => S.trashSelected.delete(id));
    await openTrash();
  } catch (err) {
    toast('删除失败: ' + err.message, true);
  }
}

async function onTrashClick(e) {
  const restoreBtn = e.target.closest('[data-restore]');
  const purgeBtn = e.target.closest('[data-purge]');
  if (restoreBtn) {
    restoreBtn.disabled = true;
    await restoreIDs([restoreBtn.dataset.restore]);
    return;
  }
  if (purgeBtn) {
    const id = purgeBtn.dataset.purge;
    const item = S.trashItems.find((t) => t.id === id);
    await purgeIDs([id], '彻底删除',
      `「${truncate(item?.title || id, 48)}」将被永久删除，无法恢复。`, '永久删除');
  }
}

// Sessions created elsewhere (another terminal, a hook, another machine) land
// on disk; poll the count and offer a one-click refresh rather than re-rendering
// the list under the user's cursor.
async function pollForChanges() {
  try {
    const st = await api('/api/stats');
    if (S.globalCount === null) { S.globalCount = st.sessions; return; }
    if (st.sessions === S.globalCount) return;
    const diff = st.sessions - S.globalCount;
    const chip = $('#update-chip');
    chip.hidden = false;
    chip.textContent = diff > 0 ? diff + ' 个新会话 · 刷新' : '列表有变化 · 刷新';
  } catch {
    /* 服务重启中，忽略 */
  }
}

// Clicking the title always lands on the session list: it leaves the detail or
// trash view, and resets filters when already on the list.
function goHome() {
  const view = document.body.dataset.view;
  if (view === 'detail') {
    closeDetail();
  } else if (view === 'trash') {
    setView('list');
    loadSessions();
  } else if (S.q || S.project || S.starOnly) {
    S.q = '';
    S.project = '';
    S.starOnly = false;
    $('#search').value = '';
    $('#clear-search').hidden = true;
    renderProjects();
    loadSessions();
  }
  $('#main').scrollTo({ top: 0, behavior: 'smooth' });
}

/* ------------------------------------------------------------------- ui */
function setView(name) {
  hideHoverCard();
  document.body.dataset.view = name;
  if (name !== 'detail') $('#jump-nav').hidden = true;
  $('#list-view').hidden = name !== 'list';
  $('#detail-view').hidden = name !== 'detail';
  $('#trash-view').hidden = name !== 'trash';
  $('#trash-btn').disabled = name === 'trash';
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme;
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('cs-theme', next);
}

function onKeydown(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

  if (e.key === '/' && !typing) {
    e.preventDefault();
    const search = document.body.dataset.view === 'detail' ? $('#conv-search') : $('#search');
    search.focus();
    search.select();
    return;
  }
  if (e.key === 'Escape') {
    if (!$('#hovercard').hidden) { hideHoverCard(); return; }
    if (typing) { if (e.target.id !== 'c-input') e.target.blur(); return; }
    if (document.body.dataset.view === 'detail') { closeDetail(); return; }
    if (document.body.dataset.view === 'trash') { setView('list'); loadSessions(); return; }
    if (S.q) { $('#search').value = ''; onSearchInput(); }
  }
}

init();

function routeFromHash() {
  const m = location.hash.match(/^#\/session\/([^?/]+)(?:\?(.*))?$/);
  if (!m) {
    if (document.body.dataset.view === 'detail') closeDetail();
    return;
  }
  const id = decodeURIComponent(m[1]);
  if (id === S.detailId && !S.isNew) return;
  const params = new URLSearchParams(m[2] || '');
  openDetail(id, params.get('agent') || null, Number(params.get('turn')) || 0);
}

// 前进/后退、手动改地址时跟着走
window.addEventListener('hashchange', routeFromHash);
routeFromHash();

/* ------------------------------------------------------------------ 聊天 */

// 点击弹窗外的空白区域 = 取消
function enableBackdropClose(dlg) {
  if (!dlg) return;
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (outside) dlg.close('cancel');
  });
}

// --------------------------------------------------------------- 斜杠命令
const SLASH = { all: [], items: [], idx: 0, open: false };

async function loadSlashCommands() {
  if (SLASH.all.length) return SLASH.all;
  try {
    const r = await api('/api/chat/commands');
    SLASH.all = r.commands || [];
  } catch {
    SLASH.all = [];
  }
  return SLASH.all;
}

function updateSlashMenu() {
  const ta = $('#c-input');
  const menu = $('#slash-menu');
  if (!ta || !menu) return;
  const text = ta.value;
  // 只在第一行、且以 / 开头、还没输入空格时提示
  const m = /^\/([a-zA-Z0-9:_-]*)$/.exec(text);
  if (!m) {
    hideSlashMenu();
    return;
  }
  const q = m[1].toLowerCase();
  loadSlashCommands().then((all) => {
    const items = all
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const ai = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bi = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return ai - bi || a.name.localeCompare(b.name);
      })
      .slice(0, 8);
    if (!items.length) { hideSlashMenu(); return; }
    SLASH.items = items;
    SLASH.idx = 0;
    SLASH.open = true;
    renderSlashMenu();
  });
}

function renderSlashMenu() {
  const menu = $('#slash-menu');
  menu.hidden = false;
  menu.innerHTML = SLASH.items.map((c, i) => `
    <button class="slash-item${i === SLASH.idx ? ' on' : ''}" data-slash="${esc(c.name)}">
      <span class="si-name">/${esc(c.name)}</span>
      <span class="si-desc">${esc(truncate(c.description || '', 70))}</span>
    </button>`).join('');
  // 让选中项可见
  const on = menu.querySelector('.slash-item.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

function hideSlashMenu() {
  SLASH.open = false;
  SLASH.items = [];
  const menu = $('#slash-menu');
  if (menu) {
    menu.hidden = true;
    menu.innerHTML = '';
  }
}

// 输入框高度跟随内容；内容没超上限时不要出滚动条
const COMPOSER_MAX = 200;
function resizeComposer() {
  const ta = $('#c-input');
  if (!ta) return;
  ta.style.height = 'auto';
  const h = ta.scrollHeight;
  ta.style.height = Math.min(h, COMPOSER_MAX) + 'px';
  ta.style.overflowY = h > COMPOSER_MAX ? 'auto' : 'hidden';
}

// 把命令名填进输入框（补一个空格，光标停在空格后）
function fillCommand(name) {
  const ta = $('#c-input');
  ta.value = '/' + name + ' ';
  ta.selectionStart = ta.selectionEnd = ta.value.length;
  hideSlashMenu();
  paintComposerHighlight();
  ta.focus();
  resizeComposer();
}

function applySlash(name) {
  // 去掉 <任务> 这类占位符，只留命令本身
  fillCommand(name.replace(/\s*<[^>]*>/g, '').trim());
}

// 输入框里的 /命令 高亮：textarea 文字透明，底下放一层同样排版的镜像
function paintComposerHighlight() {
  const ta = $('#c-input');
  const back = $('#c-highlight');
  if (!ta || !back) return;
  const raw = ta.value;
  const html = raw
    .split('\n')
    .map((line) => {
      const m = /^(\/[A-Za-z0-9:_-]+)(.*)$/.exec(line);
      if (m) return `<span class="hl-cmd">${esc(m[1])}</span>${esc(m[2])}`;
      return esc(line);
    })
    .join('\n');
  back.innerHTML = html + (raw.endsWith('\n') ? ' ' : '');
  back.scrollTop = ta.scrollTop;
  back.scrollLeft = ta.scrollLeft;
}

// ---------------------------------------------------------------- 附件
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

async function addAttachments(list) {
  const files = [...(list || [])];
  if (!files.length) return;
  let total = ATTACH.reduce((a, x) => a + x.size, 0);
  for (const f of files) {
    if (total + f.size > ATTACH_MAX_TOTAL) {
      toast('附件总大小超过 ' + fmtSize(ATTACH_MAX_TOTAL), true);
      break;
    }
    if (f.size === 0) continue;
    try {
      const data = await fileToBase64(f);
      ATTACH.push({ name: f.name || ('粘贴的图片-' + (ATTACH.length + 1)), type: f.type || '', size: f.size, data });
      total += f.size;
    } catch {
      toast('读取附件失败: ' + (f.name || ''), true);
    }
  }
  renderAttachments();
}

function renderAttachments() {
  const box = $('#attach-strip');
  if (!box) return;
  if (!ATTACH.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = ATTACH.map((a, i) => {
    const isImg = (a.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.name);
    const ext = (a.name.split('.').pop() || 'file').slice(0, 4);
    const thumb = isImg
      ? `<img src="data:${esc(a.type || 'image/png')};base64,${a.data}" alt="">`
      : `<span class="ac-icon">${esc(ext)}</span>`;
    return `<span class="attach-chip" title="${esc(a.name)}">
      ${thumb}
      <span class="ac-name">${esc(truncate(a.name, 24))}</span>
      <span class="ac-size">${esc(fmtSize(a.size))}</span>
      <button class="ac-del" type="button" data-attach-del="${i}" title="移除">✕</button>
    </span>`;
  }).join('');
}

function clearAttachments() {
  ATTACH.length = 0;
  renderAttachments();
}

function initComposer() {
  const modelSel = $('#c-model');
  const effortSel = $('#c-effort');
  const modeSel = $('#c-mode');

  effortSel.innerHTML = EFFORT_LEVELS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  applyDefaultsToComposer();

  $('#c-send').addEventListener('click', sendChat);
  $('#c-stop').addEventListener('click', stopChat);

  // 附件：按钮选文件、直接粘贴、拖进来，三种都行
  const picker = $('#c-file');
  $('#c-attach').addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    addAttachments(picker.files);
    picker.value = '';
  });
  $('#attach-strip').addEventListener('click', (e) => {
    const del = e.target.closest('[data-attach-del]');
    if (!del) return;
    ATTACH.splice(Number(del.dataset.attachDel), 1);
    renderAttachments();
  });

  const ta = $('#c-input');
  ta.addEventListener('keydown', (e) => {
    if (SLASH.open && SLASH.items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); SLASH.idx = (SLASH.idx + 1) % SLASH.items.length; renderSlashMenu(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); SLASH.idx = (SLASH.idx - 1 + SLASH.items.length) % SLASH.items.length; renderSlashMenu(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideSlashMenu(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        applySlash(SLASH.items[SLASH.idx].name);
        return;
      }
    }
    // 菜单已关闭时按 Tab：如果输入的就是一个命令名，帮它补上空格
    if (e.key === 'Tab') {
      const m = /^\/([A-Za-z0-9:_-]+)$/.exec(ta.value);
      if (m) {
        e.preventDefault();
        fillCommand(m[1]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChat();
    }
  });

  $('#slash-menu').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-slash]');
    if (btn) applySlash(btn.dataset.slash);
  });
  ta.addEventListener('scroll', () => {
    const back = $('#c-highlight');
    if (!back) return;
    back.scrollTop = ta.scrollTop;
    back.scrollLeft = ta.scrollLeft;
  });
  ta.addEventListener('paste', (e) => {
    const cb = e.clipboardData;
    if (!cb) return;
    let files = [...(cb.files || [])];
    if (!files.length) {
      // 某些平台（比如从截图工具直接粘）只在 items 里给文件
      files = [...(cb.items || [])]
        .filter((it) => it.kind === 'file')
        .map((it) => it.getAsFile())
        .filter(Boolean);
    }
    if (files.length) {
      e.preventDefault();
      addAttachments(files);
    }
  });
  const composer = $('#composer');
  composer.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    composer.classList.add('drag-over');
  });
  composer.addEventListener('dragleave', () => composer.classList.remove('drag-over'));
  composer.addEventListener('drop', (e) => {
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (!files.length) return;
    e.preventDefault();
    composer.classList.remove('drag-over');
    addAttachments(files);
  });

  ta.addEventListener('input', () => {
    resizeComposer();
    updateSlashMenu();
    paintComposerHighlight();
  });
  ta.addEventListener('blur', () => setTimeout(hideSlashMenu, 150));
}

let modelsLoaded = false;
async function loadChatModels() {
  if (modelsLoaded) return;
  try {
    const r = await api('/api/chat/models');
    fillModelOptions(r.models || []);
    modelsLoaded = true;
  } catch {}
}

function fillModelOptions(models) {
  const sel = $('#c-model');
  const list = [...new Set([...models].filter(Boolean))];
  if (DEFAULTS.model && !list.includes(DEFAULTS.model)) list.unshift(DEFAULTS.model);
  sel.innerHTML = ['<option value="">跟随 CLI 默认</option>']
    .concat(list.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`))
    .join('');
  applyDefaultsToComposer();
}

// 把服务端默认值套到输入区的三个下拉上
function applyDefaultsToComposer() {
  const m = $('#c-model');
  const e = $('#c-effort');
  const p = $('#c-mode');
  if (!m || !e || !p) return;
  if (DEFAULTS.model) {
    if (![...m.options].some((o) => o.value === DEFAULTS.model)) {
      m.insertAdjacentHTML('beforeend', `<option value="${esc(DEFAULTS.model)}">${esc(DEFAULTS.model)}</option>`);
    }
    m.value = DEFAULTS.model;
  } else {
    m.value = '';
  }
  e.value = DEFAULTS.effort || '';

  // root 下 Claude Code 不允许 bypassPermissions（进程会直接退出），
  // 所以把这一项禁用，默认值也换成「自动接受编辑」
  const bypass = [...p.options].find((o) => o.value === 'bypassPermissions');
  if (bypass) {
    bypass.disabled = DEFAULTS.root;
    bypass.textContent = DEFAULTS.root ? '跳过全部权限（root 下不可用）' : '跳过全部权限';
  }
  let want = DEFAULTS.permissionMode || 'ask';
  if (DEFAULTS.root && want === 'bypassPermissions') {
    want = 'acceptEdits';
    if (!DEFAULTS.rootWarned) {
      DEFAULTS.rootWarned = true;
      setTimeout(() => toast('以 root 运行，Claude Code 不允许「跳过全部权限」，已改用「自动接受编辑」'), 300);
    }
  }
  p.value = want;
}

async function loadSettings() {
  try {
    const r = await api('/api/settings');
    DEFAULTS.model = r.model || '';
    DEFAULTS.effort = r.effort || '';
    DEFAULTS.permissionMode = r.permissionMode || '';
    DEFAULTS.cli = r.cli || {};
    DEFAULTS.cliRaw = r.cliRaw || {};
    DEFAULTS.overrides = r.overrides || {};
    DEFAULTS.root = !!r.root;
    applyDefaultsToComposer();
  } catch {}
}

// ------------------------------------------------------------ 设置
function initSettings() {
  const dlg = $('#settings-dialog');

  $('#open-settings').addEventListener('click', async () => {
    await loadSettings();
    $('#set-effort').innerHTML = EFFORT_LEVELS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');

    const models = await api('/api/chat/models').catch(() => ({ models: [] }));
    const list = [...new Set([...(models.models || []), DEFAULTS.model, DEFAULTS.cli.model].filter(Boolean))];
    $('#set-model').innerHTML = ['<option value="">跟随 CLI</option>']
      .concat(list.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`)).join('');

    $('#set-model').value = DEFAULTS.overrides.model || '';
    $('#set-effort').value = DEFAULTS.overrides.effort || '';
    $('#set-mode').value = DEFAULTS.overrides.permissionMode || '';

    const rawM = DEFAULTS.cliRaw.model;
    const shownM = DEFAULTS.cli.model;
    $('#set-model-src').textContent = shownM
      ? (rawM && rawM !== shownM ? `（CLI: ${rawM} → ${shownM}）` : `（CLI: ${shownM}）`)
      : '';
    const rawE = DEFAULTS.cliRaw.effort;
    const shownE = DEFAULTS.cli.effort;
    $('#set-effort-src').textContent = shownE
      ? (rawE ? `（CLI: ${rawE}）` : `（CLI: ${shownE}）`)
      : '';
    $('#set-mode-src').textContent = DEFAULTS.cli.permissionMode ? `（CLI: ${DEFAULTS.cli.permissionMode}）` : '';

    dlg.returnValue = '';
    dlg.showModal();
  });

  $('#set-cancel').addEventListener('click', () => dlg.close('cancel'));
  $('#set-reset').addEventListener('click', () => {
    $('#set-model').value = '';
    $('#set-effort').value = '';
    $('#set-mode').value = '';
  });
  $('#set-save').addEventListener('click', async () => {
    try {
      await api('/api/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: $('#set-model').value,
          effort: $('#set-effort').value,
          permissionMode: $('#set-mode').value,
        }),
      });
      dlg.close('saved');
      await loadSettings();
      toast('设置已保存');
    } catch (err) {
      toast('保存失败: ' + err.message, true);
    }
  });
}

// 程序化改输入框内容后必须手动同步镜像层和高度（不会触发 input 事件）
function setComposerValue(v) {
  const ta = $('#c-input');
  if (!ta) return;
  ta.value = v;
  ta.selectionStart = ta.selectionEnd = ta.value.length;
  paintComposerHighlight();
  resizeComposer();
  updateSlashMenu();
}

async function sendChat() {
  const ta = $('#c-input');
  const text = ta.value.trim();
  if ((!text && !ATTACH.length) || !S.detailId) return;
  syncStatusFromComposer();

  const d = S.detail || {};
  // /btw 就是用来在后台那一轮还没跑完时插一句话，所以不拦
  if (!/^\/btw\b/.test(text) && (CHAT.live || !$('#c-stop').hidden)) {
    toast('上一轮还没跑完，等它结束或点停止', true);
    return;
  }

  // /branch、/fork 是「把当前对话复制出一条新会话」，网页版直接切过去，
  // 下一条消息用 --fork-session 写进新会话（CLI 里这两个命令本来就是同一件事）
  const bm = /^\/(?:branch|fork)(?:\s+(.*))?$/.exec(text);
  if (bm && S.detailId && !S.isNew) {
    setComposerValue('');
    startBranch(S.detailId, (bm[1] || '').trim());
    return;
  }

  const sentAttach = ATTACH.map((a) => ({ ...a }));
  setComposerValue('');

  const body = {
    sessionId: S.detailId,
    text,
    attachments: ATTACH.map((a) => ({ name: a.name, mediaType: a.type, size: a.size, data: a.data })),
    cwd: d.cwd || d.project || '',
    newSession: !!S.isNew,
    forkFrom: S.forkFrom || '',
    model: $('#c-model').value,
    effort: $('#c-effort').value,
    permissionMode: $('#c-mode').value,
  };

  const isForkedCmd = /^\/(?:subtask|btw)\b/.test(text);
  try {
    const res = await api('/api/chat/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.action === 'clear') {
      // /clear：开一条新会话
      startNewSession(res.cwd || S.detail.cwd || '');
      toast('已开新会话');
      return;
    }
    if (!res.ok) throw new Error(res.error || '发送失败');
    clearAttachments();
    S.isNew = false;
    if (!isForkedCmd) startLiveBubble(text, sentAttach);
  } catch (err) {
    toast('发送失败: ' + err.message, true);
    setComposerValue(text);
  }
}

async function stopChat() {
  if (!S.detailId) return;
  try {
    await api('/api/chat/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: S.detailId }),
    });
    toast('已停止');
  } catch (err) {
    toast('停止失败: ' + err.message, true);
  }
}

// 输入区上方的状态条：模型 / 强度 / 权限 / 本轮用量
function modeLabel(v) {
  return { auto: '自动（auto）', ask: '每次询问权限', default: '默认权限', acceptEdits: '自动接受编辑', plan: '只读（规划）', bypassPermissions: '跳过全部权限' }[v] || v || '自动（auto）';
}
function effortLabel(v) {
  const hit = EFFORT_LEVELS.find(([k]) => k === v);
  return hit ? hit[1] : (v || '默认');
}

// 输入区上方的状态：目录 · 分支 · 上下文 · 会话时长，以及模型/强度/权限
function shortPath(p) {
  if (!p) return '';
  const home = (S.stats && S.stats.home) || '';
  let out = p;
  if (home && p === home) out = '~';
  else if (home && p.startsWith(home + '/')) out = '~' + p.slice(home.length);
  const segs = out.split('/');
  if (segs.length > 4) out = '…/' + segs.slice(-3).join('/');
  return out;
}

// 会话时长：刚刚 / 12 分钟 / 1 小时 41 分 / 3 天 4 小时
function humanSpan(ms) {
  if (!ms || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚开始';
  if (min < 60) return `${min} 分钟`;
  const hours = Math.floor(min / 60);
  const restMin = min % 60;
  if (hours < 24) return restMin ? `${hours} 小时 ${restMin} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHour = hours % 24;
  if (days < 30) return restHour ? `${days} 天 ${restHour} 小时` : `${days} 天`;
  const months = Math.floor(days / 30);
  return `${months} 个月`;
}

function sessionAge() {
  const d = S.detail;
  if (!d) return '';
  const start = d.createdAt ? new Date(d.createdAt).getTime() : 0;
  if (!start) return '';
  const end = d.running ? Date.now() : (d.updatedAt ? new Date(d.updatedAt).getTime() : Date.now());
  return humanSpan(Math.max(0, end - start));
}

function renderChatStatus() {
  const el = $('#chat-status');
  if (!el) return;
  const d = S.detail || {};
  const info = [];

  const path = shortPath(d.cwd || d.project || '');
  if (path) info.push(`<span class="cs-path" title="${esc(d.cwd || '')}">${esc(path)}</span>`);
  if (d.branch) info.push(`<span class="cs-branch" title="git 分支">${esc(d.branch)}</span>`);

  const limit = d.contextLimit || 0;
  const used = (CHAT.turn && CHAT.turn.in) || d.contextTokens || 0;
  if (limit && used) {
    const pct = Math.min(100, Math.round((used / limit) * 100));
    const cls = pct >= 90 ? ' high' : pct >= 70 ? ' warn' : '';
    info.push(`<span class="cs-ctx${cls}" title="上下文占用 ${fmtNum(used)} / ${fmtNum(limit)} tokens">上下文 ${pct}%</span>`);
  }

  const age = sessionAge();
  if (age) info.push(`<span class="cs-age" title="会话开始于 ${esc(abs(d.createdAt))}">${esc(age)}</span>`);

  // 这个会话正在跑（我们的进程或终端里的都算）
  if (d.running) {
    info.push('<span class="cs-running" title="这个会话有进程正在运行">运行中</span>');
  }

  // 模型/强度/权限就在下面的下拉里，这里不再重复；只补本轮用量
  if (CHAT.turn && CHAT.turn.out) {
    info.push(`<span class="cs-turn">本轮 <b>${fmtNum(CHAT.turn.in)}</b> in / <b>${fmtNum(CHAT.turn.out)}</b> out</span>`);
  }
  if (CHAT.turn && CHAT.turn.sec) info.push(`${CHAT.turn.sec.toFixed(1)}s`);
  if (CHAT.turn && CHAT.turn.cost) info.push(`$${CHAT.turn.cost.toFixed(4)}`);

  const row = info.join('<span class="cs-sep">·</span>');
  el.innerHTML = row ? `<div class="cs-row">${row}</div>` : '';
  el.hidden = !row;
}

let ageTimer = null;
function startAgeTimer() {
  stopAgeTimer();
  ageTimer = setInterval(() => {
    if (document.body.dataset.view === 'detail') renderChatStatus();
  }, 30000);
}
function stopAgeTimer() {
  if (ageTimer) {
    clearInterval(ageTimer);
    ageTimer = null;
  }
}

// 正在回答时，标签页标题转起来（切到别的标签也能看到）
const TAB_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let tabTimer = null;
let tabFrame = 0;
let tabBase = '';

function startTabActivity() {
  if (tabTimer) return;
  tabBase = document.title.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]\s*/, '');
  tabTimer = setInterval(() => {
    tabFrame = (tabFrame + 1) % TAB_FRAMES.length;
    document.title = TAB_FRAMES[tabFrame] + ' ' + tabBase;
  }, 260);
}

function stopTabActivity() {
  if (!tabTimer) return;
  clearInterval(tabTimer);
  tabTimer = null;
  document.title = tabBase || 'Claude Code 会话';
}

// 起一个「正在回答」的临时块，接在最后一轮后面
function syncStatusFromComposer() {
  CHAT.effort = $('#c-effort').value;
  CHAT.mode = $('#c-mode').value;
  if (!$('#c-model').value) {
    CHAT.model = DEFAULTS.model || '';
  } else {
    CHAT.model = $('#c-model').value;
  }
  CHAT.turn = null;
  renderChatStatus();
}

function startLiveBubble(userText, attachments = []) {
  const box = $('#conv');
  const wrap = document.createElement('article');
  wrap.className = 'turn live-turn';
  // 附件立刻显示出来，别等这一轮跑完、会话落盘后才冒出来
  const shots = attachments.filter((a) => (a.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.name));
  const files = attachments.filter((a) => !shots.includes(a));
  const shotHTML = shots.length
    ? `<div class="turn-images">${shots.map((a, i) => `<span class="turn-img live-img">
        <span class="turn-img-no">#${i + 1}</span>
        <img src="data:${esc(a.type || 'image/png')};base64,${a.data}" alt="${esc(a.name)}">
      </span>`).join('')}</div>`
    : '';
  const fileHTML = files.length
    ? `<div class="live-files">${files.map((a) => `<span class="attach-chip">${esc(truncate(a.name, 24))} · ${esc(fmtSize(a.size))}</span>`).join('')}</div>`
    : '';
  wrap.innerHTML = `
    <div class="prompt-box"><span class="lbl">用户</span>${esc(userText)}${userText ? '' : '<span class="dim">（仅附件）</span>'}</div>
    ${shotHTML}${fileHTML}
    <div class="live-body"></div>`;
  box.appendChild(wrap);
  CHAT.live = { el: wrap, body: wrap.querySelector('.live-body'), textEl: null, thinkEl: null, tools: new Map() };
  $('#c-stop').hidden = false;
  scrollToBottomSoon();
}

function liveAppend(html) {
  if (!CHAT.live) return;
  CHAT.live.body.insertAdjacentHTML('beforeend', html);
  scrollToBottomSoon();
}

function scrollToBottomSoon() {
  const m = $('#main');
  if (m.scrollHeight - m.clientHeight - m.scrollTop < 200) {
    requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
  }
}

function ensureTextEl() {
  if (!CHAT.live.textEl) {
    CHAT.live.body.insertAdjacentHTML('beforeend', '<div class="live-text"></div>');
    const els = CHAT.live.body.querySelectorAll('.live-text');
    CHAT.live.textEl = els[els.length - 1];
  }
  return CHAT.live.textEl;
}

function ensureThinkEl() {
  if (!CHAT.live.thinkEl) {
    const el = document.createElement('details');
    el.className = 'think live-think';
    el.innerHTML = '<summary>思考过程</summary><div class="live-think-body"></div>';
    CHAT.live.body.appendChild(el);
    CHAT.live.thinkEl = el.querySelector('.live-think-body');
  }
  return CHAT.live.thinkEl;
}

// 处理 CLI 的一条 stream-json 事件
// 把以前跑过的子任务和旁注读回来，刷新页面后底部标签里还在
async function loadPastSubtasks(id) {
  try {
    const r = await api(`/api/chat/subtasks/${encodeURIComponent(id)}`);
    if (CHAT.id !== id) return;
    for (const t of (r.tasks || [])) {
      if (t.kind === 'btw') {
        if (BTW.some((b) => b.id === t.id)) continue;
        BTW.push({ id: t.id, q: t.task || '', a: t.text || '', at: t.endedAt || t.startedAt || 0 });
        continue;
      }
      if (FORKS.some((f) => f.id === t.id)) continue;
      FORKS.push({
        id: t.id, task: t.task || '', status: 'done',
        startedAt: t.startedAt || 0, text: t.text || '',
      });
    }
    // 历史旁注按时间倒序排，最新的在前
    BTW.sort((a, b) => (b.at || 0) - (a.at || 0));
    if (FORKS.length || BTW.length) renderPanelTabs();
  } catch {}
}

function handleChatLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }

  if (ev.type === 'ui_subtask') {
    if (!FORKS.some((f) => f.id === ev.id)) {
      FORKS.push({ id: ev.id, task: ev.task || '', status: 'running', startedAt: Date.now() });
    }
    renderPanelTabs();
    liveAppend(`<div class="live-note">↳ 子任务已在后台启动：${esc(truncate(ev.task || '', 40))}</div>`);
    return;
  }
  if (ev.type === 'ui_btw') {
    BTW.unshift({ id: ev.id, q: ev.task || '', a: null, at: Date.now() });
    if (BTW.length > 20) BTW.length = 20;
    renderPanelTabs();
    // 旁注本来就该在旁边看，起了就直接翻到那一页
    openPanel(`btw:${ev.id}`);
    return;
  }
  if (ev.type === 'ui_btw_done') {
    const b = BTW.find((x) => x.id === ev.id) || BTW.find((x) => x.a === null);
    if (b) b.a = ev.text || '（没有回答）';
    renderPanelTabs();
    if (PANEL.open && PANEL.open.startsWith('btw:')) renderPanelBody();
    return;
  }
  if (ev.type === 'ui_subtask_done') {
    const f = FORKS.find((x) => x.id === ev.id);
    if (f) { f.status = 'done'; f.text = ev.text || ''; }
    renderPanelTabs();
    liveAppend(`<div class="live-note">↳ 子任务结束（退出码 ${esc(String(ev.code))}），底部可以点开看</div>`);
    return;
  }
  if (ev.type === 'ui_permission') {
    showPermission(ev);
    return;
  }
  if (ev.type === 'ui_started') {
    $('#c-stop').hidden = false;
    startTabActivity();
    return;
  }
  if (ev.type === 'ui_stderr') {
    liveAppend(`<div class="live-err">${esc(ev.text || '')}</div>`);
    return;
  }
  if (ev.type === 'ui_exit') {
    $('#c-stop').hidden = true;
    stopTabActivity();
    if (CHAT.live && CHAT.live.thinkEl) {
      CHAT.live.thinkEl.closest('details').open = false;
    }
    CHAT.live = null;
    return;
  }

  if (ev.type === 'system' && ev.subtype === 'init') {
    if (ev.model) CHAT.model = ev.model;
    if (ev.permissionMode) CHAT.mode = ev.permissionMode;
    renderChatStatus();
    return;
  }

  if (ev.type === 'stream_event') {
    const e = ev.event || {};
    if (e.type === 'content_block_start') {
      const cb = e.content_block || {};
      if (cb.type === 'thinking') ensureThinkEl();
      else if (cb.type === 'tool_use') startToolBlock(cb);
      else ensureTextEl();
    } else if (e.type === 'content_block_delta') {
      const d = e.delta || {};
      if (d.type === 'text_delta') {
        ensureTextEl().textContent += d.text || '';
        scrollToBottomSoon();
      } else if (d.type === 'thinking_delta') {
        ensureThinkEl().textContent += d.thinking || '';
      } else if (d.type === 'input_json_delta') {
        appendToolInput(d.partial_json || '');
      }
    } else if (e.type === 'content_block_stop') {
      CHAT.live && (CHAT.live.textEl = null, CHAT.live.thinkEl = null);
    }
    return;
  }

  if (ev.type === 'result') {
    const u = ev.usage || {};
    CHAT.turn = {
      in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      out: u.output_tokens || 0,
      sec: (ev.duration_ms || 0) / 1000,
      cost: ev.total_cost_usd || 0,
    };
    renderChatStatus();
    // 一轮结束：会话文件已更新，让详情页落到最新
    if (ev.is_error) liveAppend(`<div class="live-err">${esc(ev.result || '出错了')}</div>`);
    const id = S.detailId;
    setTimeout(async () => {
      loadHUD(id);
      if (!id || S.detailId !== id) return;
      // 新会话/新分支这时候才有第一轮，refreshTail 对空列表是空转的，
      // 得等索引扫到再整页载入一次
      if (!S.turns.length) { await loadFirstTurn(id); return; }
      try { await refreshTail(); } catch {}
    }, 900);
  }
}

let toolSeq = 0;
function startToolBlock(cb) {
  const id = cb.id || 'tool' + (++toolSeq);
  const el = document.createElement('details');
  el.className = 'tool live-tool';
  el.innerHTML = `<summary><span class="tool-name">${esc(cb.name || '工具')}</span> <span class="tool-status">运行中…</span></summary>
    <div class="tool-input"></div>`;
  CHAT.live && CHAT.live.body.appendChild(el);
  CHAT.live && CHAT.live.tools.set(id, { el, input: el.querySelector('.tool-input'), raw: '' });
  scrollToBottomSoon();
}

function appendToolInput(chunk) {
  if (!CHAT.live || !CHAT.live.tools.size) return;
  const last = [...CHAT.live.tools.values()].pop();
  last.raw += chunk;
  last.input.textContent = last.raw.slice(0, 4000);
}

// ------------------------------------------------------------ 权限确认

function showPermission(ev) {
  const dlg = $('#perm-dialog');
  CHAT.pending = ev;
  $('#perm-sub').textContent = `会话请求执行：${ev.toolName || '未知工具'}`;
  let body = ev.input;
  try {
    if (typeof body === 'string') body = JSON.parse(body);
    $('#perm-body').textContent = JSON.stringify(body, null, 2).slice(0, 4000);
  } catch {
    $('#perm-body').textContent = String(ev.input || '').slice(0, 4000);
  }
  dlg.returnValue = '';
  if (!dlg.open) dlg.showModal();
}

async function answerPermission(allow) {
  const ev = CHAT.pending;
  const dlg = $('#perm-dialog');
  if (dlg.open) dlg.close();
  CHAT.pending = null;
  if (!ev || !S.detailId) return;
  try {
    await api('/api/chat/answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: S.detailId, requestId: ev.requestId, allow }),
    });
  } catch (err) {
    toast('提交失败: ' + err.message, true);
  }
}

// 新建会话：目录选择器（点进点出，不用手输）
const PICK = { path: '', parent: '', cwd: '' };

function openNewDialog(cwd) {
  const dlg = $('#new-dialog');
  PICK.cwd = cwd || '';
  dlg.returnValue = '';
  renderQuickPicks();
  dlg.showModal();
  browseDir(cwd || '');
}

function renderQuickPicks() {
  const seen = new Set();
  const picks = [];
  for (const p of S.projects) {
    if (!p.path || seen.has(p.path)) continue;
    seen.add(p.path);
    picks.push(p);
  }
  const box = $('#pick-quick');
  if (!picks.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `<div class="pick-quick-head">常用位置</div>
    <div class="pick-quick-list">${picks.slice(0, 10).map((p) =>
      `<button class="pick-item" data-pick="${esc(p.path)}" title="${esc(p.path)}">
         <span class="pick-icon"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M3 7.2c0-.9.7-1.6 1.6-1.6h4l1.8 2.1h7.9c.9 0 1.6.7 1.6 1.6v7.5c0 .9-.7 1.6-1.6 1.6H4.6c-.9 0-1.6-.7-1.6-1.6V7.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></span>
         <span class="pick-abs">${esc(p.path)}</span>
         <span class="pick-n">${p.count}</span>
       </button>`).join('')}</div>`;
}

async function browseDir(path) {
  const list = $('#pick-list');
  const pathEl = $('#pick-path');
  list.innerHTML = '<div class="pick-empty">读取中…</div>';
  try {
    const r = await api('/api/fs/dirs?path=' + encodeURIComponent(path || ''));
    PICK.path = r.path;
    PICK.parent = r.parent;

    if (!r.path) {
      // 没选具体路径：展示该系统的根（Windows 盘符 / WSL 的 / 和 /mnt/*）
      pathEl.textContent = '选择位置';
      pathEl.title = '';
      $('#pick-up').disabled = true;
      PICK.path = '';
      list.innerHTML = (r.roots || []).map((d) =>
        `<button class="pick-item root" data-enter="${esc(d.path)}"><span class="pick-icon">${/^[A-Za-z]:[\\/]?$/.test(d.name) ? '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="17" cy="12" r="1.1" fill="currentColor"/><path d="M6.6 9.6h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' : '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M3 7.2c0-.9.7-1.6 1.6-1.6h4l1.8 2.1h7.9c.9 0 1.6.7 1.6 1.6v7.5c0 .9-.7 1.6-1.6 1.6H4.6c-.9 0-1.6-.7-1.6-1.6V7.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'}</span>${esc(d.name)}</button>`
      ).join('') || '<div class="pick-empty">没有可用的根目录</div>';
      return;
    }

    pathEl.textContent = r.path;
    pathEl.title = r.path;
    $('#pick-up').disabled = !r.parent && !(r.roots || []).length;
    if (!r.dirs || !r.dirs.length) {
      list.innerHTML = '<div class="pick-empty">（没有子目录）</div>';
    } else {
      list.innerHTML = r.dirs.map((d) =>
        `<button class="pick-item" data-enter="${esc(d.path)}"><span class="pick-icon"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M3 7.2c0-.9.7-1.6 1.6-1.6h4l1.8 2.1h7.9c.9 0 1.6.7 1.6 1.6v7.5c0 .9-.7 1.6-1.6 1.6H4.6c-.9 0-1.6-.7-1.6-1.6V7.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></span>${esc(d.name)}</button>`
      ).join('');
    }
  } catch (err) {
    list.innerHTML = `<div class="pick-empty">${esc(err.message)}</div>`;
    pathEl.textContent = path || '';
  }
}

function initNewSession() {
  const dlg = $('#new-dialog');
  $('#new-session-top').addEventListener('click', () => openNewDialog(''));

  $('#projects').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-new-in]');
    if (!btn) return;
    e.stopPropagation();
    startNewSession(btn.dataset.newIn);
  });

  $('#new-cancel').addEventListener('click', () => dlg.close('cancel'));
  $('#new-ok').addEventListener('click', () => dlg.close('ok'));

  $('#pick-up').addEventListener('click', () => {
    if (!PICK.path) return;
    browseDir(PICK.parent || ''); // 到顶时 Windows 回到盘符列表，Linux 停在 /
  });
  $('#pick-quick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (b) browseDir(b.dataset.pick);
  });
  $('#pick-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-enter]');
    if (b) browseDir(b.dataset.enter);
  });

  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    const cwd = PICK.path;
    if (!cwd) { toast('请选择目录', true); return; }
    localStorage.setItem('lastCwd', cwd);
    startNewSession(cwd);
  });
}

function startNewSession(cwd) {
  const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2));
  stopChatStream();
  stopLiveWatch();
  S.detailId = id;
  S.agent = null;
  S.isNew = true;
  S.turns = [];
  S.totalTurns = 0;
  S.detail = { id, title: '(新会话)', cwd, project: cwd, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), userMsgs: 0, asstMsgs: 0 };
  // 新会话不该继承上一条会话的子任务/子代理/shell/旁注
  FORKS.length = 0;
  BTW.length = 0;
  closePanel();
  renderPanelTabs();
  setView('detail');
  $('#d-title').textContent = '(新会话)';
  $('#d-sub').textContent = cwd;
  $('#d-meta').innerHTML = '<span><span class="k">新会话</span> <b>发出第一条消息后才会写入磁盘</b></span>';
  $('#d-branch').hidden = true;
  $('#conv').innerHTML = '<div class="empty"><h3>新会话</h3><div>在下面输入第一句话，就会在 ' + esc(cwd) + ' 里创建</div></div>';
  $('#outline-list').innerHTML = '';
  history.replaceState(null, '', '#/session/' + encodeURIComponent(id));
  startChatStream(id);
  loadChatModels();
  $('#c-input').focus();
}

// 从当前会话分出一条新分支：界面先切到"新分支"，
// 发出第一条消息时才真正 fork（--resume 父会话 --fork-session --session-id 新会话）
function startBranch(parentID, name = '') {
  const d = S.detail || {};
  const cwd = d.cwd || d.project || '';
  const from = parentID || S.detailId;
  startNewSession(cwd);
  S.forkFrom = from;
  S.isNew = true;
  $('#d-title').textContent = name || '(新分支)';
  $('#d-meta').innerHTML = `<span><span class="k">新分支</span> 从 <b>${esc(truncate(d.title || from, 28))}</b> 分出来，发出第一条消息后写入磁盘</span>`;
  $('#conv').innerHTML = `<div class="empty"><h3>新分支${name ? '：' + esc(name) : ''}</h3>
    <div>它会带着上面那条会话的上下文继续，原会话不受影响</div></div>`;
  toast('已切到新分支，下一条消息会发在这里');
}

function initPermissionDialog() {
  $('#perm-allow').addEventListener('click', () => answerPermission(true));
  $('#perm-deny').addEventListener('click', () => answerPermission(false));
  $('#perm-dialog').addEventListener('close', () => {
    if (CHAT.pending) answerPermission(false);
  });
}

// ------------------------------------------------------------ SSE 连接

function startChatStream(id) {
  stopChatStream();
  CHAT.id = id;
  CHAT.model = '';
  CHAT.turn = null;
  FORKS.length = 0;
  loadPastSubtasks(id);
  CHAT.effort = '';
  syncStatusFromComposer();
  const es = new EventSource(`/api/chat/stream/${encodeURIComponent(id)}`);
  CHAT.es = es;
  es.addEventListener('state', (e) => {
    try {
      const st = JSON.parse(e.data);
      $('#c-stop').hidden = !st.running;
      if (st.running) startTabActivity(); else stopTabActivity();
    } catch {}
  });
  es.onmessage = (e) => handleChatLine(e.data);
  es.onerror = () => { /* EventSource 自己会重连 */ };
}

function stopChatStream() {
  stopTabActivity();
  if (CHAT.es) {
    CHAT.es.close();
    CHAT.es = null;
  }
  CHAT.id = null;
  CHAT.live = null;
  $('#c-stop').hidden = true;
}
