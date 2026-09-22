# RedistributeBgmGaps 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `RedistributeBgmGaps.js`，把源音频轨（默认 A2）中间各首音乐之间的间隙重排为等长，
结果写入目标音频轨（默认 A3），源轨全程只读。

**Architecture:** 单文件 ExtendScript，分成两层：`BgmGapPlanner` 是纯粹的排期计算（十进制字符串
大整数运算 + 等距间隙求解 + 自检），不依赖 Premiere，可在 Node 下用真实数据快照做单元测试；
其余函数是 Premiere 胶水层（读轨、试算报告、清空目标轨、落位预检、写入、复读校验）。
`CONFIG.mode` 区分 `"report"`（只算不写）与 `"write"`（写入并校验）。

**Tech Stack:** Adobe Premiere Pro ExtendScript（ES3 语法）、Node.js 20（`node:test` + `node:vm`）、
Markdown

## Global Constraints

- 设计依据：`docs/superpowers/specs/2026-09-22-bgm-gap-redistribution-design.md`。
- 源轨（A2）只读：`remove` / `overwriteClip` / `setInPoint` 等写操作只能作用于目标轨（A3）与素材对象
  （素材 in/out 用完必须恢复）。任何情况下不得移动、删除或改写源轨剪辑。
- ExtendScript 目标为 ES3：只用 `var`、函数声明/表达式、字符串拼接；不用 `let` / `const` / 箭头函数 /
  模板字符串 / `Array.prototype.forEach`。
- tick 值可达 1e19，超过 JS 安全整数范围，所有时间运算必须走十进制字符串大整数函数，
  不得用 `Number` 做精确比较（`Number` 只用于打印和偏差容忍判断）。
- 文件末尾入口必须带 `typeof app` 守卫，使整份文件在 Node 下可安全求值。
- 不修改 `PlaceBgmInfoBars.js`：源轨 A2 不变，BGM 信息条无需重新放置。
- 不修改仓库中其他既有脚本。
- 所有面向用户的提示用中文。

---

## File Structure

- Create: `RedistributeBgmGaps.js` — 脚本本体，含纯计算层 `BgmGapPlanner` 与 Premiere 胶水层。
- Create: `tests/bgm_gap_planner.test.js` — 纯计算层的 Node 测试。
- Create: `tests/fixtures/a2_clips.json` — 已生成的真实 A2 快照（58 条 start/end tick 字符串）。
- Modify: `README.md` — 脚本概览表格、脚本说明新增一节、注意事项补充。
- Already committed: `docs/superpowers/specs/2026-09-22-bgm-gap-redistribution-design.md`。

已核实过的 API 事实（来自 ppro-scripting.docsforadobe.dev）：

- `Track.overwriteClip(projectItem, time)`，`time` 是 tick 字符串。
- `TrackItem.start` / `end` / `inPoint` / `outPoint` 都是 Time 对象，可读写；`TrackItem.remove(inRipple, inAlignToVideo)`。
- `Track.setMute(isMuted)`、`Track.isMuted()`。
- `ProjectItem.setInPoint(seconds, mediaType)` / `setOutPoint(seconds, mediaType)`，
  `mediaType`：1 = 仅视频、2 = 仅音频、4 = 全部。
- 现有剪辑时间点为 48000 Hz 采样栅格（5292000 ticks）的整数倍。

---

### Task 1: 纯计算层 BgmGapPlanner 与 Node 测试

**Files:**
- Create: `tests/bgm_gap_planner.test.js`
- Create: `RedistributeBgmGaps.js`
- Reference: `tests/fixtures/a2_clips.json`（已存在，58 条真实 A2 快照）

**Interfaces:**
- Consumes: `tests/fixtures/a2_clips.json` 的 `clips` 数组，元素形如 `{"start": "<ticks>", "end": "<ticks>"}`。
- Produces: 全局对象 `BgmGapPlanner`，导出
  `plan(clips, keepHead, keepTail)`、`inferGrid(clips)`、`cmp(a, b)`、`add(a, b)`、`sub(a, b)`、
  `mulSmall(value, factor)`、`divSmall(value, divisor)`、`seconds(value)`。
  `plan` 成功时返回 `{ ok: true, entries, gap, grid, ngaps, movedCount, windowStart, windowEnd }`，
  失败时返回 `{ ok: false, error }`；`entries[i]` 为
  `{ index, name, source, start, end, moved }`，其中 `start` / `end` 是十进制 tick 字符串。

- [ ] **Step 1: 写失败的测试**

创建 `tests/bgm_gap_planner.test.js`：

```js
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

test('入口带 typeof app 守卫：Node 下求值整份文件不会触发 Premiere 操作', () => {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: SCRIPT });
    assert.strictEqual(typeof sandbox.runRedistributeBgmGaps, 'function');
    assert.strictEqual(sandbox.BgmGapPlanner.seconds('254016000000'), 1);
});

test('十进制字符串大整数运算在真实 tick 量级精确', () => {
    assert.strictEqual(planner.add('344420045676000', '3161254537476000'), '3505674583152000');
    assert.strictEqual(planner.sub('3505674583152000', '344420045676000'), '3161254537476000');
    assert.strictEqual(planner.cmp('344420045676000', '344420045676001'), -1);
    assert.strictEqual(planner.cmp('0', '0'), 0);
    assert.deepStrictEqual(planner.divSmall('80194153846', 52), { q: '1542195266', r: 14 });
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

    const duplicated = clips.slice(0, 8).map((clip, i) => Object.assign({}, clip));
    duplicated[7].start = duplicated[6].start;
    const overlapping = planner.plan(duplicated, 6, 1);
    assert.strictEqual(overlapping.ok, false);
    assert.match(overlapping.error, /重叠/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
node --test tests/
```

