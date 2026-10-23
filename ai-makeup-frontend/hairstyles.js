// 2D 髮型貼圖：用程式畫出來的髮型（不用外部圖片，避免素材授權問題，也能直接換髮色）
//
// 座標系是「臉部座標」：原點 = 額頭頂端關鍵點 10，
//   x 單位 = 臉寬（關鍵點 234 → 454 的距離），往畫面右為正
//   y 單位 = 臉長（關鍵點 10 → 152 下巴的距離），往下為正
// 所以臉的左右邊緣約在 x = ±0.5、下巴在 y = 1。
// 每款髮型分兩層：back（臉後面，例如垂在肩後的長髮）和 front（蓋在臉上，例如瀏海）。
// 繪製時先畫 back，再把臉重新蓋回去，最後畫 front。

export var ART_SCALE = 220;                  // 快取畫布上每 1 單位幾 px
export var ART_X0 = -1.3, ART_X1 = 1.3;
export var ART_Y0 = -1.0, ART_Y1 = 2.5;
export var ART_W = ART_X1 - ART_X0, ART_H = ART_Y1 - ART_Y0;

// ---------- 形狀資料 ----------
// pts：外框控制點（Catmull-Rom 平滑成封閉曲線）
// crown：髮絲生長的放射中心（髮旋 / 分線）
// fall：髮絲往下垂的程度（長髮大、短髮小）
// wave：捲度振幅（0 = 直髮），parts：分線（開放曲線，畫成暗線）
// sheen：頭頂光澤

var MID_PART_FRONT = [
    [-0.62, 0.9], [-0.64, 0.5], [-0.6, 0.05], [-0.52, -0.25], [-0.36, -0.42], [-0.15, -0.5], [0, -0.51],
    [0.15, -0.5], [0.36, -0.42], [0.52, -0.25], [0.6, 0.05], [0.64, 0.5], [0.62, 0.9], [0.55, 1.05],
    [0.5, 0.9], [0.47, 0.6], [0.42, 0.3], [0.32, 0.08], [0.15, -0.04], [0.02, -0.07], [0, -0.1],
    [-0.02, -0.07], [-0.15, -0.04], [-0.32, 0.08], [-0.42, 0.3], [-0.47, 0.6], [-0.5, 0.9], [-0.55, 1.05]
];

// 披肩 / 長髮的後層：兩側沿臉旁垂下，下巴以下在中間留出脖子的空間。
// 中段控制點只取比髮尾短的那幾個，避免頭髮較短時控制點上下來回、畫出尖刺。
function longBack(len, spread) {
    var s = spread;
    var outer = [[-0.68 - s * 0.3, 0.5], [-0.72 - s * 0.6, 1.0], [-0.76 - s, 1.5], [-0.78 - s, 1.9]]
        .filter(function(p) { return p[1] < len - 0.3; });
    var inner = [[-0.33, 1.9], [-0.33, 1.5]]
        .filter(function(p) { return p[1] < len - 0.3; });
    var left = [[-0.58, 0.0]].concat(outer, [
        [-0.74 - s, len - 0.12], [-0.6 - s * 0.6, len], [-0.42 - s * 0.3, len - 0.04], [-0.35, len - 0.2]
    ], inner, [[-0.3, 1.05]]);
    var right = left.slice().reverse().map(function(p) { return [-p[0], p[1]]; });
    return left.concat([[0, 0.85]], right, [[0.5, -0.3], [0, -0.48], [-0.5, -0.3]]);
}

