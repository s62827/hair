// 髮型 / 髮色試用原型
//   髮色：鏡頭 + MediaPipe ImageSegmenter（頭髮）+ 線性光染髮合成
//   髮型：鏡頭 + MediaPipe FaceLandmarker + 2D 髮型貼圖（hairstyles.js）
//
// 目的是驗證 HAIRSTYLE_PLAN.md 的做法 A / B 在手機上的速度與效果。
// 刻意獨立於 script.js，不碰試妝頁的舊版 face_mesh 流程。

import { FilesetResolver, ImageSegmenter, FaceLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
import { STYLES, getStyleArt, ART_X0, ART_Y0, ART_W, ART_H } from './hairstyles.js';

var WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
var FACE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
// 臉部輪廓關鍵點（與 script.js 的 FACE_OVAL 相同），10 = 額頭頂、152 = 下巴、234 / 454 = 左右臉緣
var FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
var MODELS = {
    // 頭髮專用：輸入 512x512，邊緣較細，比較慢
    hair: {
        name: '頭髮專用',
        url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/hair_segmenter/float32/latest/hair_segmenter.tflite',
        hairIndex: 1
    },
    // 多類別（背景/頭髮/身體皮膚/臉部皮膚/衣服/其他）：輸入 256x256，較快
    multiclass: {
        name: '多類別',
        url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
        hairIndex: 1
    }
};

var HAIR_COLORS = [
    { name: '自然黑', color: '#1c1a1a' },
    { name: '深棕',   color: '#3b2a20' },
    { name: '栗棕',   color: '#5a3825' },
    { name: '奶茶棕', color: '#8a6a4f' },
    { name: '亞麻金', color: '#c7a97a' },
    { name: '霧灰',   color: '#8c8c90' },
    { name: '酒紅',   color: '#6e1f2b' },
    { name: '粉紅',   color: '#d88aa0' },
    { name: '藍黑',   color: '#1f2a44' }
];

// ---------- 可調常數（尚未用實機畫面校準） ----------
// 信心值 → 染色權重的 smoothstep 區間。LO 調高可壓住髮際線外溢色，
// HI 調低讓髮絲較細處也吃得到顏色。
var EDGE_LO = 0.3, EDGE_HI = 0.75;
// 遮罩時間平滑：新一幀的權重。越低越穩但轉頭時越拖影。
var MASK_EMA = 0.6;
// 頭髮平均亮度的時間平滑，避免整頭顏色閃爍
var REF_EMA = 0.15;
// 亮度增益上下限。黑髮染淺色時增益會很大，雜訊跟著被放大，所以要夾住。
var GAIN_MIN = 0.35, GAIN_MAX = 6;
// 頭髮像素少於這個數量就當作畫面裡沒有頭髮，不估算平均亮度
var MIN_HAIR_PIXELS = 800;
// 遮罩檢視模式的疊色不透明度
var OVERLAY_ALPHA = 0.55;
// 權重低於這個值的像素直接跳過
var MIN_WEIGHT = 0.004;

// ---------- sRGB <-> 線性光（與 script.js 相同的查表做法） ----------
var SRGB_TO_LINEAR = new Float32Array(256);
for (var _i = 0; _i < 256; _i++) {
    var _n = _i / 255;
    SRGB_TO_LINEAR[_i] = _n > 0.04045 ? Math.pow((_n + 0.055) / 1.055, 2.4) : _n / 12.92;
}
var LINEAR_TO_SRGB_N = 4096;
var LINEAR_TO_SRGB = new Uint8Array(LINEAR_TO_SRGB_N);
for (var _j = 0; _j < LINEAR_TO_SRGB_N; _j++) {
    var _m = _j / (LINEAR_TO_SRGB_N - 1);
    var _s = _m > 0.0031308 ? 1.055 * Math.pow(_m, 1 / 2.4) - 0.055 : 12.92 * _m;
    LINEAR_TO_SRGB[_j] = Math.max(0, Math.min(255, Math.round(_s * 255)));
}
function linearToSrgb(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 255;
    return LINEAR_TO_SRGB[(v * (LINEAR_TO_SRGB_N - 1)) | 0];
}
function relLuminance(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
function hexToRgb(hex) {
    var v = parseInt(hex.slice(1), 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}
function edgeWeight(m) {
    var t = (m - EDGE_LO) / (EDGE_HI - EDGE_LO);
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);
}

// ---------- 狀態 ----------
var video    = document.getElementById('video');
var canvas   = document.getElementById('view');
var ctx      = canvas.getContext('2d', { willReadFrequently: true });
var statsEl  = document.getElementById('stats');
var statusEl = document.getElementById('status');
var startEl  = document.getElementById('start');

var state = {
    tab: 'style',          // 'style' 髮型 | 'color' 髮色
    styleId: 'f1',         // null = 不戴髮型
    fitScale: 1,
    fitOffset: 0,
    mode: 'dye',
    color: null,           // null = 原色（照片髮型保留原本髮色、即時染髮不染）
    strength: 0.8,
    modelKey: 'hair',
    segEvery: 1,
    showStats: false
};

var vision = null;
var seg = null;            // { segmenter, hairIndex, delegate, key }
var loadToken = 0;
var face = null;           // { landmarker, delegate }
var faceLoading = null;

var mask = null;           // 畫面解析度的頭髮信心值（已做時間平滑）
var maskW = 0, maskH = 0;  // 模型輸出的原始遮罩尺寸（顯示用）
var hairRef = -1;          // 頭髮平均線性亮度（時間平滑後）
var hairFraction = 0;

var frameNo = 0;
var lastTs = -1;
var perf = { frames: 0, since: performance.now(), fps: 0, seg: [], comp: [], detect: [], draw: [] };

function nextTimestamp() {
    var ts = performance.now();
    if (ts <= lastTs) ts = lastTs + 0.01;
    lastTs = ts;
    return ts;
}

function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('error', !!isError);
}

// ---------- 模型載入 ----------
function createVision() {
    if (!vision) vision = FilesetResolver.forVisionTasks(WASM_BASE);
    return vision;
}

// 先試 GPU，失敗就退回 CPU（部分手機 / 瀏覽器的 WebGL 不支援）
async function createTask(TaskClass, modelUrl, options) {
    var fileset = await createVision();
    var make = function(delegate) {
        return TaskClass.createFromOptions(fileset, Object.assign({
            baseOptions: { modelAssetPath: modelUrl, delegate: delegate }
        }, options));
    };
    try {
        return { task: await make('GPU'), delegate: 'GPU' };
    } catch (e) {
        console.warn('GPU delegate 失敗，改用 CPU', e);
        return { task: await make('CPU'), delegate: 'CPU' };
    }
}

function hairIndexOf(segmenter, fallback) {
    var labels = [];
    try { labels = segmenter.getLabels() || []; } catch (e) { /* 舊模型沒有 label metadata */ }
    var idx = labels.findIndex(function(l) { return /hair/i.test(l); });
    return idx < 0 ? fallback : idx;
}

async function loadSegmenter(key) {
    var token = ++loadToken;
    setStatus('載入「' + MODELS[key].name + '」模型中…');
    try {
        var created = await createTask(ImageSegmenter, MODELS[key].url, {
            runningMode: 'VIDEO',
            outputConfidenceMasks: true,
            outputCategoryMask: false
        });
        var segmenter = created.task, delegate = created.delegate;
        if (token !== loadToken) { segmenter.close(); return; }   // 載入途中又切換了模型

        var old = seg;
        seg = { segmenter: segmenter, hairIndex: hairIndexOf(segmenter, MODELS[key].hairIndex), delegate: delegate, key: key };
        if (old) old.segmenter.close();
        mask = null;
        hairRef = -1;
        perf.seg = [];
        perf.comp = [];
        setStatus('');
    } catch (e) {
        console.error(e);
        if (token === loadToken) setStatus('模型載入失敗：' + (e && e.message ? e.message : e), true);
    }
}

function loadFaceLandmarker() {
    if (faceLoading) return faceLoading;
    setStatus('載入臉部偵測模型中…');
    faceLoading = (async function() {
        var created = await createTask(FaceLandmarker, FACE_MODEL_URL, { runningMode: 'VIDEO', numFaces: 1 });
        face = { landmarker: created.task, delegate: created.delegate };
        setStatus('');
    })().catch(function(e) {
        console.error(e);
        faceLoading = null;
        setStatus('臉部偵測模型載入失敗：' + (e && e.message ? e.message : e), true);
    });
    return faceLoading;
}

// ---------- 關鍵點平滑（One Euro Filter，與 script.js 相同參數） ----------
// 靜止時濾掉偵測雜訊（髮型不抖），移動快時降低平滑（不拖影）
function createOneEuroFilter(mincutoff, beta, dcutoff) {
    var xPrev = null, dxPrev = 0, tPrev = null;
    function alpha(cutoff, dt) {
        var tau = 1.0 / (2 * Math.PI * cutoff);
        return 1.0 / (1.0 + tau / dt);
    }
    function lowpass(x, prev, a) { return a * x + (1 - a) * prev; }
    return function(x, t) {
        if (tPrev === null) { tPrev = t; xPrev = x; return x; }
        var dt = Math.max((t - tPrev) / 1000, 1 / 120);
        var dx = (x - xPrev) / dt;
        var edx = lowpass(dx, dxPrev, alpha(dcutoff, dt));
        var cutoff = mincutoff + beta * Math.abs(edx);
        var xFiltered = lowpass(x, xPrev, alpha(cutoff, dt));
        xPrev = xFiltered; dxPrev = edx; tPrev = t;
        return xFiltered;
    };
}

var ovalFilters = null;
function smoothOval(lm, t) {
    if (!ovalFilters) {
        ovalFilters = {};
        FACE_OVAL.forEach(function(i) {
            ovalFilters[i] = [createOneEuroFilter(0.4, 4.0, 1.0), createOneEuroFilter(0.4, 4.0, 1.0)];
        });
    }
    var out = {};
    FACE_OVAL.forEach(function(i) {
        out[i] = { x: ovalFilters[i][0](lm[i].x, t), y: ovalFilters[i][1](lm[i].y, t) };
    });
    return out;
}

// ---------- 髮型貼圖 ----------
// 臉部座標系：原點 = 關鍵點 10，u = 234→454 方向（臉寬 W），v = 垂直 u 往下（臉長 H）
function faceFrame(lm, w, h) {
    var lx = lm[234].x * w, ly = lm[234].y * h;
    var rx = lm[454].x * w, ry = lm[454].y * h;
    var tx = lm[10].x * w,  ty = lm[10].y * h;
    var bx = lm[152].x * w, by = lm[152].y * h;
    var W = Math.hypot(rx - lx, ry - ly) || 1;
    var ux = (rx - lx) / W, uy = (ry - ly) / W;
    var vx = -uy, vy = ux;
    var H = (bx - tx) * vx + (by - ty) * vy;
    return { ox: tx, oy: ty, ux: ux, uy: uy, vx: vx, vy: vy, W: W, H: H > 1 ? H : W * 1.2 };
}

// 把「臉部座標」對到畫面像素。縮放以臉中心（y = 0.4）為基準，調大小時髮型不會整頂漂走。
function setFaceTransform(f) {
    var s = state.fitScale, dy = state.fitOffset, cy = 0.4;
    var a = f.ux * f.W * s, b = f.uy * f.W * s;
    var c = f.vx * f.H * s, d = f.vy * f.H * s;
    var off = (cy - s * cy + dy) * f.H;
    ctx.setTransform(a, b, c, d, f.ox + f.vx * off, f.oy + f.vy * off);
}

function traceOval(lm, w, h) {
    ctx.beginPath();
    FACE_OVAL.forEach(function(i, k) {
        var x = lm[i].x * w, y = lm[i].y * h;
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
}

// 環境光：取臉頰亮度估計現場光線，讓髮型貼圖跟著變暗 / 變亮（同 script.js 的 exposureFrom）
var NEUTRAL_SKIN_Y = 170, EXPOSURE_MIN = 0.55, EXPOSURE_MAX = 1.35, EXPOSURE_RESPONSE = 0.45;
var probe = document.createElement('canvas');
probe.width = probe.height = 8;
var probeCtx = probe.getContext('2d', { willReadFrequently: true });
var exposure = 1;
var supportsFilter = (function() {
    var t = document.createElement('canvas').getContext('2d');
    t.filter = 'brightness(1.1)';
    return t.filter === 'brightness(1.1)';
})();

// 臉中央偏下（鼻翼、臉頰一帶）的平均亮度，避開瀏海和眼睛
function probeSkinY(src, f) {
    var cx = f.ox + f.vx * f.H * 0.6, cy = f.oy + f.vy * f.H * 0.6;
    var sw = f.W * 0.4, sh = f.H * 0.2;
    probeCtx.clearRect(0, 0, 8, 8);
    probeCtx.drawImage(src, cx - sw / 2, cy - sh / 2, sw, sh, 0, 0, 8, 8);
    var d = probeCtx.getImageData(0, 0, 8, 8).data, sum = 0;
    for (var i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return Math.max(1, Math.min(255, Math.round(sum / 64)));
}

// 以「膚色亮度比」換算亮度係數：線性光比值壓 0.45 次方（同 script.js 的 exposureFrom）
function exposureRatio(userY, refY, lo, hi) {
    var e = Math.pow(SRGB_TO_LINEAR[userY] / SRGB_TO_LINEAR[refY], EXPOSURE_RESPONSE);
    return Math.max(lo, Math.min(hi, e));
}

var userSkinY = -1;
function updateExposure(f) {
    var y = probeSkinY(video, f);
    userSkinY = userSkinY < 0 ? y : userSkinY + (y - userSkinY) * 0.2;
    var e = exposureRatio(Math.round(userSkinY), NEUTRAL_SKIN_Y, EXPOSURE_MIN, EXPOSURE_MAX);
    exposure += (e - exposure) * 0.2;
}

// ---------- 照片髮型：從參考照片去背出來的頭髮 ----------
// 每張參考照片在第一次用到時處理一次：
//   FaceLandmarker 取臉部座標系 → ImageSegmenter 取頭髮信心值當 alpha → 去背貼圖
// 試戴時把「照片的臉部座標」對應到「使用者的臉部座標」，頭髮就跟著位置、大小、角度貼上。
// 頭髮本身是真實照片，光影與髮絲質感都是真的，比程式畫的自然。
var PHOTO_STYLES = [
    { id: 'f1', name: '妹妹頭長直髮', group: '女生' },
    { id: 'f5', name: '八字瀏海長髮', group: '女生' },
    { id: 'f3', name: '大波浪',       group: '女生' },
    { id: 'f7', name: '木馬捲',       group: '女生' },
    { id: 'f9', name: '層次公主切',   group: '女生' },
    { id: 'f6', name: '齊切短髮',     group: '女生' },
    { id: 'f8', name: '狼尾頭層次',   group: '女生' },
    { id: 'f4', name: '鯔魚頭',       group: '女生' },
    { id: 'f2', name: '精靈短髮',     group: '女生' },
    { id: 'm01', name: '寸頭',       group: '男生' },
    { id: 'm00', name: '捲髮短寸',   group: '男生' },
    { id: 'm20', name: '刺蝟短髮',   group: '男生' },
    { id: 'm12', name: '油頭旁分',   group: '男生' },
    { id: 'm11', name: '齊瀏海短髮', group: '男生' },
    { id: 'm02', name: '蘑菇頭',     group: '男生' },
    { id: 'm10', name: '韓系捲髮',   group: '男生' }
];
var PHOTO_IDS = new Set(PHOTO_STYLES.map(function(s) { return s.id; }));
// 去背 alpha 的 smoothstep 區間：LO 調高可去掉頭髮外圍的背景色暈
var CUTOUT_LO = 0.35, CUTOUT_HI = 0.85;
var DEFAULT_DRAWN_COLOR = '#3b2a20';   // 手繪髮型在「原色」時用的顏色

var photoTools = null;                 // Promise<{ landmarker, segmenter, hairIndex }>
var photoJobs = new Map();             // id -> Promise
var photoReady = new Map();            // id -> { canvas, inv, skinY, dyed }

function loadPhotoTools() {
    if (photoTools) return photoTools;
    photoTools = (async function() {
        var lmk = await createTask(FaceLandmarker, FACE_MODEL_URL, { runningMode: 'IMAGE', numFaces: 1 });
        var sg = await createTask(ImageSegmenter, MODELS.hair.url, {
            runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false
        });
        return { landmarker: lmk.task, segmenter: sg.task, hairIndex: hairIndexOf(sg.task, MODELS.hair.hairIndex) };
    })();
    photoTools.catch(function() { photoTools = null; });
    return photoTools;
}

function loadImage(src) {
    return new Promise(function(resolve, reject) {
        var img = new Image();
        img.onload = function() { resolve(img); };
        img.onerror = function() { reject(new Error('圖片載入失敗：' + src)); };
        img.src = src;
    });
}

// 雙線性放大（最近鄰會讓髮型邊緣變成鋸齒方塊）
function resampleMask(src, mw, mh, w, h) {
    if (mw === w && mh === h) return Float32Array.from(src);
    var out = new Float32Array(w * h);
    var sx = mw / w, sy = mh / h;
    for (var y = 0; y < h; y++) {
        var fy = Math.max(0, (y + 0.5) * sy - 0.5);
        var y0 = fy | 0, y1 = Math.min(mh - 1, y0 + 1), ty = fy - y0;
        for (var x = 0; x < w; x++) {
            var fx = Math.max(0, (x + 0.5) * sx - 0.5);
            var x0 = fx | 0, x1 = Math.min(mw - 1, x0 + 1), tx = fx - x0;
            var a = src[y0 * mw + x0] + (src[y0 * mw + x1] - src[y0 * mw + x0]) * tx;
            var b = src[y1 * mw + x0] + (src[y1 * mw + x1] - src[y1 * mw + x0]) * tx;
            out[y * w + x] = a + (b - a) * ty;
        }
    }
    return out;
}

// 方框平均（水平 + 垂直各一次），用來把閉運算留下的方角修圓
function boxBlur(src, w, h, r) {
    if (r < 1) return src;
    var tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (var pass = 0; pass < 2; pass++) {
        var from = pass === 0 ? src : tmp, to = pass === 0 ? tmp : out;
        var outer = pass === 0 ? h : w, inner = pass === 0 ? w : h;
        for (var a = 0; a < outer; a++) {
            var sum = 0, cnt = 0;
            for (var k = 0; k <= Math.min(r, inner - 1); k++) {
                sum += pass === 0 ? from[a * w + k] : from[k * w + a];
                cnt++;
            }
            for (var b = 0; b < inner; b++) {
                to[pass === 0 ? a * w + b : b * w + a] = sum / cnt;
                var add = b + r + 1, rem = b - r;
                if (add < inner) { sum += pass === 0 ? from[a * w + add] : from[add * w + a]; cnt++; }
                if (rem >= 0) { sum -= pass === 0 ? from[a * w + rem] : from[rem * w + a]; cnt--; }
            }
        }
    }
    return out;
}

// 形態學閉運算（先膨脹再侵蝕），補起瀏海髮絲間透出額頭造成的小洞；
// 比 2r 大的空隙（臉、脖子）不受影響。可分離的方框濾波，r 只有幾 px。
function slide(src, w, h, r, horizontal, pickMax) {
    var out = new Float32Array(src.length);
    var outer = horizontal ? h : w, inner = horizontal ? w : h;
    for (var a = 0; a < outer; a++) {
        for (var b = 0; b < inner; b++) {
            var v = pickMax ? 0 : 1;
            for (var k = Math.max(0, b - r); k <= Math.min(inner - 1, b + r); k++) {
                var s = horizontal ? src[a * w + k] : src[k * w + a];
                if (pickMax ? s > v : s < v) v = s;
            }
            out[horizontal ? a * w + b : b * w + a] = v;
        }
    }
    return out;
}
function closeMask(m, w, h, r) {
    if (r < 1) return m;
    var d = slide(slide(m, w, h, r, true, true), w, h, r, false, true);
    return slide(slide(d, w, h, r, true, false), w, h, r, false, false);
}
var CUTOUT_CLOSE = 0.035;              // 閉運算半徑（臉寬的比例）

// 填補被頭髮整圈包住的洞（空氣瀏海髮絲間透出的額頭）。從圖片邊緣做 flood fill，
// 碰不到邊緣的「非頭髮」區塊就是封閉的洞。臉經由脖子連到圖片底部，不會被填掉。
// 回傳被填的像素，之後去色暈時改用旁邊的髮色，不會把參考照模特兒的額頭貼上去。
var HOLE_MAX_AREA = 0.03;              // 可填補的洞面積上限（臉寬 × 臉長的比例）
function fillHoles(alpha, w, h, maxArea) {
    var n = w * h, seen = new Uint8Array(n), stack = new Int32Array(n), top = 0;
    function push(i) {
        if (!seen[i] && alpha[i] < 0.5) { seen[i] = 1; stack[top++] = i; }
    }
    for (var x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (var y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (top) {
        var i = stack[--top], cx = i % w;
        if (cx > 0) push(i - 1);
        if (cx < w - 1) push(i + 1);
        if (i >= w) push(i - w);
        if (i < n - w) push(i + w);
    }
    // 剩下沒走到的「非頭髮」區塊逐塊檢查面積，只填小洞。深色高領衣服會被誤判成頭髮、
    // 把整張臉圍成一個「洞」，面積上限擋掉這種情況，免得把參考照的臉貼上去。
    var filled = new Uint8Array(n);
    for (var k = 0; k < n; k++) {
        if (seen[k] || alpha[k] >= 0.5) continue;
        var start = top;
        seen[k] = 1;
        stack[top++] = k;
        for (var j = start; j < top; j++) {
            var p = stack[j], px = p % w;
            if (px > 0) push(p - 1);
            if (px < w - 1) push(p + 1);
            if (p >= w) push(p - w);
            if (p < n - w) push(p + w);
        }
        if (top - start <= maxArea) {
            for (var m = start; m < top; m++) { filled[stack[m]] = 1; alpha[stack[m]] = 1; }
        }
        top = start;
    }
    return filled;
}

// 去色暈：頭髮邊緣混到了原照片的背景色（男生參考照是白底），加上素材放大時的
// 振鈴亮邊，會留下一圈白邊。做法是把「確定是頭髮」的範圍再往內縮 erode px，
// 只拿內部像素做模糊；canvas 是 premultiplied alpha，模糊後讀回來的 RGB 就是
// 「附近純頭髮的平均顏色」。hairColorField 算出這張色場，recolorEdges 用它取代
// 邊緣像素的顏色（alpha 不動）。
var SOLID_ALPHA = 250;
function hairColorField(d, w, h, radius, erode, filled) {
    var core = new Float32Array(w * h);
    for (var i = 0; i < core.length; i++) core[i] = d[i * 4 + 3] >= SOLID_ALPHA && !filled[i] ? 1 : 0;
    core = slide(slide(core, w, h, erode, true, false), w, h, erode, false, false);
    var solid = new ImageData(new Uint8ClampedArray(d), w, h);
    for (var p = 3, k = 0; p < d.length; p += 4, k++) solid.data[p] = core[k] ? 255 : 0;
    var a = document.createElement('canvas');
    a.width = w; a.height = h;
    a.getContext('2d').putImageData(solid, 0, 0);
    var b = document.createElement('canvas');
    b.width = w; b.height = h;
    var bg = b.getContext('2d', { willReadFrequently: true });
    bg.filter = 'blur(' + radius + 'px)';
    bg.drawImage(a, 0, 0);
    return { fill: bg.getImageData(0, 0, w, h).data, core: core };
}

function recolorEdges(d, field, keyed) {
    var fill = field.fill, core = field.core;
    for (var q = 0, n = 0; q < d.length; q += 4, n++) {
        if (d[q + 3] === 0 || core[n] || keyed[n] || fill[q + 3] === 0) continue;
        d[q] = fill[q];
        d[q + 1] = fill[q + 1];
        d[q + 2] = fill[q + 2];
    }
}

// ---------- 純色背景的精細去背 ----------
// 分割模型在 512×512 判斷，頭髮外緣很粗。參考照如果是純色背景（例如淺灰攝影棚），
// 外緣每個像素都可以看成「頭髮色 F 與背景色 B 的混合」：c = B + a(F − B)。
// 把 c 投影到 B→F 這條線上就得到透明度 a，再反推純頭髮色 (c − B) / a + B，
// 細髮絲能切出來，而且不會帶背景色。殘差太大（不是頭髮和背景的混合，例如耳朵、
// 衣服）的像素維持分割模型的結果；臉部輪廓內（瀏海和額頭交界）也一律交給分割模型。
var BG_MAX_DEVIATION = 12;   // 圖邊取樣的平均偏差超過這個值，就當作背景不是純色，不做精細去背
var KEY_RESIDUAL = 24;       // 像素離「背景—頭髮」連線的距離上限（0–255）
var KEY_RING = 0.05;         // 從分割遮罩往外找細髮絲的範圍（臉寬比例）

function estimateBackground(d, w, h) {
    var rs = [], gs = [], bs = [];
    var band = Math.max(2, Math.round(Math.min(w, h) * 0.03));
    for (var y = 0; y < Math.round(h * 0.6); y += 2) {
        for (var x = 0; x < w; x += 2) {
            if (y >= band && x >= band && x < w - band) continue;
            var p = (y * w + x) * 4;
            rs.push(d[p]); gs.push(d[p + 1]); bs.push(d[p + 2]);
        }
    }
    var med = function(a) { a.sort(function(m, n) { return m - n; }); return a[a.length >> 1]; };
    var B = [med(rs), med(gs), med(bs)];
    var dev = 0;
    for (var i = 0; i < rs.length; i++) {
        dev += Math.abs(rs[i] - B[0]) + Math.abs(gs[i] - B[1]) + Math.abs(bs[i] - B[2]);
    }
    return { color: B, deviation: dev / (rs.length * 3) };
}

function faceOvalMask(lm, w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d', { willReadFrequently: true });
    g.beginPath();
    FACE_OVAL.forEach(function(i, k) {
        if (k === 0) g.moveTo(lm[i].x * w, lm[i].y * h); else g.lineTo(lm[i].x * w, lm[i].y * h);
    });
    g.closePath();
    g.fill();
    var px = g.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h);
    for (var i = 0; i < out.length; i++) out[i] = px[i * 4 + 3] > 0 ? 1 : 0;
    return out;
}

// 回傳哪些像素已由解混決定（之後去色暈要跳過它們）；背景不是純色時回傳全 0
function keyAgainstBackground(d, field, w, h, lm, f) {
    var keyed = new Uint8Array(w * h);
    var fill = field.fill, core = field.core;
    var bgInfo = estimateBackground(d, w, h);
    if (bgInfo.deviation > BG_MAX_DEVIATION) return keyed;
    var B = bgInfo.color;
    var face = faceOvalMask(lm, w, h);
    var seg = new Float32Array(w * h);
    for (var i = 0; i < seg.length; i++) seg[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
    var r = Math.max(1, Math.round(f.W * KEY_RING));
    var ring = slide(slide(seg, w, h, r, true, true), w, h, r, false, true);

    // 瀏海：臉部輪廓內、眉毛以上一點的範圍，瀏海後面是額頭，改用臉頰膚色當背景色解混。
    // 空氣瀏海的髮絲會變成半透明，透出的是使用者自己的額頭。
    var browY = Math.max(lm[105].y, lm[334].y) * h + f.H * 0.03;
    var S = skinColor(d, w, h, lm, f);

    for (var n = 0, q = 0; n < seg.length; n++, q += 4) {
        // 內部（core）的亮面髮絲不動
        if (core[n] || fill[q + 3] === 0) continue;
        if (face[n]) {
            // 瀏海區原則上只「削減」分割模型已判為頭髮的透明度，不憑空生出頭髮：
            // 太陽穴、額頭偏暗的皮膚算出來也會有一點 a，不擋的話會出現一塊塊假頭髮。
            // 例外是很明確的頭髮色（a ≥ BANG_RAISE_MIN），分割模型信心不足時可以補回來
            if (n / w <= browY && d[q + 3] >= 25) {
                var segA = d[q + 3];
                unmix(d, q, n, fill, S, keyed);
                if (d[q + 3] > segA && d[q + 3] < BANG_RAISE_MIN * 255) d[q + 3] = segA;
            }
        } else if (ring[n]) {
            // ring 內其他像素都檢查一次：分割模型很有把握、其實卻是白衣服的像素也會在這裡變透明
            unmix(d, q, n, fill, B, keyed);
        }
    }
    return keyed;
}

// c = B + a(F − B)：把像素投影到「背景色 B → 頭髮色 F」的連線上求透明度 a，
// 再反推純頭髮色。離連線太遠（不是頭髮和背景的混合，例如耳朵、衣服）就不處理。
function unmix(d, q, n, fill, B, keyed) {
    var vr = fill[q] - B[0], vg = fill[q + 1] - B[1], vb = fill[q + 2] - B[2];
    var vv = vr * vr + vg * vg + vb * vb;
    if (vv < 900) return;                             // 頭髮色太接近背景色，分不開
    var cr = d[q] - B[0], cg = d[q + 1] - B[1], cb = d[q + 2] - B[2];
    var a = (cr * vr + cg * vg + cb * vb) / vv;
    var er = cr - a * vr, eg = cg - a * vg, eb = cb - a * vb;
    if (er * er + eg * eg + eb * eb > KEY_RESIDUAL * KEY_RESIDUAL) return;
    a = a < 0 ? 0 : (a > 1 ? 1 : a);
    keyed[n] = 1;
    d[q + 3] = Math.round(a * 255);
    if (a > 0.02) {
        // a 很小時反推會把雜訊放大，顏色往附近的頭髮色靠
        var t = a < UNMIX_TRUST ? a / UNMIX_TRUST : 1;
        d[q]     = Math.max(0, Math.min(255, Math.round(fill[q]     + (B[0] + cr / a - fill[q])     * t)));
        d[q + 1] = Math.max(0, Math.min(255, Math.round(fill[q + 1] + (B[1] + cg / a - fill[q + 1]) * t)));
        d[q + 2] = Math.max(0, Math.min(255, Math.round(fill[q + 2] + (B[2] + cb / a - fill[q + 2]) * t)));
    }
}
var UNMIX_TRUST = 0.35;
var BANG_RAISE_MIN = 0.85;

// 兩側臉頰（關鍵點 205 / 425 附近）的中位數膚色
function skinColor(d, w, h, lm, f) {
    var rs = [], gs = [], bs = [], r = Math.max(2, Math.round(f.W * 0.04));
    [205, 425].forEach(function(idx) {
        var cx = Math.round(lm[idx].x * w), cy = Math.round(lm[idx].y * h);
        for (var y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
            for (var x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
                var p = (y * w + x) * 4;
                rs.push(d[p]); gs.push(d[p + 1]); bs.push(d[p + 2]);
            }
        }
    });
    var med = function(a) { a.sort(function(m, k) { return m - k; }); return a[a.length >> 1]; };
    return [med(rs), med(gs), med(bs)];
}

function preparePhotoStyle(id) {
    if (photoJobs.has(id)) return photoJobs.get(id);
    var job = (async function() {
        var tools = await loadPhotoTools();
        var img = await loadImage('hair-refs/' + id + '.jpg');
        var iw = img.naturalWidth, ih = img.naturalHeight;

        var det = tools.landmarker.detect(img);
        var lm = det.faceLandmarks && det.faceLandmarks[0];
        if (!lm) throw new Error('參考照片偵測不到臉：' + id);

        var alpha = null;
        tools.segmenter.segment(img, function(result) {
            var m = result.confidenceMasks && result.confidenceMasks[tools.hairIndex];
            if (m) alpha = resampleMask(m.getAsFloat32Array(), m.width, m.height, iw, ih);
        });
        if (!alpha) throw new Error('參考照片分割失敗：' + id);
        var f = faceFrame(lm, iw, ih);
        var closeR = Math.round(f.W * CUTOUT_CLOSE);
        alpha = closeMask(alpha, iw, ih, closeR);
        var filled = fillHoles(alpha, iw, ih, f.W * f.H * HOLE_MAX_AREA);
        alpha = boxBlur(alpha, iw, ih, Math.max(1, closeR >> 1));

        var c = document.createElement('canvas');
        c.width = iw;
        c.height = ih;
        var g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        var data = g.getImageData(0, 0, iw, ih);
        for (var i = 0, p = 3; i < alpha.length; i++, p += 4) {
            var t = (alpha[i] - CUTOUT_LO) / (CUTOUT_HI - CUTOUT_LO);
            t = t <= 0 ? 0 : (t >= 1 ? 1 : t * t * (3 - 2 * t));
            data.data[p] = Math.round(t * 255);
        }
        var field = hairColorField(data.data, iw, ih, Math.max(2, Math.round(f.W * 0.08)), Math.max(1, Math.round(f.W * 0.025)), filled);
        var keyed = keyAgainstBackground(data.data, field, iw, ih, lm, f);   // 先用原始顏色解混
        recolorEdges(data.data, field, keyed);                                   // 其餘邊緣再去色暈

        // 參考圖若是從拼圖截下來的，左右 / 上緣可能殘留分隔線，頭髮碰到圖邊時會被一起切進來
        var border = Math.max(2, Math.round(iw * 0.02));
        // 下緣若為了避開圖上的文字標籤而裁掉，長髮髮尾會被切成一條橫線：最下面一段改成漸淡
        var fade = Math.round(ih * 0.08);
        for (var by = 0; by < ih; by++) {
            var fy = Math.min(1, (ih - 1 - by) / fade);
            for (var bx = 0; bx < iw; bx++) {
                var ap = (by * iw + bx) * 4 + 3;
                if (bx < border || bx >= iw - border || by < border) data.data[ap] = 0;
                else if (fy < 1) data.data[ap] = Math.round(data.data[ap] * fy);
            }
        }
        g.putImageData(data, 0, 0);

        var inv = new DOMMatrix([f.ux * f.W, f.uy * f.W, f.vx * f.H, f.vy * f.H, f.ox, f.oy]).inverse();
        var entry = { canvas: c, inv: inv, skinY: probeSkinY(img, f), dyed: new Map() };
        photoReady.set(id, entry);
        return entry;
    })();
    job.catch(function(e) {
        console.warn(e);
        photoJobs.delete(id);
    });
    photoJobs.set(id, job);
    return job;
}

// 背景依序處理全部參考照片，點選時大多已經準備好
var prefetchStarted = false;
async function prefetchPhotoStyles() {
    if (prefetchStarted) return;
    prefetchStarted = true;
    for (var i = 0; i < PHOTO_STYLES.length; i++) {
        try { await preparePhotoStyle(PHOTO_STYLES[i].id); } catch (e) { /* 已在 preparePhotoStyle 記錄 */ }
        await new Promise(function(r) { setTimeout(r, 30); });
    }
}

// 套用色票：用跟即時染髮相同的線性光算法，對去背貼圖整張染一次後快取
function dyedCutout(entry, color) {
    if (!color) return entry.canvas;
    if (entry.dyed.has(color)) return entry.dyed.get(color);
    var src = entry.canvas;
    var out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    var g = out.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0);
    var img = g.getImageData(0, 0, out.width, out.height), d = img.data;
    var sum = 0, count = 0;
    for (var p = 0; p < d.length; p += 4) {
        if (d[p + 3] < 128) continue;
        sum += relLuminance(SRGB_TO_LINEAR[d[p]], SRGB_TO_LINEAR[d[p + 1]], SRGB_TO_LINEAR[d[p + 2]]);
        count++;
    }
    if (count) {
        var dp = dyeParams(color, Math.max(1e-4, sum / count));
        for (var q = 0; q < d.length; q += 4) {
            if (d[q + 3]) dyePixel(d, q, 1, dp);
        }
    }
    g.putImageData(img, 0, 0);
    entry.dyed.set(color, out);
    return out;
}

function drawPhotoStyle(f) {
    var entry = photoReady.get(state.styleId);
    if (!entry) {
        preparePhotoStyle(state.styleId);
        return;
    }
    ctx.save();
    setFaceTransform(f);
    var m = entry.inv;
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    // 依照片與鏡頭的膚色亮度比調整頭髮亮度，讓頭髮跟臉待在同一個光線裡
    if (supportsFilter && userSkinY > 0) {
        ctx.filter = 'brightness(' + exposureRatio(Math.round(userSkinY), entry.skinY, 0.5, 1.6).toFixed(3) + ')';
    }
    ctx.drawImage(dyedCutout(entry, state.color), 0, 0);
    ctx.restore();
}

var lastFace = null;
function renderStyleFrame(w, h) {
    ctx.drawImage(video, 0, 0, w, h);
    if (!face || !state.styleId) return;

    var t0 = performance.now();
    var res = face.landmarker.detectForVideo(video, nextTimestamp());
    pushSample(perf.detect, performance.now() - t0);
    var raw = res.faceLandmarks && res.faceLandmarks[0];
    if (!raw) { ovalFilters = null; lastFace = null; return; }

    var t1 = performance.now();
    var lm = smoothOval(raw, t0);
    var f = faceFrame(lm, w, h);
    if (!lastFace || frameNo % 15 === 0) updateExposure(f);
    lastFace = f;

    if (PHOTO_IDS.has(state.styleId)) {
        drawPhotoStyle(f);
        pushSample(perf.draw, performance.now() - t1);
        return;
    }

    var art = getStyleArt(state.styleId, state.color || DEFAULT_DRAWN_COLOR);
    var light = supportsFilter ? 'brightness(' + exposure.toFixed(3) + ')' : 'none';

    // 1. 後層（臉後面的頭髮）
    if (art.back) {
        ctx.save();
        setFaceTransform(f);
        ctx.filter = light;
        ctx.drawImage(art.back, ART_X0, ART_Y0, ART_W, ART_H);
        ctx.restore();
        // 2. 把臉蓋回去，頭髮才會在臉的後面
        ctx.save();
        traceOval(lm, w, h);
        ctx.clip();
        ctx.drawImage(video, 0, 0, w, h);
        ctx.restore();
    }
    // 3. 前層（瀏海、頭頂、側邊髮簾）
    if (art.front) {
        ctx.save();
        setFaceTransform(f);
        ctx.filter = light;
        ctx.drawImage(art.front, ART_X0, ART_Y0, ART_W, ART_H);
        ctx.restore();
    }
    pushSample(perf.draw, performance.now() - t1);
}

// ---------- 遮罩 ----------
// 模型輸出的遮罩尺寸不一定等於畫面，不同時做雙線性放大；同時做時間平滑。
function ingestMask(src, mw, mh, w, h) {
    var n = w * h;
    var fresh = !mask || mask.length !== n;
    if (fresh) mask = new Float32Array(n);
    var k = fresh ? 1 : MASK_EMA;
    maskW = mw; maskH = mh;

    if (mw === w && mh === h) {
        for (var i = 0; i < n; i++) mask[i] += (src[i] - mask[i]) * k;
        return;
    }
    var sx = mw / w, sy = mh / h;
    var p = 0;
    for (var y = 0; y < h; y++) {
        var fy = (y + 0.5) * sy - 0.5;
        if (fy < 0) fy = 0;
        var y0 = fy | 0, y1 = y0 + 1 < mh ? y0 + 1 : y0, ty = fy - y0;
        var r0 = y0 * mw, r1 = y1 * mw;
        for (var x = 0; x < w; x++, p++) {
            var fx = (x + 0.5) * sx - 0.5;
            if (fx < 0) fx = 0;
            var x0 = fx | 0, x1 = x0 + 1 < mw ? x0 + 1 : x0, tx = fx - x0;
            var a = src[r0 + x0] + (src[r0 + x1] - src[r0 + x0]) * tx;
            var b = src[r1 + x0] + (src[r1 + x1] - src[r1 + x0]) * tx;
            var v = a + (b - a) * ty;
            mask[p] += (v - mask[p]) * k;
        }
    }
}

// ---------- 合成 ----------
// 染髮：保留每個像素相對於「頭髮平均亮度」的明暗（髮絲紋理、光澤），
// 把整體亮度移到目標髮色的亮度，色相/彩度換成目標色。全部在線性光進行。
// 因為以頭髮自己的平均亮度為基準，環境光變暗時結果也跟著變暗，
// 不需要另外做試妝那套 exposureFrom 環境光適應。
function compositeDye(d, n) {
    var sum = 0, count = 0;
    for (var i = 0, p = 0; i < n; i++, p += 4) {
        if (mask[i] < 0.5) continue;
        sum += relLuminance(SRGB_TO_LINEAR[d[p]], SRGB_TO_LINEAR[d[p + 1]], SRGB_TO_LINEAR[d[p + 2]]);
        count++;
    }
    hairFraction = count / n;
    if (count < MIN_HAIR_PIXELS) return;
    var meanL = Math.max(1e-4, sum / count);
    hairRef = hairRef < 0 ? meanL : hairRef + (meanL - hairRef) * REF_EMA;

    var dp = dyeParams(state.color, hairRef);
    var s = state.strength;
    for (var j = 0, q = 0; j < n; j++, q += 4) {
        var a = edgeWeight(mask[j]) * s;
        if (a < MIN_WEIGHT) continue;
        dyePixel(d, q, a, dp);
    }
}

// ref = 頭髮平均線性亮度
function dyeParams(color, ref) {
    var rgb = hexToRgb(color);
    var tr = SRGB_TO_LINEAR[rgb.r], tg = SRGB_TO_LINEAR[rgb.g], tb = SRGB_TO_LINEAR[rgb.b];
    var tL = Math.max(1e-4, relLuminance(tr, tg, tb));
    var gain = tL / ref;
    if (gain < GAIN_MIN) gain = GAIN_MIN; else if (gain > GAIN_MAX) gain = GAIN_MAX;
    // 目標色的「單位亮度」色度
    return { cr: tr / tL, cg: tg / tL, cb: tb / tL, gain: gain };
}

function dyePixel(d, q, a, dp) {
    var lr = SRGB_TO_LINEAR[d[q]], lg = SRGB_TO_LINEAR[d[q + 1]], lb = SRGB_TO_LINEAR[d[q + 2]];
    var outL = relLuminance(lr, lg, lb) * dp.gain;
    d[q]     = linearToSrgb(lr + (dp.cr * outL - lr) * a);
    d[q + 1] = linearToSrgb(lg + (dp.cg * outL - lg) * a);
    d[q + 2] = linearToSrgb(lb + (dp.cb * outL - lb) * a);
}

// 遮罩檢視：直接把染色會作用的權重疊成半透明色，用來看分割邊緣
function compositeOverlay(d, n) {
    var count = 0;
    for (var i = 0, p = 0; i < n; i++, p += 4) {
        var m = mask[i];
        if (m >= 0.5) count++;
        var a = edgeWeight(m) * OVERLAY_ALPHA;
        if (a < MIN_WEIGHT) continue;
        d[p]     += (255 - d[p]) * a;
        d[p + 1] += (40 - d[p + 1]) * a;
        d[p + 2] += (160 - d[p + 2]) * a;
    }
    hairFraction = count / n;
}

// ---------- 主迴圈 ----------
var hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
function scheduleNext() {
    if (hasRVFC) video.requestVideoFrameCallback(onFrame);
    else requestAnimationFrame(onFrame);
}
function onFrame() {
    try { renderFrame(); } catch (e) { console.error(e); }
    scheduleNext();
}

function renderFrame() {
    var w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        mask = null;
    }

    frameNo++;
    if (state.tab === 'style') {
        renderStyleFrame(w, h);
        countFrame(w, h);
        return;
    }

    if (seg && state.mode !== 'off' && frameNo % state.segEvery === 0) {
        var ts = nextTimestamp();
        var current = seg;
        var t0 = performance.now();
        current.segmenter.segmentForVideo(video, ts, function(result) {
            var masks = result.confidenceMasks;
            var m = masks && masks[current.hairIndex];
            if (m) ingestMask(m.getAsFloat32Array(), m.width, m.height, w, h);
        });
        pushSample(perf.seg, performance.now() - t0);
    }

    ctx.drawImage(video, 0, 0, w, h);

    var active = state.mode === 'overlay' || (state.mode === 'dye' && state.color);
    if (active && mask && mask.length === w * h) {
        var t1 = performance.now();
        var img = ctx.getImageData(0, 0, w, h);
        if (state.mode === 'dye') compositeDye(img.data, w * h);
        else compositeOverlay(img.data, w * h);
        ctx.putImageData(img, 0, 0);
        pushSample(perf.comp, performance.now() - t1);
    }
    countFrame(w, h);
}

function countFrame(w, h) {
    perf.frames++;
    var now = performance.now();
    if (now - perf.since >= 500) {
        perf.fps = perf.frames * 1000 / (now - perf.since);
        perf.frames = 0;
        perf.since = now;
        if (state.showStats) updateStats(w, h);
    }
}

function pushSample(arr, v) {
    arr.push(v);
    if (arr.length > 30) arr.shift();
}
function avg(arr) {
    if (!arr.length) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
}
function updateStats(w, h) {
    if (state.tab === 'style') {
        statsEl.textContent = [
            'fps     ' + perf.fps.toFixed(1),
            '偵測    ' + avg(perf.detect).toFixed(1) + ' ms' + (face ? ' (' + face.delegate + ')' : ''),
            '繪製    ' + avg(perf.draw).toFixed(1) + ' ms',
            '畫面    ' + w + '×' + h,
            '臉      ' + (lastFace ? '有' : '未偵測到'),
            '光線    ×' + exposure.toFixed(2)
        ].join('\n');
        return;
    }
    var lines = [
        'fps     ' + perf.fps.toFixed(1),
        '分割    ' + avg(perf.seg).toFixed(1) + ' ms' + (seg ? ' (' + seg.delegate + ')' : ''),
        '合成    ' + avg(perf.comp).toFixed(1) + ' ms',
        '畫面    ' + w + '×' + h,
        '遮罩    ' + (maskW ? maskW + '×' + maskH : '-'),
        '頭髮    ' + (hairFraction * 100).toFixed(0) + '%'
    ];
    statsEl.textContent = lines.join('\n');
}

// ---------- 鏡頭 ----------
async function start() {
    var btn = document.getElementById('start-btn');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus('這個瀏覽器無法開啟鏡頭。手機請用 HTTPS 網址開啟（localhost 例外）。', true);
        return;
    }
    btn.disabled = true;
    var modelReady = state.tab === 'style' ? loadFaceLandmarker() : loadSegmenter(state.modelKey);
    try {
        var stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
            audio: false
        });
        video.srcObject = stream;
        await video.play();
    } catch (e) {
        console.error(e);
        btn.disabled = false;
        setStatus('無法開啟鏡頭：請允許瀏覽器存取鏡頭後再試一次。', true);
        return;
    }
    startEl.hidden = true;
    startEl.style.display = 'none';
    document.getElementById('shutter-bar').hidden = false;
    scheduleNext();
    if (state.tab === 'style') prefetchPhotoStyles();
    await modelReady;
}

// ---------- UI ----------
function setTab(tab) {
    state.tab = tab;
    document.body.dataset.tab = tab;
    document.querySelectorAll('[data-tab]').forEach(function(b) {
        if (b !== document.body) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
    });
    if (!video.srcObject) return;
    if (tab === 'style') {
        loadFaceLandmarker();
        prefetchPhotoStyles();
    } else if (!seg) {
        loadSegmenter(state.modelKey);
    }
}

function initUI() {
    document.getElementById('start-btn').addEventListener('click', start);

    document.querySelectorAll('button[data-tab]').forEach(function(b) {
        b.addEventListener('click', function() { setTab(b.dataset.tab); });
    });
    setTab(state.tab);

    var styleWrap = document.getElementById('styles');
    var groups = [
        { label: '女生', items: PHOTO_STYLES.filter(function(s) { return s.group === '女生'; }) },
        { label: '男生', items: PHOTO_STYLES.filter(function(s) { return s.group === '男生'; }) },
        { label: '手繪', items: [{ id: null, name: '不戴' }].concat(STYLES) }
    ];
    groups.forEach(function(grp) {
        var title = document.createElement('div');
        title.className = 'group-label';
        title.textContent = grp.label;
        var grid = document.createElement('div');
        grid.className = 'style-grid';
        grp.items.forEach(function(s) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'style-btn';
            b.setAttribute('aria-pressed', String(s.id === state.styleId));
            if (PHOTO_IDS.has(s.id)) {
                var thumb = document.createElement('img');
                thumb.src = 'hair-refs/' + s.id + '.jpg';
                thumb.alt = '';
                thumb.loading = 'lazy';
                b.appendChild(thumb);
            }
            b.appendChild(document.createTextNode(s.name));
            b.addEventListener('click', function() {
                state.styleId = s.id;
                styleWrap.querySelectorAll('.style-btn').forEach(function(o) {
                    o.setAttribute('aria-pressed', String(o === b));
                });
                if (PHOTO_IDS.has(s.id) && !photoReady.has(s.id)) {
                    setStatus('處理髮型照片中…');
                    preparePhotoStyle(s.id).then(function() { setStatus(''); }, function(e) {
                        setStatus('這款髮型處理失敗：' + (e && e.message ? e.message : e), true);
                    });
                }
            });
            grid.appendChild(b);
        });
        styleWrap.appendChild(title);
        styleWrap.appendChild(grid);
    });

    var fitScale = document.getElementById('fit-scale');
    var fitOffset = document.getElementById('fit-offset');
    fitScale.addEventListener('input', function() {
        state.fitScale = parseInt(fitScale.value, 10) / 100;
        document.getElementById('fit-scale-value').textContent = fitScale.value + '%';
    });
    fitOffset.addEventListener('input', function() {
        state.fitOffset = parseInt(fitOffset.value, 10) / 100;
        document.getElementById('fit-offset-value').textContent = fitOffset.value;
    });

    document.querySelectorAll('[data-mode]').forEach(function(b) {
        b.addEventListener('click', function() {
            state.mode = b.dataset.mode;
            document.querySelectorAll('[data-mode]').forEach(function(o) {
                o.setAttribute('aria-pressed', String(o === b));
            });
        });
    });

    var wrap = document.getElementById('swatches');
    [{ name: '原色', color: null }].concat(HAIR_COLORS).forEach(function(c) {
        var b = document.createElement('button');
        b.className = 'swatch';
        b.type = 'button';
        b.setAttribute('aria-pressed', String(c.color === state.color));
        b.innerHTML = '<span class="dot"></span>';
        b.querySelector('.dot').style.background = c.color ||
            'linear-gradient(135deg, #d9d2cc 46%, #c0503c 46%, #c0503c 54%, #d9d2cc 54%)';
        b.appendChild(document.createTextNode(c.name));
        b.addEventListener('click', function() {
            state.color = c.color;
            if (state.tab === 'color' && state.mode === 'off') document.querySelector('[data-mode="dye"]').click();
            wrap.querySelectorAll('.swatch').forEach(function(o) {
                o.setAttribute('aria-pressed', String(o === b));
            });
        });
        wrap.appendChild(b);
    });

    var slider = document.getElementById('strength');
    var sliderValue = document.getElementById('strength-value');
    slider.addEventListener('input', function() {
        state.strength = parseInt(slider.value, 10) / 100;
        sliderValue.textContent = slider.value + '%';
    });

    document.getElementById('model').addEventListener('change', function(e) {
        state.modelKey = e.target.value;
        if (video.srcObject) loadSegmenter(state.modelKey);
    });
    document.getElementById('seg-every').addEventListener('change', function(e) {
        state.segEvery = parseInt(e.target.value, 10) || 1;
    });

    var statsBtn = document.getElementById('stats-btn');
    statsBtn.addEventListener('click', function() {
        state.showStats = !state.showStats;
        statsBtn.setAttribute('aria-pressed', String(state.showStats));
        statsEl.hidden = !state.showStats;
    });

    initCamera();
}