预期：失败，报错指向 `RedistributeBgmGaps.js` 不存在（`ENOENT`）。

- [ ] **Step 3: 创建 `RedistributeBgmGaps.js`，只含纯计算层**

```js
// RedistributeBgmGaps.js
//
// Premiere Pro ExtendScript：把源音频轨（默认 A2）上中间各首音乐之间的间隙重排为等长，
// 整条新排列写入目标音频轨（默认 A3）。源轨全程只读。
//
// 用法：
//   1. 在 Premiere Pro 中打开目标序列。
//   2. 用 VS Code 的 ExtendScript 调试器运行本文件。
//   3. 第一次保持 CONFIG.mode = "report"：只试算并打印，不做任何修改。
//   4. 核对输出无误后改成 "write"，再跑一次；写入后会立即复读校验。
//
// BgmGapPlanner 是不依赖 Premiere 的纯计算部分，可在 Node 下测试：
//   node --test tests/
// 文件末尾的入口带 typeof app 守卫，所以在 Node 中求值整份文件不会触发任何 Premiere 操作。

var BgmGapPlanner = (function () {
    var TICKS_PER_SECOND = 254016000000;

    // 采样栅格候选。Premiere 的音频剪辑位置落在音频采样栅格上，命中哪个取决于素材采样率。
    var GRID_CANDIDATES = [
        { ticks: "5292000", label: "1/48000 秒" },
        { ticks: "5760000", label: "1/44100 秒" }
    ];

    // ---- 十进制字符串大整数运算 ----
    // tick 值可达 1e19，超过 JS 双精度的安全整数范围（2^53），
    // 因此所有精确时间运算都在十进制字符串上进行（与 PlaceBgmInfoBars.js 同一思路）。

    function digits(value) {
        var text = String(value);
        if (!/^\d+$/.test(text)) {
            throw new Error("遇到无效或负数时间：" + text);
        }
        return text.replace(/^0+(?=\d)/, "");
    }

    function cmp(left, right) {
        left = digits(left);
        right = digits(right);
        if (left.length !== right.length) {
            return left.length < right.length ? -1 : 1;
        }
        if (left === right) {
            return 0;
        }
        return left < right ? -1 : 1;
    }

    function add(left, right) {
        var a = digits(left), b = digits(right), out = "", carry = 0, sum;
        var i = a.length - 1, j = b.length - 1;
        while (i >= 0 || j >= 0 || carry) {
            sum = carry + (i >= 0 ? Number(a.charAt(i--)) : 0) +
                (j >= 0 ? Number(b.charAt(j--)) : 0);
            out = String(sum % 10) + out;
            carry = Math.floor(sum / 10);
        }
        return digits(out);
    }

    function sub(left, right) {
        if (cmp(left, right) < 0) {
            throw new Error("大整数减法越界：" + left + " - " + right);
        }
        var a = digits(left), b = digits(right), out = "", borrow = 0, diff;
        var i = a.length - 1, j = b.length - 1;
        while (i >= 0) {
            diff = Number(a.charAt(i--)) - borrow - (j >= 0 ? Number(b.charAt(j--)) : 0);
            if (diff < 0) {
                diff += 10;
                borrow = 1;
            } else {
                borrow = 0;
            }
            out = String(diff) + out;
        }
        return digits(out);
    }

    function mulSmall(value, factor) {
        var a = digits(value), out = "", carry = 0, product, i;
        for (i = a.length - 1; i >= 0; i--) {
            product = Number(a.charAt(i)) * factor + carry;
            out = String(product % 10) + out;
            carry = Math.floor(product / 10);
        }
        while (carry > 0) {
            out = String(carry % 10) + out;
            carry = Math.floor(carry / 10);
        }
        return digits(out);
    }

    // 向下取整的整除，返回 { q: 商, r: 余数 }。divisor 必须是能放进双精度的小整数（<= 1e7）。
    function divSmall(value, divisor) {
        var a = digits(value), q = "", rem = 0, current, i;
        for (i = 0; i < a.length; i++) {
            current = rem * 10 + Number(a.charAt(i));
            q += String(Math.floor(current / divisor));
            rem = current % divisor;
        }
        return { q: digits(q), r: rem };
    }

    // 仅供显示：超过 2^53 时误差约 1e-11 秒，判断精确值必须用 cmp。
    function seconds(value) {
        return Number(digits(value)) / TICKS_PER_SECOND;
    }

    function inferGrid(clips) {
        var i, j, candidate, ok;
        for (i = 0; i < GRID_CANDIDATES.length; i++) {
            candidate = GRID_CANDIDATES[i];
            ok = true;
            for (j = 0; j < clips.length && ok; j++) {
                if (divSmall(clips[j].start, Number(candidate.ticks)).r !== 0 ||
                        divSmall(clips[j].end, Number(candidate.ticks)).r !== 0) {
                    ok = false;
                }
            }
            if (ok) {
                return candidate;
            }
        }
        return { ticks: "1", label: "1 tick（未能识别采样栅格）" };
    }

    function sortByStart(clips) {
        return clips.slice().sort(function (left, right) {
            var order = cmp(left.start, right.start);
            return order !== 0 ? order : cmp(left.end, right.end);
        });
    }

    // keepHead：开头保持不动的首数；keepTail：结尾保持不动的首数。两者都必须 >= 1。
    function plan(clips, keepHead, keepTail) {
        var sorted, grid, durs = [], sumDuration = "0", ngaps, gap, entries = [];
        var windowStart, windowEnd, available, cursor, start, end, movedCount = 0;
        var quotient, actualGap, finalGap, bound, i;

        if (!clips || !clips.length) {
            return { ok: false, error: "源轨上没有剪辑。" };
        }
        if (keepHead < 1 || keepTail < 1) {
            return { ok: false, error: "keepHead 与 keepTail 都必须 >= 1。" };
        }
        if (clips.length < keepHead + keepTail + 1) {
            return { ok: false, error: "剪辑数量不足：前 " + keepHead + " 首与后 " + keepTail +
                " 首固定，中间至少要 1 首，当前共 " + clips.length + " 条。" };
        }

        sorted = sortByStart(clips);
        for (i = 1; i < sorted.length; i++) {
            if (cmp(sorted[i].start, sorted[i - 1].end) < 0) {
                return { ok: false, error: "第 " + i + " 条与第 " + (i + 1) +
                    " 条在时间上重叠，无法只靠移动完成重排。" };
            }
        }

        grid = inferGrid(sorted);
        for (i = keepHead; i <= sorted.length - keepTail - 1; i++) {
            durs.push(sub(sorted[i].end, sorted[i].start));
            sumDuration = add(sumDuration, durs[durs.length - 1]);
        }
        ngaps = durs.length + 1;
        windowStart = sorted[keepHead - 1].end;
        windowEnd = sorted[sorted.length - 1].start;

        if (cmp(windowStart, windowEnd) >= 0) {
            return { ok: false, error: "固定窗口不成立：第 " + keepHead +
                " 首的结束点不早于最后一首的开始点。" };
        }
        available = sub(sub(windowEnd, windowStart), sumDuration);
        if (cmp(available, "0") <= 0) {
            return { ok: false, error: "中间各首已填满固定窗口，没有可分配的空隙。" };
        }
        quotient = divSmall(available, ngaps).q;
        gap = mulSmall(divSmall(quotient, Number(grid.ticks)).q, Number(grid.ticks));
        if (cmp(gap, "0") <= 0) {
            return { ok: false, error: "可用空隙不足一个采样栅格（" + grid.label + "），无法均分。" };
        }

        cursor = windowStart;
        for (i = 0; i < sorted.length; i++) {
            if (i >= keepHead && i <= sorted.length - keepTail - 1) {
                cursor = add(cursor, gap);
                start = cursor;
                end = add(start, durs[i - keepHead]);
                cursor = end;
                movedCount++;
            } else {
                start = sorted[i].start;
                end = sorted[i].end;
            }
            entries.push({
                index: i + 1,
                name: sorted[i].name,
                source: sorted[i],
                start: start,
                end: end,
                moved: cmp(start, sorted[i].start) !== 0 || cmp(end, sorted[i].end) !== 0
            });
        }

        // 自检：不得重叠
        for (i = 1; i < entries.length; i++) {
            if (cmp(entries[i].start, entries[i - 1].end) < 0) {
                return { ok: false, error: "自检失败：重排后第 " + (i + 1) + " 条与前一条重叠。" };
            }
        }
        // 自检：第 keepHead 首与最后一首之间，除最后一个间隙外全部等于 gap
        for (i = keepHead; i <= entries.length - 1 - keepTail; i++) {
            actualGap = sub(entries[i].start, entries[i - 1].end);
            if (cmp(actualGap, gap) !== 0) {
                return { ok: false, error: "自检失败：第 " + i + " 个间隙为 " +
                    seconds(actualGap) + " 秒，不等于 " + seconds(gap) + " 秒。" };
            }
        }
        // 自检：最后一个间隙吸收取整余数，不得超过 ngaps 个栅格
        finalGap = sub(entries[entries.length - 1].start, entries[entries.length - 2].end);
        bound = add(gap, mulSmall(grid.ticks, ngaps));
        if (cmp(finalGap, gap) < 0 || cmp(finalGap, bound) > 0) {
            return { ok: false, error: "自检失败：最后一个间隙 " + seconds(finalGap) +
                " 秒超出 [" + seconds(gap) + ", " + seconds(bound) + "] 秒。" };
        }

        return {
            ok: true,
            entries: entries,
            gap: gap,
            grid: grid,
            ngaps: ngaps,
            movedCount: movedCount,
            windowStart: windowStart,
            windowEnd: windowEnd
        };
    }

    return {
        plan: plan,
        inferGrid: inferGrid,
        cmp: cmp,
        add: add,
        sub: sub,
        mulSmall: mulSmall,
        divSmall: divSmall,
        seconds: seconds
    };
}());
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
node --test tests/
```

