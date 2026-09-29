/* Premiere Pro host API for Yato Twitch Timestamp. Strict ES3 syntax. */

function ytsJson(v) {
    var t = typeof v;
    var i;
    var s;
    var c;
    var code;
    var parts;
    var key;
    if (v === null || t === "undefined") return "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "string") {
        s = "\"";
        for (i = 0; i < v.length; i += 1) {
            c = v.charAt(i);
            code = v.charCodeAt(i);
            if (c === "\"") s += "\\\"";
            else if (c === "\\") s += "\\\\";
            else if (c === "\n") s += "\\n";
            else if (c === "\r") s += "\\r";
            else if (c === "\t") s += "\\t";
            else if (code < 32 || code === 0x2028 || code === 0x2029) {
                c = code.toString(16);
                while (c.length < 4) c = "0" + c;
                s += "\\u" + c;
            } else s += c;
        }
        return s + "\"";
    }
    if (v instanceof Array) {
        parts = [];
        for (i = 0; i < v.length; i += 1) parts.push(ytsJson(v[i]));
        return "[" + parts.join(",") + "]";
    }
    if (t === "object") {
        parts = [];
        for (key in v) {
            if (v.hasOwnProperty(key)) parts.push(ytsJson(String(key)) + ":" + ytsJson(v[key]));
        }
        return "{" + parts.join(",") + "}";
    }
    return "null";
}

function ytsMarkerId(marker) {
    var match = String(marker.comments || "").match(/\[yts:([0-9a-f]{8}|y[0-9a-f]{7})\]/);
    return match ? match[1] : null;
}

// Same logic as splitPremiereComment / buildPremiereComment in panel/js/lib.js.
// Update both implementations when this logic changes.
function ytsSplitComment(comments) {
    var s = String(comments == null ? "" : comments);
    var tagPattern = /\s*\[yts:([0-9a-f]{8}|y[0-9a-f]{7})\]\s*$/;
    var tagMatch = tagPattern.exec(s);
    var id = tagMatch ? tagMatch[1] : null;
    var rest = tagMatch ? s.slice(0, tagMatch.index) : s;
    var index = rest.lastIndexOf("by:");
    var tail = index >= 0 ? rest.slice(index + 3) : "";
    var hasBy = index >= 0 && (index === 0 || /\s/.test(rest.charAt(index - 1))) &&
        tail.indexOf("\n") < 0 && tail.indexOf("\r") < 0 && tail.indexOf("[") < 0;
    var by = hasBy ? tail.replace(/^\s+|\s+$/g, "") : "";
    var userRaw = hasBy ? rest.slice(0, index) : rest;
    var user = userRaw.replace(/\s*\[yts:(?:[0-9a-f]{8}|y[0-9a-f]{7})\]/g, "").replace(/^\s+|\s+$/g, "");
    return { user: user, by: by, hasBy: hasBy, id: id };
}

function ytsBuildComment(user, by, hasBy, id) {
    var u = String(user == null ? "" : user).replace(/\s*\[yts:(?:[0-9a-f]{8}|y[0-9a-f]{7})\]/g, "").replace(/^\s+|\s+$/g, "");
    var parts = [];
    var s;
    if (u) parts.push(u);
    if (hasBy) parts.push("by: " + String(by == null ? "" : by));
    s = parts.join(" ");
    if (id) s = s ? s + " [yts:" + id + "]" : "[yts:" + id + "]";
    return s;
}

function ytsMarkerArray(markers) {
    var result = [];
    var marker = markers.getFirstMarker();
    var limit = Number(markers.numMarkers) || 0;
    var i = 0;
    while (marker !== null && typeof marker !== "undefined" && i < limit) {
        result.push(marker);
        marker = markers.getNextMarker(marker);
        i += 1;
    }
    return result;
}

function ytsLocate(id, index, appT) {
    var seq = app.project ? app.project.activeSequence : null;
    var list;
    var candidates = [];
    var fps;
    var tolerance;
    var targetTime = Number(appT);
    var i;
    var candidate;
    if (!seq) return null;
    list = ytsMarkerArray(seq.markers);
    fps = 254016000000 / parseFloat(seq.timebase);
    tolerance = isFinite(fps) && fps > 0 ? 0.5 / fps : 0;
    for (i = 0; i < list.length; i += 1) {
        if (ytsMarkerId(list[i]) === id) candidates.push(list[i]);
    }
    i = Number(index);
    if (i >= 0 && i < list.length && i === Math.floor(i)) {
        candidate = list[i];
        if (ytsMarkerId(candidate) === id && isFinite(targetTime) &&
                Math.abs(Number(candidate.start.seconds) - targetTime) <= tolerance) return candidate;
    }
    for (i = 0; i < candidates.length; i += 1) {
        if (isFinite(targetTime) && Math.abs(Number(candidates[i].start.seconds) - targetTime) <= tolerance) return candidates[i];
    }
    if (candidates.length === 1) return candidates[0];
    return null;
}

