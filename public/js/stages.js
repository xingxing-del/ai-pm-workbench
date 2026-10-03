// 阶段骨架：AI 项目的默认流程（不是行业统一标准）。AI 只负责往每个阶段里填"该做什么"。
(function (root) {
  const STAGES = [
    {
      n: 1, name: '业务与风险定义', key: false,
      desc: '说清要解决什么业务问题、哪些结果绝对不能接受、手里有多少预算。',
      fields: [
        { k: 'goal', label: '业务目标', type: 'textarea' },
        { k: 'unacceptable', label: '不可接受的结果', type: 'textarea' },
        { k: 'budget', label: '预算', type: 'text' }
      ],
      steps: ['梳理业务痛点与现状数据', '确定业务目标', '列出不可接受的结果', '确认预算与时间']
    },
    {
      n: 2, name: '可行性评估', key: true, gate: '是否立项',
      desc: '判断这件事适不适合用 AI 做，数据拿不拿得到，成本能不能接受。',
      fields: [
        { k: 'feasibility', label: '可行性结论', type: 'select', options: ['可行', '有条件可行', '不可行'] },
        { k: 'cost', label: '成本估算', type: 'text' }
      ],
      steps: ['评估模型能力是否够用', '确认数据能否获取', '评估合规与隐私风险', '估算建设与运行成本', '给出可行性结论']
    },
    {
      n: 3, name: '验收标准设计', key: true, gate: '标准确认',
      desc: '先定"什么算做对"，再开始做。把目标翻译成带阈值的指标。',
      fields: [
        { k: 'metrics', label: '指标', type: 'metrics' },
        { k: 'minGraySample', label: '灰度最少样本量（第 8 关会检查，样本不够就不能全量）', type: 'number' }
      ],
      steps: ['确定北极星指标及目标值', '定义离线评测指标及阈值', '定义护栏指标', '设定灰度最少样本量', '与业务方确认标准']
    },
    {
      n: 4, name: '方案设计与 PRD 评审', key: true, gate: '评审通过',
      desc: '设计方案、AI 能力边界和兜底方式，写成 PRD 并组织评审。',
      fields: [
        { k: 'prd', label: 'PRD 摘要或全文', type: 'textarea' },
        { k: 'review', label: '评审结论', type: 'select', options: ['通过', '有条件通过', '不通过'] },
        { k: 'issues', label: '遗留问题（每行一条，格式：问题｜处理方式）', type: 'textarea' }
      ],
      steps: ['设计方案与 AI 能力边界', '设计降级与兜底方案', '撰写 PRD', '组织 PRD 评审']
    },
    {
      n: 5, name: '评测集构建', key: false, parallelWith: 6,
      desc: '准备用来检验效果的样本和评分规则。可以和构建调试同时进行。',
      fields: [
        { k: 'evalset', label: '评测集说明（来源、标注方式、评分方式）', type: 'textarea' },
        { k: 'evalSize', label: '评测集样本量（条）', type: 'number' }
      ],
      steps: ['收集与清洗样本', '标注评测数据', '设计评分规则', '评测集定稿']
    },
    {
      n: 6, name: '构建与调试', key: false, parallelWith: 5,
      desc: '搭 Prompt、知识库、工具和工作流，并自测到可以送评。',
      fields: [{ k: 'build', label: '构建记录（版本、改动）', type: 'textarea' }],
      steps: ['搭建 Prompt 与工作流', '构建知识库', '联调工具与接口', '完成自测']
    },
    {
      n: 7, name: '评测验证', key: true, gate: '是否达标',
      desc: '用评测集跑一遍，对照验收标准看是否达标。',
      fields: [
        { k: 'evalResults', label: '录入评测结果', type: 'results', role: '评测' },
        { k: 'errors', label: '错误样例（每行一条）', type: 'textarea' }
      ],
      steps: ['运行离线评测', '分析错误样例', '上传评测结果']
    },
    {
      n: 8, name: '灰度发布', key: true, gate: '能否全量',
      desc: '小范围上线，盯住护栏指标，随时准备回滚。',
      fields: [
        { k: 'grayScope', label: '灰度范围', type: 'text' },
        { k: 'grayDuration', label: '灰度时长', type: 'text' },
        { k: 'graySample', label: '灰度样本量', type: 'number' },
        { k: 'grayResults', label: '录入灰度期间护栏指标', type: 'results', role: '护栏' },
        { k: 'rollback', label: '回滚方案', type: 'textarea' }
      ],
      steps: ['确定灰度范围与时长', '准备回滚方案', '灰度上线', '上传灰度数据']
    },
    {
      n: 9, name: '线上监控', key: false,
      desc: '全量后持续观察指标和线上样本，记录出现的问题。可以一直留在这一阶段；出现问题时发起迭代，或结束项目。',
      fields: [{ k: 'monitor', label: '监控记录', type: 'textarea' }],
      steps: ['搭建线上监控看板', '定期抽检线上样本', '记录线上问题']
    },
    {
      n: 10, name: '失败回流与迭代', key: false,
      desc: '把线上失败变成新的评测用例，回到评测集构建或构建调试，开始下一轮。',
      fields: [{ k: 'failures', label: '线上失败案例（每行一条）', type: 'textarea' }],
      steps: ['汇总线上失败案例', '把失败案例转为评测用例', '确定回流阶段']
    }
  ];

  const ROLES = ['北极星', '评测', '护栏'];

  function stageByN(n) { return STAGES.find(s => s.n === Number(n)); }

  const api = { STAGES, ROLES, stageByN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Stages = api;
})(typeof window !== 'undefined' ? window : globalThis);