预期：5 个测试全部通过，无失败与跳过。

- [ ] **Step 5: 提交**

```bash
git add RedistributeBgmGaps.js tests/bgm_gap_planner.test.js tests/fixtures/a2_clips.json
git commit -m "feat: add BGM gap planner with node tests

纯计算层：十进制字符串大整数运算 + 等距间隙求解 + 自检。
用真实 A2 快照（58 条）做 fixture，期望值由离线独立实现交叉验证。"
```

---

### Task 2: 读取与报告层（report 模式）

**Files:**
- Modify: `RedistributeBgmGaps.js`（在文件末尾追加）

**Interfaces:**
- Consumes: Task 1 的 `BgmGapPlanner`。
- Produces: `runRedistributeBgmGaps()`（入口，无参数，读文件内 `CONFIG`）、
  `readTrack(track)`、`count(items)`、`ticksOf(value)`、`timeFromTicks(value)`、`pad(value, width)`、
  `padRight(value, width)`、`report(entries)`、`summarize(result, config, sourceClips, target)`、
  `maxShiftText(entries)`、`execute(config)`。`readTrack` 返回的剪辑对象形如
  `{ name, start, end, inSeconds, outSeconds, item }`，`start` / `end` 为 tick 字符串。

- [ ] **Step 1: 追加读取与报告层**

