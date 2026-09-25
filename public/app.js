'use strict';

// ---------------- 状态 ----------------
let state = { cues: [], schedule: [], conflicts: [], graphErrors: [] };
let editingId = null;
let fragment = null; // 当前片段预览结果
let fragmentStale = false; // 原提示单发生增删改后，旧预览失效

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ---------------- 工具 ----------------
function fmtNum(s) {
  if (s === null || s === undefined) return '—';
  return Number(s).toFixed(3).replace(/\.?0+$/, '');
}
function scheduleById() {
  const m = new Map();
  for (const s of state.schedule) m.set(s.id, s);
  return m;
}
function cueName(id) {
  const c = state.cues.find((x) => x.id === id);
  return c ? c.name : `（已删除 ${id}）`;
}

// ---------------- API ----------------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* 非 JSON */ }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `请求失败（${res.status}）`;
    const errors = (data && data.error && data.error.errors) || [msg];
    const e = new Error(msg);
    e.errors = errors;
    throw e;
  }
  return data;
}

async function reload(notice) {
  const data = await api('GET', '/api/cues');
  state = data;
  markFragmentStale();
  render();
  if (notice) showBanner(notice, 'ok');
}

// ---------------- 顶部提示条 ----------------
let bannerTimer = null;
function showBanner(message, kind = 'info', sticky = false) {
  const b = $('#banner');
  b.className = `banner ${kind}`;
  b.innerHTML = '';
  b.append(el('span', null, message));
  b.classList.remove('hidden');
  clearTimeout(bannerTimer);
  if (!sticky) {
    bannerTimer = setTimeout(() => {
      b.classList.add('hidden');
      bannerTimer = null;
    }, 4000);
  }
}
function hideBanner() {
  $('#banner').classList.add('hidden');
}

// ---------------- 渲染：错误 / 冲突 ----------------
function renderErrors() {
  // 图错误（缺失引用、循环依赖）以粘性信息条显示
  const persistent = state.graphErrors || [];
  if (persistent.length) {
    const b = $('#banner');
    b.className = 'banner err';
    b.innerHTML = '';
    b.append(el('strong', null, '存在无法排期的问题：'));
    const ul = el('ul');
    ul.style.margin = '6px 0 0';
    ul.style.paddingLeft = '18px';
    for (const e of persistent) ul.append(el('li', null, e.message));
    b.append(ul);
    b.classList.remove('hidden');
  } else if (!bannerTimer) {
    hideBanner();
  }
}

