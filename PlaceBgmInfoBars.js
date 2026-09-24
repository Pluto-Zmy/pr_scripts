// Premiere Pro ExtendScript. Track numbers are 1-based, matching the UI.
var BgmInfoBars = (function () {
    var TICKS_PER_SECOND = 254016000000;

    function count(items) {
        return typeof items.numItems !== "undefined" ? items.numItems : items.length;
    }

    function ticks(value) {
        var text = String(value);
        if (!/^\d+$/.test(text)) {
            throw new Error("遇到无效或负数时间：" + text);
        }
        return text.replace(/^0+(?=\d)/, "");
    }

    function compare(left, right) {
        left = ticks(left);
        right = ticks(right);
        if (left.length !== right.length) {
            return left.length < right.length ? -1 : 1;
        }
        return left === right ? 0 : (left < right ? -1 : 1);
    }

    // Decimal-string arithmetic preserves Premiere's large tick values.
    function add(left, right) {
        var a = ticks(left), b = ticks(right), result = "", carry = 0, sum;
        var i = a.length - 1, j = b.length - 1;
        while (i >= 0 || j >= 0 || carry) {
            sum = carry + (i >= 0 ? Number(a.charAt(i--)) : 0) +
                (j >= 0 ? Number(b.charAt(j--)) : 0);
            result = String(sum % 10) + result;
            carry = Math.floor(sum / 10);
        }
        return result;
    }

    function time(value) {
        var result = new Time();
        result.ticks = ticks(value);
        return result;
    }

    function findBins(item, found) {
        var i;
        if (item.type === ProjectItemType.BIN && String(item.name) === "bgm_info") {
            found.push(item);
        }
        if (item.children) {
            for (i = 0; i < count(item.children); i++) {
                findBins(item.children[i], found);
            }
        }
    }

    function compareNames(left, right) {
        var a = String(left), b = String(right);
        var partsA = a.match(/\d+|\D+/g) || [];
        var partsB = b.match(/\d+|\D+/g) || [];
        var i, order;
        for (i = 0; i < partsA.length && i < partsB.length; i++) {
            if (/^\d+$/.test(partsA[i]) && /^\d+$/.test(partsB[i])) {
                order = compare(partsA[i], partsB[i]);
            } else {
                order = partsA[i] === partsB[i] ? 0 : (partsA[i] < partsB[i] ? -1 : 1);
            }
            if (order !== 0) {
                return order;
            }
        }
        if (partsA.length !== partsB.length) {
            return partsA.length < partsB.length ? -1 : 1;
        }
        // Resolve equal numeric values (e.g. 01 vs 1) deterministically.
        return a === b ? 0 : (a < b ? -1 : 1);
    }

    function imagesIn(project) {
        var bins = [], images = [], i, item;
        findBins(project.rootItem, bins);
        if (bins.length !== 1) {
            throw new Error("项目中必须有且仅有一个名为 bgm 的素材箱，当前找到 " + bins.length + " 个。");
        }
        for (i = 0; i < count(bins[0].children); i++) {
            item = bins[0].children[i];
            if (item.type !== ProjectItemType.BIN && /\.png$/i.test(String(item.name))) {
                images.push(item);
            }
        }
        images.sort(function (a, b) {
            return compareNames(a.name, b.name);
        });
        if (!images.length) {
            throw new Error("bgm 素材箱中没有 PNG 图片（只查找直接子项）。");
        }
        for (i = 0; i < images.length; i++) {
            if (i && String(images[i - 1].name) === String(images[i].name)) {
                throw new Error("bgm 中存在重名图片：" + images[i].name);
            }
            if (images[i].isOffline && images[i].isOffline()) {
                throw new Error("图片离线：" + images[i].name);
            }
        }
        return images;
    }

    function trackNumber(value, label) {
        if (typeof value !== "number" || !isFinite(value) || value < 1 || Math.floor(value) !== value) {
            throw new Error(label + "轨道编号必须是从 1 开始的正整数。");
        }
        return value - 1;
    }

    function buildPlan(project, videoNumber, audioNumber, durationSeconds) {
        var v = trackNumber(videoNumber, "视频"), a = trackNumber(audioNumber, "音频");
        var sequence = project && project.activeSequence;
        var images, audio = [], plan = [], i, clip, start, end, frameTicks, durationTicks;
        if (!sequence) {
            throw new Error("请先打开一个活动序列。");
        }
        if (!sequence.videoTracks[v] || !sequence.audioTracks[a]) {
            throw new Error("指定轨道不存在：V" + videoNumber + " / A" + audioNumber);
        }
        if (typeof durationSeconds === "undefined") {
            durationSeconds = 5;
        }
        if (typeof durationSeconds !== "number" || !isFinite(durationSeconds) || durationSeconds <= 0) {
            throw new Error("显示秒数必须是有限的正数。");
        }
        frameTicks = Number(sequence.timebase);
        if (!isFinite(frameTicks) || frameTicks <= 0) {
            throw new Error("无法读取序列帧时长。");
        }
        durationTicks = Math.round(durationSeconds * TICKS_PER_SECOND / frameTicks) * frameTicks;
        if (durationTicks < frameTicks || durationTicks > 9007199254740991) {
            throw new Error("显示时长必须至少为一帧，且不能超过安全时间精度范围。");
        }
        images = imagesIn(project);
        for (i = 0; i < count(sequence.audioTracks[a].clips); i++) {
            clip = sequence.audioTracks[a].clips[i];
            audio.push({ name: clip.name, start: ticks(clip.start.ticks), end: ticks(clip.end.ticks) });
        }
        audio.sort(function (left, right) { return compare(left.start, right.start); });
        if (images.length !== audio.length) {
            throw new Error("PNG 图片数量（" + images.length + "）与 A" + audioNumber +
                " 剪辑数量（" + audio.length + "）不一致。");
        }
        for (i = 0; i < audio.length; i++) {
            start = audio[i].start;
            end = add(start, String(durationTicks));
            if (compare(end, audio[i].end) > 0) {
                end = audio[i].end;
            }
            if (compare(start, end) >= 0) {
                throw new Error("音频剪辑时长无效：" + audio[i].name);
            }
            if (i && compare(plan[i - 1].end, start) > 0) {
                throw new Error("信息条时间区间重叠，无法放到同一视频轨道，请缩短显示秒数。");
            }
            plan.push({ item: images[i], audioName: audio[i].name, start: start, end: end });
        }
        return { track: sequence.videoTracks[v], entries: plan };
    }

    function findClip(track, entry) {
        var i, clip;
        for (i = 0; i < count(track.clips); i++) {
            clip = track.clips[i];
            if (clip.projectItem && String(clip.projectItem.nodeId) === String(entry.item.nodeId) &&
                    compare(clip.start.ticks, entry.start) === 0) {
                return clip;
            }
        }
        return null;
    }

    function place(track, entry) {
        var item = entry.item, clip;
        var oldIn = item.getInPoint(1), oldOut = item.getOutPoint(1);
        // Limit the source BEFORE overwrite, so the default still duration cannot
        // erase material beyond the requested information-bar interval.
        var seconds = time(entry.end).seconds - time(entry.start).seconds;
        try {
            item.setInPoint(0, 1);
            item.setOutPoint(seconds, 1);
            track.overwriteClip(item, entry.start);
            clip = findClip(track, entry);
            if (!clip) {
                throw new Error("Premiere 未创建匹配的图片剪辑。");
            }
            clip.end = time(entry.end);
            if (compare(clip.end.ticks, entry.end) !== 0) {
                throw new Error("Premiere 未能设置预期结束时间。");
            }
        } finally {
            // Restore the source monitor's in/out range, including on failure.
            item.setInPoint(0, 1);
            item.setOutPoint(oldOut.seconds, 1);
            item.setInPoint(oldIn.seconds, 1);
        }
    }

    function runWithProject(project, videoNumber, audioNumber, durationSeconds) {
        var plan = buildPlan(project, videoNumber, audioNumber, durationSeconds);
        var i, entry;
        for (i = 0; i < plan.entries.length; i++) {
            entry = plan.entries[i];
            try {
                place(plan.track, entry);
            } catch (error) {
                throw new Error("第 " + (i + 1) + " 张图片 " + entry.item.name + " 放置失败：" +
                    error.message + "\n时间线可能已部分修改，请检查并撤销本次操作后重试。");
            }
            $.writeln((i + 1) + ". " + entry.item.name + " -> " + entry.audioName +
                " [" + time(entry.start).seconds + "s, " + time(entry.end).seconds + "s]");
        }
        return plan.entries.length;
    }

    return { runWithProject: runWithProject };
}());

function placeBgmInfoBars(videoTrackNumber, audioTrackNumber, durationSeconds) {
    try {
        var placed = BgmInfoBars.runWithProject(app.project, videoTrackNumber, audioTrackNumber, durationSeconds);
        alert("成功放置 " + placed + " 个 BGM 信息条。");
    } catch (error) {
        alert("BGM 信息条放置失败：\n" + error.message);
    }
}

// V7: information bars; A2: BGM; display for 5 seconds (capped at BGM end).
placeBgmInfoBars(3, 2, 5);