在 `RedistributeBgmGaps.js` 末尾（`BgmGapPlanner` 定义之后）追加：

```js
// ==== 以下为 Premiere 胶水层 ====

// ProjectItem.getInPoint / setInPoint 的 mediaType：2 = 仅音频（1 = 仅视频，4 = 全部）
var AUDIO_MEDIA_TYPE = 2;

function count(items) {
    return typeof items.numItems !== "undefined" ? items.numItems : items.length;
}

function ticksOf(value) {
    var text = String(value);
    if (!/^\d+$/.test(text)) {
        throw new Error("遇到无效或负数时间：" + text);
    }
    return text.replace(/^0+(?=\d)/, "");
}

function timeFromTicks(value) {
    var stamp = new Time();
    stamp.ticks = ticksOf(value);
    return stamp;
}

function pad(value, width) {
    var text = String(value);
    while (text.length < width) {
        text = " " + text;
    }
    return text;
}

function padRight(value, width) {
    var text = String(value);
    while (text.length < width) {
        text = text + " ";
    }
    return text;
}

function readTrack(track) {
    var clips = [], i, clip;
    for (i = 0; i < count(track.clips); i++) {
        clip = track.clips[i];
        clips.push({
            name: String(clip.name),
            start: ticksOf(clip.start.ticks),
            end: ticksOf(clip.end.ticks),
            inSeconds: clip.inPoint.seconds,
            outSeconds: clip.outPoint.seconds,
            item: clip.projectItem
        });
    }
    return clips;
}

function report(entries) {
    var lines = ["序号  名称                          原 start      新 start       位移(秒)"];
    var i, entry, oldStart, newStart;
    for (i = 0; i < entries.length; i++) {
        entry = entries[i];
        oldStart = BgmGapPlanner.seconds(entry.source.start);
        newStart = BgmGapPlanner.seconds(entry.start);
        lines.push(pad(entry.index, 4) + "  " + padRight(entry.name, 28) +
            pad(oldStart.toFixed(3), 13) + pad(newStart.toFixed(3), 14) +
            pad(entry.moved ? (newStart - oldStart).toFixed(3) : "—", 10));
    }
    $.writeln(lines.join("\n"));
}

function maxShiftText(entries) {
    var worst = null, worstShift = 0, i, entry, shift;
    for (i = 0; i < entries.length; i++) {
        entry = entries[i];
        shift = BgmGapPlanner.seconds(entry.start) - BgmGapPlanner.seconds(entry.source.start);
        if (Math.abs(shift) > Math.abs(worstShift)) {
            worstShift = shift;
            worst = entry;
        }
    }
    if (!worst) {
        return "无";
    }
    return "第 " + worst.index + " 首 " + (worstShift >= 0 ? "+" : "") + worstShift.toFixed(3) + " 秒";
}

function summarize(result, config, sourceClips, target) {
    var lines = [];
    lines.push("序列：" + app.project.activeSequence.name);
    lines.push("源轨 A" + config.sourceTrack + "：" + sourceClips.length + " 条（前 " +
        config.keepHead + " 首与最后 " + config.keepTail + " 首不动，中间 " +
        result.movedCount + " 首重排）");
    lines.push("目标轨 A" + config.targetTrack + "：" +
        (target ? count(target.clips) + " 条（写入前会清空）" : "不存在"));
    lines.push("采样栅格：" + result.grid.label + "（" + result.grid.ticks + " ticks）");
    lines.push("统一间隙：" + BgmGapPlanner.seconds(result.gap).toFixed(6) + " 秒（" +
        BgmGapPlanner.divSmall(result.gap, Number(result.grid.ticks)).q + " 个采样）");
    lines.push("固定窗口：" + BgmGapPlanner.seconds(result.windowStart).toFixed(3) + " 秒 ～ " +
        BgmGapPlanner.seconds(result.windowEnd).toFixed(3) + " 秒");
    lines.push("最大位移：" + maxShiftText(result.entries));
    lines.push("模式：" + config.mode);
    return lines.join("\n");
}

function execute(config) {
    var sequence = app.project && app.project.activeSequence;
    var source, target, sourceClips, result, summary;

    if (config.mode !== "report" && config.mode !== "write") {
        throw new Error('CONFIG.mode 只能是 "report" 或 "write"，当前是 ' + config.mode + "。");
    }
    if (config.sourceTrack === config.targetTrack) {
        throw new Error("源轨与目标轨不能是同一条。");
    }
    if (!sequence) {
        throw new Error("请先在 Premiere 中打开一个序列。");
    }
    source = sequence.audioTracks[config.sourceTrack - 1];
    if (!source) {
        throw new Error("源音频轨 A" + config.sourceTrack + " 不存在。");
    }
    target = sequence.audioTracks[config.targetTrack - 1];

    sourceClips = readTrack(source);
    result = BgmGapPlanner.plan(sourceClips, config.keepHead, config.keepTail);
    if (!result.ok) {
        throw new Error(result.error);
    }

    report(result.entries);
    summary = summarize(result, config, sourceClips, target);
    $.writeln("\n" + summary);

    if (config.mode === "report") {
        alert(summary + "\n\n当前是 report 模式，未做任何修改。\n" +
            '核对上面的间隙值与位移无误后，把 CONFIG.mode 改成 "write" 再跑一次。');
        return;
    }
    throw new Error("write 模式尚未实现（Task 3 补齐）。");
}

function runRedistributeBgmGaps() {
    var CONFIG = {
        mode: "report",        // "report"：只试算并打印，不做任何修改；"write"：写入目标轨
        keepHead: 6,           // 开头保持不动的首数
        keepTail: 1,           // 结尾保持不动的首数
        sourceTrack: 2,        // 源音频轨（1 起，对应 A2），只读
        targetTrack: 3,        // 目标音频轨（1 起，对应 A3）
        autoMuteSource: false  // 写入后是否自动静音源轨
    };
    try {
        execute(CONFIG);
    } catch (error) {
        alert("BGM 间隙重排失败：\n" + error.message);
    }
}

// 带 typeof app 守卫：在 Node 下求值整份文件时不会触发任何 Premiere 操作。
if (typeof app !== "undefined" && app && app.project) {
    runRedistributeBgmGaps();
}
```

