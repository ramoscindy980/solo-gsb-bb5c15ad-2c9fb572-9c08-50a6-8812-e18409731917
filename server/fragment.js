'use strict';

/**
 * 片段排练单：
 * - 输入原演出时间窗 [winStart, winEnd)（左闭右开）
 * - 按现有重算时间选出与窗口有「正长度交集」的提示
 * - 将区间截到窗口内并平移到从 0 开始
 * - 保留片段内仍然有效的相对前置关系；前置未入选或提示跨左边界时改为固定开始
 * - 输出可作为独立提示单使用的 cues（无悬空引用），并用同一套 evaluate 重算，
 *   校验重算时刻与截取结果完全一致
 */

const { round, evaluate } = require('./scheduler');

const EPS = 1e-9; // 与冲突检测一致的浮点容差

function httpError(status, message, errors) {
  const err = new Error(message);
  err.status = status;
  err.errors = errors || [message];
  return err;
}

function readBound(raw, label, errors) {
  if (typeof raw === 'boolean' || raw === null || String(raw).trim() === '') {
    errors.push(`${label}必须填写数字`);
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    errors.push(`${label}必须是数字`);
    return null;
  }
  if (n < 0) {
    errors.push(`${label}不能为负数`);
    return null;
  }
  return round(n);
}

/**
 * 校验并规整时间窗；非法时抛出 400。
 */
function parseWindow(rawStart, rawEnd) {
  const errors = [];
  const start = readBound(rawStart, '时间窗起点', errors);
  const end = readBound(rawEnd, '时间窗止点', errors);

  if (errors.length) {
    throw httpError(400, `时间窗非法：${errors.join('；')}（需要左闭右开 [起, 止)）`, errors);
  }
  if (end < start - EPS) {
    throw httpError(400, '时间窗非法：止点不能早于起点（左闭右开 [起, 止)）', [
      '时间窗止点不能早于起点',
    ]);
  }
  if (end - start <= EPS) {
    throw httpError(400, '时间窗必须是正长度区间：止点必须严格晚于起点（左闭右开 [起, 止)）', [
      '时间窗必须为正长度区间（止 > 起）',
    ]);
  }
  return { start, end };
}

const REASON_TEXT = {
  missing: '引用了不存在的前置提示',
  cycle: '处于循环依赖中',
  'dep-missing': '其前置引用了不存在的提示',
  'dep-cycle': '其前置处于循环依赖中',
};

/**
 * 生成片段排练单。
 * 返回 { window, duration, selectedCount, totalCount, cues, schedule, conflicts,
 *        changes, selections, document }；任何非法情况抛带 status 的 Error。
 */
function buildFragment(cues, rawStart, rawEnd) {
  const win = parseWindow(rawStart, rawEnd);

  // 1) 原提示单必须全部可排期（按现有重算时间）
  const source = evaluate(cues);
  const byId = new Map(cues.map((c) => [c.id, c]));
  const unresolved = source.schedule.filter((s) => s.start === null);
  if (unresolved.length) {
    const errors = unresolved.map((s) => {
      const c = byId.get(s.id);
      const name = c ? `「${c.name}」` : s.id;
      return `原提示${name}时间未定（${REASON_TEXT[s.reason] || '无法排期'}）`;
    });
    throw httpError(
      400,
      '原提示单存在时间未定的提示，无法生成片段排练单，请先在原提示单中解决引用或循环依赖问题',
      errors
    );
  }

  // 2) 选出与窗口有正长度交集的提示，截取并平移
  const times = new Map(source.schedule.map((s) => [s.id, s]));
  const picked = [];
  for (const c of cues) {
    const t = times.get(c.id);
    const ovStart = Math.max(t.start, win.start);
    const ovEnd = Math.min(t.end, win.end);
    if (ovStart < ovEnd - EPS) {
      picked.push({
        cue: c,
        origStart: t.start,
        origEnd: t.end,
        start: round(ovStart - win.start),
        end: round(ovEnd - win.start),
      });
    }
  }
  const pickedIds = new Set(picked.map((p) => p.cue.id));

  // 3) 改写开始方式：前置未入选 / 跨左边界 → 固定开始；其余保留相对关系
  const fragmentCues = [];
  const changes = [];
  for (const p of picked) {
    const duration = round(p.end - p.start);
    const base = {
      id: p.cue.id,
      name: p.cue.name,
      channel: p.cue.channel,
      duration,
    };

    let next;
    if (p.cue.startType === 'fixed') {
      next = { ...base, startType: 'fixed', fixedAt: p.start, afterCueId: null, delayAfter: 0 };
    } else {
      const crossesLeft = p.origStart < win.start; // 起点严格在窗口左侧
      const predecessorSelected = pickedIds.has(p.cue.afterCueId);
      if (crossesLeft || !predecessorSelected) {
        next = { ...base, startType: 'fixed', fixedAt: p.start, afterCueId: null, delayAfter: 0 };
        changes.push({
          cueId: p.cue.id,
          name: p.cue.name,
          action: 'to-fixed',
          reason: crossesLeft ? 'crosses_left' : 'predecessor_excluded',
        });
      } else {
        // 前置在片段内、且本提示未被左边界截断：相对关系在平移后仍然成立
        next = {
          ...base,
          startType: 'after',
          fixedAt: null,
          afterCueId: p.cue.afterCueId,
          delayAfter: p.cue.delayAfter,
        };
      }
    }
    fragmentCues.push(next);
  }

  // 4) 用同一套调度逻辑重算片段（同时得到左闭右开的通道冲突）
  const frag = evaluate(fragmentCues);
  if (frag.errors.length) {
    // 构造上不应发生（所有引用都指向入选提示、源图无环）
    throw httpError(
      500,
      '片段重算失败，存在无效引用或循环依赖',
      frag.errors.map((e) => e.message)
    );
  }

  // 5) 一致性自检：重算时刻必须与截取结果一致
  const fragTimes = new Map(frag.schedule.map((s) => [s.id, s]));
  for (const p of picked) {
    const t = fragTimes.get(p.cue.id);
    if (
      !t ||
      t.start === null ||
      Math.abs(t.start - p.start) > EPS ||
      Math.abs(t.end - p.end) > EPS
    ) {
      throw httpError(500, '片段时间重算结果与截取结果不一致', [
        `提示「${p.cue.name}」重算时间与截取区间不一致`,
      ]);
    }
  }

  return {
    window: { start: win.start, end: win.end },
    duration: round(win.end - win.start),
    totalCount: cues.length,
    selectedCount: fragmentCues.length,
    cues: fragmentCues,
    schedule: frag.schedule,
    conflicts: frag.conflicts,
    changes,
    selections: picked.map((p) => ({
      cueId: p.cue.id,
      origStart: p.origStart,
      origEnd: p.origEnd,
      start: p.start,
      end: p.end,
    })),
    // document 即下载文件内容：与本地数据文件同构（{ cues }），可直接作为独立提示单使用
    document: {
      cues: fragmentCues,
      fragment: {
        sourceWindow: { start: win.start, end: win.end },
        selectedCount: fragmentCues.length,
        generatedAt: new Date().toISOString(),
      },
    },
  };
}

module.exports = { buildFragment, parseWindow };
