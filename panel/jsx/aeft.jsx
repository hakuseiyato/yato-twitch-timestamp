/* After Effects host API for Yato Twitch Timestamp. Strict ES3 syntax. */

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

function ytsActiveComp() {
    var item = app.project ? app.project.activeItem : null;
    return typeof CompItem !== "undefined" && item instanceof CompItem ? item : null;
}

function ytsMarkerId(markerValue) {
    var id = null;
    var params;
    var match;
    try {
        params = markerValue.getParameters();
        if (params && /^([0-9a-f]{8}|y[0-9a-f]{7})$/.test(String(params.yts_id || ""))) id = String(params.yts_id);
    } catch (e) {}
    if (!id) {
        match = String(markerValue.comment || "").match(/\[yts:([0-9a-f]{8}|y[0-9a-f]{7})\]/);
        if (match) id = match[1];
    }
    return id;
}

function ytsCleanMemo(comment) {
    return String(comment || "").replace(/\s*\[yts:(?:[0-9a-f]{8}|y[0-9a-f]{7})\]/g, "");
}

function ytsLocate(id, index, appT) {
    var comp = ytsActiveComp();
    var markerProperty;
    var candidates = [];
    var tolerance;
    var targetTime = Number(appT);
    var k;
    var candidateIndex = Number(index);
    if (!comp) return 0;
    markerProperty = comp.markerProperty;
    tolerance = 0.5 * comp.frameDuration;
    for (k = 1; k <= markerProperty.numKeys; k += 1) {
        if (ytsMarkerId(markerProperty.keyValue(k)) === id) candidates.push(k);
    }
    if (candidateIndex >= 1 && candidateIndex <= markerProperty.numKeys &&
            candidateIndex === Math.floor(candidateIndex) &&
            ytsMarkerId(markerProperty.keyValue(candidateIndex)) === id && isFinite(targetTime) &&
            Math.abs(markerProperty.keyTime(candidateIndex) - targetTime) <= tolerance) return candidateIndex;
    for (k = 0; k < candidates.length; k += 1) {
        if (isFinite(targetTime) && Math.abs(markerProperty.keyTime(candidates[k]) - targetTime) <= tolerance) return candidates[k];
    }
    return candidates.length === 1 ? candidates[0] : 0;
}

function ytsLocateForEdit(id, index, appT, origName) {
    var comp;
    var markerProperty;
    var candidateIndex;
    var targetTime;
    var tolerance;
    var candidateValue;
    if (id) return ytsLocate(id, index, appT);
    comp = ytsActiveComp();
    if (!comp) return 0;
    markerProperty = comp.markerProperty;
    candidateIndex = Number(index);
    targetTime = Number(appT);
    tolerance = 0.5 * comp.frameDuration;
    if (candidateIndex >= 1 && candidateIndex <= markerProperty.numKeys &&
            candidateIndex === Math.floor(candidateIndex) && isFinite(targetTime)) {
        candidateValue = markerProperty.keyValue(candidateIndex);
        if (!ytsMarkerId(candidateValue) &&
                Math.abs(markerProperty.keyTime(candidateIndex) - targetTime) <= tolerance &&
                ytsCleanMemo(candidateValue.comment).replace(/^\s+|\s+$/g, "") ===
                    String(origName == null ? "" : origName)) return candidateIndex;
    }
    return 0;
}

function ytsWriteKey(oldValue, comment, id, time, label) {
    var comp = ytsActiveComp();
    var markerProperty;
    var mv;
    var oldParams;
    var params = {};
    var key;
    var parametersSet = false;
    if (!comp) throw new Error("comp");
    markerProperty = comp.markerProperty;
    mv = new MarkerValue(String(comment || ""));
    if (oldValue) {
        try { mv.duration = oldValue.duration; } catch (durationError) {}
        try { mv.label = oldValue.label; } catch (labelError) {}
        try { mv.chapter = oldValue.chapter; } catch (chapterError) {}
        try { mv.url = oldValue.url; } catch (urlError) {}
        try { mv.frameTarget = oldValue.frameTarget; } catch (frameTargetError) {}
        try { mv.cuePointName = oldValue.cuePointName; } catch (cuePointNameError) {}
        try { mv.eventCuePoint = oldValue.eventCuePoint; } catch (eventCuePointError) {}
        try { mv.protectedRegion = oldValue.protectedRegion; } catch (protectedRegionError) {}
        try {
            oldParams = oldValue.getParameters();
            for (key in oldParams) {
                if (oldParams.hasOwnProperty(key)) params[key] = oldParams[key];
            }
        } catch (getParametersError) {}
    } else {
        try { mv.label = Number(label); } catch (createLabelError) {}
    }
    if (id) params.yts_id = id;
    try {
        mv.setParameters(params);
        parametersSet = true;
    } catch (setParametersError) {}
    if (!parametersSet && id) mv.comment = ytsCleanMemo(comment) + " [yts:" + id + "]";
    markerProperty.setValueAtTime(Number(time), mv);
}