- [ ] **Step 2: 语法检查**

```bash
node --check RedistributeBgmGaps.js
```

预期：无输出（语法通过）。

- [ ] **Step 3: 回归测试**

```bash
node --test tests/
```

预期：Task 1 的 5 个测试仍然全部通过（入口守卫使整份文件在 Node 下可安全求值）。

- [ ] **Step 4: 静态确认源轨只读**

```bash
rg -n "remove\(|overwriteClip\(|setInPoint\(|setOutPoint\(|\.start =|\.end =" RedistributeBgmGaps.js
```

预期：`remove(` / `overwriteClip(` / `setInPoint(` / `setOutPoint(` 只出现在 Task 3 会添加的
目标轨写入函数里；此刻应当只有 `timeFromTicks` 内部的 `stamp.ticks =` 与
`readTrack` 内的读取。出现任何对 `source` 轨对象的写调用都是错误。

- [ ] **Step 5: 提交**

```bash
git add RedistributeBgmGaps.js
git commit -m "feat: add BGM gap report mode

读取源轨、试算、打印对照表与摘要；report 模式下不做任何修改。"
```

---

### Task 3: 写入与复读校验（write 模式）

**Files:**
- Modify: `RedistributeBgmGaps.js`（替换 Task 2 里 `execute` 末尾的占位 throw，并追加新函数）

**Interfaces:**
- Consumes: Task 2 的 `readTrack`、`count`、`ticksOf`、`timeFromTicks`、`pad`、`padRight`、`execute`。
- Produces: `clearTrack(track)`、`findPlaced(track, item, startTicks)`、`preflight(target, result)`、
  `writeTarget(track, result)`、`verifyTarget(track, result, config)`。

- [ ] **Step 1: 在 `execute` 中替换占位，接入写入流程**

把 Task 2 里这一行：

```js
    throw new Error("write 模式尚未实现（Task 3 补齐）。");
```

替换为：

```js
    if (!target) {
        throw new Error("目标音频轨 A" + config.targetTrack + " 不存在。\n" +
            "请先在 Premiere 中执行：序列 → 添加轨道 → 音频轨 1 条，然后重跑本脚本。");
    }
    if (!confirm(summary + "\n\n即将写入目标轨 A" + config.targetTrack +
            "；源轨 A" + config.sourceTrack + " 不会被修改。\n确认继续？")) {
        throw new Error("已取消，未做任何修改。");
    }

    if (count(target.clips) > 0) {
        cleared = count(target.clips);
        clearTrack(target);
        $.writeln("已清空目标轨：" + cleared + " 条");
    }
    $.writeln("落位预检：请求与实际的偏差 " + preflight(target, result) + " ticks");
    writeTarget(target, result);
    verifyTarget(target, result, config);
    if (config.autoMuteSource) {
        sequence.audioTracks[config.sourceTrack - 1].setMute(true);
        $.writeln("已静音源轨 A" + config.sourceTrack);
    }
    alert("写入完成并校验通过。\n\n" + summary + "\n\n" +
        "目标轨 A" + config.targetTrack + "：" + count(target.clips) + " 条" +
        (cleared ? "（写入前清空 " + cleared + " 条）" : "") + "\n" +
        "源轨 A" + config.sourceTrack + " 未做任何修改。");
```

同时把 `execute` 开头的变量声明改为：

```js
    var sequence = app.project && app.project.activeSequence;
    var source, target, sourceClips, result, summary, cleared = 0;
```

- [ ] **Step 2: 追加写入相关函数**

在 `execute` 之前（`summarize` 之后）插入：

