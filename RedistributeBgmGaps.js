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

// 给宿主调用加标签：失败时抛出带步骤名的错误，便于定位到底是哪个接口炸的。
// Premiere 的宿主错误（如 "No Enough Parameters"）本身不带位置，只有靠标签才能定位。
function attempt(label, action) {
    try {
        return action();
    } catch (error) {
        throw new Error("[" + label + "] " + error.name + ": " + error.message);
    }
}

// 收尾动作用：失败只打印不抛出，避免掩盖真正的错误。返回是否成功。
function attemptQuietly(label, action) {
    try {
        action();
        return true;
    } catch (error) {
        $.writeln("[警告] " + label + " 失败：" + error.name + ": " + error.message);
        return false;
    }
}

// 弹出确认对话框。
// 不能用全局 confirm(message)：Premiere 25.5 实测会抛 "Not Enough Parameters"。
// 因此优先用 ExtendScript 自带的 ScriptUI；两条路都走不通就中止 ——
// 绝不在没有确认的情况下写入。
function askConfirmation(title, message) {
    var dialog;
    try {
        dialog = new Window("dialog", title);
        dialog.add("statictext", undefined, message, { multiline: true });
        dialog.add("statictext", undefined, " ");
        dialog.add("button", undefined, "取消").onClick = function () {
            dialog.close(0);
        };
        dialog.add("button", undefined, "确定，开始写入").onClick = function () {
            dialog.close(1);
        };
        return dialog.show() === 1;
    } catch (uiError) {
        $.writeln("[警告] ScriptUI 对话框不可用：" + uiError.name + ": " + uiError.message);
    }
    try {
        return confirm(message, title) === true;
    } catch (confirmError) {
        $.writeln("[警告] 全局 confirm(message, title) 也不可用：" + confirmError.name +
            ": " + confirmError.message);
    }
    throw new Error("无法弹出确认对话框（ScriptUI 与全局 confirm 都不可用）。\n" +
        "为避免在没有确认的情况下写入，已中止；源轨与目标轨都未做任何修改。");
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

// 快照后再删除：不能一边遍历 Track.clips 一边 remove。
function clearTrack(track) {
    var clips = [], current, i;
    for (i = 0; i < count(track.clips); i++) {
        clips.push(track.clips[i]);
    }
    for (i = 0; i < clips.length; i++) {
        current = clips[i];
        attempt("清空目标轨·删除第 " + (i + 1) + " 条", function () {
            current.remove(0, 0);
        });
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
    $.writeln("预检参数：inSeconds=" + entry.source.inSeconds + " outSeconds=" +
        entry.source.outSeconds + " probeTicks=" + probeTicks);
    oldIn = attempt("预检·读素材 in 点", function () { return item.getInPoint(AUDIO_MEDIA_TYPE); });
    oldOut = attempt("预检·读素材 out 点", function () { return item.getOutPoint(AUDIO_MEDIA_TYPE); });
    try {
        attempt("预检·设素材 in 点", function () {
            item.setInPoint(entry.source.inSeconds, AUDIO_MEDIA_TYPE);
        });
        attempt("预检·设素材 out 点", function () {
            item.setOutPoint(entry.source.outSeconds, AUDIO_MEDIA_TYPE);
        });
        attempt("预检·落位 overwriteClip(item, ticks)", function () {
            target.overwriteClip(item, probeTicks);
        });
        clip = attempt("预检·查找测试剪辑", function () { return findPlaced(target, item, probeTicks); });
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
            attemptQuietly("预检·删除测试剪辑", function () { clip.remove(0, 0); });
        }
        if (oldIn) {
            attemptQuietly("预检·恢复素材 in 点", function () {
                item.setInPoint(oldIn.seconds, AUDIO_MEDIA_TYPE);
            });
        }
        if (oldOut) {
            attemptQuietly("预检·恢复素材 out 点", function () {
                item.setOutPoint(oldOut.seconds, AUDIO_MEDIA_TYPE);
            });
        }
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
        if (i === 0) {
            $.writeln("写入参数（第 1 条）：inSeconds=" + entry.source.inSeconds +
                " outSeconds=" + entry.source.outSeconds + " start=" + entry.start);
        }
        oldIn = attempt("写入·第 " + entry.index + " 条读素材 in 点", function () {
            return item.getInPoint(AUDIO_MEDIA_TYPE);
        });
        oldOut = attempt("写入·第 " + entry.index + " 条读素材 out 点", function () {
            return item.getOutPoint(AUDIO_MEDIA_TYPE);
        });
        try {
            // 先按源剪辑的源 in/out 限定长度，避免覆盖掉刚放好的相邻剪辑。
            attempt("写入·第 " + entry.index + " 条设素材 in 点", function () {
                item.setInPoint(entry.source.inSeconds, AUDIO_MEDIA_TYPE);
            });
            attempt("写入·第 " + entry.index + " 条设素材 out 点", function () {
                item.setOutPoint(entry.source.outSeconds, AUDIO_MEDIA_TYPE);
            });
            attempt("写入·第 " + entry.index + " 条落位", function () {
                track.overwriteClip(item, entry.start);
            });
            clip = attempt("写入·第 " + entry.index + " 条查找新剪辑", function () {
                return findPlaced(track, item, entry.start);
            });
            if (!clip) {
                throw new Error("Premiere 没有在预期位置创建剪辑");
            }
            delta = Math.abs(Number(clip.start.ticks) - Number(entry.start));
            if (delta > Number(result.grid.ticks) * 2) {
                throw new Error("落位偏差 " + delta + " ticks，超过 2 个采样");
            }
            if (BgmGapPlanner.cmp(ticksOf(clip.end.ticks), entry.end) !== 0) {
                attempt("写入·第 " + entry.index + " 条校正结束点", function () {
                    clip.end = timeFromTicks(entry.end);
                });
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
            if (oldIn) {
                attemptQuietly("写入·恢复素材 in 点", function () {
                    item.setInPoint(oldIn.seconds, AUDIO_MEDIA_TYPE);
                });
            }
            if (oldOut) {
                attemptQuietly("写入·恢复素材 out 点", function () {
                    item.setOutPoint(oldOut.seconds, AUDIO_MEDIA_TYPE);
                });
            }
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

function execute(config) {
    var sequence = app.project && app.project.activeSequence;
    var source, target, sourceClips, result, summary, cleared = 0;

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
    summary = attempt("生成摘要", function () { return summarize(result, config, sourceClips, target); });
    $.writeln("\n" + summary);

    if (config.mode === "report") {
        alert(summary + "\n\n当前是 report 模式，未做任何修改。\n" +
            '核对上面的间隙值与位移无误后，把 CONFIG.mode 改成 "write" 再跑一次。');
        return;
    }
    if (!target) {
        throw new Error("目标音频轨 A" + config.targetTrack + " 不存在。\n" +
            "请先在 Premiere 中执行：序列 → 添加轨道 → 音频轨 1 条，然后重跑本脚本。");
    }
    if (!attempt("弹出确认对话框", function () {
            return askConfirmation("BGM 间隙重排 — 确认写入", summary + "\n\n" +
                "即将写入目标轨 A" + config.targetTrack + "；源轨 A" +
                config.sourceTrack + " 不会被修改。");
        })) {
        throw new Error("已取消，未做任何修改。");
    }

    if (count(target.clips) > 0) {
        cleared = count(target.clips);
        attempt("清空目标轨", function () { clearTrack(target); });
        $.writeln("已清空目标轨：" + cleared + " 条");
    }
    $.writeln("落位预检：请求与实际的偏差 " +
        attempt("落位预检", function () { return preflight(target, result); }) + " ticks");
    attempt("写入目标轨", function () { writeTarget(target, result); });
    attempt("复读校验", function () { verifyTarget(target, result, config); });
    if (config.autoMuteSource) {
        // setMute 要数字参数：传布尔会抛 "Illegal Parameter type"（已实测）。
        if (attemptQuietly("自动静音源轨 A" + config.sourceTrack, function () {
                sequence.audioTracks[config.sourceTrack - 1].setMute(1);
            })) {
            $.writeln("已静音源轨 A" + config.sourceTrack);
        } else {
            $.writeln("[警告] 自动静音失败，请手动静音 A" + config.sourceTrack + "。");
        }
    }
    alert("写入完成并校验通过。\n\n" + summary + "\n\n" +
        "目标轨 A" + config.targetTrack + "：" + count(target.clips) + " 条" +
        (cleared ? "（写入前清空 " + cleared + " 条）" : "") + "\n" +
        "源轨 A" + config.sourceTrack + " 未做任何修改。" +
        (config.autoMuteSource ? "" : "\n\n提醒：A" + config.sourceTrack + " 与 A" +
            config.targetTrack + " 现在会同时出声，需要手动静音其中一条。"));
}

function runRedistributeBgmGaps() {
    var CONFIG = {
        mode: "write",        // "report"：只试算并打印，不做任何修改；"write"：写入目标轨
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