// ---------- 拍照 ----------
// 照片只留在這個分頁的記憶體裡（blob URL），不會上傳；關掉頁面就消失。
var MAX_PHOTOS = 30;
var TIMER_STEPS = [0, 3, 10];
var photos = [];               // { url, blob, name }
var timerIndex = 0;
var counting = false;
var currentPhoto = null;

function currentLookName() {
    if (state.tab === 'color') return state.color ? '染髮' : '原圖';
    var all = PHOTO_STYLES.concat(STYLES);
    var s = all.find(function(x) { return x.id === state.styleId; });
    return s ? s.name : '原圖';
}

// 畫面是用 CSS 鏡像顯示的，照片也鏡像，才會和看到的一致
function snapshot() {
    var out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    var octx = out.getContext('2d');
    octx.translate(out.width, 0);
    octx.scale(-1, 1);
    octx.drawImage(canvas, 0, 0);
    return new Promise(function(resolve) { out.toBlob(resolve, 'image/jpeg', 0.92); });
}

function pad(n) { return (n < 10 ? '0' : '') + n; }

async function takePhoto() {
    if (!canvas.width || counting) return;
    var wait = TIMER_STEPS[timerIndex];
    if (wait) {
        counting = true;
        var cd = document.getElementById('countdown');
        cd.hidden = false;
        for (var i = wait; i > 0; i--) {
            cd.textContent = i;
            await new Promise(function(r) { setTimeout(r, 1000); });
        }
        cd.hidden = true;
        counting = false;
    }
    var blob = await snapshot();
    if (!blob) return;
    var flash = document.getElementById('flash');
    flash.classList.remove('on');
    void flash.offsetWidth;                 // 重新觸發動畫
    flash.classList.add('on');

    var d = new Date();
    var name = '髮型試用-' + currentLookName() + '-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
        '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.jpg';
    var photo = { url: URL.createObjectURL(blob), blob: blob, name: name };
    photos.unshift(photo);
    while (photos.length > MAX_PHOTOS) URL.revokeObjectURL(photos.pop().url);
    renderGallery();
}

