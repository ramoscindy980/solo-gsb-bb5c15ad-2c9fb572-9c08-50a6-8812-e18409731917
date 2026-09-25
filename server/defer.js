'use strict';

/**
 * 单条提示的冲突顺延预演：
 * - 在不提前其原开始时刻的前提下，于所在通道搜索最早完整空位
 *   （遇到占用则推到该占用结束；首尾相接 [a,b) [b,c) 可用，不算占用）
 * - 固定开始提示改 fixedAt；相对开始提示保持前置不变、只增加 delayAfter
 * - 目标提示的后继随现有调度器重算，且不作为搜索空位的障碍
 * - 预演为纯计算：不修改、不持久化原提示单；确认时才由路由层原子保存
 */

const { round, evaluate } = require('./scheduler');

const EPS = 1e-9; // 与冲突检测一致的浮点容差

function httpError(status, message, errors) {
  const err = new Error(message);
  err.status = status;
  err.errors = errors || [message];
  return err;
}

const REASON_TEXT = {
  missing: '引用了不存在的前置提示',
  cycle: '处于循环依赖中',
  'dep-missing': '其前置引用了不存在的提示',
  'dep-cycle': '其前置处于循环依赖中',
};

/** 目标提示的全部传递后继（沿 afterCueId 依赖链向下） */
function collectSuccessors(cues, cueId) {
  const dependents = new Map(); // 前置 id -> [后继 id]
  for (const c of cues) {
    if (c.startType === 'after' && c.afterCueId) {
      if (!dependents.has(c.afterCueId)) dependents.set(c.afterCueId, []);
      dependents.get(c.afterCueId).push(c.id);
    }
  }
  const result = new Set();
  const queue = [cueId];
  while (queue.length) {
    const cur = queue.pop();
    for (const next of dependents.get(cur) || []) {
      if (!result.has(next)) {
        result.add(next);
        queue.push(next);
      }
    }
  }
  return result;
}

// 冲突身份按「通道 + 提示对」判定（与具体重叠时刻无关），用于对比新增/消失
const conflictKey = (cf) => `${cf.channel}|${cf.cueIds.slice().sort().join('|')}`;

/**
 * 计算顺延预演方案（纯函数，不修改传入的 cues）。
 * 返回 { moved, target, nextTarget, shifted, conflictsBefore, conflictsAfter,
 *        conflictsAdded, conflictsRemoved }；非法情况抛带 status 的 Error。
 * nextTarget 为确认时要落盘的目标提示（不下发给预演响应也可，由调用方决定）。
 */
function planDefer(cues, cueId) {
  const target = cues.find((c) => c.id === cueId);
  if (!target) throw httpError(404, '提示不存在');

  const before = evaluate(cues);
  const beforeTime = new Map(before.schedule.map((s) => [s.id, s]));
  const t0 = beforeTime.get(cueId);
  if (!t0 || t0.start === null) {
    const reason = (t0 && REASON_TEXT[t0.reason]) || '无法排期';
    throw httpError(
      400,
      `提示「${target.name}」时间未定（${reason}），无法预演顺延，请先解决引用或循环依赖问题`,
      [`提示「${target.name}」时间未定：${reason}`]
    );
  }

  // 搜索障碍 = 同通道、非目标、非目标后继、时间已定的提示区间
  // （后继会随调度器重算，不作为障碍）
  const successors = collectSuccessors(cues, cueId);
  const obstacles = [];
  for (const c of cues) {
    if (c.id === cueId || successors.has(c.id) || c.channel !== target.channel) continue;
    const t = beforeTime.get(c.id);
    if (!t || t.start === null) continue;
    obstacles.push({ start: t.start, end: t.end });
  }
  obstacles.sort((a, b) => a.start - b.start || a.end - b.end);

  // 从不早于原开始时刻的位置起，找最早完整空位；遇到占用推到其结束（首尾相接可用）
  const duration = target.duration;
  let start = t0.start;
  for (const ob of obstacles) {
    if (ob.end <= start + EPS) continue; // 占用在候选之前（含首尾相接）
    if (ob.start >= start + duration - EPS) break; // 候选区间已完整落入空位
    start = ob.end; // 推到该占用结束
  }
  if (!Number.isFinite(start)) {
    throw httpError(400, `通道「${target.channel}」上找不到完整空位，无法顺延`, [
      `通道「${target.channel}」上找不到完整空位`,
    ]);
  }
  const newStart = round(start);
  const newEnd = round(newStart + duration);
  const moved = newStart > t0.start + EPS;

  // 生成修改后的目标提示：固定开始改 fixedAt；相对开始只增加 delayAfter
  let nextTarget = target;
  let change = null;
  if (moved) {
    if (target.startType === 'fixed') {
      nextTarget = { ...target, fixedAt: newStart };
      change = { field: 'fixedAt', oldValue: target.fixedAt, newValue: newStart };
    } else {
      // 原开始 = 前置结束 + delayAfter；前置时间不变，故延迟增加量 = 顺延量
      const delta = round(newStart - t0.start);
      const newDelay = round(target.delayAfter + delta);
      nextTarget = { ...target, delayAfter: newDelay };
      change = { field: 'delayAfter', oldValue: target.delayAfter, newValue: newDelay };
    }
  }

  // 用现有调度器重算（目标的后继随之更新），对比前后时刻与冲突
  const afterCues = cues.map((c) => (c.id === cueId ? nextTarget : c));
  const after = evaluate(afterCues);
  const afterTime = new Map(after.schedule.map((s) => [s.id, s]));

  // 被顺延的提示：重算后开始/结束时刻发生变化者（目标 + 受影响的后继）
  const shifted = [];
  for (const c of cues) {
    const b = beforeTime.get(c.id);
    const a = afterTime.get(c.id);
    if (!b || !a || b.start === null || a.start === null) continue;
    if (Math.abs(a.start - b.start) > EPS || Math.abs(a.end - b.end) > EPS) {
      shifted.push({
        id: c.id,
        name: c.name,
        channel: c.channel,
        oldStart: b.start,
        oldEnd: b.end,
        newStart: a.start,
        newEnd: a.end,
      });
    }
  }
  shifted.sort((x, y) => x.newStart - y.newStart || x.name.localeCompare(y.name));

  const beforeKeys = new Set(before.conflicts.map(conflictKey));
  const afterKeys = new Set(after.conflicts.map(conflictKey));
  const conflictsAdded = after.conflicts.filter((cf) => !beforeKeys.has(conflictKey(cf)));
  const conflictsRemoved = before.conflicts.filter((cf) => !afterKeys.has(conflictKey(cf)));

  return {
    moved,
    target: {
      id: target.id,
      name: target.name,
      channel: target.channel,
      startType: target.startType,
      oldStart: t0.start,
      oldEnd: t0.end,
      newStart,
      newEnd,
      change,
    },
    nextTarget,
    shifted,
    conflictsBefore: before.conflicts,
    conflictsAfter: after.conflicts,
    conflictsAdded,
    conflictsRemoved,
  };
}

module.exports = { planDefer, collectSuccessors };
