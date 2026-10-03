"""浏览器端回归测试：python3 tests/browser_test.py
需要：pip install playwright && python -m playwright install chromium
直接打开 public/index.html（演示模式），不需要启动服务。"""
import json, os, pathlib, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / 'public' / 'index.html').as_uri()
results, errors = [], []

def check(cond, name):
    results.append((bool(cond), name)); print(('PASS ' if cond else 'FAIL ') + name)

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('dialog', lambda d: d.accept())
    pg.goto(URL); pg.wait_for_timeout(600)
    pg.evaluate("localStorage.clear()"); pg.reload(); pg.wait_for_timeout(600)

    def reason(t='测试原因'):
        pg.fill('#dlgText', t); pg.click('#dlgOk'); pg.wait_for_timeout(250)
    def fill(sel, v):
        pg.fill(sel, v); pg.press(sel, 'Tab'); pg.wait_for_timeout(150)
    def stage_title(): return pg.inner_text('.sp-head h2')
    def approve(name='业务负责人 张三', why=None):
        pg.fill('#dlgInput', name)
        if why is not None: pg.fill('#dlgText', why)
        pg.click('#dlgOk'); pg.wait_for_timeout(250)

    # 主线：拦截 → 采纳返工 → 构建修订 → 依据快照
    pg.click('[data-act=gate]'); pg.wait_for_timeout(400)
    check('拦截' in pg.inner_text('.verdict'), '第 7 关拦截')
    check('预设演示建议' in pg.inner_text('.session'), '建议标注为预设')
    check(pg.locator('.decide-bar').is_visible(), '决策栏首屏可见')
    # N03：打开关卡后改错误样例，会话过期
    fill('[data-field=errors]', '换成完全不同的错误样例')
    check('已经过期' in pg.inner_text('.session'), 'N03 改错误样例后会话过期')
    pg.click('.decide-bar [data-act=recheck]'); pg.wait_for_timeout(400)
    pg.click('[data-act=adopt]'); pg.wait_for_timeout(300)
    check('第 6 阶段' in stage_title(), '采纳后回到第 6 阶段')
    check('构建依据从修订 1 变为修订 2' in pg.inner_text('.loglist'), '记录构建修订变化')
    pg.click('.loglist [data-act=viewSnap] >> nth=0'); pg.wait_for_timeout(200)
    t = pg.inner_text('.snapdlg')
    check('22' in t and '≤ 15' in t and '建议去向' in t, 'N05 快照含实测、阈值、建议去向')
    check('当时的阶段产出' in t, 'N05 快照含阶段产出')
    pg.click('[data-act=closeDlg]')

    # 返工完成 → 第 7 阶段旧结果过期 → 重录
    pg.locator('.step.todo select').first.select_option('done'); pg.wait_for_timeout(200)
    pg.click('[data-act=advance]'); pg.wait_for_timeout(300)
    check('结果已过期' in pg.inner_text('#stagePanel'), '旧评测结果过期')
    check(pg.locator('[data-mid=m2]').is_disabled(), '过期结果输入框锁定')
    pg.click('[data-act=reResult]'); pg.wait_for_timeout(200)
    # N04：无效实测值
    fill('[data-mid=m2]', '-1'); fill('[data-mid=m3]', '88')
    check('格式无效' in pg.inner_text('#stagePanel'), 'N04 负数显示格式无效')
    pg.click('[data-act=gate]'); pg.wait_for_timeout(400)
    check('录入值无效' in pg.inner_text('.rules'), 'N04 无效值不能过关')
    pg.click('[data-act=closeSession]')
    fill('[data-mid=m2]', '12')
    pg.click('[data-act=gate]'); pg.wait_for_timeout(400)
    check('规则全部满足' in pg.inner_text('.verdict'), '重录达标后通过')
    # A：趋势卡片显示 22 到 12
    t = pg.inner_text('#trend7')
    check('22' in t and '12' in t and '比上次低 10' in t, 'A 趋势卡片显示两次结果')
    pg.click('[data-act=adopt]'); pg.wait_for_timeout(300)
    # B：通过关卡需要批准人
    check(pg.locator('#dlgInput').is_visible(), 'B 通过关卡弹出批准人')
    pg.click('#dlgOk'); pg.wait_for_timeout(100)
    check('请填写批准人' in pg.inner_text('#dlgErr'), 'B 批准人必填')
    approve('业务负责人 张三', '同意进入灰度')
    check('第 8 阶段' in stage_title(), '进入第 8 阶段')
    check('批准人：业务负责人 张三' in pg.inner_text('.loglist'), 'B 决策记录显示批准人')

    # N01：回头把漏检率改成 99，第 7 关撤销，第 8 关被拦
    pg.click('.station:nth-child(7) button'); pg.wait_for_timeout(200)
    fill('[data-mid=m2]', '99')
    log = pg.inner_text('.loglist')
    check('第 7 关「是否达标」失效' in log, 'N01 结果变化撤销第 7 关')
    check('有前置关卡当前无效' in pg.inner_text('#desk'), 'N01 决策台提示前置关卡无效')
    pg.click('[data-act=gate]'); pg.wait_for_timeout(400)
    check('第 7 关「是否达标」仍然有效' in pg.inner_text('.rules') and '拦截' in pg.inner_text('.verdict'), 'N01 第 8 关被拦')
    pg.click('[data-act=closeSession]')
    # N07：改回达标后补确认第 7 关，不改变当前阶段
    pg.click('.station:nth-child(7) button'); pg.wait_for_timeout(200)
    fill('[data-mid=m2]', '12')
    pg.click('#desk [data-act=confirmGate]'); pg.wait_for_timeout(200)
    pg.click('[data-act=doConfirmGate]'); pg.wait_for_timeout(300)
    approve()
    check('有前置关卡当前无效' not in pg.inner_text('#desk') and '第 8/10' in pg.inner_text('#projSel'), 'N07 补确认前置关卡，阶段不变')

    # N02：第 6 阶段新增步骤 → 构建修订加一 → 第 7 关失效
    pg.click('.station:nth-child(6) button'); pg.wait_for_timeout(200)
    pg.fill('.addstep input', '换用新模型'); pg.click('.addstep .btn'); pg.wait_for_timeout(200); reason('模型升级')
    log = pg.inner_text('.loglist')
    check('构建依据从修订 2 变为修订 3' in log, 'N02 新增构建步骤升修订')
    check('第 7 关' in pg.inner_text('#desk .warn-card'), 'N02 第 7 关失效')

    # N09：只改指标名称不升标准修订
    pg.click('.station:nth-child(3) button'); pg.wait_for_timeout(200)
    before = pg.inner_text('.loglist')
    fill('[data-metric=m2] [data-mf=name]', '漏检比例')
    check('验收标准依据从修订' not in pg.inner_text('.loglist').replace(before, ''), 'N09 改指标名称不升修订')
    fill('[data-metric=m2] [data-mf=threshold]', '10')
    check('验收标准依据从修订 1 变为修订 2' in pg.inner_text('.loglist'), '改阈值升标准修订')

    # 强制放行、第 9 阶段、第 10 阶段回流
    pg.evaluate("localStorage.clear()"); pg.reload(); pg.wait_for_timeout(500)
    pg.click('[data-act=gate]'); pg.wait_for_timeout(400)
    pg.click('[data-act=force]'); pg.wait_for_timeout(200)
    pg.fill('#dlgInput', '业务负责人 张三'); pg.click('#dlgOk'); pg.wait_for_timeout(100)
    check('请填写强制放行的原因' in pg.inner_text('#dlgErr'), '强制放行必须写原因')
    approve('业务负责人 张三', '业务方确认')
    check('第 8 阶段' in stage_title() and '风险' in pg.inner_text('#projSel'), '强制放行并标记风险')

    # 新建项目：不可行拦截、终止、重开、确认页名称保留
    pg.click('[data-act=new]'); pg.click('[data-act=fillSample]'); pg.click('[data-act=analyze]'); pg.wait_for_timeout(400)
    pg.fill('#cName2', '我的项目'); pg.click('[data-act=dsAdd] >> nth=0'); pg.wait_for_timeout(100)
    check(pg.input_value('#cName2') == '我的项目', '确认页增删步骤后名称保留')
    pg.click('[data-act=confirmCreate]'); pg.wait_for_timeout(300)
    for k, v in [('goal', 'g'), ('unacceptable', 'u'), ('budget', 'b')]: fill(f'[data-field={k}]', v)
    for i in range(pg.locator('.step select').count()): pg.locator('.step select').nth(i).select_option('done')
    pg.click('[data-act=advance]'); pg.wait_for_timeout(200)
    pg.select_option('[data-field=feasibility]', '不可行'); fill('[data-field=cost]', 'c')
    pg.click('[data-act=gate]'); pg.wait_for_timeout(400)
    check('不是「不可行」' in pg.inner_text('.rules'), '不可行被拦截')
    pg.click('[data-act=terminate]'); pg.wait_for_timeout(200); reason('不可行')
    check('项目已终止' in pg.inner_text('#desk'), '终止项目')
    pg.click('[data-act=reopen]'); pg.wait_for_timeout(200); reason('重开')
    check('下一步' in pg.inner_text('#desk'), '重新开启')

    # C：第 8 关样本量不够被拦
    pg.evaluate("localStorage.clear()"); pg.reload(); pg.wait_for_timeout(500)
    fill('[data-mid=m2]', '12')
    pg.click('[data-act=gate]'); pg.wait_for_timeout(400); pg.click('[data-act=adopt]'); pg.wait_for_timeout(200); approve()
    for k, v in [('grayScope', '10% 用户'), ('grayDuration', '7 天'), ('graySample', '300'), ('rollback', '关闭开关回到人工')]: fill(f'[data-field={k}]', v)
    fill('[data-mid=m4]', '25'); fill('[data-mid=m5]', '5')
    pg.click('[data-act=gate]'); pg.wait_for_timeout(400)
    check('最少 1000，不够' in pg.inner_text('.rules'), 'C 灰度样本不够最少样本量被拦')
    pg.click('[data-act=closeSession]')
    fill('[data-field=graySample]', '1200')
    pg.click('[data-act=gate]'); pg.wait_for_timeout(400)
    check('规则全部满足' in pg.inner_text('.verdict'), 'C 样本够了可以通过')
    pg.click('[data-act=closeSession]')
    # 决策报告含批准人与指标趋势
    with pg.expect_download() as dl:
        pg.click('[data-act=openExport]'); pg.wait_for_timeout(150); pg.click('[data-act=exportReport]')
    rep = pathlib.Path(dl.value.path()).read_text(encoding='utf-8')
    check('**批准人**' in rep and '指标趋势' in rep and '22% → 12%' in rep, 'B/A 决策报告含批准人和指标趋势')

    # N06：坏文件导入失败，且不改变已有数据
    count = len(json.loads(pg.evaluate("localStorage.getItem('ai-pm-workbench-v1')"))['projects'])
    bad = {'name': '坏数据', 'log': [], 'currentStage': 99, 'stages': {str(i): {} for i in range(1, 11)}}
    tmp = pathlib.Path(tempfile.gettempdir()) / 'bad_project.json'; tmp.write_text(json.dumps(bad), encoding='utf-8')
    pg.set_input_files('#importFile', str(tmp)); pg.wait_for_timeout(300)
    after = len(json.loads(pg.evaluate("localStorage.getItem('ai-pm-workbench-v1')"))['projects'])
    check(after == count and '导入失败' in pg.inner_text('#toast'), 'N06 坏文件导入失败且不写入')
    good = json.loads(pg.evaluate("localStorage.getItem('ai-pm-workbench-v1')"))['projects'][0]
    tmp.write_text(json.dumps(good, ensure_ascii=False), encoding='utf-8')
    pg.set_input_files('#importFile', str(tmp)); pg.wait_for_timeout(300)
    check('（导入）' in pg.inner_text('#header h1'), '正常导入，同名自动改名')
    b.close()

failed = [n for ok, n in results if not ok]
print(f'\n{len(results) - len(failed)}/{len(results)} 通过' + (f'；页面错误：{errors}' if errors else ''))
sys.exit(1 if failed or errors else 0)