var STYLE_DEFS = [
    {
        id: 'men-short', name: '男生短髮',
        back: [],
        front: [{
            pts: [
                [-0.5, 0.44], [-0.56, 0.2], [-0.57, 0.0], [-0.52, -0.22], [-0.38, -0.4], [-0.18, -0.5], [0, -0.52],
                [0.18, -0.5], [0.38, -0.4], [0.52, -0.22], [0.57, 0.0], [0.56, 0.2], [0.5, 0.44],
                [0.46, 0.44], [0.45, 0.2], [0.42, 0.04], [0.3, -0.03], [0.15, 0.0], [0, 0.03],
                [-0.15, 0.0], [-0.3, -0.03], [-0.42, 0.04], [-0.45, 0.2], [-0.46, 0.44]
            ],
            crown: [0.05, -0.38], fall: 0.15, sheen: true
        }]
    },
    {
        id: 'men-side', name: '男生旁分',
        back: [],
        front: [{
            pts: [
                [-0.5, 0.44], [-0.57, 0.2], [-0.59, -0.05], [-0.55, -0.3], [-0.4, -0.5], [-0.15, -0.6], [0.1, -0.6],
                [0.35, -0.52], [0.53, -0.32], [0.59, -0.05], [0.56, 0.2], [0.5, 0.44],
                [0.46, 0.44], [0.45, 0.2], [0.43, 0.06], [0.3, -0.02], [0.1, -0.06], [-0.12, -0.08],
                [-0.3, -0.05], [-0.42, 0.03], [-0.45, 0.2], [-0.46, 0.44]
            ],
            crown: [-0.26, -0.5], fall: 0.2, sheen: true,
            parts: [[[-0.3, -0.56], [-0.27, -0.35], [-0.22, -0.12]]]
        }]
    },
    {
        id: 'mid-part', name: '中分',
        back: [{ pts: longBack(1.42, 0), crown: [0, -0.3], fall: 1.2 }],
        front: [{
            pts: MID_PART_FRONT, crown: [0, -0.2], fall: 1.0, sheen: true,
            parts: [[[0, -0.5], [0, -0.3], [0, -0.1]]]
        }]
    },
    {
        id: 'bob', name: '齊瀏海鮑伯',
        back: [{
            pts: [
                [-0.6, 0.0], [-0.67, 0.4], [-0.67, 0.75], [-0.6, 0.95], [-0.45, 1.0], [-0.3, 0.95], [0, 0.85],
                [0.3, 0.95], [0.45, 1.0], [0.6, 0.95], [0.67, 0.75], [0.67, 0.4], [0.6, 0.0], [0.5, -0.3],
                [0, -0.48], [-0.5, -0.3]
            ],
            crown: [0, -0.3], fall: 0.8
        }],
        front: [{
            pts: [
                [-0.64, 0.85], [-0.64, 0.45], [-0.6, 0.05], [-0.52, -0.25], [-0.36, -0.43], [-0.15, -0.51], [0, -0.52],
                [0.15, -0.51], [0.36, -0.43], [0.52, -0.25], [0.6, 0.05], [0.64, 0.45], [0.64, 0.85], [0.56, 0.97],
                [0.5, 0.85], [0.49, 0.55], [0.46, 0.3], [0.42, 0.2], [0.2, 0.215], [0, 0.22],
                [-0.2, 0.215], [-0.42, 0.2], [-0.46, 0.3], [-0.49, 0.55], [-0.5, 0.85], [-0.56, 0.97]
            ],
            crown: [0, -0.35], fall: 0.7, sheen: true
        }]
    },
    {
        id: 'long-straight', name: '長直髮',
        back: [{ pts: longBack(2.2, 0.02), crown: [0, -0.3], fall: 1.6 }],
        front: [{
            pts: [
                [-0.64, 0.9], [-0.65, 0.5], [-0.6, 0.05], [-0.52, -0.25], [-0.36, -0.43], [-0.15, -0.51], [0.05, -0.52],
                [0.25, -0.49], [0.42, -0.38], [0.55, -0.2], [0.62, 0.1], [0.65, 0.5], [0.64, 0.9], [0.57, 1.05],
                [0.51, 0.9], [0.48, 0.6], [0.44, 0.32], [0.36, 0.14], [0.15, 0.05], [-0.05, -0.02], [-0.2, -0.07],
                [-0.3, 0.0], [-0.4, 0.15], [-0.46, 0.4], [-0.49, 0.7], [-0.52, 0.95], [-0.57, 1.05]
            ],
            crown: [-0.22, -0.3], fall: 1.2, sheen: true,
            parts: [[[-0.24, -0.5], [-0.22, -0.3], [-0.2, -0.09]]]
        }]
    },
    {
        id: 'long-wavy', name: '長捲髮',
        back: [{ pts: longBack(2.0, 0.12), crown: [0, -0.3], fall: 1.4, wave: 0.045, waveFrom: 0.5 }],
        front: [{
            pts: MID_PART_FRONT, crown: [0, -0.2], fall: 1.0, sheen: true, wave: 0.03, waveFrom: 0.45,
            parts: [[[0, -0.5], [0, -0.3], [0, -0.1]]]
        }]
    }
];

export var STYLES = STYLE_DEFS.map(function(s) { return { id: s.id, name: s.name }; });

// ---------- 曲線工具 ----------
function tracePath(g, pts, closed) {
    var n = pts.length;
    g.moveTo(pts[0][0], pts[0][1]);
    var last = closed ? n : n - 1;
    for (var i = 0; i < last; i++) {
        var p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
        if (!closed) {
            if (i === 0) p0 = p1;
            if (i + 2 >= n) p3 = p2;
        }
        g.bezierCurveTo(
            p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
            p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
            p2[0], p2[1]
        );
    }
    if (closed) g.closePath();
}

// 沿 Catmull-Rom 曲線取樣成密集的點，之後才能加捲度
function sampleClosed(pts, perSeg) {
    var n = pts.length, out = [];
    for (var i = 0; i < n; i++) {
        var p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
        for (var k = 0; k < perSeg; k++) {
            var t = k / perSeg, t2 = t * t, t3 = t2 * t;
            out.push([0, 1].map(function(j) {
                return 0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 +
                    (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3);
            }));
        }
    }
    return out;
}

function wavify(pts, amp, from) {
    return sampleClosed(pts, 8).map(function(p) {
        if (p[1] <= from) return p;
        var k = Math.min(1, (p[1] - from) / 0.3);
        return [p[0] + Math.sign(p[0]) * amp * k * Math.sin(p[1] * 11), p[1]];
    });
}