function renderConflicts(conflictIds) {
  const panel = $('#conflictPanel');
  const list = $('#conflictList');
  list.innerHTML = '';
  if (!state.conflicts.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  for (const cf of state.conflicts) {
    const [a, b] = cf.cueIds;
    const li = el('li');
    li.append(el('span', 'tag', cf.channel));
    li.append(document.createTextNode(
      `「${cueName(a)}」与「${cueName(b)}」在 ${fmtNum(cf.start)}s – ${fmtNum(cf.end)}s 重叠（左闭右开）`
    ));
    list.append(li);
    conflictIds.add(a);
    conflictIds.add(b);
  }
}

// ---------------- 渲染：时间轴 ----------------
function niceStep(span) {
  const target = span / 10; // 期望约 10 格
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const n = target / pow;
  let mult;
  if (n < 1.5) mult = 1;
  else if (n < 3) mult = 2;
  else if (n < 7) mult = 5;
  else mult = 10;
  return mult * pow;
}

function renderTimeline(conflictIds, schedMap) {
  const root = $('#timeline');
  root.innerHTML = '';

  const good = state.cues
    .map((c) => ({ c, t: schedMap.get(c.id) }))
    .filter((x) => x.t && x.t.start !== null);

  if (!good.length) {
    root.append(el('div', 'tl-empty', '暂无可绘制的提示（新增一条，或先解决引用/循环问题）'));
    return;
  }

  const maxEnd = Math.max(...good.map((x) => x.t.end));
  const span = Math.max(maxEnd * 1.05, 1);
  const pct = (sec) => `${(sec / span) * 100}%`;
  const step = niceStep(span);

  // 按通道分组
  const channels = new Map();
  for (const c of state.cues) {
    if (!channels.has(c.channel)) channels.set(c.channel, []);
    channels.get(c.channel).push(c);
  }

  for (const [channel, cues] of [...channels].sort((a, b) => a[0].localeCompare(b[0]))) {
    const wrapEl = el('div', 'tl-channel');
    wrapEl.append(el('div', 'tl-channel-name', `🔌 ${channel}`));

    const track = el('div', 'tl-track');

    // 网格
    for (let g = 0; g <= span; g += step) {
      const line = el('div', 'tl-grid');
      line.style.left = pct(g);
      const lab = el('div', 'tl-grid-label', fmtNum(g));
      lab.style.left = '2px';
      line.append(lab);
      track.append(line);
    }

    // 冲突红色覆盖层（先放，块在其上）
    for (const cf of state.conflicts) {
      if (cf.channel !== channel) continue;
      const ov = el('div', 'tl-overlap');
      ov.style.left = pct(cf.start);
      ov.style.width = `${((cf.end - cf.start) / span) * 100}%`;
      ov.title = `冲突 ${fmtNum(cf.start)}s – ${fmtNum(cf.end)}s`;
      track.append(ov);
    }

    // 提示块
    for (const c of cues) {
      const t = schedMap.get(c.id);
      if (!t || t.start === null) continue;
      const b = el('div', 'tl-block' + (conflictIds.has(c.id) ? ' has-conflict' : ''));
      b.style.left = pct(t.start);
      b.style.width = pct(Math.max(t.end - t.start, 0.0001));
      b.textContent = c.name;
      b.title = `${c.name}\n${fmtNum(t.start)}s → ${fmtNum(t.end)}s（持续 ${fmtNum(c.duration)}s）`;
      b.addEventListener('click', () => startEdit(c.id));
      track.append(b);
    }

    wrapEl.append(track);

    // 该通道下时间未定的提示（引用缺失 / 在环上）
    const unresolved = cues.filter((c) => {
      const t = schedMap.get(c.id);
      return !t || t.start === null;
    });
    if (unresolved.length) {
      const urow = el('div', 'tl-unresolved');
      for (const c of unresolved) {
        const pill = el('button', 'unk-pill', `⏳ ${c.name}（时间未定）`);
        pill.type = 'button';
        pill.addEventListener('click', () => startEdit(c.id));
        urow.append(pill);
      }
      wrapEl.append(urow);
    }

    root.append(wrapEl);
  }

  // 统一时间标尺
  const scale = el('div', 'tl-scale');
  for (let g = 0; g <= span; g += step) {
    const lab = el('div', 'tl-grid-label', fmtNum(g));
    lab.style.left = pct(g);
    lab.style.transform = 'none';
    scale.append(lab);
  }
  root.append(scale);
}

// ---------------- 渲染：表格 ----------------
function startDesc(c) {
  if (c.startType === 'fixed') {
    return `固定第 ${fmtNum(c.fixedAt)}s`;
  }
  return `「${cueName(c.afterCueId)}」结束 +${fmtNum(c.delayAfter)}s`;
}

function renderTable(conflictIds) {
  const tbody = $('#cueTbody');
  tbody.innerHTML = '';
  const schedMap = scheduleById();

  state.cues.forEach((c, i) => {
    const t = schedMap.get(c.id);
    const tr = el('tr');
    if (conflictIds.has(c.id)) tr.classList.add('row-conflict');
    if (!t || t.start === null) tr.classList.add('row-error');

    tr.append(el('td', 'num', String(i + 1)));
    tr.append(el('td', 'name-cell', c.name));
    tr.append(el('td', null, c.channel));
    tr.append(el('td', 'num', fmtNum(c.duration)));
    tr.append(el('td', null, startDesc(c)));

    const startTd = el('td', 'num');
    const endTd = el('td', 'num');
    const statusTd = el('td');
    if (!t || t.start === null) {
      startTd.textContent = '—';
      endTd.textContent = '—';
      statusTd.append(el('span', 'pill unknown', '时间未定'));
    } else {
      startTd.textContent = fmtNum(t.start);
      endTd.textContent = fmtNum(t.end);
      if (conflictIds.has(c.id)) {
        statusTd.append(el('span', 'pill bad', '通道冲突'));
      } else {
        statusTd.append(el('span', 'pill ok', '正常'));
      }
    }

    const actTd = el('td');
    const actWrap = el('div', 'actions');
    const editBtn = el('button', 'btn small', '编辑');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => startEdit(c.id));
    const delBtn = el('button', 'btn small danger', '删除');
    delBtn.type = 'button';
    delBtn.addEventListener('click', () => removeCue(c));
    actWrap.append(editBtn, delBtn);
    actTd.append(actWrap);

    tr.append(startTd, endTd, statusTd, actTd);
    tbody.append(tr);
  });
}