```js
// 快照后再删除：不能一边遍历 Track.clips 一边 remove。
function clearTrack(track) {
    var clips = [], i;
    for (i = 0; i < count(track.clips); i++) {
        clips.push(track.clips[i]);
    }
    for (i = 0; i < clips.length; i++) {
        clips[i].remove(0, 0);
    }
}

// 在目标轨上找同素材、起点最接近的剪辑。找不到时返回 null，偏差由调用方判断。
function findPlaced(track, item, startTicks) {
    var best = null, bestDelta = null, i, clip, delta;
    for (i = 0; i < count(track.clips); i++) {
        clip = track.clips[i];
        if (!clip.projectItem || String(clip.projectItem.nodeId) !== String(item.nodeId)) {
            continue;
        }
        delta = Math.abs(Number(clip.start.ticks) - Number(startTicks));
        if (bestDelta === null || delta < bestDelta) {
            bestDelta = delta;
            best = clip;
        }
    }
    return best;
}

// 落位预检：在窗口末尾之后 60 秒放一条测试剪辑，确认 Premiere 严格按给定 tick 落位，
// 然后立即删掉。这是写入前唯一能验证 overwriteClip 落位精度的办法。
function preflight(target, result) {
    var entry = null, i, item, oldIn, oldOut, probeTicks, clip = null, delta;
    for (i = 0; i < result.entries.length && !entry; i++) {
        if (result.entries[i].moved) {
            entry = result.entries[i];
        }
    }
    if (!entry) {
        throw new Error("没有需要移动的剪辑，预检无从进行。");
    }
    item = entry.source.item;
    if (!item) {
        throw new Error("预检失败：第 " + entry.index + " 条没有素材引用。");
    }
    probeTicks = BgmGapPlanner.add(result.windowEnd, "15240960000000");   // 60 秒
    oldIn = item.getInPoint(AUDIO_MEDIA_TYPE);
    oldOut = item.getOutPoint(AUDIO_MEDIA_TYPE);
    try {
        item.setInPoint(entry.source.inSeconds, AUDIO_MEDIA_TYPE);
        item.setOutPoint(entry.source.outSeconds, AUDIO_MEDIA_TYPE);
        target.overwriteClip(item, probeTicks);
        clip = findPlaced(target, item, probeTicks);
        if (!clip) {
            throw new Error("预检失败：目标轨上没有出现测试剪辑。");
        }
        delta = Math.abs(Number(clip.start.ticks) - Number(probeTicks));
        if (delta > Number(result.grid.ticks) * 2) {
            throw new Error("预检失败：请求落位 " + BgmGapPlanner.seconds(probeTicks).toFixed(3) +
                " 秒，实际 " + BgmGapPlanner.seconds(ticksOf(clip.start.ticks)).toFixed(3) +
                " 秒，偏差 " + delta + " ticks（超过 2 个采样）。\n" +
                "说明 Premiere 不会严格按给定 tick 落位，需要先调整写入策略；本次未写入任何正式剪辑。");
        }
        return delta;
    } finally {
        if (clip) {
            clip.remove(0, 0);
        }
        item.setInPoint(oldIn.seconds, AUDIO_MEDIA_TYPE);
        item.setOutPoint(oldOut.seconds, AUDIO_MEDIA_TYPE);
    }
}

function writeTarget(track, result) {
    var i, entry, item, oldIn, oldOut, clip, delta;
    for (i = 0; i < result.entries.length; i++) {
        entry = result.entries[i];
        item = entry.source.item;
        if (!item) {
            throw new Error("第 " + entry.index + " 条（" + entry.source.name +
                "）没有素材引用。\n已写入 " + i +
                " 条，请撤销本次操作（Ctrl+Z）或重跑本脚本。");
        }
        oldIn = item.getInPoint(AUDIO_MEDIA_TYPE);
        oldOut = item.getOutPoint(AUDIO_MEDIA_TYPE);
        try {
            // 先按源剪辑的源 in/out 限定长度，避免覆盖掉刚放好的相邻剪辑。
            item.setInPoint(entry.source.inSeconds, AUDIO_MEDIA_TYPE);
            item.setOutPoint(entry.source.outSeconds, AUDIO_MEDIA_TYPE);
            track.overwriteClip(item, entry.start);
            clip = findPlaced(track, item, entry.start);
            if (!clip) {
                throw new Error("Premiere 没有在预期位置创建剪辑");
            }
            delta = Math.abs(Number(clip.start.ticks) - Number(entry.start));
            if (delta > Number(result.grid.ticks) * 2) {
                throw new Error("落位偏差 " + delta + " ticks，超过 2 个采样");
            }
            if (BgmGapPlanner.cmp(ticksOf(clip.end.ticks), entry.end) !== 0) {
                clip.end = timeFromTicks(entry.end);
                if (BgmGapPlanner.cmp(ticksOf(clip.end.ticks), entry.end) !== 0) {
                    throw new Error("结束点未能校正到计划值");
                }
            }
        } catch (error) {
            throw new Error("第 " + entry.index + " 条（" + entry.source.name + "）写入失败：" +
                error.message + "\n已写入 " + i +
                " 条，请撤销本次操作（Ctrl+Z）或重跑本脚本。源轨未受影响。");
        } finally {
            // 无论成败都恢复素材原有 in/out。
            item.setInPoint(oldIn.seconds, AUDIO_MEDIA_TYPE);
            item.setOutPoint(oldOut.seconds, AUDIO_MEDIA_TYPE);
        }
        $.writeln(pad(entry.index, 4) + "  " + padRight(entry.source.name, 28) +
            BgmGapPlanner.seconds(entry.start).toFixed(3) + " 秒");
    }
}

function verifyTarget(track, result, config) {
    var actual = readTrack(track), planned = result.entries;
    var i, gap, deviation, maxDeviation = 0, finalGap, bound;
    if (actual.length !== planned.length) {
        throw new Error("复读校验失败：目标轨有 " + actual.length + " 条，计划 " +
            planned.length + " 条。");
    }
    for (i = 0; i < actual.length; i++) {
        if (BgmGapPlanner.cmp(actual[i].start, actual[i].end) >= 0) {
            throw new Error("复读校验失败：目标轨第 " + (i + 1) + " 条时长为零或负。");
        }
        if (i && BgmGapPlanner.cmp(actual[i].start, actual[i - 1].end) < 0) {
            throw new Error("复读校验失败：目标轨第 " + (i + 1) + " 条与前一条重叠。");
        }
        deviation = Math.abs(Number(actual[i].start) - Number(planned[i].start));
        if (deviation > maxDeviation) {
            maxDeviation = deviation;
        }
        if (i < config.keepHead || i === actual.length - 1) {
            if (BgmGapPlanner.cmp(actual[i].start, planned[i].source.start) !== 0) {
                throw new Error("复读校验失败：本该不动的第 " + (i + 1) + " 条位置变了（" +
                    BgmGapPlanner.seconds(planned[i].source.start).toFixed(3) + " → " +
                    BgmGapPlanner.seconds(actual[i].start).toFixed(3) + " 秒）。");
            }
        }
    }
    // 第 keepHead 首与最后一首之间：除最后一个间隙外全部等于 gap
    for (i = config.keepHead; i <= actual.length - 1 - config.keepTail; i++) {
        gap = BgmGapPlanner.sub(actual[i].start, actual[i - 1].end);
        if (BgmGapPlanner.cmp(gap, result.gap) !== 0) {
            throw new Error("复读校验失败：第 " + i + " 个间隙为 " +
                BgmGapPlanner.seconds(gap).toFixed(6) + " 秒，应为 " +
                BgmGapPlanner.seconds(result.gap).toFixed(6) + " 秒。");
        }
    }
    // 最后一个间隙吸收取整余数
    finalGap = BgmGapPlanner.sub(actual[actual.length - 1].start, actual[actual.length - 2].end);
    bound = BgmGapPlanner.add(result.gap, BgmGapPlanner.mulSmall(result.grid.ticks, result.ngaps));
    if (BgmGapPlanner.cmp(finalGap, result.gap) < 0 || BgmGapPlanner.cmp(finalGap, bound) > 0) {
        throw new Error("复读校验失败：最后一个间隙为 " +
            BgmGapPlanner.seconds(finalGap).toFixed(6) + " 秒，超出允许范围 [" +
            BgmGapPlanner.seconds(result.gap).toFixed(6) + ", " +
            BgmGapPlanner.seconds(bound).toFixed(6) + "] 秒。");
    }
    $.writeln("\n复读校验通过：");
    $.writeln("  目标轨条数：" + actual.length);
    $.writeln("  最后一个间隙比统一间隙多 " +
        BgmGapPlanner.divSmall(BgmGapPlanner.sub(finalGap, result.gap),
            Number(result.grid.ticks)).q + " 个采样");
    $.writeln("  最大落位偏差：" + maxDeviation + " ticks");
}
```

