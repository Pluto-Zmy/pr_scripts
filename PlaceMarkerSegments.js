function stripExtension(name) {
    var value = String(name || "");
    var slashIndex = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
    var dotIndex = value.lastIndexOf(".");
    if (dotIndex > slashIndex) {
        return value.substring(0, dotIndex);
    }
    return value;
}

function normalizeTicks(ticks) {
    var value = String(ticks);
    var index = 0;
    while (index < value.length - 1 && value.charAt(index) === "0") {
        index++;
    }
    return value.substring(index);
}

function compareTicks(leftTicks, rightTicks) {
    var left = normalizeTicks(leftTicks);
    var right = normalizeTicks(rightTicks);
    if (left.length !== right.length) {
        return left.length < right.length ? -1 : 1;
    }
    if (left === right) {
        return 0;
    }
    return left < right ? -1 : 1;
}

function buildSegments(markerTicks) {
    var sorted = [];
    var segments = [];
    var index;
    var startTicks = "0";

    if (!markerTicks || markerTicks.length === 0) {
        throw new Error("No sequence markers were found.");
    }

    for (index = 0; index < markerTicks.length; index++) {
        sorted.push(normalizeTicks(markerTicks[index]));
    }
    sorted.sort(compareTicks);

    for (index = 0; index < sorted.length; index++) {
        if (compareTicks(sorted[index], startTicks) <= 0) {
            throw new Error("Every marker segment must have a positive duration.");
        }
        segments.push({
            index: index,
            startTicks: startTicks,
            endTicks: sorted[index]
        });
        startTicks = sorted[index];
    }

    return segments;
}

function collectionLength(collection) {
    if (!collection) {
        return 0;
    }
    if (typeof collection.numItems !== "undefined") {
        return collection.numItems;
    }
    return collection.length;
}

function collectNamedItems(item, wantedNames, result) {
    var baseName;
    var children;
    var index;

    if (!item) {
        return;
    }

    baseName = stripExtension(item.name);
    if (wantedNames[baseName] === true) {
        if (!result[baseName]) {
            result[baseName] = [];
        }
        result[baseName].push(item);
    }

    children = item.children;
    if (!children) {
        return;
    }
    for (index = 0; index < collectionLength(children); index++) {
        collectNamedItems(children[index], wantedNames, result);
    }
}

function requireUniqueItem(itemMatches, name) {
    var matches = itemMatches[name];
    if (!matches || matches.length === 0) {
        throw new Error(name + " is missing.");
    }
    if (matches.length !== 1) {
        throw new Error(name + " has duplicate project items.");
    }
    return matches[0];
}

function validateInputs(sequence, segments, itemMatches) {
    var baseItems = [];
    var maskItems = [];
    var index;

    if (!sequence) {
        throw new Error("No active sequence was found.");
    }
    if (!sequence.videoTracks || !sequence.videoTracks[4]) {
        throw new Error("V5 does not exist.");
    }
    if (!sequence.videoTracks[5]) {
        throw new Error("V6 does not exist.");
    }
    if (!segments || segments.length === 0) {
        throw new Error("No valid marker segments were found.");
    }

    for (index = 0; index < segments.length; index++) {
        baseItems.push(requireUniqueItem(itemMatches, "GLT_P0_" + index + "_BASE"));
        maskItems.push(requireUniqueItem(itemMatches, "GLT_P0_" + index + "_MASK"));
    }

    return {
        baseItems: baseItems,
        maskItems: maskItems
    };
}

function readMarkerTicks(sequence) {
    var ticks = [];
    var marker;

    if (!sequence || !sequence.markers) {
        return ticks;
    }

    marker = sequence.markers.getFirstMarker();
    while (marker) {
        ticks.push(String(marker.start.ticks));
        marker = sequence.markers.getNextMarker(marker);
    }
    return ticks;
}

function makeTime(ticks) {
    var time = new Time();
    time.ticks = normalizeTicks(ticks);
    return time;
}

function sameProjectItem(left, right) {
    if (!left || !right) {
        return false;
    }
    if (typeof left.nodeId !== "undefined" && typeof right.nodeId !== "undefined") {
        return String(left.nodeId) === String(right.nodeId);
    }
    return left === right;
}

function findPlacedClip(track, projectItem, startTicks) {
    var clips = track.clips;
    var index;
    var clip;

    for (index = 0; index < collectionLength(clips); index++) {
        clip = clips[index];
        if (sameProjectItem(clip.projectItem, projectItem) &&
                compareTicks(String(clip.start.ticks), startTicks) === 0) {
            return clip;
        }
    }
    return null;
}

function placeSegment(track, projectItem, startTicks, endTicks) {
    var endTime = makeTime(endTicks);
    var clip;

    track.overwriteClip(projectItem, normalizeTicks(startTicks));
    clip = findPlacedClip(track, projectItem, startTicks);
    if (!clip) {
        throw new Error("Premiere did not create a matching TrackItem.");
    }

    clip.end = endTime;
    if (!clip.end || compareTicks(String(clip.end.ticks), endTicks) !== 0) {
        throw new Error("Premiere could not set the requested TrackItem end.");
    }
    return clip;
}

function wantedMaterialNames(segmentCount) {
    var names = {};
    var index;
    for (index = 0; index < segmentCount; index++) {
        names["GLT_P0_" + index + "_BASE"] = true;
        names["GLT_P0_" + index + "_MASK"] = true;
    }
    return names;
}

function placementError(error, groupIndex, projectItem, segment) {
    return new Error(
        "Placement failed for group " + groupIndex +
        ", material " + projectItem.name +
        ", interval " + segment.startTicks + " to " + segment.endTicks +
        ". " + error.message + " Please undo once."
    );
}

function runWithProject(project) {
    var sequence;
    var segments;
    var itemMatches = {};
    var validated;
    var index;

    if (!project || !project.activeSequence) {
        throw new Error("No active sequence was found.");
    }
    sequence = project.activeSequence;
    segments = buildSegments(readMarkerTicks(sequence));
    collectNamedItems(project.rootItem, wantedMaterialNames(segments.length), itemMatches);
    validated = validateInputs(sequence, segments, itemMatches);

    for (index = 0; index < segments.length; index++) {
        try {
            placeSegment(
                sequence.videoTracks[4],
                validated.baseItems[index],
                segments[index].startTicks,
                segments[index].endTicks
            );
        } catch (baseError) {
            throw placementError(baseError, index, validated.baseItems[index], segments[index]);
        }

        try {
            placeSegment(
                sequence.videoTracks[5],
                validated.maskItems[index],
                segments[index].startTicks,
                segments[index].endTicks
            );
        } catch (maskError) {
            throw placementError(maskError, index, validated.maskItems[index], segments[index]);
        }
    }

    return segments.length;
}

function run() {
    var placedCount;
    try {
        placedCount = runWithProject(app.project);
        alert("成功放置 " + placedCount + " 组 BASE/MASK 素材。");
    } catch (error) {
        alert("放置失败：\n" + error.message);
    }
}

run();
