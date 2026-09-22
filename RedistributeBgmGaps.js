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
