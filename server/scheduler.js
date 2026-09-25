'use strict';

/**
 * 提示单调度核心：
 * - 引用校验（不存在的 afterCue）
 * - 循环依赖检测
 * - 时间递归重算（固定时间 / 另一提示结束后延迟）
 * - 同通道时间轴冲突检测（左闭右开 [start, end)，首尾相接不算冲突）
 */

const ROUND = 3; // 秒数保留 3 位小数，规避浮点尾差

const round = (n) => Math.round((n + Number.EPSILON) * 10 ** ROUND) / 10 ** ROUND;

function numError(value, field, label) {
  if (typeof value === 'boolean' || value === null || String(value).trim() === '') {
    return `${label}必须填写数字`;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return `${label}必须是数字`;
  if (n < 0) return `${label}不能为负数`;
  return null;
}

/**
 * 校验并规整单条提示的请求体；通过返回规整后的 payload，否则抛出 { status, errors }
 */
function validateCueBody(body) {
  const errors = [];
  const b = body || {};

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) errors.push('名称不能为空');
  if (name.length > 80) errors.push('名称不能超过 80 个字符');

  const channel = typeof b.channel === 'string' ? b.channel.trim() : '';
  if (!channel) errors.push('独占设备通道不能为空');
  if (channel.length > 40) errors.push('通道名称不能超过 40 个字符');

  let duration = NaN;
  const dErr = numError(b.duration, 'duration', '持续秒数');
  if (dErr) errors.push(dErr);
  else duration = round(Number(b.duration));

  let startType;
  if (b.startType === 'fixed' || b.startType === 'after') {
    startType = b.startType;
  } else {
    errors.push('开始时间类型必须是 fixed（固定秒数）或 after（相对另一提示）');
  }

  let fixedAt = 0;
  let afterCueId = null;
  let delayAfter = 0;

  if (startType === 'fixed') {
    const fErr = numError(b.fixedAt, 'fixedAt', '固定开始秒数');
    if (fErr) errors.push(fErr);
    else fixedAt = round(Number(b.fixedAt));
  }

  if (startType === 'after') {
    if (typeof b.afterCueId !== 'string' || !b.afterCueId.trim()) {
      errors.push('相对开始必须选择一条前置提示');
    } else {
      afterCueId = b.afterCueId.trim();
    }
    const lErr = numError(b.delayAfter, 'delayAfter', '前置结束后延迟秒数');
    if (lErr) errors.push(lErr);
    else delayAfter = round(Number(b.delayAfter));
  }

  if (errors.length) {
    const err = new Error(errors.join('；'));
    err.status = 400;
    err.errors = errors;
    throw err;
  }

  const payload = { name, channel, duration, startType };
  if (startType === 'fixed') {
    payload.fixedAt = fixedAt;
    payload.afterCueId = null;
    payload.delayAfter = 0;
  } else {
    payload.fixedAt = null;
    payload.afterCueId = afterCueId;
    payload.delayAfter = delayAfter;
  }
  return payload;
}

/**
 * 引用与循环依赖检查。
 * 返回 { errors: [{code, cueId, ref, message, cycle}], cycles: [[id,...]] }
 */
function analyzeGraph(cues) {
  const byId = new Map(cues.map((c) => [c.id, c]));
  const errors = [];
  const cycles = [];

  // 1) 不存在的引用
  for (const c of cues) {
    if (c.startType === 'after') {
      if (!byId.has(c.afterCueId)) {
        errors.push({
          code: 'missing_ref',
          cueId: c.id,
          ref: c.afterCueId,
          message: `提示「${c.name}」引用了不存在的前置提示（${c.afterCueId}）`,
        });
      }
    }
  }

  // 2) 循环依赖（三色 DFS）
  const color = new Map(); // 0=白 1=灰 2=黑
  const seenCycles = new Set();

  function dfs(startId) {
    // 迭代式 DFS，返回找到的环
    const stack = [{ id: startId, edgeIndex: 0 }];
    color.set(startId, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const cue = byId.get(frame.id);
      const nextId = cue && cue.startType === 'after' && byId.has(cue.afterCueId)
        ? cue.afterCueId
        : null;

      if (frame.edgeIndex === 0 && nextId !== null) {
        const col = color.get(nextId) || 0;
        if (col === 1) {
          // 找到环：从 nextId 在栈中的位置开始
          const idx = stack.findIndex((f) => f.id === nextId);
          const cyc = stack.slice(idx).map((f) => f.id);
          const key = cyc.slice().sort().join('|');
          if (!seenCycles.has(key)) {
            seenCycles.add(key);
            cycles.push(cyc);
            errors.push({
              code: 'cycle',
              cueId: nextId,
              cycle: cyc,
              message: `存在循环依赖：${cyc
                .map((id) => `「${byId.get(id).name}」`)
                .join(' → ')} → 「${byId.get(nextId).name}」`,
            });
          }
        } else if (col === 0) {
          color.set(nextId, 1);
          stack.push({ id: nextId, edgeIndex: 0 });
          continue;
        }
      }

      frame.edgeIndex++;
      if (frame.edgeIndex > 1 || nextId === null) {
        color.set(frame.id, 2);
        stack.pop();
      }
    }
  }

  for (const c of cues) {
    if (!color.has(c.id)) dfs(c.id);
  }

  return { errors, cycles };
}

