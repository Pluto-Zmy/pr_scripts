// RedistributeBgmGaps.js
//
// Premiere Pro ExtendScript：把源音频轨（默认 A2）上中间各首音乐之间的间隙重排为等长，
// 整条新排列写入目标音频轨（默认 A3）。源轨全程只读。
//
// 用法：
//   1. 在 Premiere Pro 中打开目标序列。
//   2. 用 VS Code 的 ExtendScript 调试器运行本文件。
//   3. 第一次保持 CONFIG.mode = "report"：只试算并打印，不做任何修改。
//   4. 核对输出无误后把 CONFIG.mode 改成 "write"，再跑一次；写入后立即复读校验。
//      放行闸门就是 mode 开关本身（必须手动改文件才能打开）—— 本脚本不弹确认窗，
//      原因见下方 "关于放行闸门"。
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

    function gcdNumber(a, b) {
        var swap;
        while (b > 0) {
            swap = a % b;
            a = b;
            b = swap;
        }
        return a;
    }

    // 落位栅格 = 采样栅格与序列帧格的最小公倍数。
    // Premiere 会把剪辑位置吸附到序列帧格（timebase）上：本机实测，请求点不在帧格上时
    // 被吸附了 248724000 ticks。因此间隙必须对齐帧格，否则实测间隙会互相差最多一帧。
    function combineGrid(sampleGridTicks, placementGridTicks) {
        var sample = Number(sampleGridTicks), placement = Number(placementGridTicks);
        var ticks;
        if (!isFinite(placement) || placement <= 0 || Math.floor(placement) !== placement) {
            throw new Error("落位栅格无效：" + placementGridTicks);
        }
        ticks = mulSmall(String(placement), sample / gcdNumber(sample, placement));
        return {
            ticks: ticks,
            label: "1/" + Math.round(TICKS_PER_SECOND / Number(ticks)) + " 秒"
        };
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
    // placementGridTicks：序列的 timebase（帧格，单位 ticks）。Premiere 会把剪辑位置
    // 吸附到这个栅格上，所以间隙必须对齐它，否则实测间隙会互相差最多一帧。
    function plan(clips, keepHead, keepTail, placementGridTicks) {
        var sorted, sampleGrid, grid, gridNumber, durs = [], sumDuration = "0", ngaps;
        var windowStart, windowEnd, available, cursor, start, end, movedCount = 0;
        var frames, baseFrames, gapBase, gapMax, extraFrames, gaps = [], gap, extra, k;
        var entries = [], gapMaxCount = 0, distributedExtras, actualGap, finalGap, finalGapFloor, i;

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
        if (!placementGridTicks || !/^\d+$/.test(String(placementGridTicks)) ||
                Number(placementGridTicks) <= 0) {
            return { ok: false, error: "落位栅格无效：" + placementGridTicks +
                "（应为序列的 timebase，单位 ticks 的正整数）。" };
        }

        sorted = sortByStart(clips);
        for (i = 1; i < sorted.length; i++) {
            if (cmp(sorted[i].start, sorted[i - 1].end) < 0) {
                return { ok: false, error: "第 " + i + " 条与第 " + (i + 1) +
                    " 条在时间上重叠，无法只靠移动完成重排。" };
            }
        }

        sampleGrid = inferGrid(sorted);
        try {
            grid = combineGrid(sampleGrid.ticks, placementGridTicks);
        } catch (gridError) {
            return { ok: false, error: gridError.message };
        }
        gridNumber = Number(grid.ticks);
        for (i = 0; i < sorted.length; i++) {
            if (divSmall(sorted[i].start, gridNumber).r !== 0 ||
                    divSmall(sorted[i].end, gridNumber).r !== 0) {
                return { ok: false, error: "源轨第 " + (i + 1) +
                    " 条的时间点不在落位栅格上（" + grid.ticks +
                    " ticks），重排后无法保证间隙严格一致。" };
            }
        }
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
        // 空隙先切成整数个落位栅格单位，除不尽的余数摊到各个间隙上（每个多一格），
        // 避免把几十帧的零头全堆在最后一个间隙里。
        frames = divSmall(available, gridNumber).q;
        baseFrames = divSmall(frames, ngaps).q;
        extraFrames = divSmall(frames, ngaps).r;
        gapBase = mulSmall(baseFrames, gridNumber);
        gapMax = add(gapBase, grid.ticks);
        // 前 ngaps-1 个间隙是显式的；最后一个间隙（最后一首之前）由固定端点决定，
        // 它吸收没摊出去的那几格和不足一格的零头。
        distributedExtras = Math.floor((ngaps - 1) * extraFrames / ngaps);
        if (cmp(frames, "1") < 0) {
            return { ok: false, error: "可用空隙不足一个落位栅格（" + grid.ticks + " ticks），无法均分。" };
        }

        cursor = windowStart;
        for (i = 0; i < sorted.length; i++) {
            if (i >= keepHead && i <= sorted.length - keepTail - 1) {
                k = i - keepHead;
                // 把「多一格」的间隙均匀摊开：前 k+1 个间隙里该有几个是多一格的
                extra = Math.floor((k + 1) * extraFrames / ngaps) -
                    Math.floor(k * extraFrames / ngaps);
                gap = mulSmall(String(Number(baseFrames) + extra), gridNumber);
                gaps.push(gap);
                cursor = add(cursor, gap);
                start = cursor;
                end = add(start, durs[k]);
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

        // 自检：所有时间点都在落位栅格上，且不得重叠
        for (i = 0; i < entries.length; i++) {
            if (divSmall(entries[i].start, gridNumber).r !== 0 ||
                    divSmall(entries[i].end, gridNumber).r !== 0) {
                return { ok: false, error: "自检失败：重排后第 " + (i + 1) +
                    " 条的时间点不在落位栅格上。" };
            }
            if (i && cmp(entries[i].start, entries[i - 1].end) < 0) {
                return { ok: false, error: "自检失败：重排后第 " + (i + 1) + " 条与前一条重叠。" };
            }
        }
        // 自检：每个显式间隙只能是「基础格数」或「多一格」，且多一格的个数等于摊出去的数量
        for (i = 0; i < gaps.length; i++) {
            if (cmp(gaps[i], gapBase) !== 0 && cmp(gaps[i], gapMax) !== 0) {
                return { ok: false, error: "自检失败：第 " + (i + 1) + " 个间隙为 " +
                    seconds(gaps[i]) + " 秒，不在 {" + seconds(gapBase) + ", " +
                    seconds(gapMax) + "} 秒内。" };
            }
            if (cmp(gaps[i], gapMax) === 0) {
                gapMaxCount++;
            }
        }
        if (gapMaxCount !== distributedExtras) {
            return { ok: false, error: "自检失败：多一格的显式间隙有 " + gapMaxCount +
                " 个，应为 " + distributedExtras + " 个。" };
        }
        // 自检：最后一个间隙 = 基础格数 + 没摊出去的那几格 + 不足一格的零头
        finalGap = sub(entries[entries.length - 1].start, entries[entries.length - 2].end);
        finalGapFloor = add(gapBase,
            mulSmall(String(extraFrames - distributedExtras), grid.ticks));
        if (cmp(finalGap, finalGapFloor) < 0 ||
                cmp(finalGap, add(finalGapFloor, grid.ticks)) > 0) {
            return { ok: false, error: "自检失败：最后一个间隙 " + seconds(finalGap) +
                " 秒超出 [" + seconds(finalGapFloor) + ", " +
                seconds(add(finalGapFloor, grid.ticks)) + ") 秒的范围。" };
        }

        return {
            ok: true,
            entries: entries,
            gaps: gaps,
            gap: gapBase,
            gapMax: gapMax,
            extraGaps: extraFrames,
            distributedExtras: distributedExtras,
            grid: grid,
            sampleGrid: sampleGrid,
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

// 关于放行闸门：
// Premiere 25.5 的 ExtendScript 里没有可用的模态确认对话框 —— 全局 confirm 抛
// "Not Enough Parameters"，ScriptUI 的 Window 也不存在（均在本机实测过），
// 所以本脚本不弹窗，以 CONFIG.mode = "write" 这个必须手动改文件才能打开的开关作为闸门。

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
    lines.push("采样栅格：" + result.sampleGrid.label + "（" + result.sampleGrid.ticks + " ticks）");
    lines.push("落位栅格：" + result.grid.label + "（" + result.grid.ticks +
        " ticks = 序列 timebase；Premiere 会把剪辑位置吸附到这里）");
    lines.push("间隙：" + BgmGapPlanner.seconds(result.gap).toFixed(4) + " 秒（" +
        BgmGapPlanner.divSmall(result.gap, Number(result.grid.ticks)).q + " 帧）～ " +
        BgmGapPlanner.seconds(result.gapMax).toFixed(4) + " 秒（" +
        BgmGapPlanner.divSmall(result.gapMax, Number(result.grid.ticks)).q + " 帧）｜共 " +
        result.ngaps + " 个间隙，其中 " + result.extraGaps + " 个取大的那档");
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

// 落位预检：在「第一条要移动的剪辑的真实计划位置」上放一条测试剪辑，确认 Premiere
// 严格按给定 tick 落位，然后立即删掉。用真实计划位置而不是随便找个空位 ——
// 随便找的位置可能恰好落在栅格上，会给出假的好结果（本机就是这么漏过一次）。
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
    probeTicks = entry.start;
    $.writeln("预检参数：位置=" + probeTicks + "（" +
        BgmGapPlanner.seconds(probeTicks).toFixed(4) + " 秒）inSeconds=" +
        entry.source.inSeconds + " outSeconds=" + entry.source.outSeconds);
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
        if (delta > Number(result.sampleGrid.ticks) * 2) {
            throw new Error("预检失败：请求落位 " + BgmGapPlanner.seconds(probeTicks).toFixed(4) +
                " 秒，实际 " + BgmGapPlanner.seconds(ticksOf(clip.start.ticks)).toFixed(4) +
                " 秒，偏差 " + delta + " ticks（" +
                (delta / Number(result.grid.ticks)).toFixed(2) +
                " 帧）。\n说明 Premiere 不会严格按给定 tick 落位，需要先调整写入策略；" +
                "本次未写入任何正式剪辑。");
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
            if (delta > Number(result.sampleGrid.ticks) * 2) {
                throw new Error("落位偏差 " + delta + " ticks（" +
                    (delta / Number(result.grid.ticks)).toFixed(2) + " 帧），超过 2 个采样");
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
    var i, gap, gapMaxCount = 0, deviation, maxDeviation = 0, finalGap, floor, bound;
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
    // 第 keepHead 首与最后一首之间：每个间隙只能是「基础格数」或「多一格」
    for (i = config.keepHead; i <= actual.length - 1 - config.keepTail; i++) {
        gap = BgmGapPlanner.sub(actual[i].start, actual[i - 1].end);
        if (BgmGapPlanner.cmp(gap, result.gap) !== 0 &&
                BgmGapPlanner.cmp(gap, result.gapMax) !== 0) {
            throw new Error("复读校验失败：第 " + i + " 个间隙为 " +
                BgmGapPlanner.seconds(gap).toFixed(4) + " 秒，不在 {" +
                BgmGapPlanner.seconds(result.gap).toFixed(4) + ", " +
                BgmGapPlanner.seconds(result.gapMax).toFixed(4) + "} 秒内。");
        }
        if (BgmGapPlanner.cmp(gap, result.gapMax) === 0) {
            gapMaxCount++;
        }
    }
    if (gapMaxCount !== result.distributedExtras) {
        throw new Error("复读校验失败：多一格的显式间隙有 " + gapMaxCount + " 个，应为 " +
            result.distributedExtras + " 个。");
    }
    // 最后一个间隙 = 基础格数 + 没摊出去的那几格 + 不足一格的零头
    finalGap = BgmGapPlanner.sub(actual[actual.length - 1].start, actual[actual.length - 2].end);
    floor = BgmGapPlanner.add(result.gap,
        BgmGapPlanner.mulSmall(String(result.extraGaps - result.distributedExtras),
            result.grid.ticks));
    bound = BgmGapPlanner.add(floor, result.grid.ticks);
    if (BgmGapPlanner.cmp(finalGap, floor) < 0 || BgmGapPlanner.cmp(finalGap, bound) > 0) {
        throw new Error("复读校验失败：最后一个间隙为 " +
            BgmGapPlanner.seconds(finalGap).toFixed(4) + " 秒，超出允许范围 [" +
            BgmGapPlanner.seconds(result.gap).toFixed(4) + ", " +
            BgmGapPlanner.seconds(bound).toFixed(4) + "] 秒。");
    }
    $.writeln("\n复读校验通过：");
    $.writeln("  目标轨条数：" + actual.length);
    $.writeln("  间隙：" + BgmGapPlanner.divSmall(result.gap, Number(result.grid.ticks)).q +
        " 帧 ～ " + BgmGapPlanner.divSmall(result.gapMax, Number(result.grid.ticks)).q +
        " 帧（多一格的 " + gapMaxCount + " 个）");
    $.writeln("  最后一个间隙：" +
        BgmGapPlanner.divSmall(finalGap, Number(result.grid.ticks)).q + " 帧");
    $.writeln("  最大落位偏差：" + maxDeviation + " ticks");
}

function execute(config) {
    var sequence = app.project && app.project.activeSequence;
    var source, target, sourceClips, placementGrid, result, summary, cleared = 0;

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
    // 序列的 timebase 就是 Premiere 吸附剪辑位置用的帧格，必须传给排期计算，
    // 否则算出来的位置会被吸附、实测间隙差最多一帧（本机实测过）。
    placementGrid = attempt("读取序列 timebase（落位栅格）", function () {
        return String(sequence.timebase);
    });
    result = BgmGapPlanner.plan(sourceClips, config.keepHead, config.keepTail, placementGrid);
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
    $.writeln("===== WRITE 模式：即将写入目标轨 A" + config.targetTrack +
        "，源轨 A" + config.sourceTrack + " 只读，不会改动 =====");

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