function ytsNudgedTime(comp, requested) {
    var markerProperty = comp.markerProperty;
    var tolerance = 0.5 * comp.frameDuration;
    var result = Number(requested);
    var n;
    var found;
    var stepCount = 0;
    while (stepCount < 10000) {
        found = false;
        for (n = 1; n <= markerProperty.numKeys; n += 1) {
            if (Math.abs(markerProperty.keyTime(n) - result) < tolerance) {
                found = true;
                break;
            }
        }
        if (!found) return result;
        result += comp.frameDuration;
        stepCount += 1;
    }
    throw new Error("nudge");
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
        var comp = ytsActiveComp();
        var info = {
            projectPath: app.project && app.project.file ? app.project.file.fsName : "",
            targetId: comp ? String(comp.id) : "",
            name: comp ? String(comp.name) : "",
            fps: comp ? Number(comp.frameRate) : 0,
            hasTarget: !!comp
        };
        return "OK|" + ytsJson(info);
    } catch (e) {
        return "ERR|紐付け先の情報を取得できませんでした: " + e.toString();
    }
}

function ytsListMarkers() {
    try {
        var comp = ytsActiveComp();
        var markerProperty;
        var result = [];
        var k;
        var markerValue;
        if (!comp) return "ERR|アクティブなコンポジションがありません";
        markerProperty = comp.markerProperty;
        for (k = 1; k <= markerProperty.numKeys; k += 1) {
            markerValue = markerProperty.keyValue(k);
            result.push({ index: k, id: ytsMarkerId(markerValue), t: Number(markerProperty.keyTime(k)), memo: ytsCleanMemo(markerValue.comment) });
        }
        return "OK|" + ytsJson(result);
    } catch (e) {
        return "ERR|マーカーを取得できませんでした: " + e.toString();
    }
}

function ytsEditMarker(p) {
    try {
        var comp = ytsActiveComp();
        var markerProperty;
        var k;
        var oldValue;
        var oldTime;
        var id;
        var undoOpen = false;
        if (!comp) return "ERR|アクティブなコンポジションがありません";
        p = p || {};
        if (typeof p.targetId === "undefined" || String(p.targetId) !== String(comp.id)) {
            return "ERR|対象が切り替わりました。↻ で更新してください";
        }
        markerProperty = comp.markerProperty;
        k = ytsLocateForEdit(p.id || null, p.index, p.t, p.origName);
        if (!k) return "ERR|マーカーが見つかりません。↻ で更新してください";
        app.beginUndoGroup("Yato Twitch Timestamp 編集");
        undoOpen = true;
        try {
            if (typeof p.name !== "undefined") {
                oldValue = markerProperty.keyValue(k);
                oldTime = markerProperty.keyTime(k);
                id = ytsMarkerId(oldValue);
                markerProperty.removeKey(k);
                try {
                    ytsWriteKey(oldValue, String(p.name), id, oldTime, 0);
                } catch (writeError) {
                    markerProperty.setValueAtTime(oldTime, oldValue);
                    throw writeError;
                }
            }
            app.endUndoGroup();
            undoOpen = false;
            return "OK|" + ytsJson({ ok: true });
        } catch (editError) {
            if (undoOpen) {
                try { app.endUndoGroup(); } catch (endError) {}
                undoOpen = false;
            }
            throw editError;
        }
    } catch (e) {
        if (undoOpen) {
            try { app.endUndoGroup(); } catch (endOuterError) {}
        }
        return "ERR|マーカーを編集できませんでした: " + e.toString();
    }
}