// ---------------- 渲染总入口 ----------------
function render() {
  const schedMap = scheduleById();
  const conflictIds = new Set();
  renderConflicts(conflictIds);
  renderErrors();
  renderTimeline(conflictIds, schedMap);
  renderTable(conflictIds);
  renderAfterOptions();
  updateFormMode();
}

// ---------------- 表单 ----------------
function renderAfterOptions() {
  const sel = $('#f-afterCueId');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const c of state.cues) {
    if (c.id === editingId) continue; // 不能以自己为前置
    const opt = el('option', null, `${c.name}（${c.channel}）`);
    opt.value = c.id;
    sel.append(opt);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function getStartType() {
  return document.querySelector('input[name="startType"]:checked').value;
}

function syncStartBoxes() {
  const isAfter = getStartType() === 'after';
  $('#fixedBox').hidden = isAfter;
  $('#afterBox').hidden = !isAfter;
  $('#f-fixedAt').disabled = isAfter;
  $('#f-afterCueId').disabled = !isAfter;
  $('#f-delayAfter').disabled = !isAfter;
}

function updateFormMode() {
  $('#formTitle').textContent = editingId ? '✏️ 编辑提示' : '➕ 新增提示';
  $('#submitBtn').textContent = editingId ? '保存修改并重算' : '保存新增';
  $('#cancelEdit').hidden = !editingId;
}

function resetForm() {
  $('#cueForm').reset();
  editingId = null;
  $('#f-id').value = '';
  document.querySelector('input[name="startType"][value="fixed"]').checked = true;
  $('#f-fixedAt').value = '0';
  $('#f-delayAfter').value = '0';
  syncStartBoxes();
  renderAfterOptions();
  updateFormMode();
}

function startEdit(id) {
  const c = state.cues.find((x) => x.id === id);
  if (!c) return;
  editingId = id;
  $('#f-id').value = id;
  $('#f-name').value = c.name;
  $('#f-channel').value = c.channel;
  $('#f-duration').value = c.duration;
  document.querySelector(`input[name="startType"][value="${c.startType}"]`).checked = true;
  renderAfterOptions();
  if (c.startType === 'fixed') {
    $('#f-fixedAt').value = c.fixedAt;
  } else {
    $('#f-afterCueId').value = c.afterCueId;
    $('#f-delayAfter').value = c.delayAfter;
  }
  syncStartBoxes();
  updateFormMode();
  document.querySelector('.cue-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitForm(e) {
  e.preventDefault();
  const isAfter = getStartType() === 'after';
  const body = {
    name: $('#f-name').value,
    channel: $('#f-channel').value,
    duration: $('#f-duration').value,
    startType: getStartType(),
    fixedAt: isAfter ? 0 : $('#f-fixedAt').value,
    afterCueId: isAfter ? $('#f-afterCueId').value : null,
    delayAfter: isAfter ? $('#f-delayAfter').value : 0,
  };

  const btn = $('#submitBtn');
  btn.disabled = true;
  try {
    if (editingId) {
      await api('PUT', `/api/cues/${encodeURIComponent(editingId)}`, body);
    } else {
      await api('POST', '/api/cues', body);
    }
    const wasEditing = editingId;
    resetForm();
    await reload(wasEditing ? '已保存，后继提示已全部重算' : '已新增，时间轴已重算');
  } catch (err) {
    showBanner(err.errors.join('\n') || err.message, 'err');
    // 让多条错误换行
    const b = $('#banner');
    b.innerHTML = '';
    b.append(el('strong', null, '保存被拒绝：'));
    const ul = el('ul');
    ul.style.margin = '6px 0 0';
    ul.style.paddingLeft = '18px';
    for (const m of err.errors) ul.append(el('li', null, m));
    b.append(ul);
  } finally {
    btn.disabled = false;
  }
}

async function removeCue(c) {
  if (!confirm(`确定删除「${c.name}」？\n删除后所有后继提示会立即重算。`)) return;
  try {
    await api('DELETE', `/api/cues/${encodeURIComponent(c.id)}`);
    if (editingId === c.id) resetForm();
    await reload('已删除并重算');
  } catch (err) {
    showBanner(err.message, 'err');
  }
}

// ---------------- 片段排练单 ----------------
function showFragError(messages) {
  const box = $('#fragError');
  box.className = 'banner err';
  box.innerHTML = '';
  box.append(el('strong', null, '无法生成片段：'));
  const ul = el('ul');
  ul.style.margin = '6px 0 0';
  ul.style.paddingLeft = '18px';
  for (const m of [].concat(messages)) ul.append(el('li', null, m));
  box.append(ul);
  box.classList.remove('hidden');
}
function hideFragError() {
  $('#fragError').classList.add('hidden');
}

function markFragmentStale() {
  if (!fragment) return;
  fragmentStale = true;
  $('#frDownloadBtn').disabled = true;
  const meta = $('#fragMeta');
  if (meta) {
    meta.classList.add('stale');
    meta.textContent = '原提示单已变更，当前预览已失效，请重新生成预览。';
  }
}

function renderFragmentTimeline() {
  const root = $('#fragTimeline');
  root.innerHTML = '';

  const schedMap = new Map(fragment.schedule.map((s) => [s.id, s]));
  const conflictIds = new Set();
  for (const cf of fragment.conflicts) cf.cueIds.forEach((id) => conflictIds.add(id));

  const span = Math.max(fragment.duration * 1.05, 1);
  const pct = (sec) => `${(sec / span) * 100}%`;
  const step = niceStep(span);

  const channels = new Map();
  for (const c of fragment.cues) {
    if (!channels.has(c.channel)) channels.set(c.channel, []);
    channels.get(c.channel).push(c);
  }

  for (const [channel, cues] of [...channels].sort((a, b) => a[0].localeCompare(b[0]))) {
    const wrapEl = el('div', 'tl-channel');
    wrapEl.append(el('div', 'tl-channel-name', `🔌 ${channel}`));
    const track = el('div', 'tl-track');

    for (let g = 0; g <= span; g += step) {
      const line = el('div', 'tl-grid');
      line.style.left = pct(g);
      const lab = el('div', 'tl-grid-label', fmtNum(g));
      lab.style.left = '2px';
      line.append(lab);
      track.append(line);
    }
    for (const cf of fragment.conflicts) {
      if (cf.channel !== channel) continue;
      const ov = el('div', 'tl-overlap');
      ov.style.left = pct(cf.start);
      ov.style.width = `${((cf.end - cf.start) / span) * 100}%`;
      ov.title = `冲突 ${fmtNum(cf.start)}s – ${fmtNum(cf.end)}s`;
      track.append(ov);
    }
    for (const c of cues) {
      const t = schedMap.get(c.id);
      if (!t || t.start === null) continue;
      const b = el('div', 'tl-block' + (conflictIds.has(c.id) ? ' has-conflict' : ''));
      b.style.left = pct(t.start);
      b.style.width = pct(Math.max(t.end - t.start, 0.0001));
      b.textContent = c.name;
      b.title = `${c.name}\n${fmtNum(t.start)}s → ${fmtNum(t.end)}s（持续 ${fmtNum(c.duration)}s）`;
      track.append(b);
    }
    wrapEl.append(track);
    root.append(wrapEl);
  }

  const scale = el('div', 'tl-scale');
  for (let g = 0; g <= span; g += step) {
    const lab = el('div', 'tl-grid-label', fmtNum(g));
    lab.style.left = pct(g);
    lab.style.transform = 'none';
    scale.append(lab);
  }
  root.append(scale);
}

function fragStartDesc(c) {
  if (c.startType === 'fixed') return `固定第 ${fmtNum(c.fixedAt)}s`;
  const dep = fragment.cues.find((x) => x.id === c.afterCueId);
  const depName = dep ? dep.name : `（未入选 ${c.afterCueId}）`;
  return `「${depName}」结束 +${fmtNum(c.delayAfter)}s`;
}

function renderFragmentTable() {
  const tbody = $('#fragTbody');
  tbody.innerHTML = '';
  const schedMap = new Map(fragment.schedule.map((s) => [s.id, s]));
  const selMap = new Map(fragment.selections.map((s) => [s.cueId, s]));
  const conflictIds = new Set();
  for (const cf of fragment.conflicts) cf.cueIds.forEach((id) => conflictIds.add(id));
  const changeMap = new Map(fragment.changes.map((ch) => [ch.cueId, ch]));

  fragment.cues.forEach((c, i) => {
    const t = schedMap.get(c.id);
    const sel = selMap.get(c.id);
    const ch = changeMap.get(c.id);
    const tr = el('tr');
    if (conflictIds.has(c.id)) tr.classList.add('row-conflict');

    tr.append(el('td', 'num', String(i + 1)));
    tr.append(el('td', 'name-cell', c.name));
    tr.append(el('td', null, c.channel));
    tr.append(el('td', 'num', fmtNum(c.duration)));
    tr.append(el('td', null, fragStartDesc(c)));
    tr.append(el('td', 'num', fmtNum(t.start)));
    tr.append(el('td', 'num', fmtNum(t.end)));
    tr.append(el('td', 'num', `${fmtNum(sel.origStart)} – ${fmtNum(sel.origEnd)}`));

    const noteTd = el('td');
    if (ch) {
      const text = ch.reason === 'crosses_left'
        ? '跨左边界，已改为固定开始'
        : '前置未入选片段，已改为固定开始';
      noteTd.append(el('span', 'pill unknown', text));
    } else if (c.startType === 'after') {
      noteTd.append(el('span', 'rel-muted', '保留相对前置'));
    } else {
      noteTd.append(el('span', 'rel-muted', '固定开始'));
    }
    tr.append(noteTd);
    tbody.append(tr);
  });
}

function renderFragmentConflicts() {
  const panel = $('#fragConflictPanel');
  const list = $('#fragConflictList');
  list.innerHTML = '';
  if (!fragment.conflicts.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const nameOf = (id) => {
    const c = fragment.cues.find((x) => x.id === id);
    return c ? c.name : id;
  };
  for (const cf of fragment.conflicts) {
    const [a, b] = cf.cueIds;
    const li = el('li');
    li.append(el('span', 'tag', cf.channel));
    li.append(document.createTextNode(
      `「${nameOf(a)}」与「${nameOf(b)}」在 ${fmtNum(cf.start)}s – ${fmtNum(cf.end)}s 重叠（左闭右开）`
    ));
    list.append(li);
  }
}

function renderFragment() {
  const box = $('#fragResult');
  if (!fragment) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const { start, end } = fragment.window;
  const fixedCount = fragment.changes.length;
  const meta = $('#fragMeta');
  meta.className = 'frag-meta' + (fragmentStale ? ' stale' : ' ok');
  meta.textContent =
    `原窗口 [${fmtNum(start)}, ${fmtNum(end)})（长 ${fmtNum(fragment.duration)}s）` +
    `｜入选 ${fragment.selectedCount} / ${fragment.totalCount} 条` +
    `｜${fixedCount} 条改为固定开始` +
    `｜冲突 ${fragment.conflicts.length} 处` +
    (fragmentStale ? '｜⚠️ 原提示单已变更，本预览已失效，请重新生成' : '');

  renderFragmentTimeline();
  renderFragmentConflicts();
  renderFragmentTable();
  $('#frDownloadBtn').disabled = fragmentStale;
}

async function previewFragment(e) {
  e.preventDefault();
  const body = {
    start: $('#fr-start').value,
    end: $('#fr-end').value,
  };
  const btn = $('#frPreviewBtn');
  btn.disabled = true;
  try {
    fragment = await api('POST', '/api/fragments/preview', body);
    fragmentStale = false;
    hideFragError();
    renderFragment();
  } catch (err) {
    fragment = null;
    $('#fragResult').hidden = true;
    $('#frDownloadBtn').disabled = true;
    showFragError(err.errors || [err.message]);
  } finally {
    btn.disabled = false;
  }
}

function downloadFragment() {
  if (!fragment || fragmentStale) return;
  const blob = new Blob([JSON.stringify(fragment.document, null, 2) + '\n'], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const { start, end } = fragment.window;
  const fmt = (n) => fmtNum(n).replace(/\./g, '-');
  a.href = url;
  a.download = `cue-fragment_${fmt(start)}-${fmt(end)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------- 初始化 ----------------
document.querySelectorAll('input[name="startType"]').forEach((r) =>
  r.addEventListener('change', syncStartBoxes)
);
$('#cueForm').addEventListener('submit', submitForm);
$('#cancelEdit').addEventListener('click', () => resetForm());
$('#fragmentForm').addEventListener('submit', previewFragment);
$('#frDownloadBtn').addEventListener('click', downloadFragment);

syncStartBoxes();
reload().catch((err) => showBanner(`加载失败：${err.message}`, 'err', true));
