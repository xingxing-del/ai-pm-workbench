// 规则层：只检查客观条件（填没填、数字达没达标），需要判断的交给 AI 建议层。
(function (root) {
  const S = (typeof module !== 'undefined' && module.exports) ? require('./stages.js') : root.Stages;

  const filled = v => typeof v === 'string' ? v.trim().length > 0 : v !== undefined && v !== null && v !== '';
  const num = v => (v === '' || v === null || v === undefined || isNaN(Number(v))) ? null : Number(v);

  function f(project, n) { return (project.stages[n] && project.stages[n].fields) || {}; }
  function metrics(project) { return f(project, 3).metrics || []; }

  // 实测值校验：必须是有限数字；单位为 % 时在 0 到 100 之间
  function actualProblem(metric, actual) {
    if (actual === '' || actual === null || actual === undefined) return 'empty';
    const a = Number(actual);
    if (!isFinite(a)) return '不是有效数字';
    if ((metric.unit || '').trim() === '%' && (a < 0 || a > 100)) return '百分比应在 0 到 100 之间';
    return '';
  }
  // 返回 true 达标、false 未达标、null 未填或格式无效
  function meets(metric, actual) {
    if (actualProblem(metric, actual)) return null;
    const a = Number(actual), t = num(metric.threshold);
    if (t === null) return null;
    return metric.op === '<=' ? a <= t : a >= t;
  }
  const posInt = v => { const n = Number(v); return v !== '' && v !== null && v !== undefined && Number.isInteger(n) && n > 0; };

  function fmt(m, actual) {
    const u = m.unit || '';
    return `${m.name}：${actual === undefined || actual === '' ? '未填' : actual + u}（标准 ${m.op === '<=' ? '≤' : '≥'} ${m.threshold}${u}）`;
  }

  // 检查某一类指标的结果是否都达标
  function checkResults(project, role, resultsKey, stageN) {
    const list = metrics(project).filter(m => m.role === role);
    const res = f(project, stageN)[resultsKey] || {};
    if (list.length === 0) {
      return [{ label: `第 3 阶段定义了${role}指标`, pass: false, detail: `没有找到${role}指标，无法判断是否达标` }];
    }
    return list.map(m => {
      const prob = actualProblem(m, res[m.id]);
      const ok = meets(m, res[m.id]);
      return {
        label: `${m.name} 达标`,
        pass: ok === true,
        detail: prob === 'empty' ? `${m.name}：还没有填结果` : prob ? `${m.name}：录入值无效（${prob}）` : fmt(m, res[m.id]),
        metricId: m.id
      };
    });
  }

  function stepsFinished(project, n) {
    const steps = (project.stages[n] && project.stages[n].steps) || [];
    return steps.length > 0 && steps.every(s => s.status === 'done' || s.status === 'skipped');
  }
  function stepsRule(p, n, name) {
    const steps = p.stages[n].steps || [];
    const skipped = steps.filter(s => s.status === 'skipped').length;
    const left = steps.filter(s => s.status === 'todo' || s.status === 'doing').length;
    return {
      label: `第 ${n} 阶段（${name}）步骤已处理`,
      pass: stepsFinished(p, n),
      detail: left ? `还有 ${left} 个步骤未完成` : skipped ? `其中 ${skipped} 个步骤是跳过的（例外，已留痕）` : ''
    };
  }

  // 结果是否按当前版本录入：标准、评测集、构建任何一个变了，旧结果就过期
  function resultsCurrent(p, n) {
    const meta = n === 7 ? f(p, 7).evalMeta : f(p, 8).grayMeta;
    const v = p.ver || { std: 1, evalset: 1, build: 1 };
    if (!meta) return false;
    const keys = n === 7 ? ['std', 'evalset', 'build'] : ['std', 'build'];
    return keys.every(k => meta[k] === v[k]);
  }
  // 依据修订号：本工具记录的标准、评测集、构建修订次数，不是 Prompt 或模型的版本号
  function verText(v, n) { return `标准修订 ${v.std}${n === 8 ? '' : `、评测集修订 ${v.evalset}`}、构建修订 ${v.build}`; }
  function versionRule(p, n) {
    const meta = n === 7 ? f(p, 7).evalMeta : f(p, 8).grayMeta;
    const v = p.ver || { std: 1, evalset: 1, build: 1 };
    const ok = resultsCurrent(p, n);
    const cur = verText(v, n);
    const old = meta ? verText(meta, n) : '';
    return { label: '结果基于当前版本', pass: ok, detail: ok ? cur : meta ? `结果按 ${old} 录入，当前为 ${cur}，需要重新录入` : '还没有录入结果' };
  }

  function metricProblems(m) {
    const t = num(m.threshold);
    if (!filled(m.name)) return '有指标没写名称';
    if (!['>=', '<='].includes(m.op)) return `${m.name} 方向无效`;
    if (t === null || !isFinite(t)) return `${m.name} 缺阈值`;
    if ((m.unit || '').trim() === '%' && (t < 0 || t > 100)) return `${m.name} 的百分比阈值应在 0 到 100 之间`;
    return '';
  }

  const hasEvidence = (p, n, type) => (p.stages[n].evidence || []).some(e => e.type === type);

  const GATES = {
    2: p => {
      const a = f(p, 1), b = f(p, 2);
      return [
        { label: '第 1 阶段：业务目标已填写', pass: filled(a.goal) },
        { label: '第 1 阶段：不可接受的结果已填写', pass: filled(a.unacceptable) },
        { label: '第 1 阶段：预算已填写', pass: filled(a.budget) },
        { label: '可行性结论已填写', pass: filled(b.feasibility), detail: b.feasibility ? `结论：${b.feasibility}` : '' },
        { label: '可行性结论不是「不可行」', pass: b.feasibility !== '不可行', detail: b.feasibility === '不可行' ? '结论为不可行，不能立项；如有例外请强制放行并说明' : '' },
        { label: '成本估算已填写', pass: filled(b.cost) }
      ];
    },
    3: p => {
      const ms = metrics(p);
      const probs = ms.map(metricProblems).filter(Boolean);
      return [
        { label: '至少 1 个北极星指标并设了目标值', pass: ms.some(m => m.role === '北极星' && num(m.threshold) !== null) },
        { label: '至少 1 个评测指标（第 7 阶段要用）', pass: ms.some(m => m.role === '评测') },
        { label: '至少 1 个护栏指标', pass: ms.some(m => m.role === '护栏') },
        { label: '每个指标的名称、方向、阈值都有效', pass: ms.length > 0 && probs.length === 0, detail: probs.join('；') },
        { label: '灰度最少样本量已设定（正整数）', pass: posInt(f(p, 3).minGraySample), detail: posInt(f(p, 3).minGraySample) ? `最少 ${f(p, 3).minGraySample}` : '' }
      ];
    },
    4: p => {
      const x = f(p, 4);
      const out = [
        { label: 'PRD 内容已记录，或已关联 PRD 材料', pass: filled(x.prd) || hasEvidence(p, 4, 'PRD'), detail: hasEvidence(p, 4, 'PRD') ? '已关联 PRD 材料' : '' },
        { label: '评审结论已记录', pass: filled(x.review), detail: x.review ? `结论：${x.review}` : '' }
      ];
      if (x.review === '不通过') out.push({ label: '评审结论为通过或有条件通过', pass: false, detail: '评审未通过，不能进入下一阶段' });
      if (x.review === '有条件通过') {
        const lines = (x.issues || '').split('\n').map(s => s.trim()).filter(Boolean);
        const bad = lines.filter(l => { const parts = l.split(/[|｜]/); return parts.length < 2 || !parts[1].trim(); });
        out.push({
          label: '每条遗留问题都标了处理方式',
          pass: lines.length > 0 && bad.length === 0,
          detail: lines.length === 0 ? '有条件通过，但没有记录遗留问题' : bad.map(l => `缺处理方式：${l}`).join('；')
        });
      }
      return out;
    },
    7: p => {
      const e = f(p, 5);
      const size = posInt(e.evalSize) ? Number(e.evalSize) : null;
      return [
        { label: '第 3 阶段验收标准已确认', pass: !!(p.stages[3] && p.stages[3].gatePassed) },
        { label: '评测集已登记（说明与样本量）', pass: filled(e.evalset) && size !== null, detail: size ? `样本量 ${size} 条` : '样本量须为正整数' },
        stepsRule(p, 5, '评测集构建'),
        stepsRule(p, 6, '构建与调试'),
        versionRule(p, 7),
        ...checkResults(p, '评测', 'evalResults', 7)
      ];
    },
    8: p => {
      const x = f(p, 8);
      const n = posInt(x.graySample) ? Number(x.graySample) : null;
      const min = posInt(f(p, 3).minGraySample) ? Number(f(p, 3).minGraySample) : null;
      return [
        { label: '第 7 关「是否达标」仍然有效', pass: !!(p.stages[7] && p.stages[7].gatePassed), detail: p.stages[7] && p.stages[7].gatePassed ? (p.stages[7].forced ? '第 7 关是强制放行的' : '') : '标准或构建变更后第 7 关已失效，需要重新评测' },
        { label: '灰度范围已记录', pass: filled(x.grayScope) },
        { label: '灰度时长已记录', pass: filled(x.grayDuration) },
        { label: '灰度样本量达到最少要求', pass: n !== null && min !== null && n >= min, detail: min === null ? '第 3 阶段没有设定灰度最少样本量' : n === null ? `样本量须为正整数（最少 ${min}）` : `样本量 ${n}，最少 ${min}${n < min ? '，不够，不能据此全量' : ''}` },
        versionRule(p, 8),
        ...checkResults(p, '护栏', 'grayResults', 8).map(r => ({ ...r, label: r.label.replace('达标', '未越线') })),
        { label: '回滚方案已填写', pass: filled(x.rollback) }
      ];
    }
  };

  function checkGate(project, n) {
    const fn = GATES[n];
    return fn ? fn(project) : [];
  }

  // 规则算出的"下一步"：当前阶段第一个没做完的步骤 → 关卡 → 下一阶段
  function nextStep(project) {
    const n = project.currentStage;
    if (project.status === 'closed') return { kind: 'closed', stage: n, text: '项目已结束' };
    if (project.status === 'terminated') return { kind: 'closed', stage: n, text: '项目已终止' };
    const stage = S.stageByN(n);
    const steps = (project.stages[n] && project.stages[n].steps) || [];
    const pending = steps.find(s => s.status === 'todo' || s.status === 'doing');
    if (pending) return { kind: 'step', stage: n, step: pending, text: `完成「${pending.title}」` };
    if (stage.key && !project.stages[n].gatePassed) return { kind: 'gate', stage: n, text: `推进关卡：${stage.gate}` };
    if (n === 10) return { kind: 'backflow', stage: n, text: '把失败案例回流到第 5 或第 6 阶段，开始下一轮' };
    if (n === 9) return { kind: 'monitor', stage: n, text: '持续监控；出现问题时发起迭代，或结束项目' };
    return { kind: 'advance', stage: n, text: `进入第 ${n + 1} 阶段：${S.stageByN(n + 1).name}` };
  }

  const api = { checkGate, nextStep, meets, actualProblem, stepsFinished, resultsCurrent, verText, GATES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Rules = api;
})(typeof window !== 'undefined' ? window : globalThis);
