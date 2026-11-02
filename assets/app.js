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

function confirmDialog(title, body, okLabel = '确定') {
  const dlg = $('#confirm-dialog');
  $('#cf-title').textContent = title;
  $('#cf-body').textContent = body;
  $('#cf-ok').textContent = okLabel;
  return new Promise((resolve) => {
    const onClose = () => { dlg.removeEventListener('close', onClose); resolve(dlg.returnValue === 'ok'); };
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
function highlightDOM(root, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle || !root) return 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const v = node.nodeValue;
      if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (p && /^(SCRIPT|STYLE|MARK|SUMMARY)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
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
  totalTurns: 0,
  convQuery: '',
  convHits: [],
  convHitIdx: 0,

  trashItems: [],
  trashSelected: new Set(),
};

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
      $('#stale-bar').hidden = false;
    }
  } catch {
    /* 服务重启中，忽略 */
  }
}

function init() {
  const savedTheme = localStorage.getItem('cs-theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;

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
  $('#conv').addEventListener('click', onGapClick);
  $('#jump-top').addEventListener('click', () => $('#main').scrollTo({ top: 0, behavior: 'smooth' }));
  $('#jump-bottom').addEventListener('click', () => {
    const m = $('#main');
    m.scrollTo({ top: m.scrollHeight, behavior: 'smooth' });
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
    rows.push(`<button class="proj" data-project="${esc(p.path)}" title="${esc(p.path)}" aria-current="${!S.starOnly && S.project === p.path}">
      <span class="proj-name">${esc(projLabel(p.path))}</span>
      <span class="proj-n">${p.count}</span>
    </button>`);
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
      <button class="btn ghost" type="button" data-hc-star2="${esc(item.id)}">${starred ? '取消收藏' : '收藏'}</button>
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
  const star2 = e.target.closest('[data-hc-star2]');
  if (star2) {
    hideHoverCard();
    toggleStar(star2.dataset.hcStar2);
    return;
  }
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
    box.innerHTML = S.items.map(rowHTML).join('');
  }
  updateBulkBar();
}

function rowHTML(it) {
  const selected = S.selected.has(it.id);
  const live = it.running ? '<span class="badge live">运行中</span>' : '';
  const snippet = it.snippet
    ? `<div class="row-snippet">${hlText(it.snippet, S.q)}</div>`
    : (it.firstPrompt && !S.q ? `<div class="row-snippet">${esc(truncate(it.firstPrompt, 180))}</div>` : '');
  const branch = it.branch ? `<span class="badge">${esc(it.branch)}</span>` : '';
  const subs = (it.subagents && it.subagents.length)
    ? `<span class="badge" title="子代理会话">↳${it.subagents.length}</span>` : '';
  const starred = !!(it.starred || (S.marks[it.id] && S.marks[it.id].starred));
  const star = `<button class="star-btn${starred ? ' on' : ''}" data-star="${esc(it.id)}" title="${starred ? '已收藏 · 点击编辑备注' : '收藏（可填备注）'}" aria-pressed="${starred}">${starred ? STAR_FILLED : STAR_OUTLINE}</button>`;
  // 收藏的备注跟在标题后面：标题【备注】
  const note = (starred && it.note) ? `<span class="row-note-inline" title="${esc(it.note)}">【${esc(truncate(it.note, 80))}】</span>` : '';

  // 一行统计：创建 · 活跃 · 条数 · token · 体积 · 工具 · 上下文
  const bits = [];
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
        ${live}${branch}${subs}
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
    if (turn) await jumpToTurn(turn, false);
  } catch (err) {
    $('#conv').innerHTML = `<div class="empty"><h3>无法打开会话</h3><div>${esc(err.message)}</div></div>`;
  }
}

function closeDetail() {
  if (document.body.dataset.view !== 'detail') return;
  S.detailId = null;
  S.detail = null;
  history.replaceState(null, '', location.pathname + location.search);
  setView('list');
  loadSessions();
}

function renderDetail() {
  const d = S.detail;
  if (!d) return;

  const title = d.subagent ? `${d.title} · 子代理 ${d.agentType || ''}` : d.title;
  $('#d-title').textContent = title || '(无标题会话)';
  $('#d-sub').textContent = (d.cwd || d.project || '') + (d.branch ? '  ·  ' + d.branch : '');

  const bits = [
    ['会话 ID', d.subagent ? `${d.id} / ${d.agentType}` : d.id],
    ['模型', d.model || '—'],
    ['创建', abs(d.createdAt) || '—'],
    ['最后活动', abs(d.updatedAt) || '—'],
    ['轮次', String(S.totalTurns)],
    ['消息', `${d.userMsgs} 用户 / ${d.asstMsgs} 助手`],
    ['工具调用', String(d.toolCalls)],
    ['Token', `入 ${fmtNum(d.in)} · 出 ${fmtNum(d.out)} · 缓存 ${fmtNum(d.cacheRead)}`],
    ['上下文', d.contextTokens && d.contextLimit
      ? `${Math.round((d.contextTokens / d.contextLimit) * 100)}%（${fmtNum(d.contextTokens)} / ${fmtNum(d.contextLimit)}）`
      : '—'],
    ['文件', fmtBytes(d.size)],
    ['版本', d.version || '—'],
  ];
  // subagent transcripts are switchable from the meta bar
  let subs = '';
  if (!d.subagent && d.subagents && d.subagents.length) {
    subs = d.subagents.map((a) => `<button class="btn ghost subagent-btn" data-agent="${esc(a.id)}" title="${esc(a.description || '')}">↳ ${esc(a.agentType)} · ${a.msgs} 条</button>`).join('');
  }
  const noteChip = d.note ? `<span class="detail-note">✎ ${esc(d.note)}</span>` : '';
  $('#d-meta').innerHTML = bits.map(([k, v]) => `<span><span class="k">${esc(k)}</span> <b>${esc(v)}</b></span>`).join('') +
    (noteChip ? `<span class="detail-mark">${noteChip}</span>` : '') + subs;

  const starBtn = $('#d-star');
  if (starBtn) {
    const starred = !!(d.starred || (S.marks[d.id] && S.marks[d.id].starred));
    starBtn.innerHTML = starred ? STAR_FILLED : STAR_OUTLINE;
    starBtn.classList.toggle('on', starred);
    starBtn.title = starred ? '已收藏 · 编辑备注' : '收藏（可填备注）';
  }

  renderTurns();
  renderOutline();
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

  if (S.convQuery) highlightDOM(box, S.convQuery);
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
function turnHTML(t) {
  const promptBlock = t.command
    ? `<div class="prompt-box cmd"><span class="lbl">命令参数</span>${esc(t.prompt || '（无参数）')}</div>`
    : (t.prompt ? `<div class="prompt-box"><span class="lbl">用户</span>${esc(t.prompt)}</div>` : '');
  const notes = (t.notes || []).map((n) => {
    const label = n.includes('Base directory for this skill:') ? '技能内容' : '系统上下文';
    return `<details class="think note"><summary>${label} · ${Array.from(n).length} 字</summary><div>${esc(n)}</div></details>`;
  }).join('');
  const empty = t.command ? '（该命令没有产生回复）' : '（本轮没有助手回复，可能被中断）';

  // 把整轮的内容块拍平：工具调用（assistant）和它的结果（user）分属两条消息，
  // 拍平后才能合并成一行摘要。
  const flat = [];
  for (const m of t.messages || []) {
    for (const b of m.blocks || []) flat.push(b);
  }
  const body = renderBlocks(flat);

  return `<article class="turn" id="t-${t.index}" data-turn="${t.index}">
    ${promptBlock}
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
      return `<div class="imgblk">[图片 ${esc(b.detail || '')}]</div>`;
    default:
      return '';
  }
}

function onConvClick(e) {
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
  const outline = $('#outline');
  const visible = outline && getComputedStyle(outline).display !== 'none' && outline.getBoundingClientRect().width > 0;
  document.body.classList.remove('jump-inside');
  if (!visible) {
    nav.style.right = '16px';
    return;
  }
  const r = outline.getBoundingClientRect();
  const room = window.innerWidth - r.right; // 大纲右边到窗口边缘的空间
  const need = nav.offsetWidth + 12;
  if (room >= need + 12) {
    // 空间够：放到大纲右侧，留 12px
    nav.style.right = Math.round(room - 12 - nav.offsetWidth) + 'px';
  } else {
    // 空间不够（窄窗口）：贴着窗口右边，同时给大纲留出右侧内边距，避免压字
    nav.style.right = '12px';
    document.body.classList.add('jump-inside');
  }
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
  const items = S.turns.map((t) => `<button class="outline-item" data-jump="${t.index}" title="${esc(truncate(turnLabel(t), 120))}">
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
  main.scrollTo({ top: main.scrollTop + offset - 128, behavior: smooth ? 'smooth' : 'auto' });
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

async function onConvSearch() {
  const q = $('#conv-search').value.trim();
  S.convQuery = q;
  S.convHitIdx = 0;
  clearHighlight($('#conv'));
  const counter = $('#conv-search-count');
  if (!q) { counter.textContent = ''; S.convHits = []; return; }

  const local = highlightDOM($('#conv'), q);
  counter.textContent = '…';
  try {
    const qs = new URLSearchParams({ q });
    if (S.agent) qs.set('agent', S.agent);
    const res = await api(`/api/sessions/${encodeURIComponent(S.detailId)}/search?` + qs.toString());
    S.convHits = res.items || [];
    counter.textContent = S.convHits.length ? `${S.convHits.length} 轮` : local ? `${local} 处` : '无';
    if (S.convHits.length) await jumpToTurn(S.convHits[0].turn);
  } catch {
    counter.textContent = local ? `${local} 处` : '无';
  }
}

async function jumpNextHit() {
  if (!S.convHits.length) return;
  S.convHitIdx = (S.convHitIdx + 1) % S.convHits.length;
  await jumpToTurn(S.convHits[S.convHitIdx].turn);
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
  const ok = await confirmDialog('删除会话', `「${truncate(d.title || d.id, 60)}」将被移入回收站，可随时恢复。`, '移入回收站');
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
    if (typing) { e.target.blur(); return; }
    if (document.body.dataset.view === 'detail') { closeDetail(); return; }
    if (document.body.dataset.view === 'trash') { setView('list'); loadSessions(); return; }
    if (S.q) { $('#search').value = ''; onSearchInput(); }
  }
}

init();

// Deep link: #/session/<id>?agent=<agentId>&turn=<n>
(() => {
  const m = location.hash.match(/^#\/session\/([^?/]+)(?:\?(.*))?$/);
  if (!m) return;
  const params = new URLSearchParams(m[2] || '');
  openDetail(decodeURIComponent(m[1]), params.get('agent') || null, Number(params.get('turn')) || 0);
})();
