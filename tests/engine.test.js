// 推进引擎与规则的单元测试：node tests/engine.test.js
const assert = require('assert');
const S = require('../public/js/stages.js'), R = require('../public/js/rules.js'), E = require('../public/js/engine.js');
function mk() { const st = {}; S.STAGES.forEach(s => { st[s.n] = { steps: s.steps.map(t => ({ id: t, title: t, status: 'done' })), fields: {}, gatePassed: false }; }); return E.ensure({ currentStage: 1, iteration: 1, stages: st, log: [] }); }
const p = mk();
Object.assign(p.stages[1].fields, { goal: 'g', unacceptable: 'u', budget: 'b' });
Object.assign(p.stages[2].fields, { feasibility: '不可行', cost: 'c' });
p.currentStage = 2;
assert.strictEqual(E.advance(p).ok, false, '不可行不能立项');
p.stages[2].fields.feasibility = '可行';
assert.strictEqual(E.advance(p).ok, true);
p.stages[3].fields.metrics = [{ id: 'a', name: '北', role: '北极星', op: '>=', threshold: 1, unit: '%' }, { id: 'b', name: '护', role: '护栏', op: '<=', threshold: 10, unit: '%' }];
assert.strictEqual(E.advance(p).ok, false, '没有评测指标不能确认标准');
p.stages[3].fields.metrics.push({ id: 'c', name: '漏检率', role: '评测', op: '<=', threshold: 150, unit: '%' });
assert.strictEqual(E.advance(p).ok, false, '百分比阈值超范围');
p.stages[3].fields.metrics[2].threshold = 15;
assert.strictEqual(E.advance(p).ok, false, '没有设定灰度最少样本量不能确认标准');
p.stages[3].fields.minGraySample = 300;
assert.strictEqual(E.advance(p).ok, true);
Object.assign(p.stages[4].fields, { prd: 'x', review: '通过' });
E.advance(p); E.advance(p); E.advance(p);
assert.strictEqual(p.currentStage, 7);
Object.assign(p.stages[5].fields, { evalset: '说明', evalSize: 250 });
assert.strictEqual(E.advance(p).ok, false, '没有结果不能过第 7 关');
E.stampResults(p, 7); p.stages[7].fields.evalResults = { c: 12 };
assert.strictEqual(E.advance(p).ok, true, '达标通过第 7 关');
// 回到第 6 阶段：构建版本变化，旧结果过期
p.currentStage = 7; E.back(p, 6, '调 Prompt');
assert.strictEqual(R.resultsCurrent(p, 7), false, '回到构建后旧评测结果过期');
p.currentStage = 7;
assert.strictEqual(E.advance(p).ok, false, '过期结果不能放行');
// 改标准：第 3、7、8 关失效
assert.strictEqual((E.stampResults(p, 7), E.advance(p).ok), false, '返工步骤没完成不能过第 7 关');
p.stages[6].steps.forEach(x => { x.status = 'done'; });
assert.strictEqual(E.advance(p).ok, true);
const c = E.touch(p, 'std');
assert.deepStrictEqual(c.reset, [3, 7]);
assert.strictEqual(R.checkGate(p, 8).find(r => r.label.includes('第 7 关')).pass, false, '第 7 关失效后第 8 关拦截');
// 强制放行：通过但标记风险
const f = E.advance(p, { force: true });
assert.strictEqual(f.ok && f.forced && p.risk, true);
console.log('全部通过');

// ---------- 第二轮评审的反例（N01 N02 N03 N04 N07 N09） ----------
function atStage8() {
  const q = mk();
  Object.assign(q.stages[1].fields, { goal: 'g', unacceptable: 'u', budget: 'b' });
  Object.assign(q.stages[2].fields, { feasibility: '可行', cost: 'c' });
  q.stages[3].fields.metrics = [
    { id: 'n', name: '北', role: '北极星', op: '>=', threshold: 1, unit: '%' },
    { id: 'c', name: '漏检率', role: '评测', op: '<=', threshold: 15, unit: '%' },
    { id: 'g', name: '无效工单率', role: '护栏', op: '<=', threshold: 10, unit: '%' }];
  q.stages[3].fields.minGraySample = 300;
  Object.assign(q.stages[4].fields, { prd: 'x', review: '通过' });
  Object.assign(q.stages[5].fields, { evalset: '说明', evalSize: 250 });
  q.currentStage = 2;
  for (let i = 0; i < 5; i++) assert.strictEqual(E.advance(q).ok, true);
  E.stampResults(q, 7); q.stages[7].fields.evalResults = { c: 12 };
  assert.strictEqual(E.advance(q).ok, true);
  assert.strictEqual(q.currentStage, 8);
  return q;
}