function ytsLocateForEdit(id, index, appT, origName) {
    var seq;
    var list;
    var candidateIndex;
    var targetTime;
    var fps;
    var tolerance;
    var candidate;
    if (id) return ytsLocate(id, index, appT);
    seq = app.project ? app.project.activeSequence : null;
    if (!seq) return null;
    list = ytsMarkerArray(seq.markers);
    candidateIndex = Number(index);
    targetTime = Number(appT);
    fps = 254016000000 / parseFloat(seq.timebase);
    tolerance = isFinite(fps) && fps > 0 ? 0.5 / fps : 0;
    if (candidateIndex >= 0 && candidateIndex < list.length &&
            candidateIndex === Math.floor(candidateIndex) && isFinite(targetTime)) {
        candidate = list[candidateIndex];
        if (!ytsMarkerId(candidate) &&
                Math.abs(Number(candidate.start.seconds) - targetTime) <= tolerance &&
                String(candidate.name || "") === String(origName == null ? "" : origName)) return candidate;
    }
    return null;
}

function ytsInfoForSequence(seq) {
    var fps = 0;
    if (seq) fps = 254016000000 / parseFloat(seq.timebase);
    return {
        projectPath: app.project && app.project.path ? app.project.path : "",
        targetId: seq ? String(seq.sequenceID) : "",
        name: seq ? String(seq.name) : "",
        fps: seq && isFinite(fps) ? fps : 0,
        hasTarget: !!seq
    };
}

function ytsPing() {
    try {
        return "OK|pong";
    } catch (e) {
        return "ERR|ホストとの接続確認に失敗しました";
    }
}

function ytsTargetInfo() {
    try {
        var seq = app.project ? app.project.activeSequence : null;
        return "OK|" + ytsJson(ytsInfoForSequence(seq));
    } catch (e) {
        return "ERR|紐付け先の情報を取得できませんでした: " + e.toString();
    }
}

function ytsListMarkers() {
    try {
        var seq = app.project ? app.project.activeSequence : null;
        var list;
        var result = [];
        var i;
        var marker;
        if (!seq) return "ERR|アクティブなシーケンスがありません";
        list = ytsMarkerArray(seq.markers);
        for (i = 0; i < list.length; i += 1) {
            marker = list[i];
            result.push({ index: i, id: ytsMarkerId(marker), t: Number(marker.start.seconds), memo: String(marker.name || "") });
        }
        return "OK|" + ytsJson(result);
    } catch (e) {
        return "ERR|マーカーを取得できませんでした: " + e.toString();
    }
}

function ytsEditMarker(p) {
    try {
        var seq = app.project ? app.project.activeSequence : null;
        var marker;
        var split;
        var id;
        if (!seq) return "ERR|アクティブなシーケンスがありません";
        p = p || {};
        if (typeof p.targetId === "undefined" || String(p.targetId) !== String(seq.sequenceID)) {
            return "ERR|対象が切り替わりました。↻ で更新してください";
        }
        marker = ytsLocateForEdit(p.id || null, p.index, p.t, p.origName);
        if (!marker) return "ERR|マーカーが見つかりません。↻ で更新してください";
        if (typeof p.name !== "undefined") marker.name = String(p.name);
        if (typeof p.comment !== "undefined") {
            split = ytsSplitComment(marker.comments);
            id = split.id || ytsMarkerId(marker);
            marker.comments = ytsBuildComment(String(p.comment), split.by, split.hasBy, id);
        }
        return "OK|" + ytsJson({ ok: true });
    } catch (e) {
        return "ERR|マーカーを編集できませんでした: " + e.toString();
    }
}

function ytsDeleteMarker(p) {
    try {
        var seq = app.project ? app.project.activeSequence : null;
        var marker;
        if (!seq) return "ERR|アクティブなシーケンスがありません";
        p = p || {};
        if (typeof p.targetId === "undefined" || String(p.targetId) !== String(seq.sequenceID)) {
            return "ERR|対象が切り替わりました。↻ で更新してください";
        }
        marker = ytsLocateForEdit(p.id || null, p.index, p.t, p.origName);
        if (!marker) return "ERR|マーカーが見つかりません。↻ で更新してください";
        seq.markers.deleteMarker(marker);
        return "OK|" + ytsJson({ ok: true });
    } catch (e) {
        return "ERR|マーカーを削除できませんでした: " + e.toString();
    }
}

