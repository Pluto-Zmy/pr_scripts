var project = app.project;
var sequence = project.activeSequence;

function getAllProjectItem() {
    var children = app.project.rootItem.children
    for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.name === "base_V3") {
            var bases = child.children;
            $.writeln(bases)
            for (var j = 0; j < bases.length; j++) {
                var base = bases[j];
                if (base.name === "区界.wav") {
                    $.writeln(base.name)
                    var alertAudioTrack = sequence.audioTracks[0];
                    alertAudioTrack.overwriteClip(base, 10)
                    break
                }
            }
            break
        }
    }
}

getAllProjectItem()