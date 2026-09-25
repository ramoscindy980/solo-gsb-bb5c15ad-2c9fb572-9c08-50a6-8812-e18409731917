'use strict';

/**
 * 单条提示的冲突顺延预演：
 * - 在不提前目标提示原开始时刻的前提下，搜索其所在通道的最早完整空位
 *   （遇到占用则推到该占用结束，首尾相接 [end, ...) 可用）
 * - 固定开始提示改 fixedAt；相对开始提示只增加 delayAfter
 * - 目标的后继提示随现有调度器重算，不作为搜索障碍
 * - 预演只读：列出被顺延的提示、前后时刻及新增/消失的冲突，原数据不写入
 * - 确认时以 baseVersion 核对预演所依据的提示单版本，一致才允许保存
 */

const crypto = require('crypto');
const { round, evaluate } = require('./scheduler');

const EPS = 1e-9; // 与冲突检测一致的浮点容差

function httpError(status, message, errors) {
  const err = new Error(message);
  err.status = status;
  err.errors = errors || [message];
  return err;
}

/** 提示单版本：对当前 cues 全量内容的哈希，任何增删改都会改变它 */
function cuesVersion(cues) {
  return crypto.createHash('sha256').update(JSON.stringify(cues)).digest('hex');
}

/** 目标提示的全部后继（直接或间接以它为前置的提示 id 集合，不含自身） */
function successorIds(cues, targetId) {
  const children = new Map();
  for (const c of cues) {
    if (c.startType === 'after' && c.afterCueId) {
      if (!children.has(c.afterCueId)) children.set(c.afterCueId, []);
      children.get(c.afterCueId).push(c.id);
    }
  }
  const out = new Set();
  const queue = [targetId];
  while (queue.length) {
    const id = queue.shift();
    for (const next of children.get(id) || []) {
      if (!out.has(next)) {
        out.add(next);
        queue.push(next);
      }
    }
  }
  return out;
}

/**
 * 在 [originalStart, +∞) 上为长度 duration 的区间搜索最早完整空位。
 * obstacles：同通道、非目标且非目标后继的占用区间 [{start, end}]（按开始排序）。
 * 遇占用则推到该占用结束（首尾相接可用）；每次推进严格变大，有限步内必然落定。
 * 返回空位起点；理论上障碍有限必有空位，仍兜底返回 null（无空位）。
 */
function findEarliestSlot(obstacles, originalStart, duration) {
  let t = originalStart;
  for (let i = 0; i <= obstacles.length; i++) {
    const hit = obstacles.find(
      (o) => Math.max(o.start, t) < Math.min(o.end, t + duration) - EPS
    );
    if (!hit) return round(t);
    t = hit.end; // 推到该占用结束，首尾相接不算占用
  }
  return null;
}

const conflictKey = (cf) =>
  `${cf.channel}|${cf.cueIds.slice().sort().join('~')}|${cf.start}|${cf.end}`;

/**
 * 生成顺延预演计划（只读，不修改传入的 cues）。
 * 返回 { cueId, channel, startType, changed, adjust, target, moved,
 *        conflictsAdded, conflictsRemoved, baseVersion }。
 */
function planDeferral(cues, cueId) {
  const target = cues.find((c) => c.id === cueId);
  if (!target) {
    throw httpError(404, '提示不存在', [`提示 ${cueId} 不存在或已被删除`]);
  }

  const before = evaluate(cues);
  const beforeTimes = new Map(before.schedule.map((s) => [s.id, s]));
  const t0 = beforeTimes.get(cueId);
  if (!t0 || t0.start === null) {
    throw httpError(
      400,
      `提示「${target.name}」时间未定（无效时间），无法预演顺延，请先解决引用或循环依赖问题`,
      [`提示「${target.name}」时间未定，无法确定其原开始时刻`]
    );
  }

  // 搜索障碍：同通道、非目标、非目标后继、时间已定的提示（后继随调度器重算，不占位）
  const successors = successorIds(cues, cueId);
  const obstacles = [];
  for (const c of cues) {
    if (c.id === cueId || successors.has(c.id) || c.channel !== target.channel) continue;
    const t = beforeTimes.get(c.id);
    if (!t || t.start === null) continue;
    obstacles.push({ start: t.start, end: t.end });
  }
  obstacles.sort((a, b) => a.start - b.start || a.end - b.end);

  const newStart = findEarliestSlot(obstacles, t0.start, target.duration);
  if (newStart === null) {
    throw httpError(
      400,
      `通道「${target.channel}」上找不到可容纳「${target.name}」（${target.duration}s）的完整空位`,
      [`通道「${target.channel}」没有可用空位`]
    );
  }

  const delta = round(newStart - t0.start); // 顺推迟早量，>= 0（不提前原开始时刻）
  const changed = delta > EPS;

  // 应用方式：固定开始改 fixedAt；相对开始只增加 delayAfter
  const adjust =
    target.startType === 'fixed'
      ? { field: 'fixedAt', from: target.fixedAt, to: round(newStart) }
      : { field: 'delayAfter', from: target.delayAfter, to: round(target.delayAfter + delta), delta };

  // 在副本上应用调整，交给现有调度器重算（后继随之移动）
  const nextCues = cues.map((c) => {
    if (c.id !== cueId) return c;
    return c.startType === 'fixed'
      ? { ...c, fixedAt: adjust.to }
      : { ...c, delayAfter: adjust.to };
  });
  const after = evaluate(nextCues);
  const afterTimes = new Map(after.schedule.map((s) => [s.id, s]));

  // 被顺延的提示：目标 + 重算后时刻发生变化的后继
  const moved = [];
  for (const c of cues) {
    const b = beforeTimes.get(c.id);
    const a = afterTimes.get(c.id);
    const bStart = b ? b.start : null;
    const bEnd = b ? b.end : null;
    const aStart = a ? a.start : null;
    const aEnd = a ? a.end : null;
    const differs =
      (bStart === null) !== (aStart === null) ||
      (bStart !== null && (Math.abs(aStart - bStart) > EPS || Math.abs(aEnd - bEnd) > EPS));
    if (differs) {
      moved.push({
        id: c.id,
        name: c.name,
        channel: c.channel,
        isTarget: c.id === cueId,
        oldStart: bStart,
        oldEnd: bEnd,
        newStart: aStart,
        newEnd: aEnd,
      });
    }
  }

  // 冲突 diff：按（通道 + 提示对 + 区间）判定新增 / 消失
  const beforeKeys = new Set(before.conflicts.map(conflictKey));
  const afterKeys = new Set(after.conflicts.map(conflictKey));
  const conflictsRemoved = before.conflicts.filter((cf) => !afterKeys.has(conflictKey(cf)));
  const conflictsAdded = after.conflicts.filter((cf) => !beforeKeys.has(conflictKey(cf)));

  return {
    cueId,
    name: target.name,
    channel: target.channel,
    startType: target.startType,
    changed,
    adjust,
    target: {
      id: target.id,
      name: target.name,
      oldStart: t0.start,
      oldEnd: t0.end,
      newStart,
      newEnd: round(newStart + target.duration),
    },
    moved,
    conflictsAdded,
    conflictsRemoved,
    baseVersion: cuesVersion(cues),
  };
}

module.exports = { cuesVersion, successorIds, findEarliestSlot, planDeferral };
