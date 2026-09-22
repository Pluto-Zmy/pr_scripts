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

test('真实 A2 快照的重排计划与离线独立计算结果一致', () => {
    const result = planner.plan(clips, 6, 1);
    assert.strictEqual(result.ok, true, result.error);

    assert.strictEqual(result.entries.length, 58);
    assert.strictEqual(result.movedCount, 51);
    assert.strictEqual(result.ngaps, 52);
    assert.strictEqual(result.grid.ticks, '5292000');
    assert.strictEqual(result.gap, '80189676000');           // 0.3156875 秒 = 15153 个采样

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
    assert.strictEqual(result.entries[6].start, '344420045676000');    // 第 7 首
    assert.strictEqual(result.entries[15].start, '875810811960000');   // 第 16 首，位移最大 −12.293 秒
    assert.strictEqual(result.entries[56].start, '3161254537476000');  // 第 57 首

    // 第 6 首与最后一首之间：除最后一个间隙外全部等于 gap
    for (let i = 6; i <= 56; i++) {
        assert.strictEqual(
            planner.sub(result.entries[i].start, result.entries[i - 1].end),
            result.gap,
            '第 ' + i + ' 个间隙不等于 gap'
        );
    }
    // 最后一个间隙吸收取整余数 = gap + 44 个采样
    assert.strictEqual(planner.sub(result.entries[57].start, result.entries[56].end), '80422524000');
    assert.strictEqual(planner.add(result.gap, planner.mulSmall('5292000', 44)), '80422524000');

    // 不重叠
    for (let i = 1; i < result.entries.length; i++) {
        assert.ok(planner.cmp(result.entries[i].start, result.entries[i - 1].end) >= 0);
    }
});

test('剪辑数量不足或时间重叠时拒绝出计划', () => {
    const tooFew = planner.plan(clips.slice(0, 3), 6, 1);
    assert.strictEqual(tooFew.ok, false);
    assert.match(tooFew.error, /数量不足/);

    const duplicated = clips.slice(0, 8).map((clip) => Object.assign({}, clip));
    duplicated[7].start = duplicated[6].start;
    const overlapping = planner.plan(duplicated, 6, 1);
    assert.strictEqual(overlapping.ok, false);
    assert.match(overlapping.error, /重叠/);
});
