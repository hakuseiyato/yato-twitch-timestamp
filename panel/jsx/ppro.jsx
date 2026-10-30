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

// Same logic as isCandidate / shortSequenceName in panel/js/lib.js.
// Update both implementations when this logic changes.
// memo が候補の印（候補: / 候補：）で始まるか / Whether the memo starts with the candidate prefix.
function ytsIsCandidate(memo) {
    return /^\s*候補[:：]/.test(String(memo || ""));
}

// Short 用 Sequence 名: Short_NN_本文（印と " | " 以降を除き、使えない文字を消して 20 文字まで）
// Short sequence name: Short_NN_body (drops the prefix and everything from " | ", strips unsafe characters, max 20 chars).
function ytsShortName(memo, n) {
    var body = String(memo || "").replace(/^\s*候補[:：]\s*/, "").split(" | ")[0]
        .replace(/[\\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "").substring(0, 20);
    var num = String(n);
    while (num.length < 2) num = "0" + num;
    return body ? "Short_" + num + "_" + body : "Short_" + num;
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

// VBScript string literal built from character codes, so the generated script stays ASCII
// (WSH reads .vbs files in the ANSI code page, which would garble Japanese paths).
function ytsVbsString(text) {
    var parts = [];
    var i;
    for (i = 0; i < text.length; i += 1) parts.push("ChrW(" + text.charCodeAt(i) + ")");
    return parts.length ? parts.join(" & ") : "\"\"";
}

// Shows an exported file in Explorer in front of other windows, with the file selected.
// An Explorer window already showing the folder is closed first: Windows reuses such a window without
// bringing it forward. Falls back to plainly opening the folder when the script cannot run.
function ytsRevealFile(filePath) {
    var file;
    var folder;
    var script;
    var lines;
    try {
        file = new File(String(filePath));
        folder = file.parent;
        if (!folder || !folder.exists) return "ERR|フォルダが見つかりません";
        lines = [
            "Option Explicit",
            "Dim app, w, p, i, count, wins(), target, file",
            "file = " + ytsVbsString(file.fsName),
            "target = LCase(" + ytsVbsString(folder.fsName) + ")",
            "Set app = CreateObject(\"Shell.Application\")",
            "count = 0",
            "ReDim wins(app.Windows.Count)",
            "For Each w In app.Windows",
            "  p = \"\"",
            "  On Error Resume Next",
            "  p = LCase(w.Document.Folder.Self.Path)",
            "  On Error GoTo 0",
            "  If p = target Then Set wins(count) = w : count = count + 1",
            "Next",
            "For i = 0 To count - 1",
            "  On Error Resume Next",
            "  wins(i).Quit",
            "  On Error GoTo 0",
            "Next",
            "CreateObject(\"WScript.Shell\").Run \"explorer.exe /select,\" & Chr(34) & file & Chr(34), 1, False"
        ];
        script = new File(Folder.temp.fsName + "/yts_reveal.vbs");
        script.encoding = "ASCII";
        script.lineFeed = "Windows";
        if (script.open("w")) {
            script.write(lines.join("\n"));
            script.close();
            if (script.execute()) return "OK|";
        }
        folder.execute();
        return "OK|";
    } catch (e) {
        return "ERR|フォルダを開けませんでした: " + e.toString();
    }
}

// Exports the sequence's rendered frame (all layers) at p.t as PNG. The QE export runs asynchronously and
// appends ".png" itself, so the panel waits for the returned path to appear. The playhead is not moved.
function ytsExportFrame(p) {
    try {
        var seq = app.project ? app.project.activeSequence : null;
        var sep = String.fromCharCode(92);
        var settings;
        var time;
        var tc;
        var base;
        var target;
        if (!seq) return "ERR|アクティブなシーケンスがありません";
        p = p || {};
        if (typeof p.targetId === "undefined" || String(p.targetId) !== String(seq.sequenceID)) {
            return "ERR|対象が切り替わりました。↻ で更新してください";
        }
        if (!isFinite(Number(p.t)) || Number(p.t) < 0) return "ERR|時刻が不正です";
        app.enableQE();
        settings = seq.getSettings();
        time = new Time();
        time.seconds = Number(p.t);
        tc = time.getFormatted(settings.videoFrameRate, settings.videoDisplayFormat);
        base = new Folder(String(p.dir)).fsName + sep + String(p.name);
        target = new File(base + ".png");
        if (target.exists) target.remove();
        if (!qe.project.getActiveSequence().exportFramePNG(tc, base)) return "ERR|フレームを書き出せませんでした";
        return "OK|" + ytsJson({ path: target.fsName, width: settings.videoFrameWidth, height: settings.videoFrameHeight });
    } catch (e) {
        return "ERR|フレームを書き出せませんでした: " + e.toString();
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

        // Premiere の色番号: 0 緑 1 赤 2 紫 3 橙 4 黄 5 白 6 青 7 水色。黄は Scout の候補専用にする
        // Premiere colour indices: 0 green 1 red 2 purple 3 orange 4 yellow 5 white 6 blue 7 cyan. Yellow is reserved for Scout candidates.
        var colorFor = function (item) {
            if (ytsIsCandidate(item.memo)) return 4;
            if (item["native"]) return 0;
            colorKey = "k_" + String(item.by || "");
            if (typeof colorMap[colorKey] === "undefined") {
                colorMap[colorKey] = [1, 2, 3, 5, 6, 7][colorCounter % 6];
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

// parent 直下の名前が一致する bin（無ければ null）/ The child bin of parent with this name (null when missing)
function ytsFindBin(parent, name) {
    var i;
    var child;
    if (!parent || !parent.children) return null;
    for (i = 0; i < parent.children.numItems; i += 1) {
        child = parent.children[i];
        if (child && child.type === ProjectItemType.BIN && child.name === name) return child;
    }
    return null;
}

// parent 直下の bin を探し、無ければ作る / Finds the child bin of parent, creating it when missing
function ytsFindOrCreateBin(parent, name) {
    var bin = ytsFindBin(parent, name);
    var made;
    if (bin) return bin;
    made = parent.createBin(name);
    // createBin は失敗時 0 を返す。成功時も取り直して実体を返す / createBin returns 0 on failure; re-read to return the live item
    return ytsFindBin(parent, name) || (made && typeof made === "object" ? made : null);
}

// root から names の順に bin をたどる。create なら足りない bin を作る（作れなければ null）
// Walks bins from root along names; with create, missing bins are created (null when one cannot be found or made).
function ytsFindBinPath(root, names, create) {
    var bin = root;
    var i;
    for (i = 0; i < names.length && bin; i += 1) bin = create ? ytsFindOrCreateBin(bin, names[i]) : ytsFindBin(bin, names[i]);
    return bin || null;
}

// フル尺 Sequence のマーカー 1 つごとに Short 用 Sequence を作る。クリップは動かさず、元の In/Out は最後に戻す
// Creates one Short sequence per marker of the active full-length sequence. Clips are never moved; the original In/Out is restored at the end.
// p = { preSec, postSec, includeHuman, binName, prefix, onlyIds }
// onlyIds（スタンプ id の配列）を渡すと、その id のマーカーだけを対象にし includeHuman は見ない
// With onlyIds (array of stamp ids), only markers with those ids are targeted and includeHuman is ignored.
function ytsCreateShorts(p) {
    var TICKS_PER_SEC = 254016000000;
    var seq = app.project ? app.project.activeSequence : null;
    var created = [];
    var names = [];
    var sequenceNames = [];
    var onlySet = null;
    var skipped = 0;
    var usedNames = {};
    var targets = [];
    var origIn = NaN;
    var origOut = NaN;
    var result;
    var restoreError = null;
    var touched = false;
    var preSec;
    var postSec;
    var binName;
    var seqEndSec;
    var allSequences;
    var list;
    var i;
    var j;
    var n;
    var name;
    var inSec;
    var outSec;
    var sub;
    var subMarkers;
    var bin = null;
    var dateTag;
    var namePrefix;
    var parentBinName;
    var parentBin;
    var binPath;
    var origId;
    var existing;
    var id;
    // Premiere 26 で確実に効くのは ticks で作った Time / A Time built from ticks is the form known to work in Premiere 26.
    var toTime = function (sec) {
        var t = new Time();
        t.ticks = String(Math.round(sec * TICKS_PER_SEC));
        return t;
    };
    if (!seq) return "ERR|アクティブなシーケンスがありません";
    p = p || {};
    preSec = Number(p.preSec);
    postSec = Number(p.postSec);
    if (!isFinite(preSec) || preSec < 0 || !isFinite(postSec) || postSec <= 0) {
        return "ERR|前後の秒数を確認してください";
    }
    // 日付 YYMMDD は配信の開始日（パネルから）→ 無ければ元 Sequence 名の先頭 6 桁。プロジェクトの慣例 `Sequence/_YYMMDD/YYMMDD_…` に合わせる
    // The YYMMDD date comes from the stream start (panel), else the sequence name's leading 6 digits, matching the project's `Sequence/_YYMMDD/YYMMDD_…` convention.
    dateTag = String(p.dateTag || "");
    if (!/^[0-9]{6}$/.test(dateTag)) {
        dateTag = /^([0-9]{6})[_-]/.test(String(seq.name)) ? String(seq.name).substring(0, 6) : "";
    }
    namePrefix = dateTag ? dateTag + "_" : "";
    binName = dateTag ? "_" + dateTag : String(p.binName || "Peakaboo_Shorts");
    parentBinName = dateTag ? String(p.parentBin || "Sequence") : "";
    binPath = (parentBinName ? parentBinName + "/" : "") + binName;
    if (p.onlyIds instanceof Array) {
        onlySet = {};
        for (i = 0; i < p.onlyIds.length; i += 1) onlySet["i_" + String(p.onlyIds[i])] = true;
    }
    try {
        origId = String(seq.sequenceID);
        origIn = parseFloat(seq.getInPoint());
        origOut = parseFloat(seq.getOutPoint());
        seqEndSec = parseFloat(seq.end) / TICKS_PER_SEC;
        if (!isFinite(seqEndSec) || seqEndSec <= 0) throw new Error("シーケンスの長さを読めません");

        list = ytsMarkerArray(seq.markers);
        for (i = 0; i < list.length; i += 1) {
            id = ytsMarkerId(list[i]);
            if (!id) continue;
            if (onlySet) {
                if (!onlySet["i_" + id]) continue;
            } else if (!p.includeHuman && !ytsIsCandidate(list[i].name)) continue;
            targets.push({ t: Number(list[i].start.seconds), name: String(list[i].name || ""), id: id });
        }
        targets.sort(function (a, b) { return a.t - b.t; });

        allSequences = app.project.sequences;
        for (i = 0; i < allSequences.numSequences; i += 1) {
            usedNames["n_" + allSequences[i].name] = true;
            sequenceNames.push(String(allSequences[i].name));
        }

        // 既にその日の bin に Short があれば番号はその続きから。p.dryRun なら件数だけ返す（二重作成の確認用）
        // Numbering continues after Shorts already in the day's bin. p.dryRun only reports the count (used to confirm before duplicating).
        existing = 0;
        parentBin = parentBinName ? ytsFindBin(app.project.rootItem, parentBinName) : null;
        if (!parentBin) { parentBin = app.project.rootItem; binPath = binName; }
        bin = ytsFindBin(parentBin, binName);
        if (bin) existing = bin.children.numItems;
        if (p.dryRun) return "OK|" + ytsJson({ existing: existing, bin: binPath, targets: targets.length, sequenceNames: sequenceNames });

        for (i = 0; i < targets.length; i += 1) {
            inSec = Math.max(0, targets[i].t - preSec);
            outSec = Math.min(seqEndSec, targets[i].t + postSec);
            if (!(outSec > inSec)) {
                skipped += 1;
                continue;
            }
            n = existing + created.length + 1;
            name = namePrefix + ytsShortName(targets[i].name, n);
            while (usedNames["n_" + name]) {
                n += 1;
                name = namePrefix + ytsShortName(targets[i].name, n);
            }
            // In を 2 回置くのは、前の Out より後ろの In が弾かれないようにするため
            // In is set twice so a new In past the previous Out is not rejected.
            touched = true;
            seq.setInPoint(toTime(inSec));
            seq.setOutPoint(toTime(outSec));
            seq.setInPoint(toTime(inSec));
            // true = トラックのターゲット指定を無視して全トラックを含める / true = ignore track targeting and include every track
            sub = seq.createSubsequence(true);
            if (!sub || typeof sub !== "object") {
                skipped += 1;
                continue;
            }
            sub.name = name;
            usedNames["n_" + name] = true;
            names.push(name);
            // sequenceId は Task 9 が ytsPlaceChat / ytsPlaceCaption に渡すため / sequenceId lets the caller pass it to ytsPlaceChat / ytsPlaceCaption
            created.push({ id: targets[i].id, name: name, sequenceId: String(sub.sequenceID) });

            // [yts:<id>] が残ると同期で元のスタンプを動かすので、作った Sequence のマーカーは全部消す
            // Delete every marker in the new sequence; a surviving [yts:<id>] tag would make sync move the original stamp.
            try {
                subMarkers = sub.markers;
                if (subMarkers) {
                    list = ytsMarkerArray(subMarkers);
                    for (j = 0; j < list.length; j += 1) subMarkers.deleteMarker(list[j]);
                }
            } catch (markerError) {}

            // 日付 bin は親 bin（既定 Sequence）の下、親が無ければルート。無ければここで作る / The day bin sits under the parent (default Sequence), else at the root; created here when missing
            if (!bin) bin = ytsFindOrCreateBin(parentBin, binName);
            if (bin && sub.projectItem) sub.projectItem.moveBin(bin);
        }
        result = "OK|" + ytsJson({ created: created, names: names, skipped: skipped, bin: binPath });
    } catch (e) {
        result = "ERR|" + created.length + " 件作成後に失敗: " + e.toString();
    } finally {
        // In/Out を一度でも動かしたときだけ元へ戻す。未設定は -400000 と読めるので、数値の -400000 を置き直すと未設定に戻る
        // （PPro 26.5 実機で確認、2026-10-30）。out → in → out の順は、途中で In と Out の前後が入れ替わって弾かれるのを避けるため
        // Restore only when this run moved In/Out. "Unset" reads as -400000, and writing the number -400000 back clears it
        // (verified on PPro 26.5, 2026-10-30). The out → in → out order avoids a rejected reversed intermediate state.
        if (touched && isFinite(origIn) && isFinite(origOut)) {
            try {
                if (origOut < 0) seq.setOutPoint(-400000); else seq.setOutPoint(toTime(origOut));
                if (origIn < 0) seq.setInPoint(-400000); else seq.setInPoint(toTime(origIn));
                if (origOut < 0) seq.setOutPoint(-400000); else seq.setOutPoint(toTime(origOut));
            } catch (restoreFailure) { restoreError = restoreFailure; }
        }
        // createSubsequence は新しい Sequence をアクティブにするので元へ戻す。`activeSequence =` の代入は PPro 26.5 で効かなかったため openSequence(ID) を使う
        // createSubsequence activates the new sequence, so switch back. Assigning `activeSequence =` did nothing on PPro 26.5, hence openSequence(ID).
        try { if (origId) app.project.openSequence(origId); } catch (activateError) {}
        try { if (app.project.activeSequence && String(app.project.activeSequence.sequenceID) !== origId) app.project.activeSequence = seq; } catch (activateError2) {}
    }
    if (restoreError) {
        return "ERR|" + created.length + " 件作成しましたが In/Out を戻せませんでした: " + restoreError.toString();
    }
    return result;
}

// Sequence を sequenceID（優先）か名前で探す / Finds a sequence by sequenceID (preferred) or by name
function ytsFindSequence(sequenceId, name) {
    var list = app.project.sequences;
    var i;
    var s;
    for (i = 0; i < Number(list.numSequences); i += 1) {
        s = list[i];
        if (sequenceId ? String(s.sequenceID) === String(sequenceId) : String(s.name) === String(name)) return s;
    }
    return null;
}

// 素材パスが同じ既存の項目（無ければ null）。Windows のパスは大文字小文字を区別しない
// An existing project item with the same media path (null when none). Windows paths compare case-insensitively.
function ytsFindItemByMediaPath(path) {
    var native = new File(path).fsName;
    var want = native.toLowerCase();
    var items = app.project.rootItem.findItemsMatchingMediaPath(native, 1);
    var count;
    var i;
    if (!items) return null;
    count = Number(items.length || items.numItems || 0);
    for (i = 0; i < count; i += 1) {
        try {
            if (new File(String(items[i].getMediaPath())).fsName.toLowerCase() === want) return items[i];
        } catch (pathError) {}
    }
    return null;
}

// 同じ素材が既にあれば再利用し、無ければ bin へ読み込む（二重に読み込まない）
// Reuses an item with the same media, else imports it into bin (never imports twice).
function ytsImportOnce(path, bin) {
    var item = ytsFindItemByMediaPath(path);
    if (item) return item;
    if (!bin) throw new Error("読み込み先の bin を作れませんでした");
    // importFiles(パス配列, 警告を出さない, 読み込み先 bin, 連番静止画として読まない) / (paths, suppressUI, targetBin, importAsNumberedStills)
    app.project.importFiles([new File(path).fsName], true, bin, false);
    item = ytsFindItemByMediaPath(path);
    if (!item) throw new Error("読み込めませんでした: " + path);
    return item;
}

// 配信の素材を Footage/_<dateTag> に読み込み、フル尺 Sequence を Sequence/_<dateTag> に作って開く。同名の Sequence があれば作らずそれを開く
// Imports the stream footage into Footage/_<dateTag>, creates the full-length sequence in Sequence/_<dateTag> and opens it; an existing same-named sequence is reused and opened instead.
// createNewSequenceFromClips(名前, [項目], 入れ先 bin) は Sequence を返し、失敗時は 0 / returns the Sequence, 0 on failure
// p = { footage, dateTag, sequenceName }
function ytsImportStream(p) {
    var footage;
    var dateTag;
    var sequenceName;
    var item;
    var seq;
    var existing;
    try {
        p = p || {};
        footage = String(p.footage || "");
        dateTag = String(p.dateTag || "");
        sequenceName = String(p.sequenceName || "");
        if (!/^[0-9]{6}$/.test(dateTag)) return "ERR|日付（YYMMDD）が不正です";
        if (!sequenceName) return "ERR|Sequence 名がありません";
        if (!footage || !new File(footage).exists) return "ERR|素材が見つかりません: " + footage;
        item = ytsImportOnce(footage, ytsFindBinPath(app.project.rootItem, ["Footage", "_" + dateTag], true));
        seq = ytsFindSequence("", sequenceName);
        existing = !!seq;
        if (!seq) {
            seq = app.project.createNewSequenceFromClips(sequenceName, [item],
                ytsFindBinPath(app.project.rootItem, ["Sequence", "_" + dateTag], true));
            if (!seq || typeof seq !== "object") return "ERR|Sequence を作れませんでした";
        }
        // 続くマーカー同期と Short 作成はアクティブな Sequence に対して動くので、既存でも開く
        // Marker sync and Short creation that follow work on the active sequence, so the existing one is opened too.
        app.project.openSequence(String(seq.sequenceID));
        return "OK|" + ytsJson({ sequenceId: String(seq.sequenceID), existing: existing, projectItem: String(item.nodeId) });
    } catch (e) {
        return "ERR|配信を取り込めませんでした: " + e.toString();
    }
}

// チャット動画（.mov）を Footage/_<dateTag>/chat に読み込み、Short の V2 の 0 秒に置く。終わったら元のアクティブ Sequence に戻す
// Imports the chat video (.mov) into Footage/_<dateTag>/chat and puts it at 0 s on the Short's V2; the previously active sequence is reopened afterwards.
// p = { sequenceId, movPath, dateTag }
function ytsPlaceChat(p) {
    var origId = "";
    var result = "";
    var seq;
    var item;
    var movPath;
    var dateTag;
    var qeSeq;
    var track;
    var fps;
    var tolerance;
    var i;
    try {
        p = p || {};
        movPath = String(p.movPath || "");
        dateTag = String(p.dateTag || "");
        if (!/^[0-9]{6}$/.test(dateTag)) return "ERR|日付（YYMMDD）が不正です";
        if (!movPath || !new File(movPath).exists) return "ERR|チャット動画が見つかりません: " + movPath;
        seq = ytsFindSequence(p.sequenceId, "");
        if (!seq) return "ERR|Short が見つかりません";
        item = ytsImportOnce(movPath, ytsFindBinPath(app.project.rootItem, ["Footage", "_" + dateTag, "chat"], true));
        origId = app.project.activeSequence ? String(app.project.activeSequence.sequenceID) : "";
        // QE はアクティブな Sequence にしか効かないので開く / QE only acts on the active sequence, so open it
        app.project.openSequence(String(seq.sequenceID));
        if (Number(seq.videoTracks.numTracks) < 2) {
            app.enableQE();
            qeSeq = qe.project.getActiveSequence();
            // 名前を確かめてから足す（別の Sequence に足さないため）。addTracks(映像の本数, 足す位置, 音声の本数)
            // Check the name first so the track never lands in another sequence. addTracks(video count, insert index, audio count)
            if (qeSeq && String(qeSeq.name) === String(seq.name)) qeSeq.addTracks(1, 1, 0);
            seq = ytsFindSequence(p.sequenceId, "");
        }
        if (!seq || Number(seq.videoTracks.numTracks) < 2) {
            result = "ERR|V2 がありません。Short に V2 を足してから再実行してください";
        } else {
            track = seq.videoTracks[1];
            fps = 254016000000 / parseFloat(seq.timebase);
            tolerance = isFinite(fps) && fps > 0 ? 0.5 / fps : 0;
            for (i = 0; i < Number(track.clips.numItems); i += 1) {
                if (Math.abs(Number(track.clips[i].start.seconds)) <= tolerance) {
                    result = "OK|" + ytsJson({ placed: false, skipped: "already" });
                    break;
                }
            }
            if (!result) {
                // Track.insertClip(項目, ticks の文字列)。チャット動画は映像だけなので音声トラックは触らない
                // Track.insertClip(item, time in ticks as a string). The chat video has no audio, so no audio track is touched.
                track.insertClip(item, "0");
                result = "OK|" + ytsJson({ placed: true });
            }
        }
    } catch (e) {
        result = "ERR|チャット動画を置けませんでした: " + e.toString();
    } finally {
        try { if (origId && app.project.activeSequence && String(app.project.activeSequence.sequenceID) !== origId) app.project.openSequence(origId); } catch (activateError) {}
    }
    return result;
}

// 字幕（.srt）を Sequence/_<dateTag>/captions に読み込み、Short のキャプショントラックに置く
// Imports the captions (.srt) into Sequence/_<dateTag>/captions and puts them on the Short's caption track.
// 調べた API（PPro 26.5）: Sequence.createCaptionTrack(項目, 開始秒, 形式) / API checked: Sequence.createCaptionTrack(item, startSeconds, format)
// p = { sequenceId, srtPath, dateTag }
function ytsPlaceCaption(p) {
    var seq;
    var item;
    var srtPath;
    var dateTag;
    var placed = false;
    try {
        p = p || {};
        srtPath = String(p.srtPath || "");
        dateTag = String(p.dateTag || "");
        if (!/^[0-9]{6}$/.test(dateTag)) return "ERR|日付（YYMMDD）が不正です";
        if (!srtPath || !new File(srtPath).exists) return "ERR|字幕ファイルが見つかりません: " + srtPath;
        seq = ytsFindSequence(p.sequenceId, "");
        if (!seq) return "ERR|Short が見つかりません";
        item = ytsImportOnce(srtPath, ytsFindBinPath(app.project.rootItem, ["Sequence", "_" + dateTag, "captions"], true));
        if (typeof seq.createCaptionTrack === "function") {
            try { placed = seq.createCaptionTrack(item, 0, Sequence.CAPTION_FORMAT_SUBTITLE) === true; } catch (captionError) { placed = false; }
        }
        if (placed) return "OK|" + ytsJson({ placed: true });
        return "OK|" + ytsJson({ placed: false, imported: true, note: "字幕は bin から各 Short へドラッグ" });
    } catch (e) {
        return "ERR|字幕を読み込めませんでした: " + e.toString();
    }
}
