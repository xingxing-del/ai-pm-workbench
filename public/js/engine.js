// 推进引擎：所有改变阶段、关卡状态的动作都走这里，保证"规则拦人"在任何路径上都成立。
// 纯逻辑，不碰界面，可以在 Node 里单独测试。
(function (root) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const S = isNode ? require('./stages.js') : root.Stages;
  const R = isNode ? require('./rules.js') : root.Rules;

  const now = () => new Date().toISOString();
  const KIND_NAME = { std: '验收标准', evalset: '评测集', build: '构建' };
  // 哪类变化会让哪些关卡失效
  const INVALIDATES = { std: [3, 7, 8], evalset: [7, 8], build: [7, 8] };

  // 旧数据补默认值
  function ensure(p) {
    p.ver = p.ver || { std: 1, evalset: 1, build: 1 };
    p.status = p.status || 'active';
    p.doc = p.doc || { text: '', files: [] };
    p.metricHistory = Array.isArray(p.metricHistory) ? p.metricHistory : [];
    (p.doc.files || []).forEach(f => { if (!f.id) f.id = 'm' + Math.random().toString(36).slice(2, 10); });
    S.STAGES.forEach(s => {
      const st = p.stages[s.n];
      st.evidence = st.evidence || [];
      st.fields = st.fields || {};
    });
    return p;
  }

  function resetGate(p, n) {
    const st = p.stages[n];
    const was = st.gatePassed;
    st.gatePassed = false; st.forced = false; st.lastGate = null;
    return was;
  }

  // 当前版本是否已经"被用过"（关卡通过过，或有结果是按这个版本录的）
  function inUse(p, kind) {
    const v = p.ver[kind];
    const e = p.stages[7].fields.evalMeta, g = p.stages[8].fields.grayMeta;
    const metaUses = m => m && m[kind] === v;
    return INVALIDATES[kind].some(n => p.stages[n].gatePassed) || metaUses(e) || metaUses(g);
  }

  // 标准、评测集或构建发生变化：如果当前版本已被用过，版本号加一，相关关卡失效，旧结果变成过期
  function touch(p, kind) {
    ensure(p);
    if (!inUse(p, kind)) return null;
    const from = p.ver[kind];
    p.ver[kind] = from + 1;
    const reset = INVALIDATES[kind].filter(n => resetGate(p, n));
    return { kind, name: KIND_NAME[kind], from, to: p.ver[kind], reset };
  }

  function stampResults(p, n) {
    const key = n === 7 ? 'evalMeta' : 'grayMeta';
    p.stages[n].fields[key] = { ...p.ver, at: now() };
  }

  function clearResults(p, n) {
    const f = p.stages[n].fields;
    const rKey = n === 7 ? 'evalResults' : 'grayResults';
    const old = { ...(f[rKey] || {}) };
    f[rKey] = {};
    stampResults(p, n);
    return old;
  }

  function hasValues(obj) { return obj && Object.values(obj).some(v => v !== '' && v !== null && v !== undefined); }

  // ---------- 依赖关系表：什么变化让什么失效 ----------
  // 版本类变化：改的是"判定口径或被测对象"本身
  //   验收标准（指标的类型、方向、阈值、单位，增删指标）→ 标准版本，失效第 3、7、8 关
  //   评测集（第 5 阶段的说明、样本量、步骤增删、步骤产出、步骤完成状态）→ 评测集版本，失效第 7、8 关
  //   构建（第 6 阶段的构建记录、步骤增删、步骤产出、步骤完成状态）→ 构建版本，失效第 7、8 关
  // 不算版本变化：指标显示名称、步骤备注、风险标记、步骤排序
  // 其余变化（评测结果、评审结论、第 1、2 阶段字段等）不升版本，但会触发"已通过关卡复核"：
  //   已通过（非强制）的关卡如果按当前数据不再满足规则，就撤销，并连带撤销它之后已通过的关卡
  const METRIC_DEF_KEYS = ['role', 'op', 'threshold', 'unit', 'add', 'delete'];
  const STEP_VERSION_ACTIONS = ['add', 'delete', 'output', 'done'];
  function versionKindOf(c) {
    if (c.type === 'metric') return METRIC_DEF_KEYS.includes(c.key) ? 'std' : null;
    if (c.type === 'field') return c.stage === 5 ? 'evalset' : c.stage === 6 ? 'build' : null;
    if (c.type === 'step') return STEP_VERSION_ACTIONS.includes(c.key) ? (c.stage === 5 ? 'evalset' : c.stage === 6 ? 'build' : null) : null;
    return null;
  }

  const norm = v => (v === undefined || v === null) ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v).trim();

  // 已通过的关卡复核：不再满足规则就撤销，并连带撤销之后的关卡（强制放行的关卡视为有意例外，复核时跳过，但会被连带撤销）
  function revalidate(p) {
    const revoked = [];
    const keys = S.STAGES.filter(s => s.key).map(s => s.n);
    for (const k of keys) {
      const st = p.stages[k];
      if (!st.gatePassed || st.forced) continue;
      const fails = R.checkGate(p, k).filter(r => !r.pass);
      if (fails.length) {
        resetGate(p, k);
        const cascade = keys.filter(j => j > k && p.stages[j].gatePassed);
        cascade.forEach(j => resetGate(p, j));
        revoked.push({ n: k, fails: fails.map(r => r.label), cascade });
      }
    }
    return revoked;
  }

  // 统一变更入口：所有会改变依据的修改都走这里
  // c = { type: 'field'|'metric'|'step'|'result'|'evidence', stage, key, before, after }
  function applyChange(p, c) {
    ensure(p);
    if (c.before !== undefined && norm(c.before) === norm(c.after)) return { skipped: true, versions: [], revoked: [] };
    const versions = [];
    const kind = versionKindOf(c);
    if (kind) { const t = touch(p, kind); if (t) versions.push(t); }
    const revoked = revalidate(p);
    return { skipped: false, versions, revoked };
  }

  // 前置关卡确认（不移动当前阶段）：用于"未核验"阶段补确认，或依据变化后重新确认
  function confirmGate(p, n) {
    ensure(p);
    const s = S.stageByN(n);
    if (!s || !s.key || n >= p.currentStage) return { ok: false, reason: '只能确认当前阶段之前的关卡' };
    const rules = R.checkGate(p, n);
    if (!rules.every(r => r.pass)) return { ok: false, reason: '规则检查未通过', rules };
    p.stages[n].gatePassed = true; p.stages[n].forced = false; p.stages[n].lastGate = 'pass';
    return { ok: true, rules };
  }

  // AI 建议依据的签名：建议实际用到的数据（阶段产出、指标、版本、关联材料、相关阶段）
  function inputSignature(p, n) {
    const pick = k => p.stages[k] ? { f: p.stages[k].fields, e: (p.stages[k].evidence || []).map(x => x.id || x.name), s: p.stages[k].steps.map(x => [x.title, x.status, x.output || '']) } : null;
    const related = n === 7 ? [5, 6, 7] : n === 8 ? [7, 8] : n === 10 ? [9, 10] : [n];
    return JSON.stringify({ n, ver: p.ver, m: p.stages[3].fields.metrics || [], r: related.map(pick) });
  }

  // 指标历史：每次关卡检查（第 7、8 关）和清空旧结果时记一笔，用来画趋势
  function recordResults(p, n, values, meta) {
    ensure(p);
    const role = n === 7 ? '评测' : '护栏';
    const ms = (p.stages[3].fields.metrics || []).filter(m => m.role === role);
    const src = values || p.stages[n].fields[n === 7 ? 'evalResults' : 'grayResults'] || {};
    const vals = {};
    ms.forEach(m => { const v = src[m.id]; if (!R.actualProblem(m, v)) vals[m.id] = Number(v); }); // 只记有效值
    if (!Object.keys(vals).length) return null;
    const ver = { ...(meta || p.stages[n].fields[n === 7 ? 'evalMeta' : 'grayMeta'] || p.ver) };
    delete ver.at;
    const last = p.metricHistory.filter(h => h.stage === n).slice(-1)[0];
    if (last && JSON.stringify(last.values) === JSON.stringify(vals) && JSON.stringify(last.ver) === JSON.stringify(ver)) return null;
    const entry = { t: now(), stage: n, iteration: p.iteration, ver, values: vals };
    p.metricHistory.push(entry);
    return entry;
  }

  // 统一的前进入口：只能前进一步；关键节点在这一刻重新检查规则
  function advance(p, opts = {}) {
    ensure(p);
    const n = p.currentStage, s = S.stageByN(n);
    if (p.status !== 'active') return { ok: false, reason: '项目不在进行中' };
    if (n >= 10) return { ok: false, reason: '第 10 阶段只能回流，不能再前进' };
    const rules = R.checkGate(p, n);
    const pass = rules.every(r => r.pass);
    if (s.key) {
      if (!pass && !opts.force) return { ok: false, reason: '规则检查未通过', rules };
      p.stages[n].gatePassed = true;
      p.stages[n].forced = !pass && !!opts.force;
      p.stages[n].lastGate = pass ? 'pass' : 'fail';
      if (p.stages[n].forced) p.risk = true;
    }
    p.currentStage = n + 1;
    return { ok: true, rules, forced: s.key && !pass };
  }

  // 回退：途经的关卡全部重置；从评测之后回到构建或评测集，说明要返工，旧结果不能再用
  function back(p, target, note) {
    ensure(p);
    const n = p.currentStage;
    if (target >= n) return { ok: false };
    for (let k = target; k <= n; k++) if (S.stageByN(k).key) resetGate(p, k);
    const changes = [];
    if (n >= 7 && target <= 6) {
      const c = touch(p, target === 5 ? 'evalset' : 'build');
      if (c) changes.push(c);
    }
    if (note) p.stages[target].steps.push(makeStepLike(`返工：${note}`));
    p.currentStage = target;
    return { ok: true, changes };
  }

  function makeStepLike(title) {
    return { id: Math.random().toString(36).slice(2, 10), title, status: 'todo', risk: '', note: '', output: '' };
  }

  // 失败回流：开始新一轮
  function backflow(p, target) {
    ensure(p);
    const fails = (p.stages[10].fields.failures || '').split('\n').map(s => s.trim()).filter(Boolean);
    p.iteration += 1;
    for (let k = target; k <= 10; k++) {
      p.stages[k].steps.forEach(x => { x.status = 'todo'; });
      if (S.stageByN(k).key) resetGate(p, k);
    }
    p.ver[target === 5 ? 'evalset' : 'build'] += 1;
    if (target === 5) p.ver.build += 1;
    p.stages[7].fields.evalResults = {}; p.stages[7].fields.evalMeta = null;
    p.stages[8].fields.grayResults = {}; p.stages[8].fields.grayMeta = null;
    fails.forEach(f => p.stages[target].steps.push(makeStepLike(target === 5 ? `新增评测用例：${f}` : `修复线上问题：${f}`)));
    p.stages[10].fields.failures = '';
    p.currentStage = target;
    return { fails };
  }

  // 决策依据快照：当时的规则明细、指标实测与阈值、版本、关联材料、AI 完整建议
  function snapshot(p, n, rules, advice) {
    const ms = (p.stages[3].fields.metrics || []);
    const ev = p.stages[7].fields.evalResults || {}, gr = p.stages[8].fields.grayResults || {};
    const metrics = ms.map(m => ({
      name: m.name, role: m.role, op: m.op, threshold: m.threshold, unit: m.unit || '',
      actual: m.role === '评测' ? ev[m.id] : m.role === '护栏' ? gr[m.id] : undefined
    }));
    const related = n === 7 ? [5, 6, 7] : n === 8 ? [7, 8] : n === 10 ? [9, 10] : [n];
    const fields = {};
    related.forEach(k => { fields[k] = JSON.parse(JSON.stringify(p.stages[k].fields || {})); });
    return {
      at: now(), stage: n, ver: { ...p.ver },
      rules: (rules || []).map(r => ({ label: r.label, pass: r.pass, detail: r.detail || '' })),
      metrics,
      fields,
      resultMeta: { eval: p.stages[7].fields.evalMeta || null, gray: p.stages[8].fields.grayMeta || null },
      evidence: (p.stages[n].evidence || []).map(e => ({ ...e })),
      advice: advice ? { summary: advice.summary, reason: advice.reason, alternatives: advice.alternatives || [], source: advice.source, preset: !!advice.preset, suggestedStage: advice.suggestedStage } : null
    };
  }

  // 用来判断"拍板时的依据和打开关卡时是否一致"
  function signature(rules) {
    return JSON.stringify((rules || []).map(r => [r.label, r.pass, r.detail || '']));
  }

  const api = { ensure, touch, stampResults, clearResults, hasValues, advance, back, backflow, snapshot, signature, inputSignature, applyChange, revalidate, confirmGate, versionKindOf, recordResults, KIND_NAME };
  if (isNode) module.exports = api; else root.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
