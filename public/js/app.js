(function () {
  const { STAGES, ROLES, stageByN } = window.Stages;
  const { Rules, AI, Store, Engine } = window;

  const ui = {
    view: 'project',      // project | create
    viewStage: null,      // 正在查看的阶段
    session: null,        // 决策台会话 {kind, stage, rules, advice, loading}
    draft: null           // 新建项目草稿
  };

  const $ = sel => document.querySelector(sel);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const timeStr = t => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const STATUS = { todo: '未开始', doing: '进行中', done: '已完成', skipped: '跳过' };
  const DECISION_TYPES = ['create', 'gate', 'force', 'next', 'backflow', 'advance', 'adjust', 'mark', 'version', 'close'];
  const LOG_GROUPS = [
    { key: 'all', label: '全部' },
    { key: 'decision', label: '决策', types: ['create', 'gate', 'force', 'next', 'backflow', 'advance', 'close'] },
    { key: 'version', label: '依据变更', types: ['version'] },
    { key: 'step', label: '步骤', types: ['status', 'adjust', 'mark'] },
    { key: 'edit', label: '产出修改', types: ['edit'] },
    { key: 'material', label: '材料', types: ['material'] },
    { key: 'note', label: '手动记录', types: ['note'] }
  ];
  const groupOf = t => (LOG_GROUPS.find(g => g.types && g.types.includes(t)) || { label: '其他' }).label;
  const fullTime = t => new Date(t).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  // 产出修改：同一字段 5 分钟内的连续修改合并成一条，保留最初的旧值和最新的新值
  const full = v => typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v == null || v === '' ? '（空）' : v);
  const brief = full; // 存储保留全文，显示时再折叠
  function longText(t) {
    t = String(t == null ? '' : t);
    return t.length > 80 ? `${esc(t.slice(0, 80))}…<details class="more"><summary>展开全文</summary><pre class="doc">${esc(t)}</pre></details>` : esc(t);
  }
  function logEdit(p, n, key, text, before, after) {
    const last = p.log[p.log.length - 1];
    if (last && last.type === 'edit' && last.editKey === `${n}:${key}` && Date.now() - new Date(last.t).getTime() < 5 * 60 * 1000) {
      last.decision = text; last.t = new Date().toISOString();
      if (after !== undefined) last.after = brief(after);
      return;
    }
    Store.log(p, { stage: n, stageName: stageByN(n).name, type: 'edit', editKey: `${n}:${key}`, decision: text, reason: '', rule: '', ai: '',
      ...(before !== undefined || after !== undefined ? { before: brief(before), after: brief(after) } : {}) });
  }

  function openLog(filter) {
    const p = Store.active(); ui.logFilter = filter || ui.logFilter || 'all';
    const g = LOG_GROUPS.find(x => x.key === ui.logFilter);
    const list = p.log.filter(l => !g.types || g.types.includes(l.type)).slice().reverse();
    const dlg = $('#dialog');
    dlg.innerHTML = `<div class="dlg wide logdlg">
      <div class="card-head"><h3>项目日志：${esc(p.name)}</h3><button class="icon" data-act="closeDlg" aria-label="关闭">×</button></div>
      <form class="lognote" data-form="note">
        <textarea name="note" rows="2" placeholder="写一条手动记录，例如：和算法对齐了漏检率阈值，下周一复评"></textarea>
        <button class="btn primary">记一笔</button>
      </form>
      <div class="filters">${LOG_GROUPS.map(x => `<button class="filter ${x.key === ui.logFilter ? 'on' : ''}" data-act="logFilter" data-k="${x.key}">${x.label}<small>${x.types ? p.log.filter(l => x.types.includes(l.type)).length : p.log.length}</small></button>`).join('')}</div>
      <ol class="timeline">${list.map(l => `
        <li class="tl-${l.type}">
          <div class="tl-meta"><time>${fullTime(l.t)}</time><span class="tag">${groupOf(l.type)}</span><span>第 ${l.stage} 阶段</span></div>
          <p>${l.type === 'note' ? '' : `<b>${esc(l.stageName)}</b>`}${esc(l.decision)}</p>
          ${l.rule ? `<p class="log-sub">规则：${esc(l.rule)}</p>` : ''}
          ${l.ai ? `<p class="log-sub">AI：${esc(l.ai)}</p>` : ''}
          ${l.approver ? `<p class="log-approver">批准人：${esc(l.approver)}${l.opinion ? `　意见：${esc(l.opinion)}` : ''}</p>` : ''}
          ${l.before !== undefined ? `<div class="log-sub">修改前：${longText(l.before)}<br>修改后：${longText(l.after)}</div>` : ''}
          ${l.reason ? `<p class="log-reason">原因：${esc(l.reason)}</p>` : ''}
          ${l.snapshot ? `<button class="link snap-link" data-act="viewSnap" data-id="${esc(l.id)}">查看当时依据</button>` : ''}
        </li>`).join('') || '<li class="empty">这个分类下还没有记录。</li>'}</ol>
    </div>`;
    if (!dlg.open) { dlg.onclose = null; dlg.showModal(); }
  }

  // ---------- 原因弹窗 ----------
  function ask(title, desc, opts = {}) {
    return new Promise(resolve => {
      const dlg = $('#dialog');
      dlg.innerHTML = `
        <form method="dialog" class="dlg">
          <h3>${esc(title)}</h3>
          ${desc ? `<p class="dlg-desc">${esc(desc)}</p>` : ''}
          ${opts.select ? `<label class="fld"><span>${esc(opts.selectLabel || '选择')}</span><select id="dlgSelect">${opts.select.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></label>` : ''}
          ${opts.input ? `<label class="fld"><span>${esc(opts.input.label)}</span><input id="dlgInput" value="${esc(opts.input.value || '')}" placeholder="${esc(opts.input.placeholder || '')}"></label>` : ''}
          <label class="fld"><span>${esc(opts.label || '原因')}</span>
            <textarea id="dlgText" rows="3" placeholder="${esc(opts.placeholder || '写清楚为什么，这条会进入决策记录')}"></textarea></label>
          <p class="dlg-err" id="dlgErr"></p>
          <div class="dlg-actions">
            <button value="cancel" class="btn ghost">取消</button>
            <button value="ok" class="btn primary" id="dlgOk">${esc(opts.ok || '确认')}</button>
          </div>
        </form>`;
      const done = v => { dlg.close(); resolve(v); };
      $('#dlgOk').onclick = e => {
        e.preventDefault();
        const text = $('#dlgText').value.trim();
        const input = opts.input ? $('#dlgInput').value.trim() : null;
        if (opts.input && opts.input.required && !input) { $('#dlgErr').textContent = `请填写${opts.input.label}。`; $('#dlgInput').focus(); return; }
        if (!text && !opts.optional) { $('#dlgErr').textContent = `请填写${opts.label || '原因'}。`; return; }
        done({ text, select: opts.select ? $('#dlgSelect').value : null, input });
      };
      dlg.onclose = null;
      setTimeout(() => { dlg.onclose = () => resolve(null); }, 0); // 避开上一个弹窗关闭时排队的 close 事件
      dlg.querySelector('[value=cancel]').onclick = e => { e.preventDefault(); done(null); };
      dlg.showModal();
      setTimeout(() => { const i = $('#dlgInput'); (i && !i.value ? i : $('#dlgText')).focus(); }, 30);
    });
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- 渲染 ----------
  function render() {
    renderTopbar();
    const p = Store.active();
    $('#main').className = 'main' + (ui.view === 'create' || !p ? '' : ' shell');
    if (ui.view === 'create' || !p) { renderCreate(); return; }
    if (ui.viewStage == null) ui.viewStage = p.currentStage;
    $('#main').innerHTML = `
      <header id="header"></header>
      <div id="materials"></div>
      <div class="work">
        <nav id="track" aria-label="项目阶段"></nav>
        <section id="stagePanel" class="stage-panel"></section>
        <aside id="desk" class="desk"></aside>
      </div>`;
    renderHeader(p); renderTrack(p); renderStage(p); renderDesk(p); renderMaterials(p);
  }

  function renderTopbar() {
    const s = Store.state;
    setTimeout(() => { const f = $('#importFile'); if (f) f.onchange = e => { if (e.target.files[0]) importProject(e.target.files[0]); e.target.value = ''; }; });
    $('#topbar').innerHTML = `
      <div class="brand">
        <div class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></div>
        <strong>AI 产品工作台</strong>
      </div>
      ${s.projects.length ? `<label class="switch"><span class="sr">切换项目</span>
        <select id="projSel">${s.projects.map(p => `<option value="${esc(p.id)}" ${p.id === s.activeId && ui.view !== 'create' ? 'selected' : ''}>${esc(p.name)}（第 ${p.currentStage}/10 阶段${p.risk ? '，有风险' : ''}）</option>`).join('')}
        ${ui.view === 'create' ? '<option selected disabled>正在新建项目</option>' : ''}</select></label>` : ''}
      <button class="btn primary" data-act="new">新建项目</button>
      <span class="grow"></span>
      <label class="link import-link" title="导入之前导出的项目 JSON">导入项目<input type="file" id="importFile" accept=".json,application/json" hidden></label>
      <span class="mode" title="${AI.available ? '' : '没有配置模型，建议由内置规则模板生成'}">
        <span class="mode-dot ${AI.mode}"></span>${AI.mode === 'model' ? `AI：${esc(AI.modelName || '已接入模型')}` : 'AI：演示模式'}
        ${AI.available ? `<button class="link" data-act="toggleMode">${AI.mode === 'model' ? '切到演示' : '切回模型'}</button>` : ''}
      </span>
      <button class="link" data-act="resetDemo">重置示例项目</button>`;
  }

  // 导入：先完整校验并规范化成新对象，全部通过后才写入；失败不改变已有数据
  function normalizeImport(d) {
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    const str = (v, dflt = '') => typeof v === 'string' ? v : dflt;
    if (!isObj(d)) throw new Error('不是有效的项目文件');
    if (!str(d.name).trim()) throw new Error('缺少项目名称');
    if (!isObj(d.stages)) throw new Error('缺少阶段数据');
    const cur = Number(d.currentStage);
    if (!Number.isInteger(cur) || cur < 1 || cur > 10) throw new Error('当前阶段必须是 1 到 10');
    const stages = {};
    STAGES.forEach(s => {
      const st = d.stages[s.n];
      if (!isObj(st)) throw new Error(`缺少第 ${s.n} 阶段`);
      if (!Array.isArray(st.steps)) throw new Error(`第 ${s.n} 阶段的步骤不是列表`);
      stages[s.n] = {
        steps: st.steps.map(x => {
          if (!isObj(x) || !str(x.title).trim()) throw new Error(`第 ${s.n} 阶段有无效步骤`);
          return { id: Store.uid(), title: x.title, status: ['todo', 'doing', 'done', 'skipped'].includes(x.status) ? x.status : 'todo', risk: str(x.risk), note: str(x.note), output: str(x.output) };
        }),
        fields: isObj(st.fields) ? JSON.parse(JSON.stringify(st.fields)) : {},
        gatePassed: !!st.gatePassed, forced: !!st.forced, lastGate: null, fromDoc: !!st.fromDoc,
        evidence: Array.isArray(st.evidence) ? st.evidence.filter(isObj).map(e => ({ id: str(e.id), name: str(e.name), type: str(e.type, '未识别') })) : []
      };
    });
    const m = stages[3].fields.metrics;
    if (m !== undefined) {
      if (!Array.isArray(m)) throw new Error('指标不是列表');
      stages[3].fields.metrics = m.filter(isObj).map(x => ({ id: /^[\w-]{1,40}$/.test(x.id) ? x.id : Store.uid(), name: str(x.name), role: ['北极星', '评测', '护栏'].includes(x.role) ? x.role : '评测', op: x.op === '<=' ? '<=' : '>=', threshold: x.threshold === '' || x.threshold == null ? '' : Number(x.threshold), unit: str(x.unit) }));
    }
    const ver = isObj(d.ver) ? d.ver : {};
    const vi = v => Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : 1;
    const doc = isObj(d.doc) ? d.doc : {};
    const p = {
      id: Store.uid(), name: d.name.trim(), createdAt: str(d.createdAt, new Date().toISOString()),
      iteration: vi(d.iteration), currentStage: cur, risk: !!d.risk,
      status: ['active', 'closed', 'terminated'].includes(d.status) ? d.status : 'active', statusReason: str(d.statusReason),
      ver: { std: vi(ver.std), evalset: vi(ver.evalset), build: vi(ver.build) },
      doc: { text: str(doc.text), type: str(doc.type), reason: str(doc.reason), missing: Array.isArray(doc.missing) ? doc.missing.map(String) : [],
        files: Array.isArray(doc.files) ? doc.files.filter(isObj).map(f => ({ ...f, id: str(f.id) || undefined, name: str(f.name, '未命名材料'), type: str(f.type, '未识别'), text: str(f.text) })) : [] },
      stages,
      log: (Array.isArray(d.log) ? d.log : []).filter(isObj).map(l => ({ ...l, id: Store.uid(), stageName: str(l.stageName), decision: str(l.decision), reason: str(l.reason), rule: str(l.rule), ai: str(l.ai), type: str(l.type, 'note') }))
    };
    return Engine.ensure(p);
  }

  async function importProject(file) {
    let p;
    try { p = normalizeImport(JSON.parse(await file.text())); }
    catch (err) { toast(`导入失败：${err.message}`); return; }
    if (Store.state.projects.some(x => x.name === p.name)) p.name += '（导入）';
    Store.log(p, { stage: p.currentStage, stageName: '导入项目', type: 'note', decision: `从文件「${file.name}」导入`, reason: '', rule: '', ai: '' });
    Store.add(p); ui.view = 'project'; ui.viewStage = null; ui.session = null; render(); toast('项目已导入');
  }

  // ---------- 导出：决策报告（给人看）与项目备份（给程序读） ----------
  const REPORT_TYPES = ['gate', 'force', 'next', 'backflow', 'advance', 'close'];
  const mdEsc = t => String(t == null ? '' : t).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const GATE_STATE = (p, s) => { const st = p.stages[s.n]; if (st.gatePassed) return st.forced ? '强制放行' : '已通过'; if (s.n < p.currentStage) return '无效（未确认或依据变化后失效）'; return st.lastGate === 'fail' ? '未通过' : '尚未到达'; };

  function decisionMd(p, l) {
    const sn = l.snapshot, out = [];
    out.push(`### ${fullTime(l.t)}　第 ${l.stage} 阶段「${l.stageName}」`, '');
    out.push(`**决定**：${l.decision}`, '');
    if (l.approver) out.push(`**批准人**：${l.approver}${l.opinion ? `　**批准意见**：${l.opinion}` : ''}`, '');
    if (l.reason) out.push(`**原因**：${l.reason}`, '');
    if (!sn) {
      if (l.rule) out.push(`**规则检查**：${l.rule}`, '');
      if (l.ai) out.push(`**AI 建议**：${l.ai}`, '');
      out.push('*这条记录没有保存完整依据快照。*', '');
    }
    if (sn) {
      out.push(`**当时依据**：${Rules.verText(sn.ver, 7)}`, '');
      if (sn.rules.length) {
        out.push('**规则检查**', '', ...sn.rules.map(r => `- ${r.pass ? '✓' : '✕'} ${r.label}${r.detail ? `（${r.detail}）` : ''}`), '');
      }
      const ms = sn.metrics.filter(m => m.actual !== undefined && m.actual !== '' && m.actual !== null);
      if (ms.length) {
        out.push('**指标实测**', '', '| 指标 | 类型 | 标准 | 实测 | 结果 |', '|---|---|---|---|---|');
        ms.forEach(m => { const ok = Rules.meets(m, m.actual); out.push(`| ${mdEsc(m.name)} | ${m.role} | ${m.op === '<=' ? '≤' : '≥'} ${m.threshold}${m.unit} | ${m.actual}${m.unit} | ${ok === null ? '格式无效' : ok ? '达标' : '未达标'} |`); });
        out.push('');
      }
      if (sn.evidence && sn.evidence.length) out.push(`**依据材料**：${sn.evidence.map(e => `${e.name}（${e.type}）`).join('、')}`, '');
      const a = sn.advice;
      if (a) {
        out.push(`**AI 建议**（${a.preset ? '预设演示建议' : a.source === 'model' ? '模型生成' : '规则模板生成'}）：${a.summary}`, '');
        if (a.reason) out.push(`> ${a.reason}`, '');
        if (a.alternatives && a.alternatives.length) out.push('备选路线：', '', ...a.alternatives.map(x => `- 第 ${x.stage} 阶段：${x.desc}`), '');
      }
    }
    return out.join('\n');
  }

  function buildReport(p, onlyId) {
    const decisions = p.log.filter(l => onlyId ? l.id === onlyId : REPORT_TYPES.includes(l.type));
    const forced = p.log.filter(l => l.type === 'force');
    const revoked = p.log.filter(l => l.type === 'version');
    const lines = [];
    lines.push(`# 决策报告：${p.name}`, '');
    lines.push(`生成时间：${fullTime(new Date().toISOString())}`, '');
    if (p.demo) lines.push('> 示例项目，报告中的数字均为示例值。', '');
    if (!onlyId) {
      lines.push('## 项目概况', '');
      lines.push(`- 当前阶段：第 ${p.currentStage} 阶段「${stageByN(p.currentStage).name}」，第 ${p.iteration} 轮`);
      lines.push(`- 项目状态：${{ active: '进行中', closed: '已结束', terminated: '已终止' }[p.status]}${p.statusReason ? `（${p.statusReason}）` : ''}`);
      lines.push(`- 风险标记：${p.risk ? '有（存在强制放行）' : '无'}`);
      lines.push(`- 当前依据：${Rules.verText(p.ver, 7)}`, '');
      lines.push('## 关卡状态', '', '| 关卡 | 状态 |', '|---|---|');
      STAGES.filter(s => s.key).forEach(s => lines.push(`| 第 ${s.n} 关：${s.gate} | ${GATE_STATE(p, s)} |`));
      lines.push('');
      const ms = p.stages[3].fields.metrics || [];
      if (ms.length) {
        lines.push('## 验收标准', '', '| 指标 | 类型 | 标准 |', '|---|---|---|');
        ms.forEach(m => lines.push(`| ${mdEsc(m.name)} | ${m.role} | ${m.op === '<=' ? '≤' : '≥'} ${m.threshold}${m.unit || ''} |`));
        lines.push('');
      }
      const hist = p.metricHistory || [];
      const trendRows = ms.filter(m => m.role !== '北极星').map(m => {
        const n = m.role === '评测' ? 7 : 8;
        const vals = hist.filter(h => h.stage === n && h.values[m.id] !== undefined).map(h => `${h.values[m.id]}${m.unit || ''}`);
        return vals.length ? `| ${mdEsc(m.name)} | ${m.op === '<=' ? '≤' : '≥'} ${m.threshold}${m.unit || ''} | ${vals.join(' → ')} |` : null;
      }).filter(Boolean);
      if (trendRows.length) lines.push('## 指标趋势（历次关卡检查）', '', '| 指标 | 标准 | 历次结果 |', '|---|---|---|', ...trendRows, '');
      if (forced.length || revoked.length) {
        lines.push('## 风险、例外与依据变更', '');
        forced.forEach(l => lines.push(`- ${fullTime(l.t)} 强制放行第 ${l.stage} 关：${l.reason || '（未写原因）'}${l.approver ? `（批准人：${l.approver}）` : ''}`));
        revoked.forEach(l => lines.push(`- ${fullTime(l.t)} ${l.decision}`));
        lines.push('');
      }
      lines.push(`## 关键决策（${decisions.length} 次，按时间顺序）`, '');
    }
    if (!decisions.length) lines.push('还没有关键决策记录。', '');
    decisions.forEach(l => lines.push(decisionMd(p, l), '---', ''));
    lines.push('*由「AI 产品工作台」生成。规则检查只说明数据是否满足事先约定的标准，数据本身由产品经理录入。*');
    return lines.join('\n');
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a'); el.href = url; el.download = name; document.body.appendChild(el); el.click(); el.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const safeName = n => String(n).replace(/[\\/:*?"<>|]/g, '_');

  function openExport() {
    const p = Store.active();
    const n = p.log.filter(l => REPORT_TYPES.includes(l.type)).length;
    const dlg = $('#dialog');
    dlg.innerHTML = `<div class="dlg wide">
      <div class="card-head"><h3>导出</h3><button class="icon" data-act="closeDlg" aria-label="关闭">×</button></div>
      <div class="export-opts">
        <button class="export-opt" data-act="exportReport">
          <b>决策报告</b><span>Markdown 文件，给人看。包含项目概况、关卡状态、验收标准、风险与例外，以及 ${n} 次关键决策的依据（规则、实测、AI 建议、你的选择和原因）。可以直接发给业务方或贴进文档。</span>
        </button>
        <button class="export-opt" data-act="exportProj">
          <b>项目备份</b><span>JSON 文件，给程序读。包含项目的全部数据，用于换电脑或清缓存后通过「导入项目」恢复。</span>
        </button>
      </div>
      <p class="hint">只想导出某一次决定：在决策记录里点「查看当时依据」，弹窗底部有「导出这次决定」。</p>
    </div>`;
    if (!dlg.open) { dlg.onclose = null; dlg.showModal(); }
  }

  // ---------- 底部：补充材料 ----------
  function materialList(p) {
    if (p.doc.files && p.doc.files.length) return p.doc.files;
    return [{ name: '来源文档', type: p.doc.type, text: p.doc.text }];
  }

  // 只在材料显示的进度和当前阶段不一致等需要注意时，才在标题下方显示一条提醒
  function renderMaterials(p) {
    const m = ui.material && ui.material.pid === p.id ? ui.material : null;
    $('#materials').innerHTML = m && m.notice ? `<p class="notice mat-notice">${esc(m.notice)}<button class="link" data-act="closeNotice">知道了</button></p>` : '';
    const inp = $('#matFile');
    if (inp) inp.onchange = e => { addMaterials(p, e.target.files); e.target.value = ''; };
  }

  const whenText = f => f.addedAt ? `第 ${f.addedStage} 阶段${f.addedStageName ? `（${f.addedStageName}）` : ''}时补充` : '创建项目时上传';

  function openLinkMat() {
    const p = Store.active(), n = ui.viewStage, files = materialList(p);
    const linked = new Set((p.stages[n].evidence || []).map(e => e.name));
    const dlg = $('#dialog');
    dlg.innerHTML = `<div class="dlg wide">
      <div class="card-head"><h3>第 ${n} 阶段的依据材料</h3><button class="icon" data-act="closeDlg" aria-label="关闭">×</button></div>
      <p class="dlg-desc">勾选能证明这一阶段产出的材料。关联后会写进决策依据；第 4 关关联了 PRD 类材料，也视为 PRD 已记录。</p>
      <ul class="link-list">${files.map((f, i) => `<li><label><input type="checkbox" data-link="${i}" ${linked.has(f.name) ? 'checked' : ''}><span class="tag">${esc(f.type || '未识别')}</span>${esc(f.name)}<small>${esc(whenText(f))}</small></label></li>`).join('')}</ul>
      <div class="dlg-actions"><button class="btn ghost" data-act="closeDlg">取消</button><button class="btn primary" data-act="saveLinks">保存</button></div>
    </div>`;
    if (!dlg.open) { dlg.onclose = null; dlg.showModal(); }
  }

  function openMats() {
    const p = Store.active(), files = materialList(p);
    const groups = [];
    files.forEach((f, i) => {
      const key = whenText(f);
      let g = groups.find(x => x.key === key);
      if (!g) groups.push(g = { key, items: [] });
      g.items.push({ ...f, i });
    });
    const dlg = $('#dialog');
    dlg.innerHTML = `<div class="dlg wide matdlg">
      <div class="card-head"><h3>项目材料（${files.length} 份）</h3><button class="icon" data-act="closeDlg" aria-label="关闭">×</button></div>
      ${groups.map(g => `<h4 class="mat-group">${esc(g.key)}</h4>
        <ul class="mat-items">${g.items.map(f => `<li><details><summary><span class="tag">${esc(f.type || '未识别')}</span><span class="mi-name">${esc(f.name)}</span>${f.truncated ? `<small class="warn">已截断：原文 ${f.chars} 字，只保存前 20000 字</small>` : ''}${f.addedAt ? `<small>${fullTime(f.addedAt)}</small>` : ''}</summary><pre class="doc">${esc(f.text || '（没有保存原文）')}</pre></details></li>`).join('')}</ul>`).join('')}
    </div>`;
    dlg.onclose = null; dlg.showModal();
  }

  async function addMaterials(p, list) {
    if (!list || !list.length) return;
    ui.material = { pid: p.id, busy: true }; renderHeader(p); renderMaterials(p);
    const parsed = await window.Files.parseFiles(list);
    const ok = parsed.filter(f => f.ok);
    const bad = parsed.filter(f => !f.ok);
    if (!ok.length) { ui.material = { pid: p.id, notice: `没有读出内容：${bad.map(f => `${f.name}（${f.error}）`).join('；')}` }; if (Store.state.activeId === p.id && ui.view === 'project') { renderHeader(p); renderMaterials(p); } else toast('补充材料没有读出内容'); return; }
    const a = await AI.analyze(ok.map(f => ({ name: f.name, text: f.text })));
    const stillHere = () => Store.state.activeId === p.id && ui.view === 'project';
    if (!p.doc.files || !p.doc.files.length) p.doc.files = [{ name: '来源文档', type: p.doc.type, text: p.doc.text }];
    a.files.forEach(f => {
      const src = ok.find(x => x.name === f.name) || {};
      p.doc.files.push({ ...f, id: 'm' + Store.uid(), text: src.text || '', truncated: !!src.truncated, chars: src.chars, addedAt: new Date().toISOString(), addedStage: p.currentStage, addedStageName: stageByN(p.currentStage).name });
    });
    let notice = `已补充 ${ok.length} 份：${a.files.map(f => `${f.name}（${f.type}）`).join('、')}。`;
    if (a.stageGuess > p.currentStage) notice += `新材料显示项目可能已经到了第 ${a.stageGuess} 阶段，而当前记录在第 ${p.currentStage} 阶段。是否推进由你决定，可以在右侧决策台操作。`;
    if (bad.length) notice += ` 另有 ${bad.length} 份没有读出内容：${bad.map(f => f.name).join('、')}。`;
    Store.log(p, { stage: p.currentStage, stageName: '补充材料', type: 'material', decision: `补充 ${ok.length} 份材料：${a.files.map(f => `${f.name}（${f.type}）`).join('、')}`, reason: '', rule: '', ai: a.stageGuess > p.currentStage ? `材料显示可能已到第 ${a.stageGuess} 阶段` : '' });
    Store.save();
    const needAttention = a.stageGuess > p.currentStage || bad.length;
    ui.material = needAttention ? { pid: p.id, notice } : null;
    if (stillHere()) { renderHeader(p); renderMaterials(p); renderDesk(p); }
    if (!needAttention || !stillHere()) toast(`「${p.name}」已补充 ${ok.length} 份材料`);
  }

  function renderHeader(p) {
    $('#header').innerHTML = `
      <div class="h-main">
        <h1>${esc(p.name)}</h1>
        <p class="h-sub">
                    <span>第 ${p.iteration} 轮</span>
          ${p.risk ? '<span class="tag caution">有强制放行</span>' : ''}
          ${p.demo ? '<span class="tag">示例数据，数字均为示例值</span>' : ''}
        </p>
      </div>
      <div class="h-actions">
        <button class="btn ghost" data-act="openMats">项目材料 <span class="count">${materialList(p).length}</span></button>
        <button class="btn ghost" data-act="openLog">项目日志</button>
        <label class="btn ghost">${ui.material && ui.material.busy && ui.material.pid === p.id ? '读取中…' : '补充材料'}<input type="file" id="matFile" multiple accept="${window.Files.ACCEPT}" hidden></label>
        ${window.self === window.top ? '<button class="btn ghost" data-act="openExport">导出</button>' : ''}
        <button class="btn ghost danger" data-act="delete">删除项目</button>
      </div>`;
    const inp = $('#matFile');
    if (inp) inp.onchange = e => { addMaterials(p, e.target.files); e.target.value = ''; };
  }

  function lampState(p, s) {
    const st = p.stages[s.n];
    if (!s.key) return '';
    if (st.gatePassed) return st.forced ? 'forced' : 'go';
    if (st.lastGate === 'fail') return 'stop';
    return 'idle';
  }

  function renderTrack(p) {
    $('#track').innerHTML = `<ol class="rail">${STAGES.map(s => {
      const st = p.stages[s.n];
      const done = st.steps.filter(x => x.status === 'done' || x.status === 'skipped').length;
      const cls = [s.n === p.currentStage ? 'current' : '', s.n < p.currentStage ? 'past' : '', s.n === ui.viewStage ? 'viewing' : '', s.key ? 'key' : ''].join(' ');
      const lamp = lampState(p, s);
      return `<li class="station ${cls}">
        <button data-act="viewStage" data-n="${s.n}" aria-current="${s.n === p.currentStage ? 'step' : 'false'}">
          <span class="node ${lamp}" aria-hidden="true">${s.n}</span>
          <span class="st-name">${esc(s.name)}</span>
          <span class="st-meta">${s.key ? esc(s.gate) + '，' : ''}${done}/${st.steps.length}${st.fromDoc ? '，未核验' : ''}</span>
        </button></li>`;
    }).join('')}</ol>`;
  }

  function renderStage(p) {
    const n = ui.viewStage, s = stageByN(n), st = p.stages[n];
    $('#stagePanel').innerHTML = `
      <div class="sp-head">
        <h2>第 ${n} 阶段　${esc(s.name)}</h2>
        ${s.key ? `<span class="tag ${st.gatePassed ? (st.forced ? 'caution' : 'go') : ''}">关键节点：${esc(s.gate)}${st.gatePassed ? (st.forced ? '（强制放行）' : '（已通过）') : ''}</span>` : ''}
        ${n !== p.currentStage ? `<span class="tag">当前在第 ${p.currentStage} 阶段</span>` : ''}
      </div>
      <p class="sp-desc">${esc(s.desc)}${s.parallelWith ? `　可与第 ${s.parallelWith} 阶段并行。` : ''}</p>
      ${st.fromDoc ? `<p class="notice">这一阶段在当前工作阶段之前，创建项目时标记为「未核验」：系统不确定它的产出是否真的存在。请对照项目材料补全步骤和产出，再点「标记为已核验」。${s.key ? '核验只说明产出已对照材料，关卡还需要单独「检查并确认」。' : ''}<button class="link" data-act="verify">标记为已核验</button></p>` : ''}
      ${s.key && n < p.currentStage && !st.gatePassed ? `<p class="notice">第 ${n} 关当前无效（未确认，或依据变化后已失效）。<button class="link" data-act="confirmGate" data-n="${n}">检查并确认第 ${n} 关</button></p>` : ''}
      <h3 class="sec">步骤</h3>
      <ul class="steps">${st.steps.map((x, i) => stepRow(x, i, st.steps.length)).join('') || '<li class="empty">这个阶段还没有步骤，可以在下面添加。</li>'}</ul>
      <form class="addstep" data-form="addStep"><input name="title" placeholder="添加一个步骤" aria-label="新步骤名称"><button class="btn ghost">添加步骤</button></form>
      <h3 class="sec">阶段产出</h3>
      <div class="evidence">
        <span class="k">依据材料</span>
        ${(st.evidence || []).length ? st.evidence.map(e => `<span class="chip-sm"><span class="tag">${esc(e.type)}</span>${esc(e.name)}</span>`).join('') : '<span class="hint">还没有关联</span>'}
        <button class="link" data-act="linkMat">关联材料</button>
      </div>
      <div class="fields">${s.fields.map(f => fieldHTML(p, n, f)).join('')}</div>`;
  }

  function stepRow(x, i, len) {
    return `<li class="step ${esc(x.status)}" data-step="${esc(x.id)}">
      <div class="step-line">
        <select data-act="status" aria-label="步骤状态">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${x.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <span class="step-title">${esc(x.title)}</span>
        ${x.risk ? `<span class="tag caution" title="${esc(x.risk)}">风险</span>` : ''}
        <span class="step-tools">
          <button class="icon" data-act="risk" title="${x.risk ? '取消风险标记' : '标记风险'}" aria-label="风险">!</button>
          <button class="icon" data-act="note" title="备注与产出" aria-label="备注">✎</button>
          <button class="icon" data-act="up" ${i === 0 ? 'disabled' : ''} title="上移" aria-label="上移">↑</button>
          <button class="icon" data-act="down" ${i === len - 1 ? 'disabled' : ''} title="下移" aria-label="下移">↓</button>
          <button class="icon" data-act="del" title="删除" aria-label="删除">×</button>
        </span>
      </div>
      ${x.risk ? `<p class="step-risk">风险：${esc(x.risk)}</p>` : ''}
      <div class="step-more" ${x._open ? '' : 'hidden'}>
        <label class="fld"><span>备注</span><textarea data-sf="note" rows="2">${esc(x.note)}</textarea></label>
        <label class="fld"><span>这一步的产出</span><textarea data-sf="output" rows="2">${esc(x.output)}</textarea></label>
      </div>
      ${!x._open && (x.note || x.output) ? `<p class="step-peek">${esc(x.output || x.note)}</p>` : ''}
    </li>`;
  }

  function fieldHTML(p, n, f) {
    const v = p.stages[n].fields[f.k];
    if (f.type === 'textarea') return `<label class="fld"><span>${esc(f.label)}</span><textarea rows="3" data-field="${f.k}">${esc(v || '')}</textarea></label>`;
    if (f.type === 'number') return `<label class="fld fld-num"><span>${esc(f.label)}</span><input type="number" min="0" step="1" data-field="${f.k}" value="${esc(v ?? '')}"></label>`;
    if (f.type === 'text') return `<label class="fld"><span>${esc(f.label)}</span><input data-field="${f.k}" value="${esc(v || '')}"></label>`;
    if (f.type === 'select') return `<label class="fld"><span>${esc(f.label)}</span><select data-field="${f.k}"><option value="">请选择</option>${f.options.map(o => `<option ${v === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
    if (f.type === 'metrics') {
      const ms = v || [];
      return `<div class="metrics">
        <div class="m-row m-head"><span>指标名称</span><span>类型</span><span>方向</span><span>阈值</span><span>单位</span><span></span></div>
        ${ms.map(m => `<div class="m-row" data-metric="${m.id}">
          <input data-mf="name" value="${esc(m.name)}" aria-label="指标名称">
          <select data-mf="role" aria-label="类型">${ROLES.map(r => `<option ${m.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
          <select data-mf="op" aria-label="方向"><option value=">=" ${m.op === '>=' ? 'selected' : ''}>不低于</option><option value="<=" ${m.op === '<=' ? 'selected' : ''}>不高于</option></select>
          <input data-mf="threshold" type="number" step="any" value="${esc(m.threshold)}" aria-label="阈值">
          <input data-mf="unit" value="${esc(m.unit || '')}" aria-label="单位">
          <button class="icon" data-act="delMetric" aria-label="删除指标">×</button>
        </div>`).join('')}
        <button class="btn ghost" data-act="addMetric">添加指标</button>
        <p class="hint">北极星：最终业务结果。评测：上线前离线评测看的指标（第 7 阶段检查）。护栏：守住"不可接受的结果"（第 8 阶段检查）。</p>
      </div>`;
    }
    if (f.type === 'results') {
      const ms = (p.stages[3].fields.metrics || []).filter(m => m.role === f.role);
      if (!ms.length) return `<div class="fld"><span>${esc(f.label)}</span><p class="hint">第 3 阶段还没有定义${f.role}指标。</p></div>`;
      const res = v || {};
      const metaKey = n === 7 ? 'evalMeta' : 'grayMeta';
      const meta = p.stages[n].fields[metaKey];
      const stale = !!meta && Engine.hasValues(res) && !Rules.resultsCurrent(p, n);
      const verText = m => Rules.verText(m, n);
      const trend = trendCards(p, n, ms, res, stale);
      return `${trend}<div class="fld"><span>${esc(f.label)}${meta && !stale && Engine.hasValues(res) ? `<small class="ver">按 ${verText(meta)} 录入</small>` : ''}</span>
        ${stale ? `<p class="notice">这些结果是按 ${verText(meta)} 录入的，之后标准、评测集或构建发生了变化，结果已过期，不能用于放行。<button class="link" data-act="reResult" data-n="${n}">清空并按当前版本重新录入</button></p>` : ''}
        <div class="results ${stale ? 'stale' : ''}">${ms.map(m => {
        const ok = Rules.meets(m, res[m.id]), prob = Rules.actualProblem(m, res[m.id]);
        return `<label class="r-row"><span>${esc(m.name)}<small>标准 ${m.op === '<=' ? '≤' : '≥'} ${esc(m.threshold)}${esc(m.unit || '')}</small></span>
          <input type="number" step="any" data-result="${f.k}" data-mid="${m.id}" value="${esc(res[m.id] ?? '')}" aria-label="${esc(m.name)}实际值" ${stale ? 'disabled' : ''}>
          <b class="r-flag ${prob && prob !== 'empty' ? 'stop' : ok === null ? '' : ok ? 'go' : 'stop'}">${prob && prob !== 'empty' ? '格式无效' : ok === null ? '未填' : ok ? '达标' : '未达标'}</b></label>`;
      }).join('')}</div></div>`;
    }
    return '';
  }

  // ---------- 指标趋势卡片：历次关卡检查的结果 + 当前录入值，带阈值虚线 ----------
  function sparkline(m, pts) {
    const W = 260, H = 92, L = 10, R = 10, T = 18, B = 22;
    const t = Number(m.threshold);
    const vals = pts.map(x => x.v).concat(isFinite(t) ? [t] : []);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if ((m.unit || '').trim() === '%') { lo = Math.max(0, lo); hi = Math.min(100, hi); }
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.25; lo -= pad; hi += pad;
    const x = i => pts.length === 1 ? W / 2 : L + i * (W - L - R) / (pts.length - 1);
    const y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    const line = pts.map((pt, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(pt.v).toFixed(1)}`).join(' ');
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.name)}趋势">
      ${isFinite(t) ? `<line class="thr" x1="0" x2="${W}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>` : ''}
      ${pts.length > 1 ? `<path class="ln" d="${line}"/>` : ''}
      ${pts.map((pt, i) => { const ok = Rules.meets(m, pt.v); return `<g><title>${esc(pt.title)}</title><circle class="${ok ? 'go' : 'stop'} ${pt.current ? 'cur' : ''}" cx="${x(i).toFixed(1)}" cy="${y(pt.v).toFixed(1)}" r="4.5"/><text class="pv" x="${x(i).toFixed(1)}" y="${(y(pt.v) - 8).toFixed(1)}" text-anchor="middle">${esc(pt.v)}</text><text class="px" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(pt.label)}</text></g>`; }).join('')}
    </svg>`;
  }

  function trendCards(p, n, ms, res, stale) {
    const hist = (p.metricHistory || []).filter(h => h.stage === n);
    const cards = ms.map(m => {
      const pts = hist.filter(h => h.values[m.id] !== undefined).map((h, i) => ({ v: h.values[m.id], label: `第 ${i + 1} 次`, title: `${fullTime(h.t)}，第 ${h.iteration} 轮，${Rules.verText(h.ver, n)}` }));
      const cur = res[m.id];
      if (!stale && cur !== '' && cur != null && !Rules.actualProblem(m, cur) && (!pts.length || pts[pts.length - 1].v !== Number(cur))) pts.push({ v: Number(cur), label: '当前', title: '当前录入值，还没有做关卡检查', current: true });
      if (!pts.length) return '';
      const last = pts[pts.length - 1], prev = pts[pts.length - 2];
      const ok = Rules.meets(m, last.v);
      const diff = prev ? Math.round((last.v - prev.v) * 100) / 100 : null;
      return `<div class="tcard ${ok ? 'go' : 'stop'}">
        <div class="tc-head"><span class="tc-name">${esc(m.name)}<small>虚线为标准 ${m.op === '<=' ? '≤' : '≥'} ${esc(m.threshold)}${esc(m.unit || '')}</small></span><span class="tag ${ok ? 'go' : 'caution'}">${ok ? '达标' : '未达标'}</span></div>
        <div class="tc-val"><b>${esc(last.v)}${esc(m.unit || '')}</b>${diff !== null && diff !== 0 ? `<small>比上次${diff > 0 ? '高' : '低'} ${Math.abs(diff)}${m.unit === '%' ? ' 个百分点' : ''}</small>` : pts.length === 1 ? '<small>只有一次记录</small>' : ''}</div>
        ${sparkline(m, pts)}
      </div>`;
    }).filter(Boolean);
    return `<div class="trend" id="trend${n}">${cards.length ? `<p class="trend-title">指标趋势<small>每次点「推进关卡」都会记一笔；悬停圆点可看当时的依据修订</small></p><div class="tcards">${cards.join('')}</div>` : ''}</div>`;
  }

  // ---------- 决策台 ----------
  const STATUS_NAME = { closed: '项目已结束', terminated: '项目已终止' };

  function decisionItem(l) {
    return `<li class="log-${l.type}">
      <time>${timeStr(l.t)}</time>
      <p><b>${esc(l.stageName)}</b>${esc(l.decision)}</p>
      ${l.rule ? `<p class="log-sub">规则：${esc(l.rule)}</p>` : ''}
      ${l.ai ? `<p class="log-sub">AI 建议：${esc(l.ai)}</p>` : ''}
      ${l.approver ? `<p class="log-approver">批准人：${esc(l.approver)}${l.opinion ? `　意见：${esc(l.opinion)}` : ''}</p>` : ''}
      ${l.reason ? `<p class="log-reason">原因：${esc(l.reason)}</p>` : ''}
      ${l.snapshot ? `<button class="link snap-link" data-act="viewSnap" data-id="${esc(l.id)}">查看当时依据</button>` : ''}
    </li>`;
  }

  function renderDesk(p) {
    const n = p.currentStage, s = stageByN(n);
    const next = Rules.nextStep(p);
    const sess = ui.session && ui.session.stage === n && ui.session.pid === p.id ? ui.session : null;
    let top = '';
    if (p.status !== 'active') {
      top = `<div class="card status-card">
        <h3>${STATUS_NAME[p.status]}</h3>
        ${p.statusReason ? `<p class="advice-reason">原因：${esc(p.statusReason)}</p>` : ''}
        <button class="btn ghost block" data-act="reopen">重新开启项目</button>
      </div>`;
    } else if (sess) {
      top = sessionHTML(p, sess);
    } else {
      let primary;
      if (s.key && !p.stages[n].gatePassed) primary = `<button class="btn primary block" data-act="gate">推进关卡：${esc(s.gate)}</button>`;
      else if (n === 10) primary = `<button class="btn primary block" data-act="backflow">失败回流，开始第 ${p.iteration + 1} 轮</button>`;
      else if (n === 9) primary = `<div class="btn-row"><button class="btn primary" data-act="keepMonitor">继续监控</button><button class="btn ghost" data-act="advance">发起迭代</button><button class="btn ghost" data-act="closeProject">结束项目</button></div>`;
      else primary = `<button class="btn primary block" data-act="advance">完成本阶段，进入第 ${n + 1} 阶段</button>`;
      top = `<div class="card next">
        <h3>下一步</h3>
        <p class="next-text">${esc(next.text)}</p>
        <p class="hint">由规则计算：先做完当前阶段的步骤，再过关卡，再进下一阶段。</p>
        ${primary}
        <button class="btn ghost block" data-act="askAI">问 AI 下一步该怎么走</button>
      </div>`;
    }
    const invalid = STAGES.filter(x => x.key && x.n < n && !p.stages[x.n].gatePassed).map(x => x.n);
    const invalidCard = invalid.length && p.status === 'active' ? `<div class="card warn-card">
        <h3>有前置关卡当前无效</h3>
        <p class="advice-reason">第 ${invalid.join('、')} 关没有确认，或因依据变化已失效。后续关卡会因此被拦截。</p>
        <div class="btn-row">${invalid.map(k => `<button class="btn ghost" data-act="confirmGate" data-n="${k}">检查并确认第 ${k} 关</button>`).join('')}</div>
      </div>` : '';
    $('#desk').innerHTML = `${invalidCard}${top}
      <div class="card log">
        <div class="card-head"><h3>决策记录</h3><button class="link" data-act="openLog">查看完整项目日志</button></div>
        <ol class="loglist">${p.log.filter(l => DECISION_TYPES.includes(l.type)).slice().reverse().map(decisionItem).join('')}</ol>
      </div>`;
  }

  function targetOf(sess) {
    const a = sess.advice, n = sess.stage;
    if (!a) return null;
    return a.suggestedStage > n ? n + 1 : a.suggestedStage; // 前进最多一步
  }

  function sessionHTML(p, sess) {
    const n = sess.stage, s = stageByN(n);
    const allPass = sess.rules.every(r => r.pass);
    const a = sess.advice;
    const title = sess.kind === 'gate' ? `关卡：${esc(s.gate)}` : sess.kind === 'backflow' ? '失败回流' : '下一步建议';
    const staleBar = sess.stale ? `<p class="notice">打开${sess.kind === 'gate' ? '关卡' : '建议'}之后，相关数据被修改过，下面的检查结果和建议已经过期。请重新检查后再决定。<button class="link" data-act="recheck">重新检查</button></p>` : '';
    let rulesBlock = '';
    if (sess.kind === 'gate') {
      rulesBlock = `<h4>规则检查</h4>
        <ul class="rules ${sess.stale ? 'stale' : ''}">${sess.rules.map(r => `<li class="${r.pass ? 'go' : 'stop'}"><span class="mark" aria-hidden="true">${r.pass ? '✓' : '✕'}</span><span>${esc(r.label)}${r.detail ? `<small>${esc(r.detail)}</small>` : ''}</span></li>`).join('')}</ul>
        <p class="verdict ${allPass ? 'go' : 'stop'}">${allPass ? '规则全部满足，可以推进。' : `拦截：${sess.rules.filter(r => !r.pass).length} 项不满足。`}</p>`;
    }
    let adviceBlock = '<p class="hint loading">AI 正在分析…</p>';
    let actions = '';
    if (a) {
      const target = targetOf(sess);
      const tgtText = target === n ? '留在本阶段' : target > n ? `进入第 ${target} 阶段` : `回到第 ${target} 阶段`;
      const src = a.preset ? '预设演示建议' : a.source === 'model' ? '模型生成' : '演示模式，由规则模板生成';
      adviceBlock = `<h4>AI 建议 <small>${src}</small></h4>
        ${a.warning ? `<p class="notice">${esc(a.warning)}</p>` : ''}
        <p class="advice">${esc(a.summary)}</p>
        ${(() => { const parts = String(a.reason).split(/(?<=。)/); const head = parts.slice(0, 2).join(''), rest = parts.slice(2).join(''); return `<p class="advice-reason">${esc(head)}</p>` + (rest ? `<details class="advice-more"><summary>展开完整理由</summary><p class="advice-reason">${esc(rest)}</p></details>` : ''); })()}
        <details class="advice-more"><summary>备选路线（${a.alternatives.length}）</summary>
          ${a.alternatives.length ? `<ul class="alts">${a.alternatives.map(x => `<li>第 ${x.stage} 阶段：${esc(x.desc)}</li>`).join('')}</ul>` : '<p class="hint">没有备选路线</p>'}
        </details>`;
      let canAdopt = true, adoptHint = '';
      if (sess.kind === 'backflow') canAdopt = [5, 6].includes(target);
      else if (target > n) {
        if (s.key && !allPass) { canAdopt = false; adoptHint = '建议前进，但规则没通过，不能直接采纳。'; }
        if (!s.key && p.stages[n].steps.some(x => x.status === 'todo' || x.status === 'doing')) { canAdopt = false; adoptHint = '本阶段还有步骤没完成，请用「完成本阶段」并说明原因。'; }
      }
      actions = sess.stale ? `<div class="decide-bar"><button class="btn primary" data-act="recheck">重新检查</button><button class="btn ghost" data-act="closeSession">先不决定</button></div>` :
        `<div class="decide-bar">
          <p class="decide-title">你的决定</p>
          <div class="decide">
            ${canAdopt ? `<button class="btn primary" data-act="adopt">采纳建议：${tgtText}</button>` : ''}
            ${sess.kind === 'gate' && allPass && target !== n + 1 ? `<button class="btn ghost" data-act="passAnyway">按规则通过，进入第 ${n + 1} 阶段</button>` : ''}
            <button class="btn ghost" data-act="otherRoute">选其他路线</button>
            ${sess.kind === 'gate' && !allPass ? '<button class="btn ghost danger" data-act="force">强制放行</button>' : ''}
            <button class="btn ghost" data-act="closeSession">先不决定</button>
          </div>
          <p class="hint">${adoptHint ? esc(adoptHint) + ' ' : ''}推翻建议或规则需填写原因；强制放行会给项目打上风险标记。${sess.kind !== 'backflow' ? '<button class="link danger-link" data-act="terminate">终止项目</button>' : ''}</p>
        </div>`;
    }
    return `<div class="card session ${sess.kind}">
      <h3>${title}</h3>
      ${staleBar}${rulesBlock}${adviceBlock}${actions}
    </div>`;
  }

  // 关卡放行时记录批准人与意见（单人工具，不做真的多人审批，只记录是谁拍板的）
  async function askApproval(p, title, desc, opts = {}) {
    const r = await ask(title, desc, {
      input: { label: '批准人', value: p.lastApprover || '', placeholder: '例如：业务负责人 张三', required: true },
      label: opts.reasonLabel || '批准意见（可选）', optional: !opts.reasonRequired,
      placeholder: opts.placeholder || '例如：同意进入灰度，先观察一周', ok: opts.ok || '确认'
    });
    if (!r) return null;
    p.lastApprover = r.input;
    return { approver: r.input, text: r.text };
  }

  // ---------- 推进逻辑（所有推进都走 Engine） ----------
  async function openSession(kind) {
    const p = Store.active(), n = p.currentStage;
    if (p.status !== 'active') return;
    if (n === 10 && kind === 'next') kind = 'backflow';
    const rules = Rules.checkGate(p, n);
    if (kind === 'gate') {
      p.stages[n].lastGate = rules.every(r => r.pass) ? 'pass' : 'fail';
      if ((n === 7 || n === 8) && Rules.resultsCurrent(p, n)) Engine.recordResults(p, n); // 每次关卡检查记一笔，用来画趋势
      Store.save();
    }
    const reqId = Store.uid();
    ui.session = { kind, stage: n, pid: p.id, reqId, rules, sig: Engine.signature(rules), inSig: Engine.inputSignature(p, n), advice: null, stale: false };
    ui.viewStage = n;
    render();
    const advice = await AI.advise(p, { stage: n, rules, kind });
    const cur = ui.session;
    if (cur && cur.reqId === reqId && Store.state.activeId === p.id) { cur.advice = advice; renderDesk(Store.active()); }
  }

  // 拍板前重新检查：依据变了就不允许按旧结果决定
  // 拍板前重新检查：规则结果或 AI 所依据的数据任何一个变了，都不允许按旧结果决定
  function sessionChanged(p, sess) {
    return Engine.signature(Rules.checkGate(p, sess.stage)) !== sess.sig || Engine.inputSignature(p, sess.stage) !== sess.inSig;
  }
  function freshRules(p, sess) {
    if (sess.stale || sessionChanged(p, sess)) {
      sess.stale = true; renderDesk(p); toast('依据已变化，请重新检查后再决定'); return null;
    }
    return Rules.checkGate(p, sess.stage);
  }

  function markSessionStale(p) {
    const sess = ui.session;
    if (!sess || sess.pid !== p.id || sess.stage !== p.currentStage || sess.stale) return;
    if (sessionChanged(p, sess)) sess.stale = true;
  }

  // 统一变更入口：所有会改变依据的修改都经过这里，由 Engine 按依赖关系表决定升版本、撤销哪些关卡
  function commit(p, change, why) {
    const r = Engine.applyChange(p, change);
    if (r.skipped) return r;
    if (r.versions.length) logChanges(p, r.versions, why);
    r.revoked.forEach(x => Store.log(p, {
      stage: p.currentStage, stageName: '依据变更', type: 'version',
      decision: `第 ${x.n} 关「${stageByN(x.n).gate}」失效：${why}后不再满足「${x.fails.join('、')}」${x.cascade.length ? `，连带撤销第 ${x.cascade.join('、')} 关` : ''}`,
      reason: '', rule: '', ai: ''
    }));
    if (r.versions.length || r.revoked.length) toast(`${why}：${r.revoked.length ? `第 ${r.revoked.map(x => x.n).join('、')} 关已失效` : '相关关卡需要重新确认'}，详见决策记录`);
    markSessionStale(p);
    return r;
  }

  async function confirmPriorGate(n) {
    const p = Store.active(), s = stageByN(n);
    const rules = Rules.checkGate(p, n);
    const pass = rules.every(r => r.pass);
    const dlg = $('#dialog');
    dlg.innerHTML = `<div class="dlg wide">
      <div class="card-head"><h3>检查第 ${n} 关「${esc(s.gate)}」</h3><button class="icon" data-act="closeDlg" aria-label="关闭">×</button></div>
      <p class="dlg-desc">补确认当前阶段之前的关卡，不会改变项目所在的阶段。${pass ? '规则全部满足，可以确认。' : '规则没有全部满足，请先补全这一阶段的产出。'}</p>
      <ul class="rules">${rules.map(r => `<li class="${r.pass ? 'go' : 'stop'}"><span class="mark">${r.pass ? '✓' : '✕'}</span><span>${esc(r.label)}${r.detail ? `<small>${esc(r.detail)}</small>` : ''}</span></li>`).join('')}</ul>
      <div class="dlg-actions"><button class="btn ghost" data-act="closeDlg">关闭</button>${pass ? `<button class="btn primary" data-act="doConfirmGate" data-n="${n}">确认第 ${n} 关</button>` : ''}</div>
    </div>`;
    if (!dlg.open) { dlg.onclose = null; dlg.showModal(); }
  }

  async function doConfirmGate(n) {
    const p = Store.active();
    $('#dialog').close();
    const ap = await askApproval(p, `补确认第 ${n} 关「${stageByN(n).gate}」`, '记录由谁批准这次补确认。项目所在的阶段不会改变。', { ok: '确认' });
    if (!ap) return;
    const snap = Engine.snapshot(p, n, Rules.checkGate(p, n), null);
    const r = Engine.confirmGate(p, n);
    if (!r.ok) { toast(`不能确认：${r.reason}`); return; }
    Store.log(p, { stage: n, stageName: stageByN(n).gate, type: 'gate', decision: `补确认第 ${n} 关（前置关卡，项目仍在第 ${p.currentStage} 阶段）`, rule: ruleSummary(r.rules), ai: '', reason: '', approver: ap.approver, opinion: ap.text, snapshot: snap });
    markSessionStale(p);
    Store.save(); render(); toast(`第 ${n} 关已确认`);
  }

  function ruleSummary(rules) {
    if (!rules.length) return '';
    const ok = rules.filter(r => r.pass).length;
    const bad = rules.filter(r => !r.pass).map(r => r.label);
    return `${ok}/${rules.length} 项通过${bad.length ? '；未通过：' + bad.join('、') : ''}`;
  }

  function logChanges(p, changes, why) {
    (changes || []).forEach(c => Store.log(p, {
      stage: p.currentStage, stageName: '版本变更', type: 'version',
      decision: `${c.name}依据从修订 ${c.from} 变为修订 ${c.to}（${why}）。${c.reset.length ? `第 ${c.reset.join('、')} 关需要重新确认，` : ''}之前录入的结果已过期，不能用于放行`,
      reason: '', rule: '', ai: ''
    }));
  }

  function logDecision(p, n, fields, rules, advice) {
    Store.log(p, { stage: n, rule: ruleSummary(rules), ai: advice ? advice.summary : '', reason: '', ...fields, snapshot: Engine.snapshot(p, n, rules, advice) });
  }

  async function doBackflow(p, target, advice, decisionPrefix, rules, reasonIn) {
    const fails = (p.stages[10].fields.failures || '').split('\n').filter(x => x.trim());
    let reason = reasonIn || '';
    if (!fails.length) {
      const r = await ask('没有记录线上失败案例', '第 10 阶段的失败案例是空的。仍要开始新一轮，需要说明原因。', { ok: '仍然开始' });
      if (!r) return false;
      reason = [reason, r.text].filter(Boolean).join('；');
    }
    logDecision(p, 10, { stageName: '失败回流', type: 'backflow', decision: `${decisionPrefix}：回流到第 ${target} 阶段，开始第 ${p.iteration + 1} 轮（带入 ${fails.length} 条失败案例）`, reason }, rules, advice);
    Engine.backflow(p, target);
    return true;
  }

  async function decide(act) {
    const p = Store.active(), sess = ui.session;
    if (!sess || sess.pid !== p.id) return;
    const n = sess.stage, s = stageByN(n), a = sess.advice;
    if (act === 'closeSession') { ui.session = null; renderDesk(p); return; }
    if (act === 'recheck') { openSession(sess.kind); return; }
    const rules = freshRules(p, sess);
    if (!rules) return;
    const stageName = sess.kind === 'gate' ? s.gate : sess.kind === 'backflow' ? '失败回流' : s.name;
    const base = { stageName, type: sess.kind === 'gate' ? 'gate' : 'next' };

    if (sess.kind === 'backflow') {
      let ok = false;
      if (act === 'adopt') {
        if (![5, 6].includes(a.suggestedStage)) { toast('回流目标只能是第 5 或第 6 阶段。'); return; }
        ok = await doBackflow(p, a.suggestedStage, a, '采纳建议', rules);
      } else if (act === 'otherRoute') {
        const r = await ask('选择回流阶段', '这会推翻 AI 的建议，需要写明原因。', { select: [{ value: '5', label: '第 5 阶段：评测集构建' }, { value: '6', label: '第 6 阶段：构建与调试' }], selectLabel: '回流到' });
        if (!r) return;
        ok = await doBackflow(p, Number(r.select), a, '选其他路线', rules, r.text);
      }
      if (!ok) return;
      ui.session = null; ui.viewStage = p.currentStage; Store.save(); render(); toast(`已开始第 ${p.iteration} 轮`); return;
    }

    if (act === 'adopt') {
      const target = targetOf(sess);
      if (target > n) {
        let ap = null;
        if (s.key) {
          ap = await askApproval(p, `通过第 ${n} 关「${s.gate}」`, '规则已全部满足。记录这次放行由谁批准，会写进决策记录和决策报告。', { ok: '确认通过' });
          if (!ap) return;
          if (!freshRules(p, sess)) return;
        }
        const snap = Engine.snapshot(p, n, rules, a);
        const res = Engine.advance(p);
        if (!res.ok) { toast(`不能推进：${res.reason}。如确需推进，请选择强制放行。`); return; }
        Store.log(p, { stage: n, ...base, decision: `采纳建议：进入第 ${n + 1} 阶段`, rule: ruleSummary(rules), ai: a.summary, reason: '', approver: ap ? ap.approver : '', opinion: ap ? ap.text : '', snapshot: snap });
      } else {
        logDecision(p, n, { ...base, decision: `采纳建议：${target === n ? '留在本阶段' : `回到第 ${target} 阶段`}` }, rules, a);
        if (target < n) { const r = Engine.back(p, target, a.summary.replace(/^回到第\s*\d+\s*阶段[，,]?\s*/, '')); logChanges(p, r.changes, `回到第 ${target} 阶段返工`); }
      }
    } else if (act === 'passAnyway') {
      const r = await askApproval(p, '按规则通过', `AI 建议的是另一条路线：「${a.summary}」。推翻它需要写明原因，并记录批准人。`, { reasonRequired: true, reasonLabel: '推翻 AI 建议的原因', placeholder: '写清楚为什么不采纳 AI 的建议', ok: '确认通过' });
      if (!r) return;
      if (!freshRules(p, sess)) return;
      const snap = Engine.snapshot(p, n, rules, a);
      const res = Engine.advance(p);
      if (!res.ok) { toast(`不能推进：${res.reason}`); return; }
      Store.log(p, { stage: n, ...base, decision: `推翻 AI 建议，按规则通过，进入第 ${n + 1} 阶段`, rule: ruleSummary(rules), ai: a.summary, reason: r.text, approver: r.approver, opinion: '', snapshot: snap });
    } else if (act === 'otherRoute') {
      const opts = [];
      for (let k = n; k >= 1; k--) opts.push({ value: String(k), label: k === n ? `留在第 ${k} 阶段` : `回到第 ${k} 阶段：${stageByN(k).name}` });
      const r = await ask('选其他路线', '这会推翻 AI 的建议，需要写明原因。往前推进只能通过规则检查或强制放行。', { select: opts, selectLabel: '去哪个阶段' });
      if (!r) return;
      const target = Number(r.select);
      logDecision(p, n, { ...base, decision: `选其他路线：${target === n ? '留在本阶段' : `回到第 ${target} 阶段`}`, reason: r.text }, rules, a);
      if (target < n) { const res = Engine.back(p, target, r.text); logChanges(p, res.changes, `回到第 ${target} 阶段返工`); }
    } else if (act === 'force') {
      const r = await askApproval(p, '强制放行', '规则没有全部满足。强制放行必须写明原因和批准人，项目会被标记为"有风险"，这条决定会一直留在记录里。', { reasonRequired: true, reasonLabel: '强制放行的原因', ok: '确认强制放行', placeholder: '例如：业务方书面确认接受当前漏检率，先灰度观察两周' });
      if (!r) return;
      if (!freshRules(p, sess)) return;
      const snap = Engine.snapshot(p, n, rules, a);
      Engine.advance(p, { force: true });
      Store.log(p, { stage: n, ...base, type: 'force', decision: `强制放行，进入第 ${n + 1} 阶段`, rule: ruleSummary(rules), ai: a.summary, reason: r.text, approver: r.approver, opinion: '', snapshot: snap });
    } else if (act === 'terminate') {
      const r = await ask('终止项目', '终止后项目停止推进，记录全部保留，之后可以重新开启。', { ok: '确认终止', placeholder: '例如：可行性评估结论为不可行，业务方同意不立项' });
      if (!r) return;
      logDecision(p, n, { ...base, type: 'close', decision: '终止项目', reason: r.text }, rules, a);
      p.status = 'terminated'; p.statusReason = r.text;
    }
    ui.session = null; ui.viewStage = p.currentStage; Store.save(); render();
  }

  async function advanceNonKey() {
    const p = Store.active(), n = p.currentStage;
    if (stageByN(n).key || n >= 10) return;
    const left = p.stages[n].steps.filter(x => x.status === 'todo' || x.status === 'doing');
    let reason = '';
    if (left.length) {
      const r = await ask('还有步骤没完成', `未完成：${left.map(x => x.title).join('、')}。仍然推进需要写明原因。`, { ok: '仍然推进' });
      if (!r) return;
      reason = r.text;
    }
    const snap = Engine.snapshot(p, n, [], null);
    const res = Engine.advance(p);
    if (!res.ok) { toast(res.reason); return; }
    Store.log(p, { stage: n, stageName: stageByN(n).name, type: 'advance', decision: n === 9 ? '发起迭代：进入第 10 阶段' : `完成第 ${n} 阶段，进入第 ${n + 1} 阶段${left.length ? `（${left.length} 个步骤未完成）` : ''}`, reason, rule: '', ai: '', snapshot: snap });
    ui.viewStage = p.currentStage; ui.session = null;
    Store.save(); render();
  }

  async function statusAction(act) {
    const p = Store.active();
    if (act === 'keepMonitor') {
      const r = await ask('继续监控', '记录一次监控结论，项目留在第 9 阶段。', { label: '监控结论（可选）', optional: true, ok: '记录' });
      if (!r) return;
      Store.log(p, { stage: 9, stageName: '线上监控', type: 'next', decision: '继续监控', reason: r.text, rule: '', ai: '', snapshot: Engine.snapshot(p, 9, [], null) });
    } else if (act === 'closeProject') {
      const r = await ask('结束项目', '项目正常收尾，停止推进。记录全部保留，之后可以重新开启。', { ok: '确认结束', placeholder: '例如：全量运行稳定三个月，转入常规运营' });
      if (!r) return;
      Store.log(p, { stage: p.currentStage, stageName: '项目状态', type: 'close', decision: '结束项目', reason: r.text, rule: '', ai: '', snapshot: Engine.snapshot(p, p.currentStage, [], null) });
      p.status = 'closed'; p.statusReason = r.text;
    } else if (act === 'reopen') {
      const r = await ask('重新开启项目', '项目会回到进行中，停在当前阶段。', { ok: '重新开启' });
      if (!r) return;
      Store.log(p, { stage: p.currentStage, stageName: '项目状态', type: 'close', decision: '重新开启项目', reason: r.text, rule: '', ai: '' });
      p.status = 'active'; p.statusReason = '';
    }
    Store.save(); render();
  }

  function viewSnap(id) {
    const p = Store.active(), l = p.log.find(x => x.id === id);
    if (!l || !l.snapshot) return;
    const sn = l.snapshot, a = sn.advice;
    const ms = sn.metrics;
    const target = a && a.suggestedStage ? (a.suggestedStage === sn.stage ? '留在本阶段' : `第 ${a.suggestedStage} 阶段`) : '';
    const fieldLabel = (k, key) => { const f = stageByN(Number(k)).fields.find(x => x.k === key); return f ? f.label : key; };
    const fieldsBlock = sn.fields ? Object.entries(sn.fields).map(([k, fs]) => Object.entries(fs)
      .filter(([key, v]) => !['metrics', 'evalResults', 'grayResults', 'evalMeta', 'grayMeta'].includes(key) && v !== '' && v != null)
      .map(([key, v]) => `<p><b>第 ${k} 阶段 · ${esc(fieldLabel(k, key))}</b>：${longText(typeof v === 'object' ? JSON.stringify(v) : v)}</p>`).join('')).join('') : '';
    const dlg = $('#dialog');
    dlg.innerHTML = `<div class="dlg wide snapdlg">
      <div class="card-head"><h3>决策依据</h3><button class="icon" data-act="closeDlg" aria-label="关闭">×</button></div>
      <p class="snap-head"><b>${esc(l.stageName)}</b>${esc(l.decision)}</p>
      <p class="hint">${fullTime(l.t)}，第 ${sn.stage} 阶段。当时依据：${Rules.verText(sn.ver, 7)}</p>
      ${l.approver ? `<p class="log-approver">批准人：${esc(l.approver)}${l.opinion ? `　意见：${esc(l.opinion)}` : ''}</p>` : ''}
      ${l.reason ? `<p class="log-reason">原因：${esc(l.reason)}</p>` : ''}
      ${sn.rules.length ? `<h4>规则检查明细</h4><ul class="rules">${sn.rules.map(r => `<li class="${r.pass ? 'go' : 'stop'}"><span class="mark">${r.pass ? '✓' : '✕'}</span><span>${esc(r.label)}${r.detail ? `<small>${esc(r.detail)}</small>` : ''}</span></li>`).join('')}</ul>` : ''}
      ${ms.length ? `<h4>当时的指标</h4><table class="snap-table"><thead><tr><th>指标</th><th>类型</th><th>标准</th><th>实测</th><th>结果</th></tr></thead><tbody>${ms.map(m => { const empty = m.actual === undefined || m.actual === '' || m.actual === null; const ok = empty ? null : Rules.meets(m, m.actual); return `<tr><td>${esc(m.name)}</td><td>${esc(m.role)}</td><td>${m.op === '<=' ? '≤' : '≥'} ${esc(m.threshold)}${esc(m.unit)}</td><td>${empty ? '未录入' : esc(m.actual) + esc(m.unit)}</td><td class="${ok === null ? '' : ok ? 'go' : 'stop'}">${ok === null ? (empty ? '—' : '格式无效') : ok ? '达标' : '未达标'}</td></tr>`; }).join('')}</tbody></table>` : ''}
      ${sn.resultMeta && (sn.resultMeta.eval || sn.resultMeta.gray) ? `<p class="hint">${sn.resultMeta.eval ? `评测结果按 ${Rules.verText(sn.resultMeta.eval, 7)} 录入。` : ''}${sn.resultMeta.gray ? `灰度结果按 ${Rules.verText(sn.resultMeta.gray, 8)} 录入。` : ''}</p>` : ''}
      ${fieldsBlock ? `<details class="more"><summary>当时的阶段产出（含错误样例、评测集说明、构建记录等）</summary>${fieldsBlock}</details>` : ''}
      ${sn.evidence.length ? `<h4>关联材料</h4><p>${sn.evidence.map(e => `<span class="tag">${esc(e.type)}</span> ${esc(e.name)}`).join('　')}</p>` : ''}
      ${a ? `<h4>当时的 AI 建议 <small>${a.preset ? '预设演示建议' : a.source === 'model' ? '模型生成' : '规则模板生成'}${target ? `，建议去向：${target}` : ''}</small></h4><p class="advice">${esc(a.summary)}</p><p class="advice-reason">${esc(a.reason)}</p>${a.alternatives.length ? `<ul class="alts">${a.alternatives.map(x => `<li>第 ${x.stage} 阶段：${esc(x.desc)}</li>`).join('')}</ul>` : ''}` : ''}
      ${window.self === window.top ? `<div class="dlg-actions"><button class="btn ghost" data-act="exportOne" data-id="${esc(l.id)}">导出这次决定（Markdown）</button></div>` : ''}
    </div>`;
    if (!dlg.open) { dlg.onclose = null; dlg.showModal(); }
  }

  // ---------- 步骤操作 ----------
  async function stepAction(act, stepId) {
    const p = Store.active(), n = ui.viewStage, list = p.stages[n].steps;
    const i = list.findIndex(x => x.id === stepId), x = list[i];
    const sn = stageByN(n).name;
    if (act === 'risk') {
      if (x.risk) { Store.log(p, { stage: n, stageName: sn, type: 'mark', decision: `取消风险标记：${x.title}`, reason: '', rule: '', ai: '' }); x.risk = ''; commit(p, { type: 'step', stage: n, key: 'risk' }, '修改了风险标记'); }
      else {
        const r = await ask('标记风险', `步骤：${x.title}`, { label: '风险说明', placeholder: '例如：评测数据可能不够', ok: '标记' });
        if (!r) return; x.risk = r.text;
        Store.log(p, { stage: n, stageName: sn, type: 'mark', decision: `标记风险：${x.title}`, reason: r.text, rule: '', ai: '' });
        commit(p, { type: 'step', stage: n, key: 'risk' }, '修改了风险标记');
      }
    } else if (act === 'note') {
      x._open = !x._open;
    } else if (act === 'up' || act === 'down') {
      const j = act === 'up' ? i - 1 : i + 1;
      const r = await ask('调整步骤顺序', `把「${x.title}」${act === 'up' ? '上移' : '下移'}。调整步骤需要写明原因。`);
      if (!r) return;
      [list[i], list[j]] = [list[j], list[i]];
      Store.log(p, { stage: n, stageName: sn, type: 'adjust', decision: `调整顺序：「${x.title}」${act === 'up' ? '上移' : '下移'}`, reason: r.text, rule: '', ai: '' });
      commit(p, { type: 'step', stage: n, key: 'order' }, '调整了步骤顺序');
    } else if (act === 'del') {
      const r = await ask('删除步骤', `删除「${x.title}」。调整步骤需要写明原因。`, { ok: '删除' });
      if (!r) return;
      list.splice(i, 1);
      Store.log(p, { stage: n, stageName: sn, type: 'adjust', decision: `删除步骤：${x.title}`, reason: r.text, rule: '', ai: '' });
      commit(p, { type: 'step', stage: n, key: 'delete' }, `删除了第 ${n} 阶段的步骤`);
    }
    Store.save(); renderStage(p); renderTrack(p); renderDesk(p);
  }

  async function setStatus(stepId, val, sel) {
    const p = Store.active(), n = ui.viewStage;
    const x = p.stages[n].steps.find(s => s.id === stepId);
    if (val === 'skipped') {
      const r = await ask('跳过步骤', `跳过「${x.title}」需要写明原因。`, { ok: '跳过' });
      if (!r) { sel.value = x.status; return; }
      Store.log(p, { stage: n, stageName: stageByN(n).name, type: 'adjust', decision: `跳过步骤：${x.title}`, reason: r.text, rule: '', ai: '' });
    }
    if (val !== 'skipped') Store.log(p, { stage: n, stageName: stageByN(n).name, type: 'status', decision: `「${x.title}」：${STATUS[x.status]} 改为 ${STATUS[val]}`, reason: '', rule: '', ai: '' });
    const was = x.status;
    x.status = val;
    // 完成状态的变化代表资产变化（第 5、6 阶段会升修订）；其余状态变化只触发关卡复核
    commit(p, { type: 'step', stage: n, key: was === 'done' || val === 'done' ? 'done' : 'status', before: was, after: val }, `修改了第 ${n} 阶段的步骤状态`);
    Store.save(); renderStage(p); renderTrack(p); renderDesk(p);
  }

  // ---------- 新建项目 ----------
  const SAMPLE = `目前私域培育群约 5 万人，成交转化率只有约 0.8%，每月大约 400 单。群里其实有不少人在问课程、说自己的问题，但运营人员看不过来，很多有意向的人没被及时跟进。希望用 AI 识别群里的意向信号，把有意向的人及时转给销售，提高培育群的成交转化。`;

  function wizardSteps(cur) {
    return `<ol class="wsteps">${['上传材料', '确认拆解', '生成项目'].map((t, i) => `<li class="${i + 1 < cur ? 'done' : i + 1 === cur ? 'on' : ''}"><span>${i + 1}</span>${t}</li>`).join('')}</ol>`;
  }
  const extOf = n => (n.split('.').pop() || '').toUpperCase().slice(0, 4);

  function renderCreate() {
    const d = ui.draft || (ui.draft = { name: '', text: '', files: [], analysis: null, loading: false, parsing: false });
    if (!d.analysis) {
      const okFiles = d.files.filter(f => f.ok);
      $('#main').innerHTML = `
        <div class="wizard">
          ${wizardSteps(1)}
          <h1>新建项目</h1>
          <p class="lead">上传这个项目已有的文档，一份或多份都行。AI 会判断项目进行到哪一步，再拆出接下来要做的事。</p>
          <section class="wcard">
            <label class="drop big ${d.parsing ? 'busy' : ''}" id="drop">
              <input type="file" id="cFile" multiple accept="${window.Files.ACCEPT}" hidden>
              <svg class="drop-icon" viewBox="0 0 48 48" aria-hidden="true"><rect x="12" y="6" width="24" height="32" rx="3"/><path d="M18 16h12M18 22h12M18 28h7"/><path d="M24 46V34m-5 5l5-5 5 5"/></svg>
              <b>${d.parsing ? '正在读取文件…' : '把文件拖到这里，或点击选择'}</b>
              <small>需求描述、BRD、PRD、评审纪要、评测报告都可以；支持 Markdown、TXT、Word、PDF、CSV、JSON</small>
            </label>
            ${d.files.length ? `<ul class="wfiles">${d.files.map((f, i) => `
              <li class="${f.ok ? '' : 'bad'}">
                <span class="ext">${esc(extOf(f.name))}</span>
                <span class="fname">${esc(f.name)}</span>
                <span class="fmeta">${f.ok ? `${f.chars} 字${f.truncated ? '，只取前 20000 字' : ''}` : esc(f.error)}</span>
                <button class="icon" data-act="rmFile" data-i="${i}" aria-label="移除">×</button>
              </li>`).join('')}</ul>` : ''}
            <details class="wextra" ${d.text ? 'open' : ''} id="cExtra">
              <summary>粘贴文字或补充说明<small>可选</small></summary>
              <textarea id="cText" rows="5" placeholder="没有文件也可以直接粘贴需求描述；或者写业务方口头补充的背景">${esc(d.text)}</textarea>
            </details>
            <label class="wname"><span>项目名称</span><input id="cName" value="${esc(d.name)}" placeholder="可以不填，AI 会根据文档内容拟定"></label>
          </section>
          <div class="wactions">
            <button class="link" data-act="fillSample">没有文档？用示例需求试一下</button>
            <span class="grow"></span>
            ${Store.state.projects.length ? '<button class="btn ghost" data-act="cancelCreate">取消</button>' : ''}
            <button class="btn primary" data-act="analyze" ${d.loading || d.parsing ? 'disabled' : ''}>${d.loading ? 'AI 分析中…' : `分析并拆解${okFiles.length ? `（${okFiles.length} 个文件）` : ''}`}</button>
          </div>
        </div>`;
      const addFiles = async list => {
        if (!list || !list.length) return;
        d.name = $('#cName').value; d.text = $('#cText').value; d.parsing = true; renderCreate();
        const parsed = await window.Files.parseFiles(list);
        if (ui.draft !== d || ui.view !== 'create') return; // 已取消或切走
        d.files.push(...parsed); d.parsing = false;
        renderCreate();
        const bad = parsed.filter(f => !f.ok).length;
        if (bad) toast(`${bad} 个文件没有读出内容，已在列表中标出原因`);
      };
      $('#cFile').onchange = e => addFiles(e.target.files);
      const drop = $('#drop');
      drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
      return;
    }

    const a = d.analysis, g = a.stageGuess;
    const total = STAGES.reduce((n, s) => n + a.steps[s.n].length, 0);
    const stageBlock = s => `
      <section class="tstage ${s.key ? 'key' : ''} ${s.n === g ? 'current' : ''}">
        <span class="tnode">${s.n}</span>
        <div class="tbody">
          <h3>${esc(s.name)}${s.key ? `<span class="tag">${esc(s.gate)}</span>` : ''}${s.n === g ? '<span class="tag go">当前工作阶段</span>' : ''}</h3>
          <ul class="tsteps">${a.steps[s.n].map((t, i) => `<li><input class="inline" data-ds="${s.n}" data-i="${i}" value="${esc(t)}" placeholder="写一个步骤" aria-label="第 ${s.n} 阶段步骤"><button class="icon" data-act="dsDel" data-n="${s.n}" data-i="${i}" aria-label="删除步骤">×</button></li>`).join('')}</ul>
          <button class="link add" data-act="dsAdd" data-n="${s.n}">＋ 添加步骤</button>
        </div>
      </section>`;
    const pre = STAGES.filter(s => s.n < g), rest = STAGES.filter(s => s.n >= g);
    $('#main').innerHTML = `
      <div class="wizard">
        ${wizardSteps(2)}
        <h1>确认拆解结果</h1>
        <p class="lead">核对 AI 的判断，按需增删步骤。确认后才会生成项目。</p>
        ${a.warning ? `<p class="notice">${esc(a.warning)}</p>` : ''}
        <section class="wcard wsum">
          <label class="wname big"><span>项目名称${ui.draft.autoName ? '<small>AI 根据文档拟定，可以修改</small>' : ''}</span><input id="cName2" value="${esc(ui.draft.name)}"></label>
          <div class="wgrid">
            <label><span>当前工作阶段</span><select id="cStart">${STAGES.map(s => `<option value="${s.n}" ${s.n === g ? 'selected' : ''}>第 ${s.n} 阶段：${esc(s.name)}</option>`).join('')}</select></label>
            <div><span>识别的材料</span><b>${esc(a.docType)}</b></div>
          </div>
          <p class="wreason">${esc(a.reason)}<small>${a.source === 'model' ? '由模型判断' : '演示模式：由关键词规则判断'}</small></p>
          ${a.files && a.files.length > 1 ? `<details class="wfj"><summary>逐个文件的判断（${a.files.length} 份）</summary><ul class="ftypes">${a.files.map(f => `<li><span class="tag">${esc(f.type)}</span><b>${esc(f.name)}</b><small>${esc(f.reason)}</small></li>`).join('')}</ul></details>` : ''}
          ${a.missing.length ? `<div class="wmiss"><b>文档里缺这些信息</b><ul>${a.missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul></div>` : ''}
        </section>
        <h2 class="wsub">拆解结果<small>${total} 个步骤，可以直接点文字修改</small></h2>
        <div class="timeline-edit">
          ${pre.length ? `<details class="pregroup" id="preGroup" ${d.preOpen ? 'open' : ''}>
            <summary><span class="tnode muted">1${pre.length > 1 ? `–${pre.length}` : ''}</span><span><b>第 1${pre.length > 1 ? ` 至 ${pre.length}` : ''} 阶段：未核验</b><small>在当前工作阶段之前。生成后需要对照材料确认，展开可修改步骤</small></span></summary>
            ${pre.map(stageBlock).join('')}
          </details>` : ''}
          ${rest.map(stageBlock).join('')}
        </div>
        <div class="wfoot">
          <span class="wfoot-info">${total} 个步骤，从第 ${g} 阶段开始</span>
          <span class="grow"></span>
          <button class="btn ghost" data-act="backToDoc">返回修改材料</button>
          <button class="btn primary" data-act="confirmCreate">确认并生成项目</button>
        </div>
      </div>`;
    $('#cStart').onchange = () => { syncDraftSteps(); renderCreate(); };
    const pg = $('#preGroup'); if (pg) pg.ontoggle = () => { d.preOpen = pg.open; }; // 增删步骤重绘后保持展开
  }

  function syncDraftSteps() {
    const d = ui.draft;
    document.querySelectorAll('[data-ds]').forEach(inp => { d.analysis.steps[inp.dataset.ds][inp.dataset.i] = inp.value; });
    const nm = $('#cName2'), st = $('#cStart');
    if (nm) d.name = nm.value;
    if (st) d.analysis.stageGuess = Number(st.value);
  }

  // ---------- 事件 ----------
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b || b.tagName === 'SELECT') return;
    const act = b.dataset.act;
    const p = Store.active();
    const stepEl = b.closest('[data-step]');
    if (stepEl && ['risk', 'note', 'up', 'down', 'del'].includes(act)) { e.preventDefault(); stepAction(act, stepEl.dataset.step); return; }

    switch (act) {
      case 'new': ui.view = 'create'; ui.draft = null; ui.session = null; render(); break;
      case 'open': Store.state.activeId = b.dataset.id; Store.save(); ui.view = 'project'; ui.viewStage = null; ui.session = null; render(); break;
      case 'toggleMode': AI.mode = AI.mode === 'model' ? 'demo' : 'model'; ui.session = null; render(); break;
      case 'resetDemo': if (confirm('把示例项目恢复到初始状态？你对示例项目做的修改会丢失。')) { Store.resetDemo(); ui.view = 'project'; ui.viewStage = null; ui.session = null; render(); toast('示例项目已重置'); } break;
      case 'viewStage': ui.viewStage = Number(b.dataset.n); renderTrack(p); renderStage(p); $('#stagePanel').scrollTop = 0; break;
      case 'gate': openSession('gate'); break;
      case 'askAI': openSession('next'); break;
      case 'backflow': openSession('backflow'); break;
      case 'advance': advanceNonKey(); break;
      case 'adopt': case 'passAnyway': case 'otherRoute': case 'force': case 'closeSession': decide(act); break;
      case 'addMetric': case 'delMetric': {
        const f = p.stages[3].fields; f.metrics = f.metrics || [];
        if (act === 'addMetric') {
          f.metrics.push({ id: Store.uid(), name: '', role: '评测', op: '>=', threshold: '', unit: '%' });
          logEdit(p, 3, 'metric:add', '添加一个指标');
          commit(p, { type: 'metric', stage: 3, key: 'add' }, '修改了验收标准');
        } else {
          const id = b.closest('[data-metric]').dataset.metric, m = f.metrics.find(x => x.id === id);
          f.metrics = f.metrics.filter(x => x.id !== id);
          logEdit(p, 3, `metric:${id}`, `删除指标「${m.name || '未命名'}」`, `${m.name}，${m.role}，${m.op === '<=' ? '不高于' : '不低于'} ${m.threshold}${m.unit || ''}`, '（已删除）');
          commit(p, { type: 'metric', stage: 3, key: 'delete' }, '修改了验收标准');
        }
        Store.save(); renderStage(p); renderTrack(p); renderDesk(p); break;
      }
      case 'confirmGate': confirmPriorGate(Number(b.dataset.n)); break;
      case 'doConfirmGate': doConfirmGate(Number(b.dataset.n)); break;
      case 'recheck': case 'terminate': decide(act); break;
      case 'keepMonitor': case 'closeProject': case 'reopen': statusAction(act); break;
      case 'viewSnap': viewSnap(b.dataset.id); break;
      case 'verify': {
        p.stages[ui.viewStage].fromDoc = false;
        Store.log(p, { stage: ui.viewStage, stageName: stageByN(ui.viewStage).name, type: 'status', decision: '标记为已核验（产出已对照材料确认）', reason: '', rule: '', ai: '' });
        Store.save(); renderStage(p); renderTrack(p); break;
      }
      case 'reResult': {
        const n = Number(b.dataset.n);
        const oldMeta = p.stages[n].fields[n === 7 ? 'evalMeta' : 'grayMeta'];
        Engine.recordResults(p, n, p.stages[n].fields[n === 7 ? 'evalResults' : 'grayResults'], oldMeta);
        const old = Engine.clearResults(p, n);
        logEdit(p, n, 'result:reset', '旧结果已过期，清空后按当前依据重新录入', old, '（已清空）');
        commit(p, { type: 'result', stage: n, key: 'reset', before: old, after: {} }, '清空了评测结果');
        Store.save(); renderStage(p); renderDesk(p); break;
      }
      case 'linkMat': openLinkMat(); break;
      case 'saveLinks': {
        const n = ui.viewStage, files = materialList(p);
        const picked = [...document.querySelectorAll('[data-link]:checked')].map(x => files[Number(x.dataset.link)]).map(f => ({ id: f.id, name: f.name, type: f.type || '未识别' }));
        const before = (p.stages[n].evidence || []).map(e => e.name).join('、');
        p.stages[n].evidence = picked;
        logEdit(p, n, 'evidence', '更新依据材料', before, picked.map(e => e.name).join('、'));
        commit(p, { type: 'evidence', stage: n, key: 'evidence', before, after: picked.map(e => e.name).join('、') }, '修改了依据材料');
        $('#dialog').close(); Store.save(); renderStage(p); renderDesk(p); break;
      }
      case 'openExport': openExport(); break;
      case 'exportProj': download(`${safeName(p.name)}_项目备份.json`, JSON.stringify(p, null, 2), 'application/json'); $('#dialog').close(); toast('已导出项目备份'); break;
      case 'exportReport': download(`${safeName(p.name)}_决策报告.md`, buildReport(p), 'text/markdown'); $('#dialog').close(); toast('已导出决策报告'); break;
      case 'exportOne': { const l = p.log.find(x => x.id === b.dataset.id); download(`${safeName(p.name)}_决策_${new Date(l.t).toISOString().slice(0, 10)}.md`, buildReport(p, l.id), 'text/markdown'); toast('已导出这次决定'); break; }
      case 'openLog': openLog('all'); break;
      case 'openMats': openMats(); break;
      case 'logFilter': openLog(b.dataset.k); break;
      case 'closeDlg': $('#dialog').close(); break;
      case 'closeNotice': ui.material = null; renderMaterials(p); break;
      case 'openMat': {
        const f = materialList(p)[Number(b.dataset.i)];
        const dlg = $('#dialog');
        dlg.innerHTML = `<form method="dialog" class="dlg wide"><h3>${esc(f.name)}</h3>
          <p class="dlg-desc">${esc(f.type || '')}，${f.addedAt ? `第 ${f.addedStage} 阶段${f.addedStageName ? `（${esc(f.addedStageName)}）` : ''}时补充，${fullTime(f.addedAt)}` : '创建项目时上传'}</p>
          <pre class="doc">${esc(f.text || '（没有保存原文）')}</pre>
          <div class="dlg-actions"><button class="btn primary">关闭</button></div></form>`;
        dlg.onclose = null; dlg.showModal(); break;
      }
      case 'showDoc': {
        const dlg = $('#dialog');
        const fl = p.doc.files && p.doc.files.length ? p.doc.files : [{ name: '来源文档', type: p.doc.type, text: p.doc.text }];
        dlg.innerHTML = `<form method="dialog" class="dlg wide"><h3>来源文档（${fl.length} 份）</h3>
          ${fl.map(f => `<details class="docf" ${fl.length === 1 ? 'open' : ''}><summary><span class="tag">${esc(f.type || '')}</span> ${esc(f.name)}</summary><pre class="doc">${esc(f.text)}</pre></details>`).join('')}
          ${p.doc.missing && p.doc.missing.length ? `<h4>创建时的缺失信息提醒</h4><ul class="missing">${p.doc.missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
          <div class="dlg-actions"><button class="btn primary">关闭</button></div></form>`;
        dlg.onclose = null; dlg.showModal(); break;
      }
      case 'export_old': {
        const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `${p.name}.json`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000); break;
      }
      case 'delete': if (confirm(`删除项目「${p.name}」？这一步不能撤销。`)) { Store.remove(p.id); ui.viewStage = null; ui.session = null; ui.view = Store.state.projects.length ? 'project' : 'create'; render(); } break;
      case 'fillSample': { const ex = $('#cExtra'); if (ex) ex.open = true; } $('#cText').value = SAMPLE; if (!$('#cName').value) $('#cName').value = '培育群意向识别'; break;
      case 'cancelCreate': ui.view = 'project'; ui.draft = null; render(); break;
      case 'analyze': {
        const d = ui.draft;
        d.name = $('#cName').value.trim(); d.text = $('#cText').value.trim();
        const docs = d.files.filter(f => f.ok).map(f => ({ name: f.name, text: f.text, truncated: f.truncated, chars: f.chars }));
        if (d.text) docs.push({ name: '补充说明', text: d.text });
        if (!docs.length) { toast('先上传文件，或在补充说明里粘贴文字。'); return; }
        d.autoName = !d.name;
        d.docs = docs; d.loading = true; d.token = Store.uid(); renderCreate();
        const token = d.token;
        const a = await AI.analyze(docs.map(x => ({ name: x.name, text: x.text })));
        if (ui.draft !== d || d.token !== token || ui.view !== 'create') break; // 已取消或切走，丢弃旧结果
        if (d.autoName) d.name = a.projectName || '未命名项目';
        d.loading = false; d.analysis = a; renderCreate(); break;
      }
      case 'rmFile': ui.draft.files.splice(Number(b.dataset.i), 1); ui.draft.name = $('#cName').value; ui.draft.text = $('#cText').value; renderCreate(); break;
      case 'backToDoc': if (ui.draft.autoName) ui.draft.name = ''; ui.draft.analysis = null; renderCreate(); break;
      case 'dsDel': syncDraftSteps(); ui.draft.analysis.steps[b.dataset.n].splice(Number(b.dataset.i), 1); renderCreate(); break;
      case 'dsAdd': { syncDraftSteps(); const n = b.dataset.n; ui.draft.analysis.steps[n].push(''); renderCreate(); const ins = document.querySelectorAll(`[data-ds="${n}"]`); if (ins.length) ins[ins.length - 1].focus(); break; }
      case 'confirmCreate': {
        syncDraftSteps();
        const a = ui.draft.analysis;
        ui.draft.name = (ui.draft.name || '').trim() || '未命名项目';
        const steps = {}; Object.keys(a.steps).forEach(k => { steps[k] = a.steps[k].map(s => s.trim()).filter(Boolean); });
        const docs = ui.draft.docs || [];
        const proj = Store.makeProject({ name: ui.draft.name, docText: docs.map(x => `【${x.name}】\n${x.text}`).join('\n\n'), analysis: a, stepsByStage: steps });
        proj.doc.files = (a.files || []).map(f => { const src = docs.find(x => x.name === f.name) || {}; return { ...f, id: 'm' + Store.uid(), text: src.text || '', truncated: !!src.truncated, chars: src.chars }; });
        Store.add(proj); ui.view = 'project'; ui.draft = null; ui.viewStage = null; render(); toast('项目已生成'); break;
      }
    }
  });

  document.addEventListener('change', e => {
    if (e.target.id === 'projSel') {
      Store.state.activeId = e.target.value; Store.save();
      ui.view = 'project'; ui.viewStage = null; ui.session = null; ui.draft = null; render(); return;
    }
    const t = e.target, p = Store.active();
    if (!p || ui.view !== 'project') return;
    const n = ui.viewStage;
    if (t.dataset.act === 'status') { setStatus(t.closest('[data-step]').dataset.step, t.value, t); return; }
    if (t.dataset.sf) {
      const x = p.stages[n].steps.find(s => s.id === t.closest('[data-step]').dataset.step);
      const before = x[t.dataset.sf];
      x[t.dataset.sf] = t.value;
      logEdit(p, n, `${x.id}:${t.dataset.sf}`, `更新步骤「${x.title}」的${t.dataset.sf === 'note' ? '备注' : '产出'}`, before, t.value);
      commit(p, { type: 'step', stage: n, key: t.dataset.sf, before, after: t.value }, `修改了第 ${n} 阶段的步骤${t.dataset.sf === 'note' ? '备注' : '产出'}`);
      Store.save(); renderTrack(p); renderDesk(p); return;
    }
    if (t.dataset.field) {
      const k = t.dataset.field, f = stageByN(n).fields.find(x => x.k === k);
      const before = p.stages[n].fields[k];
      const val = f && f.type === 'number' ? (t.value === '' ? '' : Number(t.value)) : t.value;
      p.stages[n].fields[k] = val;
      const label = f ? f.label.replace(/（.*）/, '') : k;
      logEdit(p, n, k, `修改「${label}」`, before, val);
      const r = commit(p, { type: 'field', stage: n, key: k, before, after: val }, `修改了「${label}」`);
      if (r.versions.length || r.revoked.length) renderStage(p);
    } else if (t.dataset.mf) {
      const m = p.stages[3].fields.metrics.find(m => m.id === t.closest('[data-metric]').dataset.metric);
      const desc = () => `${m.name}，${m.role}，${m.op === '<=' ? '不高于' : '不低于'} ${m.threshold}${m.unit || ''}`;
      const key = t.dataset.mf, beforeVal = m[key], before = desc();
      m[key] = key === 'threshold' ? (t.value === '' ? '' : Number(t.value)) : t.value;
      logEdit(p, 3, `metric:${m.id}`, `修改指标「${m.name || '未命名'}」`, before, desc());
      // 只改显示名称不影响判定口径，依赖关系表里不升标准修订
      const r = commit(p, { type: 'metric', stage: 3, key, before: beforeVal, after: m[key] }, key === 'name' ? '修改了指标名称' : '修改了验收标准');
      if (r.versions.length || r.revoked.length) renderStage(p);
    } else if (t.dataset.result) {
      const f = p.stages[n].fields, rk = t.dataset.result;
      f[rk] = f[rk] || {};
      const metaKey = n === 7 ? 'evalMeta' : 'grayMeta';
      if (!f[metaKey] || !Engine.hasValues(f[rk])) Engine.stampResults(p, n); // 第一次录入时记下所依据的修订
      const before = f[rk][t.dataset.mid];
      f[rk][t.dataset.mid] = t.value === '' ? '' : Number(t.value);
      const m = p.stages[3].fields.metrics.find(m => m.id === t.dataset.mid);
      const ok = Rules.meets(m, t.value), prob = Rules.actualProblem(m, t.value);
      logEdit(p, n, `result:${m.id}`, `录入${m.name}（${prob && prob !== 'empty' ? '无效' : ok === null ? '未填' : ok ? '达标' : '未达标'}）`, before === undefined ? '' : before, t.value);
      const r = commit(p, { type: 'result', stage: n, key: m.id, before, after: f[rk][t.dataset.mid] }, `修改了${m.name}的录入值`);
      const flag = t.closest('.r-row').querySelector('.r-flag');
      flag.className = `r-flag ${prob && prob !== 'empty' ? 'stop' : ok === null ? '' : ok ? 'go' : 'stop'}`;
      flag.textContent = prob && prob !== 'empty' ? '格式无效' : ok === null ? '未填' : ok ? '达标' : '未达标';
      if (r.versions.length || r.revoked.length) renderStage(p);
      else { const tr = $('#trend' + n); if (tr) { const ms = (p.stages[3].fields.metrics || []).filter(x => x.role === (n === 7 ? '评测' : '护栏')); tr.outerHTML = trendCards(p, n, ms, f[rk], false); } }
    } else return;
    Store.save(); renderTrack(p); renderDesk(p);
  });

  document.addEventListener('submit', e => {
    if (e.target.dataset.form === 'note') {
      e.preventDefault();
      const text = e.target.elements.note.value.trim();
      if (!text) return;
      const p = Store.active();
      Store.log(p, { stage: p.currentStage, stageName: '手动记录', type: 'note', decision: text, reason: '', rule: '', ai: '' });
      Store.save(); openLog(ui.logFilter); toast('已记录'); return;
    }
    if (e.target.dataset.form !== 'addStep') return;
    e.preventDefault();
    const title = e.target.elements.title.value.trim();
    if (!title) return;
    ask('添加步骤', `在第 ${ui.viewStage} 阶段添加「${title}」。调整步骤需要写明原因。`, { ok: '添加' }).then(r => {
      if (!r) return;
      const p = Store.active();
      p.stages[ui.viewStage].steps.push(Store.makeStep(title));
      Store.log(p, { stage: ui.viewStage, stageName: stageByN(ui.viewStage).name, type: 'adjust', decision: `添加步骤：${title}`, reason: r.text, rule: '', ai: '' });
      commit(p, { type: 'step', stage: ui.viewStage, key: 'add' }, `新增了第 ${ui.viewStage} 阶段的步骤`);
      Store.save(); renderStage(p); renderTrack(p); renderDesk(p);
    });
  });

  // ---------- 启动 ----------
  (async function boot() {
    Store.onError = msg => toast(msg);
    Store.load();
    await AI.init();
    render();
  })();
})();