function ytsAddMarker(p) {
    try {
        var seq = app.project ? app.project.activeSequence : null;
        var id;
        var t;
        var marker;
        var list;
        var fps;
        var tolerance;
        var step;
        var collision;
        var i;
        var n;
        if (!seq) return "ERR|アクティブなシーケンスがありません";
        p = p || {};
        if (typeof p.targetId === "undefined" || String(p.targetId) !== String(seq.sequenceID)) {
            return "ERR|対象が切り替わりました。↻ で更新してください";
        }
        id = String(p.id || "");
        if (!/^([0-9a-f]{8}|y[0-9a-f]{7})$/.test(id)) return "ERR|マーカー ID が不正です";
        t = Number(seq.getPlayerPosition().seconds);
        if (!isFinite(t)) return "ERR|再生位置を取得できませんでした";
        fps = 254016000000 / parseFloat(seq.timebase);
        if (isFinite(fps) && fps > 0) {
            tolerance = 0.5 / fps;
            step = 1 / fps;
            list = ytsMarkerArray(seq.markers);
            n = 0;
            while (n <= 10000) {
                collision = false;
                for (i = 0; i < list.length; i += 1) {
                    if (Math.abs(Number(list[i].start.seconds) - t) <= tolerance) {
                        collision = true;
                        break;
                    }
                }
                if (!collision) break;
                if (n === 10000) return "ERR|マーカーを追加できませんでした";
                t += step;
                n += 1;
            }
        }
        marker = seq.markers.createMarker(t);
        if (!marker) return "ERR|マーカーを追加できませんでした";
        try {
            marker.start = t;
            marker.end = t;
            marker.name = "";
            marker.comments = ytsBuildComment("", String(p.by || ""), true, id);
        } catch (writeError) {
            try { seq.markers.deleteMarker(marker); } catch (cleanupError) {}
            throw writeError;
        }
        return "OK|" + ytsJson({ id: id, t: t });
    } catch (e) {
        return "ERR|マーカーを追加できませんでした: " + e.toString();
    }
}

function ytsSequenceClips(seq, cache) {
    var nodeId = seq.projectItem ? String(seq.projectItem.nodeId) : "";
    var key = nodeId ? "n" + nodeId : "s" + String(seq.sequenceID);
    var result = [];
    var trackIndex;
    var track;
    var trackData;
    var muted;
    var disabled;
    var clipIndex;
    var clip;
    if (cache[key]) return cache[key];
    for (trackIndex = Number(seq.videoTracks.numTracks) - 1; trackIndex >= 0; trackIndex -= 1) {
        try {
            track = seq.videoTracks[trackIndex];
            muted = false;
            try {
                muted = typeof track.isMuted === "function" && track.isMuted() === true;
            } catch (muteError) {
                muted = false;
            }
            trackData = { muted: muted, clips: [] };
            for (clipIndex = 0; clipIndex < Number(track.clips.numItems); clipIndex += 1) {
                try {
                    clip = track.clips[clipIndex];
                    disabled = false;
                    try { disabled = clip.disabled === true; } catch (disabledError) { disabled = false; }
                    trackData.clips.push({
                        start: Number(clip.start.seconds),
                        end: Number(clip.end.seconds),
                        inPoint: Number(clip.inPoint.seconds),
                        disabled: disabled,
                        projectItem: clip.projectItem,
                        name: String(clip.name || "")
                    });
                } catch (clipReadError) {}
            }
            result.push(trackData);
        } catch (trackReadError) {}
    }
    cache[key] = result;
    return result;
}

function ytsCachedSequences(cache) {
    var source;
    var i;
    if (cache.sequences) return cache.sequences;
    cache.sequences = [];
    source = app.project.sequences;
    for (i = 0; i < Number(source.numSequences); i += 1) {
        try { cache.sequences.push(source[i]); } catch (sequenceReadError) {}
    }
    return cache.sequences;
}

function ytsNodeVisited(nodeId, visited) {
    var i;
    for (i = 0; i < visited.length; i += 1) {
        if (visited[i] === nodeId) return true;
    }
    return false;
}