// N01：第 7 关通过后把漏检率改成 99%，第 7、8 关都不能再放行
let q = atStage8();
q.stages[7].fields.evalResults.c = 99;
let r = E.applyChange(q, { type: 'result', stage: 7, key: 'c', before: 12, after: 99 });
assert.deepStrictEqual(r.revoked.map(x => x.n), [7], 'N01 结果变化撤销第 7 关');
Object.assign(q.stages[8].fields, { grayScope: '10%', grayDuration: '7 天', graySample: 500, rollback: '回滚' });
E.stampResults(q, 8); q.stages[8].fields.grayResults = { g: 5 };
assert.strictEqual(E.advance(q).ok, false, 'N01 第 7 关失效后第 8 关拦截');

// N01：评审结论改成不通过，撤销第 4 关并连带撤销之后的关卡
q = atStage8();
q.stages[4].fields.review = '不通过';
r = E.applyChange(q, { type: 'field', stage: 4, key: 'review', before: '通过', after: '不通过' });
assert.strictEqual(r.revoked[0].n, 4);
assert.deepStrictEqual(r.revoked[0].cascade, [7], 'N01 连带撤销第 7 关');

// N02：第 6 阶段新增步骤、修改步骤产出都会让构建修订加一，旧评测过期
q = atStage8();
r = E.applyChange(q, { type: 'step', stage: 6, key: 'add' });
assert.strictEqual(r.versions[0].kind, 'build', 'N02 新增构建步骤升构建修订');
assert.strictEqual(R.resultsCurrent(q, 7), false, 'N02 旧评测过期');
q = atStage8();
r = E.applyChange(q, { type: 'step', stage: 6, key: 'output', before: '', after: '换了模型' });
assert.strictEqual(r.versions.length, 1, 'N02 修改构建步骤产出升修订');
q = atStage8();
r = E.applyChange(q, { type: 'step', stage: 6, key: 'note', before: '', after: '备注' });
assert.strictEqual(r.versions.length, 0, '备注不升修订');

// N03：错误样例变化不改变规则结果，但改变 AI 依据签名
q = atStage8(); q.currentStage = 7;
const sig1 = E.inputSignature(q, 7);
q.stages[7].fields.errors = '全新的错误样例';
assert.notStrictEqual(E.inputSignature(q, 7), sig1, 'N03 错误样例变化使依据签名变化');

// N04：实测值无效不能达标
const lm = { name: '漏检率', op: '<=', threshold: 15, unit: '%' };
assert.strictEqual(R.meets(lm, -1), null, 'N04 负数百分比无效');
assert.strictEqual(R.meets(lm, 'abc'), null);
assert.strictEqual(R.meets(lm, 12), true);
q = atStage8(); q.stages[5].fields.evalSize = 2.5;
assert.strictEqual(R.checkGate(q, 7).find(x => x.label.includes('评测集已登记')).pass, false, 'N04 样本量须为正整数');

// N09：前后值相同不处理；只改指标名称不升标准修订
q = atStage8();
assert.strictEqual(E.applyChange(q, { type: 'field', stage: 5, key: 'evalset', before: '说明', after: '说明' }).skipped, true, 'N09 同值跳过');
r = E.applyChange(q, { type: 'metric', stage: 3, key: 'name', before: '漏检率', after: '漏检比例' });
assert.strictEqual(r.versions.length, 0, 'N09 改名不升修订');
assert.strictEqual(R.resultsCurrent(q, 7), true);

// N07：前置关卡补确认，不改变当前阶段
q = atStage8();
E.applyChange(q, { type: 'metric', stage: 3, key: 'threshold', before: 15, after: 14 });
assert.strictEqual(q.stages[3].gatePassed, false);
const cg = E.confirmGate(q, 3);
assert.strictEqual(cg.ok && q.stages[3].gatePassed && q.currentStage === 8, true, 'N07 补确认第 3 关');

// 最少样本量：灰度样本不够不能全量
q = atStage8();
Object.assign(q.stages[8].fields, { grayScope: '10%', grayDuration: '7 天', graySample: 200, rollback: '回滚' });
E.stampResults(q, 8); q.stages[8].fields.grayResults = { g: 5 };
let g8 = R.checkGate(q, 8).find(x => x.label.includes('最少要求'));
assert.strictEqual(g8.pass, false, '样本 200 不够最少 300');
q.stages[8].fields.graySample = 300;
assert.strictEqual(E.advance(q).ok, true, '样本够了可以全量');

// 指标历史：相同结果不重复记录，结果变化追加
q = atStage8();
E.recordResults(q, 7); E.recordResults(q, 7);
assert.strictEqual(q.metricHistory.length, 1, '相同结果只记一次');
q.stages[7].fields.evalResults.c = 10; E.recordResults(q, 7);
assert.deepStrictEqual(q.metricHistory.map(h => h.values.c), [12, 10], '结果变化追加记录');

console.log('第二轮反例全部通过');
console.log('最少样本量、指标历史通过');
