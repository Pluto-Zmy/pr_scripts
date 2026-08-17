var project = app.project;
var sequence = project.activeSequence;

function printBgmStartTime(audioTrackIndex) {
    if (!sequence) {
        alert("请先打开一个序列！");
    } else {
        var trackIndex = audioTrackIndex !== undefined ? audioTrackIndex : 0; // 默认使用第一条音频轨道
        var audioTrack = sequence.audioTracks[trackIndex];

        if (!audioTrack) {
            alert("音频轨道 " + (trackIndex + 1) + " 不存在！");
        } else {
            var clips = audioTrack.clips;
            var result = "序列: " + sequence.name + "\n";
            result += "音频轨道 " + (trackIndex + 1) + " 素材起始时间码：\n\n";

            for (var i = 0; i < clips.length; i++) {
                var clip = clips[i];
                var seconds = clip.start.seconds;
                var showIndex = i + 1; // 从1开始显示索引
                result += "音频 " + showIndex + " : " + clip.name + " : " + seconds + "\n";
            }
            $.writeln(result);
        }
    }
}

printBgmStartTime(1)