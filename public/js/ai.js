// AI 建议层。两种模式：
//   model —— 通过本地 server.js 代理调用兼容 OpenAI 接口的大模型
//   demo  —— 没有配置模型时，用内置规则模板生成建议，保证演示稳定
(function (root) {
  const { STAGES, stageByN } = root.Stages;

  const AI = { mode: 'demo', modelName: '', available: false };

  AI.init = async function () {
    try {
      const r = await fetch('api/config');
      if (!r.ok) throw new Error();
      const c = await r.json();
      AI.available = !!c.aiEnabled;
      AI.modelName = c.model || '';
      AI.mode = AI.available ? 'model' : 'demo';
    } catch (e) {
      AI.available = false; AI.mode = 'demo';
    }
  };

  async function callModel(system, user) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const r = await fetch('api/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
        signal: ctrl.signal
      });
      const data = await r.json().catch(e => { if (e.name === 'AbortError') throw e; return {}; });
      if (!r.ok) throw new Error(data.error || '模型调用失败');
      return parseJSON(data.content);
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('模型响应超时（60 秒）');
      throw e;
    } finally { clearTimeout(timer); }
  }

  function parseJSON(text) {
    const clean = String(text).replace(/```json|```/g, '').trim();
    const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
    if (a < 0 || b < 0) throw new Error('模型没有返回 JSON');
    return JSON.parse(clean.slice(a, b + 1));
  }

  const clampStage = n => Math.min(10, Math.max(1, parseInt(n, 10) || 1));
  const stageList = () => STAGES.map(s => `${s.n}. ${s.name}${s.key ? `（关键节点：${s.gate}）` : ''}`).join('\n');

  // ---------- 1. 文档判断 + 拆解 ----------

  // docs: [{name, text}]，可以是一份也可以是多份
  const TYPES = ['需求描述', 'BRD', 'PRD', '评审纪要', '评测报告', '其他材料'];
  const TYPE_STAGE = { '需求描述': 1, 'BRD': 2, 'PRD': 4, '评审纪要': 5, '评测报告': 7, '其他材料': 1 };

  function joinDocs(docs) {
    return docs.map((d, i) => `=== 文件 ${i + 1}：${d.name} ===\n${d.text}`).join('\n\n');
  }

  AI.analyze = async function (docs) {
    if (AI.mode === 'model') {
      try {
        const out = await callModel(
          `你是资深 AI 产品经理助手。用户会给你同一个 AI 项目的一份或多份文档。你要做三件事：
1）逐个文件判断类型（${TYPES.join(' / ')}），各用一句话说明理由；
2）综合所有文件，判断项目当前处于哪个阶段（以进度最靠后、且有实际产出的文件为准），并列出项目层面缺失的关键信息；
3）按下面固定的 10 个阶段，为每个阶段列出 2-5 个"该做什么"的步骤。步骤只写要做的事，不要替用户编造答案、数字或结论。

固定阶段：
${stageList()}

只返回 JSON，不要任何其他文字：
{"projectName":"根据文档内容拟定的项目名，不超过 12 个字，不要带文档类型或版本号","files":[{"name":"文件名","type":"类型","reason":"一句话理由"}],"stageGuess":1,"reason":"为什么从这个阶段开始","missing":["缺失信息1"],"steps":{"1":["步骤"],...,"10":["步骤"]}}`,
          joinDocs(docs)
        );
        return normalizeAnalysis(out, docs, 'model');
      } catch (e) {
        const fb = demoAnalyze(docs);
        fb.warning = `模型调用失败，已改用演示模式：${e.message}`;
        return fb;
      }
    }
    return demoAnalyze(docs);
  };

  function summarizeTypes(files) {
    const uniq = [...new Set(files.map(f => f.type))];
    return files.length === 1 ? uniq[0] : `${uniq.join('、')}（共 ${files.length} 份）`;
  }

  function normalizeAnalysis(o, docs, source) {
    const steps = {};
    STAGES.forEach(s => {
      const arr = o.steps && (o.steps[s.n] || o.steps[String(s.n)]);
      steps[s.n] = Array.isArray(arr) && arr.length ? arr.map(String).slice(0, 8) : s.steps.slice();
    });
    const byName = {};
    (Array.isArray(o.files) ? o.files : []).forEach(f => { byName[f.name] = f; });
    const files = docs.map(d => {
      const f = byName[d.name] || {};
      return { name: d.name, type: TYPES.includes(f.type) ? f.type : '其他材料', reason: String(f.reason || '') };
    });
    const pn = String(o.projectName || '').trim();
    return {
      projectName: pn && pn.length <= 20 ? pn : guessName(docs),
      files, docType: summarizeTypes(files),
      reason: String(o.reason || ''),
      stageGuess: clampStage(o.stageGuess),
      missing: Array.isArray(o.missing) ? o.missing.map(String) : [],
      steps, source
    };
  }

  function classify(t) {
    const has = words => words.some(w => t.includes(w));
    if (has(['评测结果', '评测报告', '测试结果', '错误样例', 'bad case', 'Bad case'])) return ['评测报告', '包含评测结果或错误样例，说明已经进入评测验证。'];
    if (has(['准确率', '召回率', '漏检率']) && has(['样本数', '评测集'])) return ['评测报告', '包含按样本统计的评测指标，属于评测结果明细。'];
    if (has(['评审']) && has(['纪要', '会议', '参会', '结论'])) return ['评审纪要', '记录了评审会的讨论和结论。'];
    if (has(['功能清单', '功能需求', '交互', '页面', '字段说明', 'PRD', '验收标准'])) return ['PRD', '包含功能、交互或验收层面的具体方案。'];
    if (has(['ROI', '收益', '投入产出', '立项', '商业价值', '市场规模'])) return ['BRD', '包含收益、成本或立项论证。'];
    if (has(['纪要', '会议', '周报', '参会'])) return ['其他材料', '会议或过程记录，不单独决定项目阶段。'];
    return ['需求描述', '只描述了问题和大方向，没有成本收益论证，也没有具体方案。'];
  }

  // 演示模式下的项目名拟定：优先用文档标题，其次用文件名，再次从正文里找"用 AI 做什么"
  const TYPE_WORDS = /(离线评测报告|评测结果明细|评测结果|评测报告|评审会议纪要|会议纪要|纪要|需求描述|需求文档|产品需求|立项说明|立项|BRD|PRD|示例|虚构|第.轮|v\d+(\.\d+)*|（[^）]*）|\([^)]*\))/gi;
  function cleanTitle(t) {
    return String(t).replace(/^#+\s*/, '').replace(TYPE_WORDS, ' ')
      .split(/[｜|:：—]|\s-\s/).map(x => x.replace(/^[\d\s_.\-]+/, '').replace(/[\s_\-·,，。]+$/g, '').trim()).filter(x => x.length >= 2)[0] || '';
  }
  function guessName(docs) {
    const count = {};
    const add = n => { if (n && n.length >= 2 && n.length <= 20 && !/[,，]/.test(n)) count[n] = (count[n] || 0) + 1; };
    docs.forEach(d => {
      const first = (d.text || '').split('\n').map(x => x.trim()).find(Boolean) || '';
      if (first.length <= 40) add(cleanTitle(first));
      const book = (d.text || '').match(/《([^》]{2,30})》/);
      if (book) add(cleanTitle(book[1]));
    });
    let best = Object.keys(count).sort((a, b) => count[b] - count[a] || a.length - b.length)[0];
    if (!best) {
      docs.forEach(d => { if (d.name !== '补充说明') add(cleanTitle(d.name.replace(/\.[^.]+$/, '').replace(/_/g, ' '))); });
      best = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
    }
    if (!best) {
      const all = docs.map(d => d.text).join('\n');
      const m = all.match(/用\s*AI\s*([^，,。；\n]{2,14})/);
      if (m) best = `AI ${m[1].trim()}`;
    }
    return best || '未命名项目';
  }
  AI.guessName = guessName;

  function demoAnalyze(docs) {
    const files = docs.map(d => { const [type, reason] = classify(d.text || ''); return { name: d.name, type, reason }; });
    let top = files[0], stageGuess = TYPE_STAGE[files[0].type];
    files.forEach(f => { if (TYPE_STAGE[f.type] > stageGuess) { stageGuess = TYPE_STAGE[f.type]; top = f; } });
    // 评审纪要里写明"不通过"时，停在第 4 阶段
    const all = docs.map(d => d.text).join('\n');
    if (top.type === '评审纪要' && /不通过/.test(all) && !/有条件通过|评审通过|结论：通过/.test(all)) stageGuess = 4;
    const has = words => words.some(w => all.includes(w));
    const missing = [];
    if (!/\d+(\.\d+)?\s*%/.test(all) || !has(['目标', '提升到', '达到'])) missing.push('目标值没写清：提升到多少算成功？');
    if (!has(['预算', '成本', '投入'])) missing.push('预算和成本没有提到');
    if (!has(['数据', '记录', '样本'])) missing.push('数据从哪来、能不能拿到没有说明');
    if (!has(['合规', '隐私', '授权', '风险'])) missing.push('没有提到隐私、合规等风险');
    if (!has(['不能', '不可接受', '底线', '避免'])) missing.push('没有说明哪些结果绝对不能接受');
    if (stageGuess >= 7 && !has(['回滚', '灰度'])) missing.push('还没有灰度和回滚方案');
    const steps = {};
    STAGES.forEach(s => { steps[s.n] = s.steps.slice(); });
    const reason = files.length > 1
      ? `以进度最靠后的文件为准：「${top.name}」是${top.type}，当前工作阶段判断为第 ${stageGuess} 阶段。这不代表前面阶段的产出都已存在，前面的阶段会标记为「未核验」，需要你对照材料确认。`
      : top.reason;
    return { projectName: guessName(docs), files, docType: summarizeTypes(files), reason, stageGuess, missing, steps, source: 'demo' };
  }

  // ---------- 2. 下一步建议 ----------

  AI.advise = async function (project, ctx) {
    if (AI.mode === 'model') {
      try {
        const out = await callModel(
          `你是资深 AI 产品经理助手，负责在项目推进时给出"下一步建议"。最终决定由产品经理做出，你只提供建议和理由。
建议要具体：指出问题出在哪，建议去哪个阶段做什么，并说明为什么不是别的路线。
信息不足时直接说明缺什么，不要编造数据。

固定阶段：
${stageList()}

只返回 JSON：
{"summary":"一句话建议","reason":"2-4 句理由，引用具体指标或错误样例；证据不足以下结论时，写成待验证的假设并给出验证方法","suggestedStage":数字,"alternatives":[{"stage":数字,"desc":"另一条路线及其代价"}]}
suggestedStage 只能是当前阶段、下一阶段，或之前的某个阶段；关键节点的规则没有全部通过时，不要建议前进。`,
          buildContext(project, ctx)
        );
        return {
          summary: String(out.summary || ''),
          reason: String(out.reason || ''),
          suggestedStage: clampStage(out.suggestedStage || ctx.stage),
          alternatives: (out.alternatives || []).slice(0, 3).map(a => ({ stage: clampStage(a.stage), desc: String(a.desc || '') })),
          source: 'model'
        };
      } catch (e) {
        const fb = demoAdvise(project, ctx);
        fb.warning = `模型调用失败，已改用演示模式：${e.message}`;
        return fb;
      }
    }
    return demoAdvise(project, ctx);
  };

  function buildContext(p, ctx) {
    const st = stageByN(ctx.stage);
    const fieldsDump = STAGES.map(s => {
      const x = p.stages[s.n];
      if (!x) return '';
      const done = x.steps.filter(z => z.status === 'done').length;
      const flds = JSON.stringify(x.fields || {});
      return `第${s.n}阶段 ${s.name}：步骤 ${done}/${x.steps.length} 完成；关卡${s.key ? (x.gatePassed ? '已通过' : '未通过') : '无'}；产出 ${flds}`;
    }).join('\n');
    const rules = (ctx.rules || []).map(r => `${r.pass ? '通过' : '未通过'}：${r.label}${r.detail ? '（' + r.detail + '）' : ''}`).join('\n') || '本阶段没有准入规则';
    const log = (p.log || []).slice(-6).map(l => `${l.stageName || ''} ${l.decision || ''} ${l.reason || ''}`).join('\n');
    // 关联材料摘录：当前阶段关联的材料，每份最多 1500 字，总计最多 6000 字
    const files = (p.doc && p.doc.files) || [];
    let budget = 6000;
    const ev = ((p.stages[ctx.stage] && p.stages[ctx.stage].evidence) || []).map(e => {
      const f = files.find(x => (e.id && x.id === e.id) || x.name === e.name);
      if (!f || budget <= 0) return `【${e.name}】（未读取原文）`;
      const take = Math.min(1500, budget); budget -= take;
      const t = String(f.text || '');
      return `【${e.type}：${e.name}】${t.length > take || f.truncated ? '（节选）' : ''}\n${t.slice(0, take)}`;
    }).join('\n\n');
    return `项目：${p.name}
当前阶段：第${ctx.stage}阶段 ${st.name}
场景：${ctx.kind === 'gate' ? '产品经理请求推进关键节点「' + st.gate + '」' : ctx.kind === 'backflow' ? '产品经理要把线上失败回流，开始下一轮。suggestedStage 只能是 5（失败属于评测集没覆盖的新类型）或 6（已知类型，直接调构建）' : '产品经理询问下一步'}

规则检查结果：
${rules}

各阶段情况：
${fieldsDump}

最近决策记录：
${log || '无'}

本阶段关联的材料：
${ev || '无'}`;
  }

  function demoAdvise(p, ctx) {
    const n = ctx.stage;
    const failed = (ctx.rules || []).filter(r => !r.pass);
    const base = { source: 'demo', alternatives: [] };
    const fields = (p.stages[n] && p.stages[n].fields) || {};

    // 示例项目的预设剧本：第 7 阶段漏检率未达标。结论写成待验证的假设，并给出验证方法
    if (p.demo && n === 7 && failed.some(r => r.label.includes('漏检'))) {
      return {
        ...base, preset: true,
        summary: '回到第 6 阶段，优先验证"Prompt 对隐含痛点表达识别不足"这个假设。',
        reason: '错误样例的分类型统计显示，漏检集中在痛点需求类（60 条中漏检 19 条，约 32%），明确咨询类较少（55 条中漏检 6 条，约 11%）。漏检样例多是"孩子数学一直上不去"这类没有直接提到课程的说法，所以优先怀疑识别环节。验证方法：在 Prompt 中补 3 到 5 条隐含痛点示例，用同一份评测集复测；如果痛点类漏检明显下降，假设成立；如果没有变化，再检查评测集里这类样本的标注口径是否一致。动作准确率 88% 达到了当前阈值，本轮不作为优先项，但不代表出口规则没有问题。',
        suggestedStage: 6,
        alternatives: [
          { stage: 5, desc: '如果复测后痛点类漏检没有改善，回到第 5 阶段核查这类样本的标注口径。' },
          { stage: 3, desc: '如果业务方能接受更高的漏检率，可以回到第 3 阶段调整阈值，但需要业务方确认并记录理由。' }
        ]
      };
    }

    // 可行性结论为不可行：规则已拦截
    if (n === 2 && failed.some(r => r.label.includes('不是「不可行」'))) {
      return { ...base, summary: '可行性结论为"不可行"，建议终止项目，或回到第 1 阶段重新界定问题。', reason: '规则已拦截立项。继续推进意味着在不可行的前提下投入成本。如果不可行的原因可以通过缩小范围解决，回到第 1 阶段重新定义目标；否则终止项目，记录原因。', suggestedStage: 1, alternatives: [{ stage: 2, desc: '如果你判断不可行的因素可以被解决，可以强制放行，但必须写明理由，项目会被标记风险。' }] };
    }

    const missingFill = failed.filter(r => !r.metricId && !r.label.includes('结论为通过'));
    const metricFail = failed.filter(r => r.metricId);

    if (ctx.kind === 'gate' && failed.length === 0) {
      if (false) {
        return { ...base, summary: '规则已满足，但可行性结论是"不可行"，建议不立项。', reason: '材料都齐了，结论本身是否定的。继续推进意味着在不可行的前提下投入成本。可以回到第 1 阶段重新界定问题范围，或者结束这个项目。', suggestedStage: 1, alternatives: [{ stage: 3, desc: '如果你判断不可行的因素可以被解决，可以强行立项，但要记录理由。' }] };
      }
      if (n === 2 && fields.feasibility === '有条件可行') {
        return { ...base, summary: '可以立项，但要把"条件"写进第 3 阶段的验收标准。', reason: '结论是有条件可行。条件如果不变成可检查的指标，后面很容易被忘掉。建议在第 3 阶段把这些条件设成护栏指标。', suggestedStage: 3, alternatives: [] };
      }
      return { ...base, summary: `关卡「${stageByN(n).gate}」的规则全部满足，可以进入第 ${n + 1} 阶段。`, reason: n === 4 ? '评审已通过。下一步评测集构建和构建调试可以并行，建议先把评测集的样本来源定下来，避免调完 Prompt 才发现没法评。' : n === 7 ? '评测指标全部达标。灰度前确认回滚方案，并提前约好灰度期间盯哪几个护栏指标。' : n === 8 ? '灰度期间护栏指标都没有越线，可以全量。全量后第 9 阶段要继续抽检线上样本。' : '前置条件都已具备，没有发现需要回头处理的问题。', suggestedStage: Math.min(10, n + 1), alternatives: [] };
    }

    if (ctx.kind === 'gate' && metricFail.length && n === 7) {
      const names = metricFail.map(r => r.detail).join('；');
      const errText = fields.errors || '';
      const dataProblem = /样本|数据|评测集|覆盖/.test(errText);
      return {
        ...base,
        summary: dataProblem ? '回到第 5 阶段，先补齐评测集里缺的样本类型。' : '回到第 6 阶段，针对错误样例调整 Prompt 或知识库。',
        reason: `未达标的指标：${names}。${errText ? '从错误样例看，' + (dataProblem ? '问题和样本覆盖有关，评测本身可能不准，先修评测集再判断模型效果。' : '错误集中在识别和回答环节，属于构建问题，优先调 Prompt 和知识库。') : '还没有上传错误样例，建议先补上，否则很难判断问题出在构建还是数据。'}`,
        suggestedStage: dataProblem ? 5 : 6,
        alternatives: [{ stage: 3, desc: '如果业务方能接受当前水平，可以回到第 3 阶段调整阈值，但需要业务方确认。' }]
      };
    }

    if (ctx.kind === 'gate' && metricFail.length && n === 8) {
      return {
        ...base,
        summary: '护栏指标越线，建议暂停扩量并回到第 6 阶段排查。',
        reason: `越线的指标：${metricFail.map(r => r.detail).join('；')}。护栏指标代表"不可接受的结果"，越线时继续放量风险最大。先按回滚方案控制影响，再回到构建阶段定位原因。`,
        suggestedStage: 6,
        alternatives: [{ stage: 4, desc: '如果问题出在方案本身（比如转人工规则设计不合理），回到第 4 阶段改方案并重新评审。' }]
      };
    }

    if (ctx.kind === 'gate' && n === 4 && fields.review === '不通过') {
      return { ...base, summary: '评审没通过，留在第 4 阶段修改方案后重新评审。', reason: '先把评审意见逐条记成遗留问题，判断哪些是方案问题、哪些是标准问题。如果争议集中在指标上，需要回到第 3 阶段。', suggestedStage: 4, alternatives: [{ stage: 3, desc: '如果争议在验收标准本身，回到第 3 阶段重新和业务方确认。' }] };
    }

    if (missingFill.length) {
      return {
        ...base,
        summary: `先留在第 ${n} 阶段，把缺的材料补齐。`,
        reason: `规则检查没通过的项：${missingFill.map(r => r.label).join('；')}。这些都是客观缺项，补齐后再推进。${n === 7 && missingFill.some(r => r.label.includes('第 3 阶段')) ? '验收标准没确认就做评测，等于没有判断依据。' : ''}`,
        suggestedStage: n,
        alternatives: []
      };
    }

    if (ctx.kind === 'backflow') return backflowAdvice(fields, base);

    // 非关卡：询问下一步
    const next = root.Rules.nextStep(p);
    if (next.kind === 'step') {
      return { ...base, summary: `继续当前阶段：${next.text}。`, reason: `第 ${n} 阶段还有未完成的步骤。${stageByN(n).desc}`, suggestedStage: n, alternatives: n === 5 ? [{ stage: 6, desc: '评测集构建和构建调试可以并行，人手够的话可以同时推进第 6 阶段。' }] : [] };
    }
    if (n === 10) return backflowAdvice(fields, base);
    return { ...base, summary: next.text + '。', reason: '当前阶段的步骤都已完成。', suggestedStage: next.kind === 'advance' ? n + 1 : n, alternatives: [] };
  }

  function backflowAdvice(fields, base) {
    const lines = (fields.failures || '').split('\n').filter(s => s.trim());
    const toEval = lines.some(l => /样本|没覆盖|新类型|新问题/.test(l));
    return {
      ...base,
      summary: toEval ? '回流到第 5 阶段，把新出现的失败类型加进评测集。' : '回流到第 6 阶段，针对线上失败调整构建。',
      reason: lines.length ? `已记录 ${lines.length} 条线上失败。${toEval ? '其中有评测集没覆盖到的新类型，先补评测集，下一轮评测才能发现同类问题。' : '这些失败属于已知类型，评测集已经覆盖，直接调构建更快。'}` : '还没有记录线上失败案例。建议先在本阶段补充，否则下一轮没有新的评测用例。',
      suggestedStage: toEval ? 5 : 6,
      alternatives: [{ stage: toEval ? 6 : 5, desc: toEval ? '如果时间紧，也可以先调构建，但同类问题下一轮评测时仍可能漏掉。' : '如果怀疑评测集覆盖不全，回到第 5 阶段补样本。' }]
    };
  }

  root.AI = AI;
})(window);