- [ ] **Step 3: 语法检查**

```bash
node --check RedistributeBgmGaps.js
```

预期：无输出。

- [ ] **Step 4: 回归测试**

```bash
node --test tests/
```

预期：5 个测试全部通过。

- [ ] **Step 5: 静态确认源轨只读**

```bash
rg -n "remove\(|overwriteClip\(|setInPoint\(|setOutPoint\(|\.start =|\.end =|setMute\(" RedistributeBgmGaps.js
```

预期：写调用只出现在 `clearTrack` / `preflight` / `writeTarget`（都接收 `target` /
`track` 参数）以及 `execute` 末尾的 `setMute`；`readTrack` 只读取。
逐条人工确认这些函数的调用点传入的是 `target` 而不是 `source`：

```bash
rg -n "clearTrack\(|preflight\(|writeTarget\(|verifyTarget\(" RedistributeBgmGaps.js
```

预期：四个调用点第一个实参都是 `target`。

- [ ] **Step 6: 提交**

```bash
git add RedistributeBgmGaps.js
git commit -m "feat: add BGM gap write mode with preflight and verification

写入前清空目标轨、落位预检；写入后复读校验条数、位置与间隙；
失败立即中止并报告第几条，源轨不受影响。"
```

---

### Task 4: README 更新

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1–3 完成的 `RedistributeBgmGaps.js` 行为与 CONFIG 参数名。
- Produces: 文档化的脚本入口与运行步骤。

- [ ] **Step 1: 在脚本概览表格中加一行**

在 `README.md` 的脚本概览表格最后一行（`PlaceMarkerSegments.js` 那行）之后加：

```markdown
| `RedistributeBgmGaps.js` | 把源音频轨（默认 A2）中间各首音乐之间的间隙重排为等长，结果写入目标音频轨（默认 A3）；源轨只读。 |
```

- [ ] **Step 2: 新增脚本说明小节**

在 `### PlaceMarkerSegments.js` 小节之后、`## 注意事项` 之前插入：

````markdown
### RedistributeBgmGaps.js

脚本读取活动序列源音频轨上的全部剪辑，保持开头 `keepHead` 首和结尾 `keepTail` 首不动，
把其余各首之间的间隙重排为等长，整条新排列写入目标音频轨。**源轨全程只读。**

固定窗口是第 `keepHead` 首的结束点到最后一首的开始点。两端固定后，等长间隙只有一个解：

```text
gap = (窗口长度 − 中间各首时长之和) / (中间条数 + 1)
```

`gap` 向下取整到源轨实测的采样栅格（由现有剪辑时间点反推），因此除最后一个间隙会吸收
全部取整余数（上限为中间条数个采样）外，其余间隙严格相等。

顶部 `CONFIG`：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `"report"` | `"report"` 只试算并打印，不做任何修改；`"write"` 才写入目标轨 |
| `keepHead` | `6` | 开头保持不动的首数，必须 ≥ 1 |
| `keepTail` | `1` | 结尾保持不动的首数，必须 ≥ 1 |
| `sourceTrack` | `2` | 源音频轨（1 起，对应 A2），只读 |
| `targetTrack` | `3` | 目标音频轨（1 起，对应 A3） |
| `autoMuteSource` | `false` | 写入后是否自动静音源轨 |

运行步骤：

1. 保持 `mode = "report"` 跑一次，核对打印出的间隙值与各首位移。
2. 在 Premiere 中执行 `序列 → 添加轨道 → 音频轨 1 条`，确保目标轨存在。
   ExtendScript 无法创建轨道，目标轨不存在时脚本会中止并提示。