function ytsDeleteMarker(p) {
    try {
        var comp = ytsActiveComp();
        var k;
        var undoOpen = false;
        if (!comp) return "ERR|アクティブなコンポジションがありません";
        p = p || {};
        if (typeof p.targetId === "undefined" || String(p.targetId) !== String(comp.id)) {
            return "ERR|対象が切り替わりました。↻ で更新してください";
        }
        k = ytsLocateForEdit(p.id || null, p.index, p.t, p.origName);
        if (!k) return "ERR|マーカーが見つかりません。↻ で更新してください";
        app.beginUndoGroup("Yato Twitch Timestamp 削除");
        undoOpen = true;
        try {
            comp.markerProperty.removeKey(k);
            app.endUndoGroup();
            undoOpen = false;
            return "OK|" + ytsJson({ ok: true });
        } catch (deleteError) {
            if (undoOpen) {
                try { app.endUndoGroup(); } catch (endError) {}
                undoOpen = false;
            }
            throw deleteError;
        }
    } catch (e) {
        if (undoOpen) {
            try { app.endUndoGroup(); } catch (endOuterError) {}
        }
        return "ERR|マーカーを削除できませんでした: " + e.toString();
    }
}

function ytsAddMarker(p) {
    try {
        var comp = ytsActiveComp();
        var id;
        var t;
        var undoOpen = false;
        if (!comp) return "ERR|アクティブなコンポジションがありません";
        p = p || {};
        if (typeof p.targetId === "undefined" || String(p.targetId) !== String(comp.id)) {
            return "ERR|対象が切り替わりました。↻ で更新してください";
        }
        id = String(p.id || "");
        if (!/^([0-9a-f]{8}|y[0-9a-f]{7})$/.test(id)) return "ERR|マーカー ID が不正です";
        app.beginUndoGroup("Yato Twitch Timestamp 追加");
        undoOpen = true;
        try {
            t = ytsNudgedTime(comp, Number(comp.time));
            ytsWriteKey(null, "", id, t, 0);
            app.endUndoGroup();
            undoOpen = false;
            return "OK|" + ytsJson({ id: id, t: t });
        } catch (addError) {
            if (undoOpen) {
                try { app.endUndoGroup(); } catch (endError) {}
                undoOpen = false;
            }
            throw addError;
        }
    } catch (e) {
        if (undoOpen) {
            try { app.endUndoGroup(); } catch (endOuterError) {}
        }
        return "ERR|マーカーを追加できませんでした: " + e.toString();
    }
}

// ponytail: speed changes / time remap are ignored; thumbnails drift in that case
function ytsResolveMedia(comp, t, depth) {
    var layerIndex;
    var layer;
    var src;
    var sourceTime;
    var result;
    if (depth > 8) return null;
    for (layerIndex = 1; layerIndex <= Number(comp.numLayers); layerIndex += 1) {
        try {
            layer = comp.layer(layerIndex);
            if (!(layer instanceof AVLayer) || !layer.enabled || !layer.hasVideo ||
                    Number(layer.inPoint) > t || t >= Number(layer.outPoint)) continue;
            if ((typeof TextLayer !== "undefined" && layer instanceof TextLayer) ||
                    (typeof ShapeLayer !== "undefined" && layer instanceof ShapeLayer)) continue;
            src = layer.source;
            if (!src) continue;
            if (src instanceof CompItem) {
                sourceTime = Number(layer.sourceTime(t));
                result = ytsResolveMedia(src, sourceTime, depth + 1);
                if (result) return result;
                continue;
            }
            if (src instanceof FootageItem) {
                if (!src.file) continue;
                return { path: String(src.file.fsName), t: Number(layer.sourceTime(t)) };
            }
        } catch (layerError) {}
    }
    return null;
}

function ytsMarkerDetails() {
    try {
        var comp = ytsActiveComp();
        var markerProperty;
        var markers = [];
        var k;
        var t;
        var markerValue;
        var name;
        if (!comp) return "ERR|アクティブなコンポジションがありません";
        markerProperty = comp.markerProperty;
        for (k = 1; k <= markerProperty.numKeys; k += 1) {
            t = Number(markerProperty.keyTime(k));
            markerValue = markerProperty.keyValue(k);
            name = ytsCleanMemo(markerValue.comment).replace(/^\s+|\s+$/g, "");
            markers.push({
                index: k,
                t: t,
                name: name,
                comment: "",
                by: "",
                id: ytsMarkerId(markerValue),
                media: ytsResolveMedia(comp, t, 0)
            });
        }
        markers.sort(function (a, b) { return a.t - b.t; });
        return "OK|" + ytsJson({ fps: Number(comp.frameRate), targetName: String(comp.name), markers: markers });
    } catch (e) {
        return "ERR|マーカー詳細を取得できませんでした: " + e.toString();
    }
}

