// ProbeBgmApi.js —— 诊断脚本（临时用，不是项目正式脚本）
//
// 目的：RedistributeBgmGaps.js 在 write 模式下抛 "No Enough Parameters"。
// 本脚本把读取与写入路径上的每个宿主调用**单独**拿出来试一遍，每步独立 try/catch，
// 失败的那一步会打印 [FAIL] 和错误原文，从而定位到具体是哪个接口参数不够。
//
// 安全性：
//   - 源轨 A2 只读，不写入、不移动、不删除任何源轨剪辑。
//   - 只会在目标轨 A3 上放一条测试剪辑并立即删除；A3 不存在时自动跳过写测试。
//   - 对素材 in/out 的改动都是「设成它原本的值」，并且最后再恢复一次。
//
// 用法：在 Premiere 中打开目标序列，用 ExtendScript 调试器运行本文件，把控制台输出整段发回。

var PROBE_TICKS_PER_SECOND = 254016000000;

function probe(label, action) {
    try {
        $.writeln("[OK]   " + label + " -> " + String(action()));
        return true;
    } catch (error) {
        $.writeln("[FAIL] " + label + " -> " + error.name + ": " + error.message);
        return false;
    }
}

function runProbe() {
    var sequence, sourceTrack, targetTrack, clip, item, i;
    var targetIndex = 2;
    var probeTicks, probeClip, before, after, inSeconds, outSeconds;

    $.writeln("=== ProbeBgmApi 开始 ===");
    probe("app.version", function () { return app.version; });
    if (!probe("app.project.activeSequence 存在", function () { return !!app.project.activeSequence; })) {
        $.writeln("=== 没有活动序列，结束 ===");
        return;
    }
    sequence = app.project.activeSequence;
    probe("sequence.name", function () { return sequence.name; });
    probe("sequence.timebase", function () { return sequence.timebase; });
    probe("audioTracks.numItems", function () { return sequence.audioTracks.numItems; });
    probe("audioTracks[0].name", function () { return sequence.audioTracks[0].name; });
    probe("audioTracks[1].name", function () { return sequence.audioTracks[1].name; });
    probe("audioTracks[2]（目标轨）", function () {
        var t = sequence.audioTracks[2];
        return t ? "存在，名字=" + t.name : "不存在（undefined）";
    });

    // ---------- 读取路径 ----------
    sourceTrack = sequence.audioTracks[1];
    probe("A2 clips.numItems", function () { return sourceTrack.clips.numItems; });
    clip = sourceTrack.clips[0];
    probe("clip.name", function () { return clip.name; });
    probe("clip.start.ticks", function () { return clip.start.ticks; });
    probe("clip.end.ticks", function () { return clip.end.ticks; });
    probe("clip.duration.seconds", function () { return clip.duration.seconds; });
    probe("typeof clip.inPoint", function () { return typeof clip.inPoint; });
    probe("clip.inPoint.seconds", function () { return clip.inPoint.seconds; });
    probe("clip.outPoint.seconds", function () { return clip.outPoint.seconds; });
    probe("clip.projectItem.name", function () { return clip.projectItem.name; });
    probe("clip.projectItem.nodeId", function () { return clip.projectItem.nodeId; });
    item = clip.projectItem;
    probe("item.getInPoint(2).seconds", function () { return item.getInPoint(2).seconds; });
    probe("item.getOutPoint(2).seconds", function () { return item.getOutPoint(2).seconds; });
    probe("typeof track.overwriteClip", function () { return typeof sourceTrack.overwriteClip; });
    probe("typeof clip.remove", function () { return typeof clip.remove; });

    // ---------- 写入路径（只在 A3 上操作） ----------
    $.writeln("--- 写入路径（仅目标轨 A3）---");
    targetTrack = sequence.audioTracks[targetIndex];
    if (!targetTrack) {
        $.writeln("目标轨 A3 不存在，跳过写入路径测试。");
        $.writeln("=== ProbeBgmApi 结束 ===");
        return;
    }
    inSeconds = clip.inPoint.seconds;
    outSeconds = clip.outPoint.seconds;
    $.writeln("       用于测试的源剪辑参数：inSeconds=" + inSeconds + " outSeconds=" + outSeconds);

    probe("目标轨 clips.numItems（测试前）", function () { return targetTrack.clips.numItems; });
    // 对话框能力测试：Premiere 25.5 的全局 confirm(message) 已知会抛 Not Enough Parameters
    probe("全局 confirm(message)（已知会失败）", function () {
        return confirm("测试") ? "返回 true" : "返回 false";
    });
    probe("全局 confirm(message, title)", function () {
        return confirm("测试", "标题") ? "返回 true" : "返回 false";
    });
    probe("ScriptUI Window 对话框（会弹窗，点「确定」继续）", function () {
        var dialog = new Window("dialog", "ProbeBgmApi：ScriptUI 对话框测试");
        dialog.add("statictext", undefined, "能看到这个窗口就说明 ScriptUI 可用。点「确定」继续。");
        dialog.add("button", undefined, "确定").onClick = function () { dialog.close(1); };
        return "show() 返回 " + dialog.show();
    });

    probe("item.getInPoint(2)", function () { return item.getInPoint(2).seconds; });
    probe("item.setInPoint(原值, 2)", function () { item.setInPoint(inSeconds, 2); return "调用返回"; });
    probe("item.setOutPoint(原值, 2)", function () { item.setOutPoint(outSeconds, 2); return "调用返回"; });

    // 落位位置取 A2 最后一条的结束点之后 60 秒，远离正片内容
    probe("计算落位时间点", function () {
        var last = sourceTrack.clips[sourceTrack.clips.numItems - 1];
        probeTicks = String(Number(last.end.ticks) + 60 * PROBE_TICKS_PER_SECOND);
        return probeTicks;
    });

    // 对照实验 A：2 参数调用
    if (probeTicks) {
        probe("【实验A】overwriteClip(item, ticks) 两参数", function () {
            targetTrack.overwriteClip(item, probeTicks);
            return "调用返回";
        });
        before = 0;
        probe("实验A 是否创建了剪辑", function () {
            before = targetTrack.clips.numItems;
            return before;
        });
        // 若实验A 失败，试对照实验 B：4 参数调用
        if (before === 0) {
            probe("【实验B】overwriteClip(item, ticks, 0, aIdx) 四参数", function () {
                targetTrack.overwriteClip(item, probeTicks, 0, targetIndex);
                return "调用返回";
            });
            probe("实验B 后目标轨条数", function () { return targetTrack.clips.numItems; });
        }
        after = targetTrack.clips.numItems;
        if (after > 0) {
            probe("删除测试剪辑 clip.remove(0, 0)", function () {
                var last = targetTrack.clips[targetTrack.clips.numItems - 1];
                last.remove(0, 0);
                return "调用返回";
            });
            probe("删除后目标轨条数（应为 0）", function () { return targetTrack.clips.numItems; });
        } else {
            $.writeln("[注意] 两个对照实验都没能创建剪辑。");
        }
    }

    probe("恢复 item.setInPoint(原值, 2)", function () { item.setInPoint(inSeconds, 2); return "调用返回"; });
    probe("恢复 item.setOutPoint(原值, 2)", function () { item.setOutPoint(outSeconds, 2); return "调用返回"; });
    probe("targetTrack.setMute(0) 数字参数", function () { targetTrack.setMute(0); return "调用返回"; });
    probe("targetTrack.setMute(1) 数字参数", function () { targetTrack.setMute(1); return "调用返回"; });
    probe("targetTrack.setMute(false) 布尔（已知会失败）", function () { targetTrack.setMute(false); return "调用返回"; });
    probe("收尾：targetTrack.setMute(0) 恢复为未静音", function () { targetTrack.setMute(0); return "调用返回"; });

    $.writeln("=== ProbeBgmApi 结束 ===");
}

runProbe();