function renderGallery() {
    var gallery = document.getElementById('gallery');
    gallery.innerHTML = '';
    photos.forEach(function(p) {
        var b = document.createElement('button');
        b.type = 'button';
        b.title = p.name;
        var img = document.createElement('img');
        img.src = p.url;
        img.alt = p.name;
        b.appendChild(img);
        b.addEventListener('click', function() { openPhoto(p); });
        gallery.appendChild(b);
    });
}

function openPhoto(p) {
    currentPhoto = p;
    document.getElementById('photo-preview').src = p.url;
    var dialog = document.getElementById('photo-dialog');
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
}

function closePhoto() {
    var dialog = document.getElementById('photo-dialog');
    if (dialog.close) dialog.close(); else dialog.removeAttribute('open');
    currentPhoto = null;
}

function downloadPhoto(p) {
    var a = document.createElement('a');
    a.href = p.url;
    a.download = p.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

function canShareFiles() {
    try {
        var f = new File([new Blob(['x'], { type: 'image/jpeg' })], 'x.jpg', { type: 'image/jpeg' });
        return !!(navigator.canShare && navigator.canShare({ files: [f] }));
    } catch (e) {
        return false;
    }
}

function initCamera() {
    document.getElementById('shutter').addEventListener('click', takePhoto);

    var timerBtn = document.getElementById('timer-btn');
    timerBtn.addEventListener('click', function() {
        timerIndex = (timerIndex + 1) % TIMER_STEPS.length;
        var t = TIMER_STEPS[timerIndex];
        timerBtn.textContent = t ? '計時 ' + t + ' 秒' : '計時 關';
        timerBtn.setAttribute('aria-pressed', String(t > 0));
    });

    // 空白鍵拍照（焦點在輸入框、下拉選單或對話框開著時不攔截）
    document.addEventListener('keydown', function(e) {
        if (e.code !== 'Space' || e.repeat || !video.srcObject) return;
        var tag = (e.target && e.target.tagName) || '';
        if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(tag)) return;
        if (document.getElementById('photo-dialog').open) return;
        e.preventDefault();
        takePhoto();
    });

    var shareBtn = document.getElementById('photo-share');
    shareBtn.hidden = !canShareFiles();
    shareBtn.addEventListener('click', function() {
        if (!currentPhoto) return;
        var file = new File([currentPhoto.blob], currentPhoto.name, { type: 'image/jpeg' });
        navigator.share({ files: [file], title: '我的髮型試用' }).catch(function() { /* 使用者取消分享 */ });
    });
    document.getElementById('photo-download').addEventListener('click', function() {
        if (currentPhoto) downloadPhoto(currentPhoto);
    });
    document.getElementById('photo-delete').addEventListener('click', function() {
        if (!currentPhoto) return;
        var p = currentPhoto;
        photos = photos.filter(function(x) { return x !== p; });
        URL.revokeObjectURL(p.url);
        closePhoto();
        renderGallery();
    });
    document.getElementById('photo-close').addEventListener('click', closePhoto);
}

initUI();