function ytsSeek(t) {
    try {
        var comp = ytsActiveComp();
        t = Number(t);
        if (!isFinite(t)) return "ERR|シーク位置が不正です";
        if (!comp) return "ERR|アクティブなコンポジションがありません";
        comp.time = t;
        return "OK|";
    } catch (e) {
        return "ERR|再生位置を移動できませんでした: " + e.toString();
    }
}

function ytsApply(ops) {
    try {
        var comp = ytsActiveComp();
        var markerProperty;
        var failed = [];
        var applied = 0;
        var colorMap = {};
        var colorCounter = 0;
        var tags = [];
        var stages = ["update", "delete", "create"];
        var i;
        var j;
        var op;
        var k;
        var idx;
        var oldValue;
        var oldTime;
        var colorKey;
        var tolerance;
        var appT;
        var t;
        var steps;
        var collision;
        var nudged = [];
        var undoOpen = false;
        if (!comp) return "ERR|アクティブなコンポジションがありません";
        markerProperty = comp.markerProperty;
        if (!(ops instanceof Array)) ops = [];
        tolerance = 0.5 * comp.frameDuration;

        var colorFor = function (item) {
            if (item["native"]) return 0;
            colorKey = "k_" + String(item.by || "");
            if (typeof colorMap[colorKey] === "undefined") {
                colorMap[colorKey] = (colorCounter % 7) + 1;
                colorCounter += 1;
            }
            return colorMap[colorKey];
        };

        app.beginUndoGroup("Yato Twitch Timestamp 同期");
        undoOpen = true;
        try {
            for (i = 0; i < ops.length; i += 1) if (ops[i] && ops[i].op === "tag") tags.push(ops[i]);
            tags.sort(function (a, b) { return Number(b.index) - Number(a.index); });
            for (i = 0; i < tags.length; i += 1) {
                op = tags[i];
                try {
                    k = Number(op.index);
                    appT = Number(op.appT);
                    if (k < 1 || k > markerProperty.numKeys || k !== Math.floor(k) || !isFinite(appT) ||
                            Math.abs(markerProperty.keyTime(k) - appT) > tolerance) {
                        k = 0;
                        for (j = 1; j <= markerProperty.numKeys; j += 1) {
                            if (!ytsMarkerId(markerProperty.keyValue(j)) && isFinite(appT) &&
                                    Math.abs(markerProperty.keyTime(j) - appT) <= tolerance) {
                                k = j;
                                break;
                            }
                        }
                    }
                    if (!k) throw new Error("marker");
                    oldValue = markerProperty.keyValue(k);
                    oldTime = markerProperty.keyTime(k);
                    markerProperty.removeKey(k);
                    ytsWriteKey(oldValue, ytsCleanMemo(oldValue.comment), op.id, oldTime, 0);
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
                            k = ytsLocate(op.id, op.index, op.appT);
                            if (!k) throw new Error("marker");
                            oldValue = markerProperty.keyValue(k);
                            oldTime = markerProperty.keyTime(k);
                            markerProperty.removeKey(k);
                            try {
                                t = ytsNudgedTime(comp, Number(op.t));
                            } catch (nudgeError) {
                                markerProperty.setValueAtTime(oldTime, oldValue);
                                throw nudgeError;
                            }
                            ytsWriteKey(oldValue, op.memo || op.timecode, op.id, t, 0);
                            if (t !== Number(op.t)) nudged.push({ id: op.id, from: Number(op.t), to: t });
                        } else if (op.op === "delete") {
                            k = ytsLocate(op.id, op.index, op.appT);
                            if (!k) throw new Error("marker");
                            markerProperty.removeKey(k);
                        } else {
                            if (!isFinite(Number(op.t)) || Number(op.t) < 0) throw new Error("time");
                            t = ytsNudgedTime(comp, Number(op.t));
                            ytsWriteKey(null, op.memo || op.timecode, op.id, t, colorFor(op));
                            if (t !== Number(op.t)) nudged.push({ id: op.id, from: Number(op.t), to: t });
                        }
                        applied += 1;
                    } catch (opError) { failed.push(String(op.id || "")); }
                }
            }
            app.endUndoGroup();
            undoOpen = false;
            return "OK|" + ytsJson({ applied: applied, failed: failed, nudged: nudged });
        } catch (applyError) {
            if (undoOpen) {
                try { app.endUndoGroup(); } catch (endError) {}
                undoOpen = false;
            }
            return "ERR|同期処理に失敗しました: " + applyError.toString();
        }
    } catch (e) {
        try { app.endUndoGroup(); } catch (endOuterError) {}
        return "ERR|同期処理を開始できませんでした: " + e.toString();
    }
}