// ponytail: speed changes / time remap are ignored; thumbnails drift in that case
function ytsResolveMedia(seq, t, depth, visited, cache) {
    var tracks;
    var trackIndex;
    var clipIndex;
    var track;
    var clip;
    var local;
    var projectItem;
    var sequences;
    var sequenceIndex;
    var nested;
    var path;
    var currentNode;
    var clipNode;
    var nextVisited = [];
    var visitedIndex;
    var result;
    if (depth > 8) return null;
    if (!(visited instanceof Array)) visited = [];
    cache = cache || {};
    for (visitedIndex = 0; visitedIndex < visited.length; visitedIndex += 1) {
        nextVisited.push(visited[visitedIndex]);
    }
    try {
        currentNode = seq.projectItem ? String(seq.projectItem.nodeId) : "";
        nextVisited.push(currentNode);
        tracks = ytsSequenceClips(seq, cache);
        sequences = ytsCachedSequences(cache);
    } catch (sequenceReadError) {
        // A broken sequence must not fail the whole marker list; it just has no thumbnail.
        return null;
    }
    for (trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
        track = tracks[trackIndex];
        if (track.muted) continue;
        clip = null;
        for (clipIndex = 0; clipIndex < track.clips.length; clipIndex += 1) {
            if (!track.clips[clipIndex].disabled && track.clips[clipIndex].start <= t && t < track.clips[clipIndex].end) {
                clip = track.clips[clipIndex];
                break;
            }
        }
        if (!clip) continue;
        try {
            local = t - clip.start + clip.inPoint;
            projectItem = clip.projectItem;
            if (!projectItem) continue;
            if (projectItem.isSequence()) {
                clipNode = String(projectItem.nodeId);
                nested = null;
                if (!ytsNodeVisited(clipNode, nextVisited)) {
                    for (sequenceIndex = 0; sequenceIndex < sequences.length; sequenceIndex += 1) {
                        if (sequences[sequenceIndex].projectItem &&
                                String(sequences[sequenceIndex].projectItem.nodeId) === clipNode &&
                                !ytsNodeVisited(String(sequences[sequenceIndex].projectItem.nodeId), nextVisited)) {
                            nested = sequences[sequenceIndex];
                            break;
                        }
                    }
                }
                if (!nested) {
                    for (sequenceIndex = 0; sequenceIndex < sequences.length; sequenceIndex += 1) {
                        if (sequences[sequenceIndex].projectItem &&
                                !ytsNodeVisited(String(sequences[sequenceIndex].projectItem.nodeId), nextVisited) &&
                                String(sequences[sequenceIndex].name) === String(clip.name)) {
                            nested = sequences[sequenceIndex];
                            break;
                        }
                    }
                }
                if (nested) {
                    result = ytsResolveMedia(nested, local, depth + 1, nextVisited, cache);
                    if (result) return result;
                }
                continue;
            }
            path = String(projectItem.getMediaPath() || "");
            if (path) return { path: path, t: local };
        } catch (clipProcessError) {}
    }
    return null;
}

function ytsMarkerDetails() {
    try {
        var seq = app.project ? app.project.activeSequence : null;
        var list;
        var markers = [];
        var fps;
        var i;
        var marker;
        var t;
        var split;
        var cache = {};
        if (!seq) return "ERR|アクティブなシーケンスがありません";
        fps = 254016000000 / parseFloat(seq.timebase);
        if (!isFinite(fps)) fps = 0;
        list = ytsMarkerArray(seq.markers);
        for (i = 0; i < list.length; i += 1) {
            marker = list[i];
            t = Number(marker.start.seconds);
            split = ytsSplitComment(marker.comments);
            markers.push({
                index: i,
                t: t,
                name: String(marker.name || ""),
                comment: split.user,
                by: split.by,
                id: ytsMarkerId(marker),
                media: ytsResolveMedia(seq, t, 0, [], cache)
            });
        }
        markers.sort(function (a, b) { return a.t - b.t; });
        return "OK|" + ytsJson({ fps: fps, targetName: String(seq.name), markers: markers });
    } catch (e) {
        return "ERR|マーカー詳細を取得できませんでした: " + e.toString();
    }
}

function ytsSeek(t) {
    try {
        var seq = app.project ? app.project.activeSequence : null;
        t = Number(t);
        if (!isFinite(t)) return "ERR|シーク位置が不正です";
        if (!seq) return "ERR|アクティブなシーケンスがありません";
        seq.setPlayerPosition(String(Math.round(t * 254016000000)));
        return "OK|";
    } catch (e) {
        return "ERR|再生位置を移動できませんでした: " + e.toString();
    }
}

