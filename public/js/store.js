// 数据存储：浏览器 localStorage。单人使用，不需要后端数据库。
(function (root) {
  const { STAGES } = root.Stages;
  const KEY = 'ai-pm-workbench-v1';

  const uid = () => Math.random().toString(36).slice(2, 10);
  const now = () => new Date().toISOString();

  function makeStep(title, status) {
    return { id: uid(), title, status: status || 'todo', risk: '', note: '', output: '' };
  }

  function makeProject({ name, docText, analysis, stepsByStage }) {
    const stages = {};
    STAGES.forEach(s => {
      stages[s.n] = {
        steps: (stepsByStage[s.n] || []).map(t => makeStep(t)),
        fields: {},
        gatePassed: false,
        fromDoc: analysis && s.n < analysis.stageGuess
      };
    });
    const start = analysis ? analysis.stageGuess : 1;
    return root.Engine.ensure({
      id: uid(), name, createdAt: now(), iteration: 1,
      currentStage: start, risk: false,
      doc: { text: docText, type: analysis && analysis.docType, reason: analysis && analysis.reason, missing: analysis ? analysis.missing : [] },
      stages,
      log: [{
        id: uid(), t: now(), stage: start, stageName: '创建项目', type: 'create',
        decision: `创建项目，识别为${analysis ? analysis.docType : '未识别'}，从第 ${start} 阶段开始`,
        reason: '', rule: '', ai: analysis ? analysis.reason : ''
      }]
    });
  }

  // ---------- 示例项目：线索培育 Agent（数据均为示例值） ----------
  function demoProject() {
    const doc = `目前私域培育群约 5 万人，成交转化率只有约 0.8%，每月大约 400 单。群里其实有不少人在问课程、说自己的问题，但运营人员看不过来，很多有意向的人没被及时跟进。希望用 AI 识别群里的意向信号，把有意向的人及时转给销售，提高培育群的成交转化。`;
    const steps = {
      1: ['梳理培育群现状数据（人数、转化率、月成交）', '确定业务目标', '列出不可接受的结果', '确认预算与时间'],
      2: ['评估模型能否识别群聊里的意向信号', '确认群聊记录能否获取', '评估隐私与合规风险', '估算建设与运行成本', '给出可行性结论'],
      3: ['确定北极星指标：培育群成交转化率', '定义离线评测指标：漏检率、Agent 动作准确率', '定义护栏指标：转出候选成交率、销售侧无效工单率', '与业务负责人确认标准'],
      4: ['定义识别信号：明确咨询、直接指向课程的痛点需求', '设计双门槛转接与分配规则', '设计 Agent 边界与五类出口（终止、短路直推、产单、挂起观察、降级转人工）', '设计 RAG 口径库方案', '撰写 PRD 并组织评审'],
      5: ['抽取培育群历史聊天样本', '标注信号识别评测集', '标注 Agent 动作评测集', '评测集定稿'],
      6: ['搭建信号识别 Prompt', '整理 RAG 口径库', '配置 Agent 出口规则', '完成自测'],
      7: ['运行离线评测', '分析错误样例', '上传评测结果'],
      8: STAGES[7].steps, 9: STAGES[8].steps, 10: STAGES[9].steps
    };
    const p = makeProject({
      name: '线索培育 Agent（示例）', docText: doc,
      analysis: { docType: '需求描述', reason: '只有问题和大方向，没有成本收益论证，也没有功能方案。', stageGuess: 1, missing: ['目标值没写清：提升到多少算成功？', '预算和成本没有提到', '没有提到隐私、合规等风险'] },
      stepsByStage: steps
    });
    p.demo = true;
    p.currentStage = 7;
    for (let n = 1; n <= 6; n++) {
      p.stages[n].steps.forEach(s => { s.status = 'done'; });
      p.stages[n].fromDoc = false;
    }
    p.stages[7].steps[0].status = 'done';
    p.stages[7].steps[1].status = 'done';
    p.stages[7].steps[2].status = 'done';

    const F = (n, o) => Object.assign(p.stages[n].fields, o);
    F(1, { goal: '提升私域培育群的成交转化率（示例值：从约 0.8% 提升到 1.1% 以上）', unacceptable: '把无意向用户大量推给销售，造成销售侧无效工单激增；Agent 回复和课程口径不一致', budget: '示例值：建设约 30 万，月运行约 5 万' });
    F(2, { feasibility: '有条件可行', cost: '示例值：建设约 30 万，月运行约 5 万。条件：群聊记录需在用户授权范围内使用' });
    F(3, {
      metrics: [
        { id: 'm1', name: '培育群成交转化率', role: '北极星', op: '>=', threshold: 1.1, unit: '%' },
        { id: 'm2', name: '漏检率', role: '评测', op: '<=', threshold: 15, unit: '%' },
        { id: 'm3', name: 'Agent 动作准确率', role: '评测', op: '>=', threshold: 85, unit: '%' },
        { id: 'm4', name: '转出候选成交率', role: '护栏', op: '>=', threshold: 20, unit: '%' },
        { id: 'm5', name: '销售侧无效工单率', role: '护栏', op: '<=', threshold: 10, unit: '%' }
      ],
      minGraySample: 1000
    });
    F(4, { prd: '培育群语义信号识别 + Agent 双门槛转接 + RAG 口径库。只识别两类信号：明确咨询、直接指向课程的痛点需求。Agent 设五类出口：终止、短路直推、产单、挂起观察、降级转人工。', review: '通过', issues: '' });
    F(5, { evalset: '示例值：信号识别评测集约 250 条（其中有意向样本 115 条：明确咨询 55、痛点需求 60），Agent 动作评测集约 150 条，均来自历史群聊并人工标注', evalSize: 250 });
    F(6, { build: '信号识别 Prompt v3；RAG 口径库约 2000 条；五类出口规则已配置' });
    F(7, {
      evalResults: { m2: 22, m3: 88 },
      errors: '【分类型统计，示例值】有意向样本 115 条，漏检 25 条（约 22%）：痛点需求类 60 条中漏检 19 条（约 32%），明确咨询类 55 条中漏检 6 条（约 11%）\n「孩子数学一直上不去，愁死了」—— 痛点需求，未识别\n「我家这个一考试就紧张，有没有办法」—— 痛点需求，未识别\n「最近孩子作业拖拉得厉害」—— 痛点需求，未识别\n「这课是不是只适合小学生」—— 明确咨询，已识别（对照）'
    });
    [2, 3, 4].forEach(n => { p.stages[n].gatePassed = true; });
    p.stages[7].fields.evalMeta = { std: 1, evalset: 1, build: 1, at: new Date(Date.UTC(2025, 8, 20, 6)).toISOString() };
    p.metricHistory = [{ t: new Date(Date.UTC(2025, 8, 20, 6)).toISOString(), stage: 7, iteration: 1, ver: { std: 1, evalset: 1, build: 1 }, values: { m2: 22, m3: 88 } }];

    const d = (day, h) => new Date(Date.UTC(2025, 7, day, h)).toISOString();
    p.log = [
      { id: uid(), t: d(4, 2), stage: 1, stageName: '创建项目', type: 'create', decision: '创建项目，识别为需求描述，从第 1 阶段开始', reason: '', rule: '', ai: '' },
      { id: uid(), t: d(11, 6), stage: 2, stageName: '是否立项', type: 'gate', decision: '采纳建议：进入第 3 阶段', reason: '', approver: '业务负责人（示例）', opinion: '同意立项，群聊数据须在授权范围内使用', rule: '6/6 项通过', ai: '可以立项，但要把"条件"写进第 3 阶段的验收标准。' },
      { id: uid(), t: d(15, 7), stage: 3, stageName: '标准确认', type: 'gate', decision: '采纳建议：进入第 4 阶段', reason: '', approver: '业务负责人（示例）', opinion: '标准确认', rule: '5/5 项通过', ai: '规则全部满足。' },
      { id: uid(), t: d(25, 8), stage: 4, stageName: '评审通过', type: 'gate', decision: '采纳建议：进入第 5 阶段', reason: '', approver: '评审会（示例）', opinion: '', rule: '2/2 项通过', ai: '评审已通过，评测集与构建可并行。' }
    ];
    p.createdAt = d(4, 2);
    return p;
  }

  const Store = {
    state: { projects: [], activeId: null },
    load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) this.state = JSON.parse(raw);
      } catch (e) { this.loadFailed = true; }
      (this.state.projects || []).forEach(p => root.Engine.ensure(p));
      if (!this.state.projects || this.state.projects.length === 0) {
        const p = demoProject();
        this.state = { projects: [p], activeId: p.id };
      }
    },
    save() {
      try { localStorage.setItem(KEY, JSON.stringify(this.state)); this.saveFailed = false; }
      catch (e) {
        if (!this.saveFailed && this.onError) this.onError('保存失败：浏览器存储空间不足或不可用，刚才的修改只在本次页面里有效。请导出项目备份。');
        this.saveFailed = true;
      }
    },
    active() { return this.state.projects.find(p => p.id === this.state.activeId) || null; },
    add(p) { this.state.projects.unshift(p); this.state.activeId = p.id; this.save(); },
    remove(id) {
      this.state.projects = this.state.projects.filter(p => p.id !== id);
      this.state.activeId = this.state.projects[0] ? this.state.projects[0].id : null;
      this.save();
    },
    resetDemo() {
      const p = demoProject();
      this.state.projects = this.state.projects.filter(x => !x.demo);
      this.state.projects.unshift(p);
      this.state.activeId = p.id;
      this.save();
    },
    log(p, entry) { p.log.push({ id: uid(), t: now(), ...entry }); },
    uid, makeStep, makeProject, demoProject
  };

  root.Store = Store;
})(window);