// ---------- 顏色 ----------
function hexToRgb(hex) {
    var v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function mix(c, to, t, a) {
    var r = Math.round(c[0] + (to[0] - c[0]) * t);
    var g = Math.round(c[1] + (to[1] - c[1]) * t);
    var b = Math.round(c[2] + (to[2] - c[2]) * t);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + (a == null ? 1 : a) + ')';
}
var WHITE = [255, 255, 255], BLACK = [0, 0, 0];

function rng(seed) {
    return function() {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    };
}

// ---------- 繪製 ----------
function drawShape(g, s, rgb, rand, isBack) {
    var pts = s.wave ? wavify(s.pts, s.wave, s.waveFrom || 0.5) : s.pts;
    var minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    pts.forEach(function(p) {
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
    });

    // 底色：上亮下暗
    g.beginPath();
    tracePath(g, pts, true);
    var grad = g.createLinearGradient(0, minY, 0, maxY);
    grad.addColorStop(0, mix(rgb, WHITE, 0.08));
    grad.addColorStop(1, mix(rgb, BLACK, 0.18));
    g.fillStyle = grad;
    g.fill();

    g.save();
    g.clip();

    // 髮絲：從 crown 放射出去，越遠越往下垂
    var cx = s.crown[0], cy = s.crown[1];
    var fall = s.fall || 0.8;
    var count = Math.max(120, Math.min(520, Math.round((maxX - minX) * (maxY - minY) * 200)));
    var hi = mix(rgb, WHITE, 0.4, 1), lo = mix(rgb, BLACK, 0.55, 1);
    for (var i = 0; i < count; i++) {
        var theta = (-0.2 + rand() * 1.4) * Math.PI;
        var L = 2.6;
        var sx = cx + (rand() - 0.5) * 0.1, sy = cy + (rand() - 0.5) * 0.06;
        var phase = rand() * Math.PI * 2;
        g.beginPath();
        for (var step = 0; step <= 24; step++) {
            var t = step / 24;
            var x = sx + Math.cos(theta) * L * t * (1 - 0.35 * t);
            var y = sy + Math.sin(theta) * L * t * 0.6 + fall * t * t * L * 0.5;
            if (s.wave) x += s.wave * 0.9 * Math.sin(y * 11 + phase);
            if (step === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        var light = rand() < 0.45;
        g.globalAlpha = light ? 0.12 + rand() * 0.18 : 0.18 + rand() * 0.25;
        g.strokeStyle = light ? hi : lo;
        g.lineWidth = 0.003 + rand() * 0.007;
        g.stroke();
    }
    g.globalAlpha = 1;

    // 分線
    (s.parts || []).forEach(function(part) {
        g.beginPath();
        tracePath(g, part, false);
        g.strokeStyle = 'rgba(0,0,0,0.35)';
        g.lineWidth = 0.012;
        g.stroke();
    });

    // 頭頂光澤
    if (s.sheen) {
        var sh = g.createRadialGradient(0, -0.28, 0.02, 0, -0.28, 0.5);
        sh.addColorStop(0, 'rgba(255,255,255,0.2)');
        sh.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = sh;
        g.fillRect(-1, -1, 2, 1.2);
    }

    // 外緣壓暗，做出體積感
    g.beginPath();
    tracePath(g, pts, true);
    g.strokeStyle = 'rgba(0,0,0,0.22)';
    g.lineWidth = 0.07;
    g.stroke();

    // 後層在頭的後面，光線比較少
    if (isBack) {
        g.fillStyle = 'rgba(0,0,0,0.16)';
        g.fillRect(ART_X0, ART_Y0, ART_W, ART_H);
    }
    g.restore();
}

function newCanvas() {
    var c = document.createElement('canvas');
    c.width = Math.round(ART_W * ART_SCALE);
    c.height = Math.round(ART_H * ART_SCALE);
    return c;
}

function renderLayer(shapes, rgb, seed, isBack) {
    if (!shapes.length) return null;
    var c = newCanvas();
    var g = c.getContext('2d');
    g.setTransform(ART_SCALE, 0, 0, ART_SCALE, -ART_X0 * ART_SCALE, -ART_Y0 * ART_SCALE);
    shapes.forEach(function(s, k) { drawShape(g, s, rgb, rng(seed + k * 101), isBack); });

    // 邊緣稍微柔化，比較不像剪下來的貼紙（不支援 ctx.filter 的瀏覽器就維持原樣）
    var out = newCanvas();
    var og = out.getContext('2d');
    og.filter = 'blur(0.8px)';
    if (og.filter !== 'blur(0.8px)') return c;
    og.drawImage(c, 0, 0);
    return out;
}

var cache = new Map();
export function getStyleArt(id, color) {
    var key = id + '|' + color;
    if (cache.has(key)) return cache.get(key);
    var def = STYLE_DEFS.find(function(s) { return s.id === id; });
    if (!def) return null;
    var rgb = hexToRgb(color);
    var art = {
        back: renderLayer(def.back, rgb, 7, true),
        front: renderLayer(def.front, rgb, 13, false)
    };
    if (cache.size > 24) cache.clear();
    cache.set(key, art);
    return art;
}