3. 把 `mode` 改成 `"write"` 再跑。脚本会先弹摘要确认，确认后依次：
   必要时清空目标轨 → 落位预检（放一条测试剪辑验证落位精度后立即删除）→ 逐条写入 →
   复读校验条数、位置与间隙。

写入失败或校验不通过时会立即中止并报告是第几条，**源轨不会被修改**。目标轨上的半成品用
`Ctrl+Z` 撤销，或直接重跑（重跑会先清空目标轨）。

写入后源轨与目标轨会同时出声，需要手动静音其中一条；`autoMuteSource = true` 可让脚本
写入后自动静音源轨。

`BgmGapPlanner` 是脚本里不依赖 Premiere 的纯计算部分，仓库内附有 Node 测试：

```bash
node --test tests/
```
````

- [ ] **Step 3: 补充注意事项与项目结构**

在 `## 注意事项` 列表中追加两条：

```markdown
- `RedistributeBgmGaps.js` 只写目标音频轨，源轨仅被读取；写入前请先保存项目，并先跑一次 `"report"` 模式核对数值。
- `RedistributeBgmGaps.js` 的测试依赖 Node.js 20 及以上（使用 `node --test`），运行 Premiere 脚本本身不需要 Node。
```

在 `## 项目结构` 的代码块中，于 `PlaceMarkerSegments.js` 那一行之后一次插入：

```text
├── RedistributeBgmGaps.js
├── tests/
│   ├── bgm_gap_planner.test.js
│   └── fixtures/
│       └── a2_clips.json
```

计划不涉及的其他条目保持原样，不要顺手改动。

- [ ] **Step 4: 文档一致性检查**

```bash
rg -n "mode|keepHead|keepTail|sourceTrack|targetTrack|autoMuteSource" README.md RedistributeBgmGaps.js
node --test tests/
```

预期：README 中出现的参数名与脚本 `CONFIG` 完全一致，测试通过。

- [ ] **Step 5: 提交**

```bash
git add README.md
git commit -m "docs: document RedistributeBgmGaps.js"
```

---

### Task 5: 实机验收（需要 Premiere Pro 与用户执行）

**Files:**
- 无新增；本任务在真实工程上验证 Task 1–3 的产物。

**Interfaces:**
- Consumes: `RedistributeBgmGaps.js`、`PrintBgmStartTime.js`、Premiere Pro 中的 `曲靖-洛阳_main.prproj`。
- Produces: 一份"报告数值与预期一致 + 写入后复读校验通过 + 源轨未变"的验收结论。

前置：在 Premiere 中打开 `曲靖-洛阳_main.prproj` 与主序列，**先保存项目**。

- [ ] **Step 1: 记录源轨现状（写入前的独立证据）**

运行 `PrintBgmStartTime.js`（当前入口为 `printBgmStartTime(1)`，即 A2），把控制台输出
（"序列: …" 到最后一个"音频 58"）复制下来存好。

- [ ] **Step 2: 跑 report 模式核对数值**

保持 `CONFIG.mode = "report"`，运行 `RedistributeBgmGaps.js`。预期摘要：

```text
源轨 A2：58 条（前 6 首与最后 1 首不动，中间 51 首重排）
采样栅格：1/48000 秒（5292000 ticks）
统一间隙：0.315688 秒（15153 个采样）
最大位移：第 16 首 -12.293 秒
模式：report
```

对照表抽查：第 7 首 1355.583 → 1355.899 秒；第 16 首 3460.150 → 3447.857 秒；
第 57 首 12445.417 → 12445.100 秒；第 1～6 首与第 58 首显示 "—"（未移动）。
数值对不上就停下来，把控制台输出发回，不要进入 write 模式。

- [ ] **Step 3: 添加目标轨**

在 Premiere 中执行 `序列 → 添加轨道 → 音频轨 1 条`（Track 数 1）。若跳过这步，
write 模式会提示"目标音频轨 A3 不存在"并中止。

- [ ] **Step 4: 跑 write 模式**

把 `CONFIG.mode` 改成 `"write"`，再次运行。在确认弹窗点"确定"。预期：

- 控制台出现 "落位预检：请求与实际的偏差 0 ticks"；
- 逐条打印 58 条写入记录；
- 末尾出现 "复读校验通过"，目标轨条数 58、最大落位偏差 0 ticks；
- 弹窗报告"写入完成并校验通过"。

出现任何"写入失败 / 复读校验失败"提示时：按提示 `Ctrl+Z` 或重跑，并把完整控制台输出发回。

- [ ] **Step 5: 验证源轨未被修改**

再次运行 `PrintBgmStartTime.js`，把输出与 Step 1 存下的逐字对比。**必须完全一致**
（序列名、58 条的名称与起始秒）。不一致就是严重问题，立刻停止并反馈。

- [ ] **Step 6: 听感验证**

在时间线上把 A2 静音（或把 A3 静音），播放第 6 首与第 58 首之间若干处，确认歌曲之间的
停顿听感一致，且第 1～6 首与最后 1 首位置未变。

- [ ] **Step 7: 记录结论**

把 Step 2 的摘要、Step 4 的控制台输出与 Step 5 的对比结果追加到本计划的"验收记录"一节，
并提交：

```bash
git add docs/superpowers/plans/2026-09-22-bgm-gap-redistribution.md
git commit -m "docs: record RedistributeBgmGaps acceptance run"
```

---

## 验收记录

（由 Task 5 填写：report 摘要、write 控制台输出、`PrintBgmStartTime.js` 前后对比结论。）