function ytsApply(ops) {
    try {
        var seq = app.project ? app.project.activeSequence : null;
        var markers;
        var failed = [];
        var applied = 0;
        var colorMap = {};
        var colorCounter = 0;
        var tags = [];
        var stages = ["update", "delete", "create"];
        var i;
        var j;
        var op;
        var marker;
        var list;
        var tm;
        var idx;
        var colorKey;
        var fps;
        var tolerance;
        var appT;
        var oldStart;
        var oldEnd;
        var delta;
        var comments;
        if (!seq) return "ERR|アクティブなシーケンスがありません";
        markers = seq.markers;
        if (!(ops instanceof Array)) ops = [];
        fps = 254016000000 / parseFloat(seq.timebase);
        tolerance = isFinite(fps) && fps > 0 ? 0.5 / fps : 0;

        var colorFor = function (item) {
            if (item["native"]) return 0;
            colorKey = "k_" + String(item.by || "");
            if (typeof colorMap[colorKey] === "undefined") {
                colorMap[colorKey] = (colorCounter % 7) + 1;
                colorCounter += 1;
            }
            return colorMap[colorKey];
        };

        var writeCreatedMarker = function (target, item) {
            // Premiere 26 rejects Time objects here ("Illegal Parameter type"); plain seconds work.
            target.start = Number(item.t);
            target.end = Number(item.t);
            target.name = item.memo || item.timecode;
            target.comments = "by: " + String(item.by || "") + " [yts:" + item.id + "]";
            idx = colorFor(item);
            try { target.setColorByIndex(idx, 0); } catch (colorError) {}
        };

        for (i = 0; i < ops.length; i += 1) if (ops[i] && ops[i].op === "tag") tags.push(ops[i]);
        tags.sort(function (a, b) { return Number(b.index) - Number(a.index); });
        for (i = 0; i < tags.length; i += 1) {
            op = tags[i];
            try {
                list = ytsMarkerArray(markers);
                idx = Number(op.index);
                appT = Number(op.appT);
                marker = null;
                if (idx >= 0 && idx < list.length && idx === Math.floor(idx) && isFinite(appT) &&
                        Math.abs(Number(list[idx].start.seconds) - appT) <= tolerance) marker = list[idx];
                if (!marker) {
                    for (j = 0; j < list.length; j += 1) {
                        if (!ytsMarkerId(list[j]) && isFinite(appT) &&
                                Math.abs(Number(list[j].start.seconds) - appT) <= tolerance) {
                            marker = list[j];
                            break;
                        }
                    }
                }
                if (!marker) throw new Error("marker");
                comments = String(marker.comments || "").replace(/\s*\[yts:(?:[0-9a-f]{8}|y[0-9a-f]{7})\]/g, "");
                marker.comments = comments + " [yts:" + op.id + "]";
                applied += 1;
            } catch (tagError) { failed.push(String(op.id || "")); }
        }

        for (j = 0; j < stages.length; j += 1) {
            for (i = 0; i < ops.length; i += 1) {
                op = ops[i];
                if (!op || op.op !== stages[j]) continue;
                try {
                    if (op.op === "update") {
                        if (!isFinite(Number(op.t)) || Number(op.t) < 0) throw new Error("time");
                        marker = ytsLocate(op.id, op.index, op.appT);
                        if (!marker) throw new Error("marker");
                        oldStart = Number(marker.start.seconds);
                        oldEnd = Number(marker.end.seconds);
                        delta = Number(op.t) - oldStart;
                        // Setting start can drag end along, so set end afterwards to keep the duration.
                        marker.start = Number(op.t);
                        marker.end = oldEnd + delta;
                        marker.name = op.memo || op.timecode;
                        comments = String(marker.comments || "").replace(/\s*\[yts:(?:[0-9a-f]{8}|y[0-9a-f]{7})\]/g, "");
                        marker.comments = comments + " [yts:" + op.id + "]";
                    } else if (op.op === "delete") {
                        marker = ytsLocate(op.id, op.index, op.appT);
                        if (!marker) throw new Error("marker");
                        markers.deleteMarker(marker);
                    } else {
                        if (!isFinite(Number(op.t)) || Number(op.t) < 0) throw new Error("time");
                        marker = markers.createMarker(Number(op.t));
                        if (!marker) throw new Error("marker");
                        try { writeCreatedMarker(marker, op); }
                        catch (writeError) {
                            // Do not leave an untagged half-made marker behind; it would come back as a new CSV row.
                            try { markers.deleteMarker(marker); } catch (cleanupError) {}
                            throw writeError;
                        }
                    }
                    applied += 1;
                } catch (opError) { failed.push(String(op.id || "")); }
            }
        }
        return "OK|" + ytsJson({ applied: applied, failed: failed, nudged: [] });
    } catch (e) {
        return "ERR|同期処理を開始できませんでした: " + e.toString();
    }
}