/**
 * 递归计算每条提示的开始/结束时间。
 * 依赖缺失或位于环上的提示返回 start=null（及 reasons）。
 */
function computeTimes(cues, graph) {
  const byId = new Map(cues.map((c) => [c.id, c]));
  const inCycle = new Set();
  for (const cyc of graph.cycles) for (const id of cyc) inCycle.add(id);

  const times = new Map();
  const stackGuard = new Set();

  function resolve(id) {
    if (times.has(id)) return times.get(id);
    const cue = byId.get(id);
    if (!cue) return { start: null, end: null, reason: 'missing' };

    if (inCycle.has(id)) {
      times.set(id, { start: null, end: null, reason: 'cycle' });
      return times.get(id);
    }
    if (stackGuard.has(id)) {
      // 理论上不会到这（环已提前处理），保险起见
      times.set(id, { start: null, end: null, reason: 'cycle' });
      return times.get(id);
    }
    stackGuard.add(id);

    let start;
    let reason = null;
    if (cue.startType === 'fixed') {
      start = cue.fixedAt;
    } else {
      const dep = byId.get(cue.afterCueId);
      if (!dep) {
        start = null;
        reason = 'missing';
      } else {
        const depTime = resolve(cue.afterCueId);
        if (depTime.start === null) {
          start = null;
          reason = depTime.reason === 'cycle' ? 'dep-cycle' : 'dep-missing';
        } else {
          start = round(depTime.end + cue.delayAfter);
        }
      }
    }

    stackGuard.delete(id);
    const end = start === null ? null : round(start + cue.duration);
    times.set(id, { start, end, reason });
    return times.get(id);
  }

  for (const c of cues) resolve(c.id);
  return times;
}

/**
 * 同通道冲突检测，区间均为左闭右开 [start, end)。
 * 首尾相接（a.end === b.start）不算冲突。
 */
function detectConflicts(cues, times) {
  const conflicts = [];
  const byChannel = new Map();
  for (const c of cues) {
    const t = times.get(c.id);
    if (!t || t.start === null) continue;
    if (!byChannel.has(c.channel)) byChannel.set(c.channel, []);
    byChannel.get(c.channel).push({ cue: c, start: t.start, end: t.end });
  }

  for (const [channel, items] of byChannel) {
    items.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        // 左闭右开重叠：max(start) < min(end)
        const ovStart = Math.max(a.start, b.start);
        const ovEnd = Math.min(a.end, b.end);
        if (ovStart < ovEnd - 1e-9) {
          conflicts.push({
            channel,
            cueIds: [a.cue.id, b.cue.id],
            start: round(ovStart),
            end: round(ovEnd),
          });
        }
      }
    }
  }

  conflicts.sort((a, b) => a.channel.localeCompare(b.channel) || a.start - b.start);
  return conflicts;
}

/**
 * 全量评估：校验引用/循环、重算时间、检测冲突。
 */
function evaluate(cues) {
  const graph = analyzeGraph(cues);
  const times = computeTimes(cues, graph);
  const conflicts = detectConflicts(cues, times);

  const schedule = cues.map((c) => {
    const t = times.get(c.id) || { start: null, end: null, reason: 'missing' };
    return { id: c.id, start: t.start, end: t.end, reason: t.reason };
  });

  return {
    errors: graph.errors,
    cycles: graph.cycles,
    schedule,
    conflicts,
  };
}

module.exports = { round, validateCueBody, analyzeGraph, computeTimes, detectConflicts, evaluate };
