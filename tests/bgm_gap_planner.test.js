'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT = path.join(__dirname, '..', 'RedistributeBgmGaps.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'a2_clips.json');

function loadPlanner() {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: SCRIPT });
    assert.ok(sandbox.BgmGapPlanner, 'RedistributeBgmGaps.js 未导出 BgmGapPlanner。');
    return sandbox.BgmGapPlanner;
}

const planner = loadPlanner();
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const clips = fixture.clips.map((clip, i) => ({
    name: 'clip' + (i + 1),
    start: clip.start,
    end: clip.end,
    inSeconds: 0,
    outSeconds: 0,
    item: null
}));

test('Node 下求值整份文件不会触发 Premiere 操作', () => {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: SCRIPT });
    assert.strictEqual(sandbox.BgmGapPlanner.seconds('254016000000'), 1);
});

test('十进制字符串大整数运算在真实 tick 量级精确', () => {
    assert.strictEqual(planner.add('344420045676000', '3161254537476000'), '3505674583152000');
    assert.strictEqual(planner.sub('3505674583152000', '344420045676000'), '3161254537476000');
    assert.strictEqual(planner.cmp('344420045676000', '344420045676001'), -1);
    assert.strictEqual(planner.cmp('0', '0'), 0);
    // 逐字段断言：vm 里造出的对象与测试不在同一 realm，deepStrictEqual 会比原型而误报。
    const divided = planner.divSmall('80194153846', 52);
    assert.strictEqual(divided.q, '1542195266');
    assert.strictEqual(divided.r, 14);
    assert.strictEqual(planner.mulSmall('15153', 5292000), '80189676000');
});

test('采样栅格由源轨时间点反推为 1/48000 秒', () => {
    assert.strictEqual(planner.inferGrid(clips).ticks, '5292000');
});

test('真实 A2 快照 + 序列帧格的重排计划与离线独立实现一致', () => {
    const result = planner.plan(clips, 6, 1, '4233600000');
    assert.strictEqual(result.ok, true, result.error);

    assert.strictEqual(result.entries.length, 58);
    assert.strictEqual(result.movedCount, 51);
    assert.strictEqual(result.ngaps, 52);
    assert.strictEqual(result.sampleGrid.ticks, '5292000');
    // 落位栅格 = 采样栅格与帧格的最小公倍数；帧格是采样栅格的 800 倍
    assert.strictEqual(result.grid.ticks, '4233600000');
    assert.strictEqual(result.grid.label, '1/60 秒');

    // 985 帧空隙分给 52 个间隙：18 帧 x 3 个 + 19 帧 x 49 个
    assert.strictEqual(result.gap, '76204800000');           // 18 帧 = 0.3000 秒
    assert.strictEqual(result.gapMax, '80438400000');        // 19 帧 = 0.3167 秒
    assert.strictEqual(result.extraGaps, 49);

    // 前 6 首原地不动
    for (let i = 0; i < 6; i++) {
        assert.strictEqual(result.entries[i].start, clips[i].start, '第 ' + (i + 1) + ' 首被移动了');
        assert.strictEqual(result.entries[i].end, clips[i].end, '第 ' + (i + 1) + ' 首被改长度了');
        assert.strictEqual(result.entries[i].moved, false);
    }
    // 最后一首原地不动
    assert.strictEqual(result.entries[57].start, clips[57].start);
    assert.strictEqual(result.entries[57].end, clips[57].end);
    assert.strictEqual(result.entries[57].moved, false);

    // 抽样核对离线独立算出的新起点
    assert.strictEqual(result.entries[6].start, '344416060800000');    // 第 7 首
    assert.strictEqual(result.entries[15].start, '875809065600000');   // 第 16 首，位移最大 −12.300 秒
    assert.strictEqual(result.entries[56].start, '3161254521600000');  // 第 57 首

    // 所有时间点必须落在落位栅格上：否则 Premiere 会吸附，实测间隙就不等了
    for (let i = 0; i < result.entries.length; i++) {
        assert.strictEqual(planner.divSmall(result.entries[i].start, 4233600000).r, 0,
            '第 ' + (i + 1) + ' 首起点不在落位栅格上');
        assert.strictEqual(planner.divSmall(result.entries[i].end, 4233600000).r, 0,
            '第 ' + (i + 1) + ' 首终点不在落位栅格上');
    }

    // 间隙只能是 18 或 19 帧。显式间隙 51 个（最后一个间隙由固定端点决定，不在 gaps 里）：
    // 摊出去 48 个「多一格」，剩下 1 格和不足一格的零头落在最后一个间隙上。
    assert.strictEqual(result.gaps.length, 51);
    assert.strictEqual(result.distributedExtras, 48);
    let maxCount = 0;
    for (let i = 0; i < result.gaps.length; i++) {
        const g = result.gaps[i];
        assert.ok(g === result.gap || g === result.gapMax,
            '第 ' + (i + 1) + ' 个间隙 = ' + g + ' 不在 {18 帧, 19 帧} 内');
        if (g === result.gapMax) maxCount++;
    }
    assert.strictEqual(maxCount, 48);
    // 最后一个间隙 = 18 帧 + 剩的 1 格 + 零头，所以是 19 帧（不会留下大窟窿）
    assert.strictEqual(planner.sub(result.entries[57].start, result.entries[56].end), result.gapMax);

    // 不重叠
    for (let i = 1; i < result.entries.length; i++) {
        assert.ok(planner.cmp(result.entries[i].start, result.entries[i - 1].end) >= 0);
    }
});

test('没有落位栅格或源轨时间点不对齐时拒绝出计划', () => {
    const missing = planner.plan(clips, 6, 1);
    assert.strictEqual(missing.ok, false);
    assert.match(missing.error, /落位栅格无效/);

    const zero = planner.plan(clips, 6, 1, '0');
    assert.strictEqual(zero.ok, false);
    assert.match(zero.error, /落位栅格无效/);

    // 把某条起点挪 1 tick，它就不在落位栅格上了 —— 必须拒绝，而不是悄悄被 Premiere 吸附
    const shifted = clips.map((clip) => Object.assign({}, clip));
    shifted[10].start = planner.add(shifted[10].start, '1');
    const misaligned = planner.plan(shifted, 6, 1, '4233600000');
    assert.strictEqual(misaligned.ok, false);
    assert.match(misaligned.error, /不在落位栅格上/);
});

test('剪辑数量不足或时间重叠时拒绝出计划', () => {
    const tooFew = planner.plan(clips.slice(0, 3), 6, 1, '4233600000');
    assert.strictEqual(tooFew.ok, false);
    assert.match(tooFew.error, /数量不足/);

    const duplicated = clips.slice(0, 8).map((clip) => Object.assign({}, clip));
    duplicated[7].start = duplicated[6].start;
    const overlapping = planner.plan(duplicated, 6, 1, '4233600000');
    assert.strictEqual(overlapping.ok, false);
    assert.match(overlapping.error, /重叠/);
});

test('入口函数存在，且 Node 下求值不触发它', () => {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: SCRIPT });
    assert.strictEqual(typeof sandbox.runRedistributeBgmGaps, 'function');
});
