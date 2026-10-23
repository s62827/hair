var videoElement   = document.getElementById('video-element');
var canvasElement  = document.getElementById('output-canvas');
var canvasCtx      = canvasElement.getContext('2d');
var loadingOverlay = document.getElementById('loading-overlay');
var startScreen    = document.getElementById('start-screen');
var appContent     = document.getElementById('app-content');
var initBtn        = document.getElementById('init-btn');
var compareBtn     = document.getElementById('compare-btn');
var saveBtn        = document.getElementById('save-btn');
var analyzeBtn     = document.getElementById('ai-analyze-btn');
var scanBar        = document.getElementById('scan-bar');
var aiPanel        = document.getElementById('ai-result-panel');
var aiText         = document.getElementById('ai-analysis-text');
var aiSummaryText  = document.getElementById('ai-summary-text');
var aiToggleBtn    = document.getElementById('ai-toggle-btn');
var aiDetailWrap   = document.getElementById('ai-detail-wrap');
var aiToggleChevron = document.getElementById('ai-toggle-chevron');
var undertoneBadge = document.getElementById('undertone-badge');
var undertoneLabel = document.getElementById('undertone-label');

// AI 分析報告改成可收闔：預設展開，點標題列切換收合/展開
if (aiToggleBtn) {
    aiToggleBtn.addEventListener('click', function() {
        var collapsed = aiDetailWrap.classList.toggle('hidden');
        aiToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        aiToggleChevron.style.transform = collapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
    });
}

// 每次重新分析時，強制回到展開狀態，避免使用者上次收合後看不到新結果
function expandAiDetail() {
    aiDetailWrap.classList.remove('hidden');
    aiToggleBtn.setAttribute('aria-expanded', 'true');
    aiToggleChevron.style.transform = 'rotate(0deg)';
}

// ---------- 外掛設定 ----------
// 嵌入電商網站時，可在載入 script.js 之前定義 window.AI_MAKEUP_CONFIG 帶入自家色號：
//   window.AI_MAKEUP_CONFIG = {
//       backendUrl: 'https://example.com/api/analyze',  // 選填
//       lipColors:  [{ id, name, color: '#RRGGBB', subtitle }],  // 選填
//       eyeColors:  [...],
//       baseColors: [...]   // 底妝的 subtitle 含「控油/持妝/持久」「水潤/輕透」會決定質感
//   };
// 沒給或格式不對的清單會沿用下面的預設色號
var PLUGIN_CONFIG = window.AI_MAKEUP_CONFIG || {};

function catalogFrom(list, fallback) {
    if (!Array.isArray(list) || list.length === 0) return fallback;
    var valid = list.filter(function(c) {
        return c && typeof c.id === 'string' && typeof c.name === 'string' &&
               typeof c.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.color);
    });
    if (valid.length !== list.length) console.warn('AI_MAKEUP_CONFIG 有色號格式不正確（需要 id、name、#RRGGBB color），已略過');
    return valid.length > 0 ? valid : fallback;
}

// 後端代理位址：預設打「目前這個網頁的來源」+ /api/analyze（同源部署時就不用改）
// 如果前後端不同網域，可用 AI_MAKEUP_CONFIG.backendUrl 或舊的 window.AI_BACKEND_URL 覆蓋
var BACKEND_URL = PLUGIN_CONFIG.backendUrl || window.AI_BACKEND_URL || (window.location.origin + "/api/analyze");
var showMakeup = true;
var lastLandmarks = null;
// 渲染解析度。原本想比照鏡頭原生解析度做自動升降級（640/800/960），但那需要
// 鏡頭同步請求到 960x720，而 MediaPipe 每一幀都要處理那張更大的影格——這個成本
// 不管裝置快慢都得付，且完全不受下面的檔位機制影響（鏡頭解析度在啟動時就決定了，
// 跟每幀量測的效能檔位是兩件事）。實機測試證實這是全面的效能退步，所以先把鏡頭
// 退回 640x480、檔位只留一級。下面的量測/升降級機制保留但暫時是無作用的死碼——
// 之後如果要讓鏡頭解析度也能動態調整（例如量到裝置夠快才用更高解析度重啟串流），
// 這裡不用重寫。
var RENDER_TIERS = [640];
var renderTier = 0;
var compositeMsAvg = 0;
var tierCooldown = 0;
var COMPOSITE_MS_UP = 5.0;     // 平均低於此值就升一級
var COMPOSITE_MS_DOWN = 12.0;  // 高於此值就降一級
var TIER_COOLDOWN_FRAMES = 45; // 換檔後至少觀察這麼多幀再考慮下一次

function noteCompositeCost(ms) {
    compositeMsAvg = compositeMsAvg === 0 ? ms : compositeMsAvg * 0.9 + ms * 0.1;
    if (tierCooldown > 0) { tierCooldown--; return; }
    if (compositeMsAvg > COMPOSITE_MS_DOWN && renderTier > 0) {
        renderTier--; tierCooldown = TIER_COOLDOWN_FRAMES; compositeMsAvg = 0;
    } else if (compositeMsAvg < COMPOSITE_MS_UP && renderTier < RENDER_TIERS.length - 1) {
        renderTier++; tierCooldown = TIER_COOLDOWN_FRAMES; compositeMsAvg = 0;
    }
}

var lipColors = catalogFrom(PLUGIN_CONFIG.lipColors, [
    { id: 'l1', name: '經典正紅',   color: '#9F1C24', price: 1200, subtitle: '絲絨唇膏' },
    { id: 'l2', name: '橘調正紅',   color: '#D2401F', price: 1150, subtitle: '緞光唇膏' },
    { id: 'l3', name: '奶茶裸粉',   color: '#AD7A6C', price: 780,  subtitle: '霧面唇膏' },
    { id: 'l4', name: '玫瑰豆沙',   color: '#B66862', price: 1250, subtitle: '潤澤唇膏' },
    { id: 'l5', name: '亮橘紅',     color: '#E2432B', price: 980,  subtitle: '持久霧唇膏' },
    // 唇色走 'color' 混合（保留唇部原本明暗、只換色相彩度），只差深淺的色號
    // 套上去會幾乎一樣，所以新增的色號刻意挑色相跟既有色號拉開的粉/紫/棕系
    { id: 'l6',  name: '櫻花冷粉',  color: '#D9728A', subtitle: '水潤唇釉' },
    { id: 'l7',  name: '珊瑚蜜桃',  color: '#EC7A5C', subtitle: '緞光唇膏' },
    { id: 'l8',  name: '莓果紫紅',  color: '#8C2F5C', subtitle: '絲絨唇膏' },
    { id: 'l9',  name: '磚紅焦糖',  color: '#9C4A35', subtitle: '霧面唇膏' },
    { id: 'l10', name: '玫瑰紫藕',  color: '#9E5A78', subtitle: '潤澤唇膏' }
]);

var eyeColors = catalogFrom(PLUGIN_CONFIG.eyeColors, [
    { id: 'e1', name: '大地棕',     color: '#8B6552', price: 680,  subtitle: '霧面眼影' },
    { id: 'e2', name: '裸粉玫瑰',   color: '#C99385', price: 2200, subtitle: '四色眼影盤' },
    { id: 'e3', name: '玫瑰裸色',   color: '#BE9284', price: 2100, subtitle: '大地系眼影盤' },
    { id: 'e4', name: '香檳金',     color: '#CBA876', price: 1450, subtitle: '雙色珠光眼影' },
    // 同唇色，眼影也是 'color' 混合，新增色號補上原本缺的冷色與亮色系
    { id: 'e5', name: '暖橘焦糖',   color: '#B5683C', subtitle: '霧面眼影' },
    { id: 'e6', name: '煙燻紫芋',   color: '#8A6A8E', subtitle: '珠光眼影' },
    { id: 'e7', name: '酒紅莓果',   color: '#7E3A44', subtitle: '四色眼影盤' },
    { id: 'e8', name: '霧藍灰',     color: '#6F7D8C', subtitle: '單色眼影' }
]);

var baseColors = catalogFrom(PLUGIN_CONFIG.baseColors, [
    { id: 'b0', name: '白皙淨透',   color: '#F3DCC0', price: 1690, subtitle: '輕透粉底液' },
    { id: 'b1', name: '中性偏黃',   color: '#E6C6A2', price: 1750, subtitle: '持久粉底液' },
    { id: 'b2', name: '沙色自然',   color: '#D9AC82', price: 1650, subtitle: '持妝粉底液' },
    { id: 'b3', name: '自然透亮',   color: '#E0BC90', price: 1780, subtitle: '水潤粉底液' },
    { id: 'b4', name: '蜜糖膚色',   color: '#C8935F', price: 1180, subtitle: '控油粉底液' },
    // 原本 5 色都是淺到中等、偏黃調：AI 分析用 Lab 距離挑最接近的色號，
    // 深膚色只能被硬配到蜜糖膚色，冷調膚色也沒得選，這裡補上冷調與深膚色
    // （subtitle 的關鍵字決定質感，見 baseFinishOf）
    { id: 'b5', name: '粉白冷調',   color: '#F1D5CA', subtitle: '輕透粉底液' },
    { id: 'b6', name: '自然冷調',   color: '#DCB3A0', subtitle: '持妝粉底液' },
    { id: 'b7', name: '小麥健康',   color: '#B57E56', subtitle: '自然粉底液' },
    { id: 'b8', name: '深邃可可',   color: '#875838', subtitle: '控油粉底液' }
]);

// ---------- 濃淡 ----------
// 每一類各自一個倍率（1 = 原本的預設濃度），由色卡下方的滑桿調整，只作用在目前分頁那一類
var intensity = { lip: 1, eye: 1, base: 1 };
var currentMode = 'lip';
var MODE_LABELS = { lip: '唇妝', eye: '眼妝', base: '底妝' };

// ---------- 質感（finish）參數表 ----------
//
// 只剩底妝用得到：眼影/唇色改回最初版本的固定透明度渲染（見 drawEye/drawLips），
// 不吃質感分級。
//
// coverage：色相/彩度的覆蓋率。
// luma    ：明度往妝容色靠攏的比例。這個值同時就是「顯色度」與「遮蓋力」——
//           調高越接近色票原色、質地越平；調低越透、越保留原本的皮膚起伏。
//           1-luma 就是保留下來的原始光影細節。
//
// 粉底的 luma 刻意壓得比較低：粉底是薄透的一層，明度拉太高整張臉會變面具。
// 但也不能是 0——純 'color' 時明度完全不動，「白皙淨透」這種淺色號畫上去
// 亮度一點都不會提，跟深色號在臉上看起來幾乎一樣。
var BASE_FINISHES = {
    matte:   { coverage: 0.38, luma: 0.25, glow: 0.00 },  // 持久 / 持妝 / 控油
    natural: { coverage: 0.34, luma: 0.21, glow: 0.08 },
    dewy:    { coverage: 0.31, luma: 0.20, glow: 0.17 }   // 水潤 / 輕透
};

function baseFinishOf(subtitle) {
    var s = subtitle || '';
    if (s.indexOf('控油') >= 0 || s.indexOf('持妝') >= 0 || s.indexOf('持久') >= 0) return BASE_FINISHES.matte;
    if (s.indexOf('水潤') >= 0 || s.indexOf('輕透') >= 0) return BASE_FINISHES.dewy;
    return BASE_FINISHES.natural;
}

// 這三個存的是整個色號物件（不再只是 hex 字串）：底妝的 compositeMakeup
// 要讀 subtitle 決定質感；眼影/唇色雖然改回不看質感的固定參數渲染，仍
// 統一存物件方便色票 UI 顯示名稱/價格等其他欄位
var activeLipColor = null;  var activeLipId  = null;
var activeEyeColor = null;  var activeEyeId  = null;
var activeBaseColor = null; var activeBaseId = null;

var UPPER_LIP = [61,185,40,39,37,0,267,269,270,409,291,308,415,310,311,312,13,82,81,80,191,78];
var LOWER_LIP = [61,146,91,181,84,17,314,405,321,375,291,308,324,318,402,317,14,87,178,88,95,78];
var FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
var LEFT_EYE_REGION  = [226,247,30,29,27,28,56,190,243,133,173,157,158,159,160,161,246,33,7,163,144,145,153,154,155];
var RIGHT_EYE_REGION = [463,414,286,258,257,259,260,467,446,362,398,384,385,386,387,388,466,263,249,390,373,374,380,381,382];

// 只取上眼瞼那條線（不含下眼瞼），眼影範圍會用這條線再往上「長」出眼皮區域，
// 避免用整圈眼睛輪廓填色時把虹膜/眼白也蓋到
var LEFT_UPPER_LID  = [33,246,161,160,159,158,157,173,133];
var RIGHT_UPPER_LID = [263,466,388,387,386,385,384,398,362];

// 眉毛與嘴唇的外輪廓：拿來從粉底範圍裡挖掉（見 buildWeightMap）。
// 眉毛沿上緣由外往內、再沿下緣由內往外繞回來，圍成一個封閉多邊形。
var LEFT_EYEBROW  = [300,293,334,296,336,285,295,282,283,276];
var RIGHT_EYEBROW = [70,63,105,66,107,55,65,52,53,46];
// 上下唇合起來的單一外圈（不含唇縫），當遮罩用比 UPPER_LIP/LOWER_LIP 兩塊新月形單純
var LIP_OUTLINE   = [61,185,40,39,37,0,267,269,270,409,291,375,321,405,314,17,84,181,91,146];

function hexToRgb(hex) {
    return { r: parseInt(hex.slice(1,3),16), g: parseInt(hex.slice(3,5),16), b: parseInt(hex.slice(5,7),16) };
}

function tracePath(ctx, points, W, H) {
    var n = points.length;
    var pts = points.map(function(p) { return { x: p.x * W, y: p.y * H }; });
    // 原本用直線把關鍵點連起來；額頭這種區域關鍵點間距很大（只有兩三個點
    // 撐開整條額頭寬度），直線段本身就是一條直的邊，套再多模糊也只是把
    // 那條直邊「化開」、邊界本身的走向還是直的，跟額頭自然的弧度不符，
    // 在平滑無陰影的額頭上特別容易被看出一條線。改成「每個關鍵點當控制點，
    // 往下一點的中點畫二次貝茲曲線」，讓路徑在每個點自然轉彎成弧線，
    // 關鍵點稀疏時也不會出現直線切邊。
    var start = { x: (pts[0].x + pts[n - 1].x) / 2, y: (pts[0].y + pts[n - 1].y) / 2 };
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    for (var i = 0; i < n; i++) {
        var cur = pts[i];
        var next = pts[(i + 1) % n];
        var mid = { x: (cur.x + next.x) / 2, y: (cur.y + next.y) / 2 };
        ctx.quadraticCurveTo(cur.x, cur.y, mid.x, mid.y);
    }
    ctx.closePath();
}

// 重複使用同一批離屏畫布，避免每一影格都 new 一堆 canvas 拖垮效能
var scratchCanvases = {};
function getScratchCanvas(key, W, H) {
    var c = scratchCanvases[key];
    if (!c) { c = document.createElement('canvas'); scratchCanvases[key] = c; }
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    return c;
}

// ---------- 羽化 ----------
//
// 舊版做法：把多邊形往「重心」方向等比縮小、疊 N 層低透明度。動機是繞過
// ctx.filter 在部分行動瀏覽器上完全失效的問題，但等比縮放在細長形狀上是
// 各向異性的，換算出來的實際羽化寬度會嚴重失真。以 640×480 畫布、一般自拍
// 距離的嘴唇（寬約 65px、上唇高約 14px）、featherRatio 0.35 為例：
//     嘴角（水平）羽化帶 ≈ 11.4px      唇峰／唇緣（垂直）≈ 2.4px
// 剛好相反——該清楚的嘴角糊成一片，該柔和的唇緣卻是硬邊。臉部更誇張，
// 水平 36px／垂直 48px，等於臉頰外緣有近 20% 臉寬都在漸層裡。
// 另外疊層本身也有問題：臉部 18 層、每層 15.3% 的階梯，在平滑的額頭上
// 會看到一圈圈的同心色帶。
//
// 新做法分兩步，兩步都是「沿路徑法線」而不是「往重心」：
//   1. 用 stroke 把輪廓整體外擴／內縮。stroke 的寬度是沿法線量的，四面等寬、
//      跟形狀長寬比無關，正好避開上面那個 4-5 倍失真。
//   2. 對整張圖層做真正的模糊，得到連續的 alpha 漸層（不再有階梯色帶）。
//
// featherPx 是羽化帶的半寬（像素）；spread 決定這條帶落在輪廓的哪一側：
//   0   → 完全在輪廓內側（顏色止於輪廓，不外溢）
//   0.5 → 以輪廓為中心
//   1   → 完全在輪廓外側（先實心蓋到輪廓，再往外暈開）

// ctx.filter 在部分舊版行動 Safari 上不生效（設了也沒作用），所以實際畫一個
// 點來測，而不是看屬性存不存在
var blurFilterSupported = null;
function supportsCanvasBlur() {
    if (blurFilterSupported !== null) return blurFilterSupported;
    try {
        var c = document.createElement('canvas');
        c.width = 9; c.height = 9;
        var x = c.getContext('2d');
        if (typeof x.filter === 'undefined') { blurFilterSupported = false; return false; }
        x.filter = 'blur(2px)';
        x.fillStyle = '#fff';
        x.fillRect(4, 4, 1, 1);
        // 模糊真的生效的話，離那個點兩格遠的地方會沾到一點 alpha
        blurFilterSupported = x.getImageData(2, 4, 1, 1).data[3] > 0;
    } catch (e) {
        blurFilterSupported = false;
    }
    return blurFilterSupported;
}

function resetCtx(ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (typeof ctx.filter !== 'undefined') ctx.filter = 'none';
}

// 沒有 ctx.filter 時的備援：Kawase 模糊。每一趟把畫面往四個對角各取樣一次
// 取平均，取樣距離逐趟加大；三趟之後等效核心已經很接近高斯。關鍵是它算的是
// 「連續平均」而不是「疊 N 層固定透明度」，所以不會有舊版那種同心色帶。
var KAWASE_PASSES = 3;
function kawaseBlur(target, radiusPx, W, H) {
    var tmp = getScratchCanvas('soft-blur-tmp', W, H);
    var pair = [target, tmp];
    var totalWeight = KAWASE_PASSES * (KAWASE_PASSES + 1) / 2;
    for (var i = 0; i < KAWASE_PASSES; i++) {
        var src = pair[i % 2];
        var dst = pair[(i + 1) % 2];
        var d = Math.max(0.5, radiusPx * (i + 1) / totalWeight);
        var dctx = dst.getContext('2d');
        resetCtx(dctx);
        dctx.clearRect(0, 0, W, H);
        // 依序用 1, 1/2, 1/3, 1/4 的透明度疊四張，source-over 複合後
        // 剛好等於四張的等權平均
        var offsets = [[d, d], [-d, d], [d, -d], [-d, -d]];
        for (var k = 0; k < 4; k++) {
            dctx.globalAlpha = 1 / (k + 1);
            dctx.drawImage(src, offsets[k][0], offsets[k][1]);
        }
        dctx.globalAlpha = 1;
    }
    if (KAWASE_PASSES % 2 === 1) { // 奇數趟時結果留在 tmp，複製回 target
        var tctx = target.getContext('2d');
        resetCtx(tctx);
        tctx.globalCompositeOperation = 'copy';
        tctx.drawImage(tmp, 0, 0);
        tctx.globalCompositeOperation = 'source-over';
    }
}

function blurLayer(target, radiusPx, W, H) {
    if (radiusPx < 0.5) return;
    if (!supportsCanvasBlur()) { kawaseBlur(target, radiusPx, W, H); return; }

    var tmp = getScratchCanvas('soft-blur-tmp', W, H);
    var tctx = tmp.getContext('2d');
    resetCtx(tctx);
    tctx.clearRect(0, 0, W, H);
    // CSS blur(N) 的 N 是標準差，可見的漸層大約落在 ±2N，
    // 所以要得到 ±radiusPx 的羽化帶，半徑取一半
    tctx.filter = 'blur(' + (radiusPx / 2).toFixed(2) + 'px)';
    tctx.drawImage(target, 0, 0);
    tctx.filter = 'none';

    var gctx = target.getContext('2d');
    resetCtx(gctx);
    gctx.globalCompositeOperation = 'copy';
    gctx.drawImage(tmp, 0, 0);
    gctx.globalCompositeOperation = 'source-over';
}

// 畫一塊四面等寬羽化的色塊。圖層一律以 alpha=1 畫滿，整體濃度統一交給
// compositePixels 的 coverage / luma 控制，不再由這裡的 maxAlpha 分一半決定權。
function fillSoft(ctx, pts, W, H, rgb, featherPx, spread) {
    var shape = getScratchCanvas('soft-shape', W, H);
    var sctx = shape.getContext('2d');
    resetCtx(sctx);
    sctx.clearRect(0, 0, W, H);
    sctx.fillStyle = sctx.strokeStyle = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
    sctx.lineJoin = 'round';
    sctx.lineCap = 'round';

    tracePath(sctx, pts, W, H);
    sctx.fill();

    // 外擴／內縮：stroke 的一半寬度落在路徑內、一半落在路徑外。往外擴時
    // 內側早就填滿了，淨效果就是整體長大 offset；往內縮時改用 destination-out
    // 把邊緣沿法線削掉 offset。兩者都是四面等寬。
    var offset = (spread - 0.5) * 2 * featherPx;
    if (Math.abs(offset) > 0.25) {
        sctx.lineWidth = Math.abs(offset) * 2;
        if (offset < 0) sctx.globalCompositeOperation = 'destination-out';
        tracePath(sctx, pts, W, H);
        sctx.stroke();
        sctx.globalCompositeOperation = 'source-over';
    }

    blurLayer(shape, featherPx, W, H);
    ctx.drawImage(shape, 0, 0);
}

// 羽化寬度一律用「臉寬的比例」換算成像素，鏡頭遠近改變時暈染的視覺比例才一致
function faceWidthPx(lm, W) { return dist(lm[234], lm[454]) * W; }

// width  = 羽化帶半寬佔臉寬的比例
// spread = 帶子落在輪廓的哪一側（見上方 fillSoft 說明）
//
// 只剩底妝跟它的排除區在用：眼影/唇色本身改回最初版本的固定參數渲染
// （見 drawEye/drawLips 裡的 fillFeathered），不吃這張表。
var FEATHER = {
    base:     { width: 0.090, spread: 0.15 }, // 粉底：帶子偏內側，不溢到頭髮／背景
    eyeMask:  { width: 0.028, spread: 0.80 }, // 以下兩個是要從粉底挖掉的區域，
    browMask: { width: 0.026, spread: 1.00 }, // 一律往外蓋，確保完整遮住
    // 底妝排除唇部用的範圍：往外蓋一點點（留一點餘裕防 landmark 抖動），
    // 避免嘴唇周圍露出一圈底妝跟唇色都沒蓋到的原始膚色
    lipMask:  { width: 0.020, spread: 0.55 }
};

// 用上眼瞼的點往上位移，圍出一塊眼皮範圍（不含眼球開口）
function buildEyelidPolygon(lm, upperIdx) {
    var pts = upperIdx.map(function(i) { return lm[i]; });
    var eyeWidth = dist(pts[0], pts[pts.length - 1]);
    // 原本 0.45 常暈到眉骨；收到 0.32，範圍落在眼摺附近，比較貼近真實眼影上色區
    var lift = eyeWidth * 0.32;
    var topEdge = pts.map(function(p) { return { x: p.x, y: p.y - lift }; }).reverse();
    // 分開回傳睫毛線（pts）跟最上緣（topEdge），供漸層遮罩取兩端座標
    return { all: pts.concat(topEdge), lashY: pts[Math.floor(pts.length / 2)].y, topY: topEdge[Math.floor(topEdge.length / 2)].y };
}

// ---------- 本地膚色 / 臉型量化分析（不需呼叫任何雲端 API） ----------

function dist(p1, p2) { return Math.hypot(p1.x - p2.x, p1.y - p2.y); }

// sRGB -> CIE Lab，用來做比「肉眼 RGB 距離」更準的膚色比對
function rgbToLab(r, g, b) {
    function pivotRgb(n) { n /= 255; return n > 0.04045 ? Math.pow((n + 0.055) / 1.055, 2.4) : n / 12.92; }
    var rl = pivotRgb(r), gl = pivotRgb(g), bl = pivotRgb(b);
    var x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
    var y = (rl * 0.2126 + gl * 0.7152 + bl * 0.0722) / 1.0;
    var z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
    function pivotXyz(n) { return n > 0.008856 ? Math.pow(n, 1 / 3) : (7.787 * n) + (16 / 116); }
    var fx = pivotXyz(x), fy = pivotXyz(y), fz = pivotXyz(z);
    return { l: (116 * fy) - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function labDistance(a, b) { return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b); }

// 在額頭與左右臉頰各取一小塊像素平均，避開眼睛/嘴唇/髮際
function sampleSkinTone(lm, video) {
    var w = video.videoWidth, h = video.videoHeight;
    // 一次分析會連續取樣 6 幀，重複用同一張標了 willReadFrequently 的畫布，
    // 不要每次都新建一張全畫面 canvas
    var off = getReadbackCanvas('skin-sample', w, h);
    var ctx = off.getContext('2d');
    ctx.drawImage(video, 0, 0, w, h);
    var points = [151, 50, 280]; // 眉心上方、左臉頰、右臉頰
    var r = 0, g = 0, b = 0, n = 0;
    points.forEach(function(idx) {
        var pt = lm[idx];
        var x = Math.max(0, Math.round(pt.x * w) - 3);
        var y = Math.max(0, Math.round(pt.y * h) - 3);
        var data = ctx.getImageData(x, y, 6, 6).data;
        for (var i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
    });
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

function averageRgb(samples) {
    var sum = samples.reduce(function(a, s) { return { r: a.r + s.r, g: a.g + s.g, b: a.b + s.b }; }, { r: 0, g: 0, b: 0 });
    var n = samples.length;
    return { r: Math.round(sum.r / n), g: Math.round(sum.g / n), b: Math.round(sum.b / n) };
}

function mostFrequent(arr) {
    var counts = {}, best = arr[0], bestCount = 0;
    arr.forEach(function(v) { counts[v] = (counts[v] || 0) + 1; if (counts[v] > bestCount) { bestCount = counts[v]; best = v; } });
    return best;
}

function matchBaseColor(rgb) {
    var targetLab = rgbToLab(rgb.r, rgb.g, rgb.b);
    var best = baseColors[0], bestDist = Infinity;
    baseColors.forEach(function(bc) {
        var c = hexToRgb(bc.color);
        var d = labDistance(targetLab, rgbToLab(c.r, c.g, c.b));
        if (d < bestDist) { bestDist = d; best = bc; }
    });
    return best;
}

// 粗略估計冷暖調：Lab 的 a*(紅綠) / b*(黃藍) 比值，非醫療級精準判斷
function estimateUndertone(rgb) {
    var lab = rgbToLab(rgb.r, rgb.g, rgb.b);
    var ratio = lab.b !== 0 ? lab.a / lab.b : 0;
    if (ratio > 0.75) return '冷';
    if (ratio < 0.45) return '暖';
    return '中性';
}

// 唇色/眼影跟粉底不同：色彩理論數值只拿來「排除」明顯不搭的選項
// （色差大、冷暖調性衝突），不是拿來決定「最終最好看」的答案——
// 好不好看常帶有刻意的對比/氣色感，不是單純數值最小就最好。
// 這裡只負責排名，取分數最好的前幾名當候選，真正的最終選擇交給 Gemini。
//
// 分數 = Lab 色差（基礎） + undertone 方向懲罰項（候選色的 a*/b* 比值，
// 算法跟 estimateUndertone 一致，跟膚色的冷暖方向差越多分數越差）
var UNDERTONE_WEIGHT = 30;
// 留 3 名給 AI 挑：只留 2 名時 AI 幾乎沒有選擇空間。色號少於 3 個時 slice 自然只取到全部
var SHORTLIST_SIZE = 3;
function rankColorsByUndertone(rgb, undertone, candidates) {
    var targetLab = rgbToLab(rgb.r, rgb.g, rgb.b);
    var targetRatio = targetLab.b !== 0 ? targetLab.a / targetLab.b : 0;
    var scored = candidates.map(function(c) {
        var cRgb = hexToRgb(c.color);
        var cLab = rgbToLab(cRgb.r, cRgb.g, cRgb.b);
        var cRatio = cLab.b !== 0 ? cLab.a / cLab.b : 0;
        var colorDist = labDistance(targetLab, cLab);
        var undertonePenalty = Math.abs(cRatio - targetRatio) * UNDERTONE_WEIGHT;
        return { item: c, score: colorDist + undertonePenalty };
    });
    scored.sort(function(a, b) { return a.score - b.score; });
    return scored.map(function(s) { return s.item; });
}

// landmark 的 x 是除以畫面寬、y 是除以畫面高的正規化值，4:3 畫面上同樣長度
// 的垂直距離會被放大 4/3 倍（直式畫面則反過來）。直接拿正規化座標算長寬比，
// 臉長/臉寬會被高估到幾乎每個人都判成長形臉，所以一律先換回像素再量
function estimateFaceShape(lm, w, h) {
    function d(a, b) { return Math.hypot((a.x - b.x) * w, (a.y - b.y) * h); }
    var faceWidth      = d(lm[234], lm[454]);
    var faceLength     = d(lm[10],  lm[152]);
    var jawWidth        = d(lm[172], lm[397]);
    var foreheadWidth  = d(lm[54],  lm[284]);
    var lengthRatio    = faceLength / faceWidth;
    var jawRatio        = jawWidth / faceWidth;
    var foreheadRatio  = foreheadWidth / faceWidth;

    if (lengthRatio >= 1.5) return '長形臉';
    if (jawRatio > 0.9 && lengthRatio < 1.35) return '方形臉';
    if (foreheadRatio - jawRatio > 0.08) return '心形臉';
    if (jawRatio < 0.85 && lengthRatio >= 1.3) return '鵝蛋臉';
    return '圓形臉';
}

// 防止單一使用者（同一瀏覽器）重複亂按耗光 Gemini 免費額度；
// 存在 localStorage，只防君子不防小人（清瀏覽器資料就能繞過），
// 但這裡的目的是擋「不小心一直按」，不是防駭客，這樣就夠用
var MAX_ANALYSES_PER_USER = 8;
var ANALYSIS_COUNT_KEY = 'aiAnalysisCount';

function getAnalysisCount() {
    return parseInt(localStorage.getItem(ANALYSIS_COUNT_KEY) || '0', 10);
}

function incrementAnalysisCount() {
    var next = getAnalysisCount() + 1;
    localStorage.setItem(ANALYSIS_COUNT_KEY, String(next));
    return next;
}

var analyzeLabel = document.getElementById('ai-analyze-label');
function updateAnalyzeBtnRemaining() {
    var remaining = Math.max(0, MAX_ANALYSES_PER_USER - getAnalysisCount());
    analyzeBtn.title = remaining > 0 ? ('還可以體驗 ' + remaining + ' 次 AI 分析') : '本次體驗次數已用完';
    // 用完時直接把按鈕文字換掉：title 只有滑鼠停留才看得到，手機上根本看不到
    if (analyzeLabel) analyzeLabel.textContent = remaining > 0 ? 'AI 智慧分析推薦' : '體驗次數已用完';
}

async function performAIAnalysis() {
    if (!lastLandmarks) {
        aiPanel.classList.remove('hidden');
        expandAiDetail();
        aiSummaryText.innerText = "";
        aiText.innerText = "請先讓臉部完整進入畫面，再重試一次。";
        return;
    }
    if (getAnalysisCount() >= MAX_ANALYSES_PER_USER) {
        aiPanel.classList.remove('hidden');
        expandAiDetail();
        aiSummaryText.innerText = "";
        aiText.innerText = "本次體驗次數已用完，感謝您的參與！";
        return;
    }
    try {
        analyzeBtn.disabled = true;
        scanBar.style.display = 'block';
        aiPanel.classList.remove('hidden');
        expandAiDetail();
        aiSummaryText.innerText = "";
        aiText.innerText = "智慧分析推薦中，請稍候...";

        // 連續取樣多個影格再平均，避免自動曝光/白平衡或臉部微動造成單一瞬間誤判
        var skinSamples = [];
        var shapeSamples = [];
        for (var i = 0; i < 6; i++) {
            if (lastLandmarks) {
                skinSamples.push(sampleSkinTone(lastLandmarks, videoElement));
                shapeSamples.push(estimateFaceShape(lastLandmarks, videoElement.videoWidth, videoElement.videoHeight));
            }
            await new Promise(function(r) { setTimeout(r, 120); });
        }
        if (skinSamples.length === 0) throw new Error("偵測不到臉部，請重新對準鏡頭");

        var skinRgb     = averageRgb(skinSamples);
        var matchedBase = matchBaseColor(skinRgb);
        var undertone    = estimateUndertone(skinRgb);
        var faceShape    = mostFrequent(shapeSamples);

        // 本地公式先排除明顯不搭的選項，只留下分數最好的前 SHORTLIST_SIZE 名，
        // 「哪個看起來最有氣色感」的最終判斷交給 Gemini（見下方 fetch），
        // 候選第一名同時當作 Gemini 連不上時的本地備援
        var lipShortlist = rankColorsByUndertone(skinRgb, undertone, lipColors).slice(0, SHORTLIST_SIZE);
        var eyeShortlist = rankColorsByUndertone(skinRgb, undertone, eyeColors).slice(0, SHORTLIST_SIZE);
        var rLip = lipShortlist[0];
        var rEye = eyeShortlist[0];
        var rBase = matchedBase;

        var finalData = null;
        // 'offline'：連不上後端；'error'：後端有回應但失敗（例如 Gemini 額度用完 429→502）
        var backendState = 'offline';
        try {
            var response = await fetch(BACKEND_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    matchedBaseName: matchedBase.name,
                    lipCandidates: lipShortlist.map(function(l) { return { id: l.id, name: l.name, color: l.color }; }),
                    eyeCandidates: eyeShortlist.map(function(l) { return { id: l.id, name: l.name, color: l.color }; }),
                    undertone: undertone,
                    faceShape: faceShape
                })
            });
            backendState = 'error';
            if (response.ok) { finalData = await response.json(); }
            // 只有真的拿到 AI 回應才扣次數；後端 502/429 或連不上時改用本地備援，
            // 不該讓使用者為伺服器的問題付出體驗次數
            if (finalData && finalData.advice) {
                incrementAnalysisCount();
                updateAnalyzeBtnRemaining();
            }
        } catch (netErr) {
            finalData = null; // 後端未啟動或連不上，改用本地備援（排名第一名 + 預設文案）
        }

        // Gemini 的選擇必須落在本地已篩選過的候選名單內才採用，
        // 避免它憑空回傳一個不在候選裡的 id；驗證失敗就維持本地排名第一名
        if (finalData && finalData.recommended_lip_id) {
            var pickedLip = lipShortlist.find(function(l) { return l.id === finalData.recommended_lip_id; });
            if (pickedLip) rLip = pickedLip;
        }
        if (finalData && finalData.recommended_eye_id) {
            var pickedEye = eyeShortlist.find(function(l) { return l.id === finalData.recommended_eye_id; });
            if (pickedEye) rEye = pickedEye;
        }

        activeLipColor = rLip;  activeLipId  = rLip.id;
        activeEyeColor = rEye;  activeEyeId  = rEye.id;
        activeBaseColor = rBase; activeBaseId = rBase.id;
        refreshAllSwatches();

        var advice = (finalData && finalData.advice)
            ? finalData.advice
            : "已根據您的膚色與臉型比例，為您配對最接近的色號" + (backendState === 'error'
                ? "（AI 服務暫時忙碌，目前為本機建議，未扣除體驗次數，請稍後再試）。"
                : "（目前為離線建議，AI 文案伺服器未連線，未扣除體驗次數）。");

        aiSummaryText.innerText = "膚色：" + matchedBase.name + "（" + undertone + "調） | " + faceShape;
        aiText.innerHTML = advice + "<br><span style='color:#1a1a1a;font-weight:700'>唇：" + rLip.name + " / 眼：" + rEye.name + " / 底：" + rBase.name + "</span>";

        undertoneLabel.textContent = undertone + '調 · ' + matchedBase.name;
        undertoneBadge.classList.remove('hidden');
        undertoneBadge.classList.add('flex');
    } catch(error) {
        aiSummaryText.innerText = "";
        aiText.innerText = "分析失敗：" + error.message;
    } finally {
        scanBar.style.display = 'none';
        analyzeBtn.disabled = getAnalysisCount() >= MAX_ANALYSES_PER_USER;
    }
}

analyzeBtn.addEventListener('click', performAIAnalysis);
updateAnalyzeBtnRemaining();
analyzeBtn.disabled = getAnalysisCount() >= MAX_ANALYSES_PER_USER;

function setLipColor(item)  { if (activeLipId  === item.id) { activeLipColor  = null; activeLipId  = null; } else { activeLipColor  = item; activeLipId  = item.id; } refreshAllSwatches(); }
function setEyeColor(item)  { if (activeEyeId  === item.id) { activeEyeColor  = null; activeEyeId  = null; } else { activeEyeColor  = item; activeEyeId  = item.id; } refreshAllSwatches(); }
function setBaseColor(item) { if (activeBaseId === item.id) { activeBaseColor = null; activeBaseId = null; } else { activeBaseColor = item; activeBaseId = item.id; } refreshAllSwatches(); }

function refreshAllSwatches() {
    document.querySelectorAll('.lip-swatch').forEach(function(el){  el.classList.toggle('active', el.dataset.id === activeLipId);  });
    document.querySelectorAll('.eye-swatch').forEach(function(el){  el.classList.toggle('active', el.dataset.id === activeEyeId);  });
    document.querySelectorAll('.base-swatch').forEach(function(el){ el.classList.toggle('active', el.dataset.id === activeBaseId); });
}

// 色號資料可能來自外部設定（AI_MAKEUP_CONFIG），一律用 textContent 放文字、不拼 innerHTML
function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

// ---------- 關鍵點時間軸平滑（One Euro Filter） ----------
// 用簡單移動平均會在快速轉頭時有明顯延遲；One Euro Filter 會依「移動速度」自動調整平滑程度：
// 靜止不動時濾掉偵測雜訊（不跳動），移動快時自動降低平滑、減少延遲（不會拖影）。
// 每個關鍵點的 x、y 各自維護一個濾波器狀態，468 點只需 O(1) 運算，即時視訊跑起來負擔可忽略。
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

var landmarkFilterX = [];
var landmarkFilterY = [];
function smoothLandmarks(rawLm) {
    var t = performance.now();
    var out = new Array(rawLm.length);
    for (var i = 0; i < rawLm.length; i++) {
        if (!landmarkFilterX[i]) {
            // mincutoff 越小越穩定但延遲越高；beta 越大，快速移動時反應越快。
            // 座標是正規化到 0~1 的比例值，原本 mincutoff=1.0 在臉部靜止時
            // 濾波截止頻率偏高、雜訊濾不乾淨，妝容會有肉眼可見的細微晃動；
            // 同時 beta=0.3 在這個座標尺度下對速度變化太不敏感，快速轉頭時
            // 幾乎沒有額外反應。改成 mincutoff=0.4（靜止時更穩）+ beta=4.0
            // （轉頭時更快跟上，避免拖影延遲）
            landmarkFilterX[i] = createOneEuroFilter(0.4, 4.0, 1.0);
            landmarkFilterY[i] = createOneEuroFilter(0.4, 4.0, 1.0);
        }
        out[i] = { x: landmarkFilterX[i](rawLm[i].x, t), y: landmarkFilterY[i](rawLm[i].y, t) };
    }
    return out;
}

function onResults(results) {
    if (loadingOverlay.style.opacity !== '0') {
        loadingOverlay.style.opacity = '0';
        setTimeout(function(){ loadingOverlay.style.display = 'none'; }, 500);
    }
    if (videoElement.videoWidth > 0) {
        // 內部繪製解析度取當前的效能檔位；比鏡頭原生解析度高就不放大
        var maxWidth = RENDER_TIERS[renderTier];
        var renderScale = videoElement.videoWidth > maxWidth ? maxWidth / videoElement.videoWidth : 1;
        var targetCanvasW = Math.round(videoElement.videoWidth  * renderScale);
        var targetCanvasH = Math.round(videoElement.videoHeight * renderScale);
        if (canvasElement.width !== targetCanvasW || canvasElement.height !== targetCanvasH) {
            canvasElement.width  = targetCanvasW;
            canvasElement.height = targetCanvasH;
        }
    }
    var W = canvasElement.width;
    var H = canvasElement.height;
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, W, H);
    // 鏡頭畫面跟妝容都畫在同一個 canvas、同一套座標系裡（鏡像只在這裡做一次），
    // 不再讓 <video> 跟 <canvas> 兩個獨立 DOM 元素各自套 CSS object-fit + 鏡像，
    // 期待瀏覽器兩邊裁切結果剛好一致——這種雙元素對齊在手機瀏覽器上很容易出現
    // 零點幾秒的裁切/尺寸判斷落差，妝容看起來就會「飄」在臉旁邊或眉毛上方。
    if (videoElement.videoWidth > 0) {
        canvasCtx.translate(W, 0);
        canvasCtx.scale(-1, 1);
        canvasCtx.drawImage(videoElement, 0, 0, W, H);
        canvasCtx.setTransform(1, 0, 0, 1, 0, 0);
    }
    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        // 每幀單獨偵測的關鍵點本身帶有雜訊，直接拿來畫會讓妝容跟著雜訊「浮動」。
        // 先做時間軸平滑再用來畫圖跟做膚色/臉型分析。
        lastLandmarks = smoothLandmarks(results.multiFaceLandmarks[0]);
    } else {
        // 臉離開畫面就清掉：否則 AI 分析會拿最後一幀的舊臉來算；
        // 濾波器狀態也重設，臉重新出現時才不會從舊位置「滑」過去
        lastLandmarks = null;
        landmarkFilterX = [];
        landmarkFilterY = [];
    }
    if (lastLandmarks) {
        if (showMakeup) {
            var lm = lastLandmarks;
            // 妝容跟鏡頭影像共用同一個鏡像矩陣，疊回主畫布前才切回鏡像座標系。
            // 底妝走逐像素合成（皮膚跟其他部位色差夠大，判斷得準）；眼影/唇色
            // 改回幾何遮罩＋canvas 混合模式（見 drawEye/drawLips 的說明），
            // 順序維持 底妝 -> 眼影 -> 唇色，後畫的疊在先畫的上面
            canvasCtx.save();
            canvasCtx.translate(W, 0);
            canvasCtx.scale(-1, 1);
            if (activeBaseColor) {
                var t0 = performance.now();
                compositeMakeup(lm, W, H, activeBaseColor);
                noteCompositeCost(performance.now() - t0);
            }
            if (activeEyeColor) drawEye(lm, W, H, activeEyeColor);
            if (activeLipColor) drawLips(lm, W, H, activeLipColor);
            canvasCtx.restore();
        }
    }
    canvasCtx.restore();
}

// ---------- 妝容合成核心 ----------
//
// 這一段從「canvas 內建混合模式」改成「逐像素自己算」，一次解決兩件事：
//
// (一) 線性光空間
//   Canvas 的 alpha 混合與 blend mode 全部在 gamma 編碼過的 sRGB 數值上做算術，
//   但真實的光是線性相加的。在 sRGB 空間插值出來的中間色會偏暗偏濁，紅色系
//   最明顯——正紅唇會呈現「髒紅／土紅」而不是乾淨的紅。IG/抖音的 shader 在
//   線性空間混色，這裡改成一樣。順帶連 luminance 的定義也修正了：CSS 的
//   'color'/'luminosity' 用 0.3/0.59/0.11 且算在非線性值上，物理正確的是
//   線性光上的 Rec.709 0.2126/0.7152/0.0722。
//
// (二) 像素級遮罩
//   舊版的遮罩是 468 個 landmark 連成的多邊形，跟真實唇線恆有 1-3px 誤差，
//   加上 landmark 抖動，色塊會週期性溢出到唇外皮膚——這是「一眼看出是貼上去」
//   的主要來源。IG/抖音用神經網路做 per-pixel 分割；這裡不下載額外模型，改用
//   影像本身的證據：每幀從額頭/雙頰取膚色參考、從唇心取唇色參考，再對每個像素
//   做一次二類判別（離哪一個參考近）。多邊形退居「大致範圍」，真正的邊界由
//   像素顏色決定，所以會自動貼齊真實唇線，也自動避開頭髮、眉毛、鼻孔、眼睛。
//
// 逐像素只跑臉的 bounding box（約 4 萬像素），不是整張畫面。實測 kernel 本身
// 在 640x480 下 <1ms、960x720 下約 2ms。

// sRGB <-> 線性光。用查表避開每像素三次 Math.pow。
var SRGB_TO_LINEAR = new Float32Array(256);
for (var _i = 0; _i < 256; _i++) {
    var _n = _i / 255;
    SRGB_TO_LINEAR[_i] = _n > 0.04045 ? Math.pow((_n + 0.055) / 1.055, 2.4) : _n / 12.92;
}
// 反向表用 4096 階：最暗那一階換算回 sRGB 也只有 0.8/255，精度足夠
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

// ---------- 環境光適應 ----------
//
// 妝容色是固定的 hex，但顏料本身不發光——它反射的是現場的光。在昏暗環境裡
// 直接畫上飽和的正紅，會像貼了一張自己會亮的貼紙浮在臉上。這裡用「這個人此刻
// 皮膚的亮度」當作現場光的估計，把妝容色的亮度按比例縮放。
//
// 相機的自動曝光已經補償掉一部分，所以這一項主要修正的是自動曝光失效的場景
//（逆光、極暗、強光直射）——而那些正好就是妝容看起來最假的時候。
// 比例要在線性光上算才有物理意義（sRGB 是 gamma 編碼過的，直接相除沒有意義）。
var NEUTRAL_SKIN_Y = 170;                        // 光線正常時中等膚色大約的畫面亮度
var EXPOSURE_MIN = 0.55, EXPOSURE_MAX = 1.35;    // 夾住範圍，避免極端光線下失控
// 完全按線性光比例縮放（指數 1.0）反應過猛：gamma 2.4 讓稍暗的環境就算出
// 0.28 倍，妝容會直接消失。這裡不是在做物理模擬，只是要讓妝容「看起來待在
// 同一個光線裡」，所以壓一個 0.45 次方讓反應平緩，正常光線範圍內才不會整段
// 都黏在夾限上、變成一個常數。
var EXPOSURE_RESPONSE = 0.45;
function exposureFrom(skinY) {
    var i = skinY < 0 ? 0 : (skinY > 255 ? 255 : Math.round(skinY));
    var ratio = SRGB_TO_LINEAR[i] / SRGB_TO_LINEAR[NEUTRAL_SKIN_Y];
    var e = Math.pow(ratio, EXPOSURE_RESPONSE);
    return e < EXPOSURE_MIN ? EXPOSURE_MIN : (e > EXPOSURE_MAX ? EXPOSURE_MAX : e);
}

// 妝容色轉成 kernel 用的線性光參數
function makeupParamsOf(item, finish, exposure) {
    var rgb = hexToRgb(item.color);
    var e = exposure || 1;
    var r = SRGB_TO_LINEAR[rgb.r] * e, g = SRGB_TO_LINEAR[rgb.g] * e, b = SRGB_TO_LINEAR[rgb.b] * e;
    return {
        r: r, g: g, b: b,
        L: Math.max(1e-4, relLuminance(r, g, b)),
        coverage: finish.coverage,
        luma: finish.luma,
        gloss: finish.gloss || 0
    };
}

// ---------- 幾何權重圖 ----------
//
// 只有底妝走逐像素這條路（眼影/唇色見下面的 drawEye/drawLips）。權重圖
// 只需要一個通道，仍用 RGB 畫布儲存（R 通道當權重，G/B 保持 0），沿用
// 既有的 getReadbackCanvas 機制。底圖先填不透明黑，通道值就等於
// 255 x 羽化後的 alpha，也不會被 premultiplied alpha 的往返損失精度。
var W_BASE = { r: 255, g: 0, b: 0 };

// 會被 getImageData 讀回的畫布要標 willReadFrequently，瀏覽器才會把它留在
// CPU 記憶體。同一張 canvas 第二次 getContext 拿到的是同一個 context、選項
// 不會再套用，所以必須在剛建立時就指定。
function getReadbackCanvas(key, W, H) {
    var c = scratchCanvases[key];
    var fresh = !c;
    if (fresh) { c = document.createElement('canvas'); scratchCanvases[key] = c; }
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    if (fresh) {
        try { c.getContext('2d', { willReadFrequently: true }); }
        catch (e) { c.getContext('2d'); }
    }
    return c;
}

// pts 是 landmark 的原始 0~1 正規化座標（相對整個畫面）。tracePath/fillSoft
// 會把座標乘上傳進去的畫布寬高，所以只要把座標換算成「相對 bbox 的 0~1」，
// 再把 bbox 的寬高當成畫布寬高傳進去，就能讓同一套函式在 bbox-local 座標系
// 裡工作，不用改 tracePath 本身。
function toLocalPts(pts, b, W, H) {
    return pts.map(function(p) {
        return { x: (p.x * W - b.x) / b.w, y: (p.y * H - b.y) / b.h };
    });
}

// 底妝走這條逐像素路徑：皮膚跟頭髮/眉毛/眼睛/嘴唇的顏色差異夠大，逐像素
// 判斷得很準，值得為此多付一點運算成本。眼影/唇色改回幾何遮罩＋canvas
// 混合模式（見下面的 drawEye/drawLips）——原因見那邊的說明。
//
// 這裡的離屏畫布只在 faceBounds() 算出的包圍盒內操作，不是整張畫面，
// 避免每一幀都在跟臉部大小無關的空白區域上白工。
function buildWeightMap(lm, W, H, b, fw, baseItem) {
    var packed = getReadbackCanvas('weight-map', b.w, b.h);
    var pctx = packed.getContext('2d');
    resetCtx(pctx);
    pctx.fillStyle = '#000';
    pctx.fillRect(0, 0, b.w, b.h);

    if (baseItem) {
        var faceLayer = getScratchCanvas('base-face', b.w, b.h);
        var faceCtx = faceLayer.getContext('2d');
        resetCtx(faceCtx);
        faceCtx.clearRect(0, 0, b.w, b.h);
        fillSoft(faceCtx, toLocalPts(FACE_OVAL.map(function(i){ return lm[i]; }), b, W, H), b.w, b.h, W_BASE,
                 fw * FEATHER.base.width, FEATHER.base.spread);

        // 幾何排除區。逐像素的膚色判別其實已經會擋掉眼睛/眉毛/嘴唇，但那是
        // 「軟」的判斷，遇到反光的眼白或很淡的眉毛可能漏掉；這幾塊是硬保證。
        //
        // 眼睛跟眉毛/嘴唇分兩個遮罩、兩種強度：眼球（鞏膜/虹膜）無論如何都不能
        // 被上妝，維持 100% 硬挖空；眉毛/嘴唇則只挖到剩 EXCLUSION_STRENGTH——
        // 真實化妝手法裡粉底本來就會薄薄蓋過眉毛跟嘴唇一層，才在上面疊眼影/唇膏，
        // 不是完全跳過不上妝。留一點底妝效果，能讓挖空區跟旁邊被大幅中性化的皮膚
        // 之間的交界不再是「有/無」的硬切，減少看起來像挖了一個洞的觀感（原始
        // 像素跟中性化後的膚色色差在手機鏡頭上特別明顯）
        var eyeMask = getScratchCanvas('base-exclusion-eye', b.w, b.h);
        var eyeMaskCtx = eyeMask.getContext('2d');
        resetCtx(eyeMaskCtx);
        eyeMaskCtx.clearRect(0, 0, b.w, b.h);
        var maskRgb = { r: 255, g: 255, b: 255 };
        [LEFT_EYE_REGION, RIGHT_EYE_REGION].forEach(function(region) {
            fillSoft(eyeMaskCtx, toLocalPts(region.map(function(i){ return lm[i]; }), b, W, H), b.w, b.h, maskRgb,
                     fw * FEATHER.eyeMask.width, FEATHER.eyeMask.spread);
        });
        faceCtx.save();
        faceCtx.globalCompositeOperation = 'destination-out';
        faceCtx.drawImage(eyeMask, 0, 0);
        faceCtx.restore();

        var softMask = getScratchCanvas('base-exclusion-soft', b.w, b.h);
        var softMaskCtx = softMask.getContext('2d');
        resetCtx(softMaskCtx);
        softMaskCtx.clearRect(0, 0, b.w, b.h);
        [LEFT_EYEBROW, RIGHT_EYEBROW].forEach(function(region) {
            fillSoft(softMaskCtx, toLocalPts(region.map(function(i){ return lm[i]; }), b, W, H), b.w, b.h, maskRgb,
                     fw * FEATHER.browMask.width, FEATHER.browMask.spread);
        });
        fillSoft(softMaskCtx, toLocalPts(LIP_OUTLINE.map(function(i){ return lm[i]; }), b, W, H), b.w, b.h, maskRgb,
                 fw * FEATHER.lipMask.width, FEATHER.lipMask.spread);

        var EXCLUSION_STRENGTH = 0.65;
        faceCtx.save();
        faceCtx.globalCompositeOperation = 'destination-out';
        faceCtx.globalAlpha = EXCLUSION_STRENGTH;
        faceCtx.drawImage(softMask, 0, 0);
        faceCtx.restore();

        pctx.globalCompositeOperation = 'lighter';
        pctx.drawImage(faceLayer, 0, 0);
    }

    pctx.globalCompositeOperation = 'source-over';
    return packed;
}

// 逐像素只跑臉的 bounding box，這是讓 CPU 方案可行的關鍵。
// 邊界要留出羽化往外暈開的餘裕，否則會把漸層切掉一條硬邊。
//
// 寬高量化到 32px 網格：臉部平滑移動時，量出來的 bbox 每幀都會有一兩像素的
// 抖動。若讓離屏畫布尺寸原封不動跟著 bbox 走，canvas.width/height 的 setter
// 只要數值一變就會整個重新配置底層記憶體（不是簡單的縮放），等於每幀都在
// 重新配置一整批畫布——這件事本身就不便宜，尤其在手機 GPU 上。量化後同一個
// 網格內的抖動不會觸發重新配置，畫布只在臉部明顯移動、跨過網格邊界時才重建。
var BBOX_GRID = 32;
function faceBounds(lm, W, H, fw) {
    var minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (var i = 0; i < FACE_OVAL.length; i++) {
        var p = lm[FACE_OVAL[i]];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    var pad = fw * FEATHER.base.width * 2 + 4;
    var x0 = Math.max(0, Math.floor(minX * W - pad));
    var y0 = Math.max(0, Math.floor(minY * H - pad));
    var x1 = Math.min(W, Math.ceil(maxX * W + pad));
    var y1 = Math.min(H, Math.ceil(maxY * H + pad));
    var w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    var qw = Math.min(W - x0, Math.ceil(w / BBOX_GRID) * BBOX_GRID);
    var qh = Math.min(H - y0, Math.ceil(h / BBOX_GRID) * BBOX_GRID);
    return { x: x0, y: y0, w: Math.max(1, qw), h: Math.max(1, qh) };
}

// ---------- 影像證據：底妝的膚色參考 ----------
//
// 用固定的膚色範圍在不同人種、不同光線下都會失準，所以每幀從影像本身取參考值。
// 這些像素在 bbox 裡已經讀回來了，不用另外再 getImageData。
var SKIN_REF_POINTS = [151, 50, 280];              // 眉心上方、左右臉頰

// 取樣點會有一部分不可靠：額頭那一點遇到瀏海就取到頭髮，唇心那幾點在嘴巴
// 微張時可能取到牙齒或口腔。直接全部平均的話，一個壞掉的取樣點就會把整個
// 參考值拉歪，連帶讓整張臉的分割失效。所以先個別算出每個取樣點的平均，
// 再用中位數亮度剔除離群點，最後只平均留下來的。
var REF_OUTLIER_TOL = 0.28;   // 亮度偏離中位數超過這個比例就視為離群

function sampleRef(data, bx, by, bw, bh, W, H, points) {
    var samples = [];
    for (var k = 0; k < points.length; k++) {
        var cx = Math.round(points[k].x * W - bx);
        var cy = Math.round(points[k].y * H - by);
        var sy = 0, scb = 0, scr = 0, n = 0;
        for (var dy = -2; dy <= 2; dy++) {
            var y = cy + dy;
            if (y < 0 || y >= bh) continue;
            for (var dx = -2; dx <= 2; dx++) {
                var x = cx + dx;
                if (x < 0 || x >= bw) continue;
                var o = (y * bw + x) << 2;
                var r = data[o], g = data[o + 1], b = data[o + 2];
                sy  += 0.299 * r + 0.587 * g + 0.114 * b;
                scb += -0.169 * r - 0.331 * g + 0.500 * b;
                scr += 0.500 * r - 0.419 * g - 0.081 * b;
                n++;
            }
        }
        if (n > 0) samples.push({ y: sy / n, cb: scb / n, cr: scr / n });
    }
    if (samples.length === 0) return null;
    if (samples.length < 3) return samples[0];

    var sorted = samples.slice().sort(function(a, b) { return a.y - b.y; });
    var medY = sorted.length % 2
        ? sorted[(sorted.length - 1) / 2].y
        : (sorted[sorted.length / 2 - 1].y + sorted[sorted.length / 2].y) / 2;
    var tol = Math.max(18, medY * REF_OUTLIER_TOL);

    var ay = 0, acb = 0, acr = 0, kept = 0;
    for (var i = 0; i < samples.length; i++) {
        if (Math.abs(samples[i].y - medY) > tol) continue;
        ay += samples[i].y; acb += samples[i].cb; acr += samples[i].cr; kept++;
    }
    if (kept === 0) return sorted[(sorted.length / 2) | 0]; // 全被剔除就退回中位數那一點
    return { y: ay / kept, cb: acb / kept, cr: acr / kept };
}

// 色度平面上「離膚色參考多遠就完全不算皮膚」。放寬一點，寧可多上一點妝
// 也不要在臉頰陰影處出現破洞
var SKIN_CHROMA_TOL = 38;
// 比參考膚色暗到這個比例以下的一律不算皮膚（頭髮、眉毛、瞳孔、鼻孔、眼線）
var SKIN_DARK_CUT = 0.55, SKIN_DARK_FULL = 0.82;
// 比參考膚色亮到這個比例以上：反光/過曝的皮膚高光（額頭、鼻樑常見，手機鏡頭
// 尤其明顯）。這種像素的色度會被沖淡趨近白色，色度距離測試會誤判成「不是皮膚」
// 而整塊跳過上妝，在額頭上開一個亮斑形狀的洞。這裡改用亮度直接判定：夠亮就
// 不管色度測試的結果，直接當皮膚處理
var SKIN_BRIGHT_RAMP = 1.25, SKIN_BRIGHT_FULL = 1.7;

// ---------- kernel ----------
//
// 只處理底妝（眼影/唇色改回幾何遮罩＋canvas 混合模式，見 drawEye/drawLips）。
// 合成公式（全程線性光）：
//   Lf   = Ls + (L妝 - Ls) * luma·w          目標亮度
//   out  = mix(原像素縮放到 Lf, 妝容色縮放到 Lf, coverage·w)
// 前半決定「顯色度」，後半決定「彩度覆蓋」，而 (1-luma) 就是保留下來的
// 原始皮膚光影細節——調 luma 不會把臉壓成一片死板色塊。
function compositePixels(src, wmap, n, skinRef, mkBase) {
    var invSkinTol = 1 / SKIN_CHROMA_TOL;
    var invDarkRamp = 1 / (SKIN_DARK_FULL - SKIN_DARK_CUT);
    var invBrightRamp = 1 / (SKIN_BRIGHT_FULL - SKIN_BRIGHT_RAMP);
    var refY = Math.max(1, skinRef.y);

    for (var i = 0; i < n; i++) {
        var o = i << 2;
        var wB = wmap[o];
        if (wB === 0) continue;

        var sr = src[o], sg = src[o + 1], sb = src[o + 2];
        var lr = SRGB_TO_LINEAR[sr], lg = SRGB_TO_LINEAR[sg], lb = SRGB_TO_LINEAR[sb];
        var Ls = relLuminance(lr, lg, lb);

        var yv = 0.299 * sr + 0.587 * sg + 0.114 * sb;
        var cb = -0.169 * sr - 0.331 * sg + 0.500 * sb;
        var cr = 0.500 * sr - 0.419 * sg - 0.081 * sb;

        // 膚色 likelihood：色度距離 + 亮度閘
        var dcb = cb - skinRef.cb, dcr = cr - skinRef.cr;
        var skin = 1 - Math.sqrt(dcb * dcb + dcr * dcr) * invSkinTol;
        if (skin < 0) skin = 0; else if (skin > 1) skin = 1;
        var yr = yv / refY;
        if (yr < SKIN_DARK_CUT) skin = 0;
        else if (yr < SKIN_DARK_FULL) skin *= (yr - SKIN_DARK_CUT) * invDarkRamp;
        else if (yr > SKIN_BRIGHT_RAMP) {
            var brightT = yr >= SKIN_BRIGHT_FULL ? 1 : (yr - SKIN_BRIGHT_RAMP) * invBrightRamp;
            skin = skin + (1 - skin) * brightT;
        }

        var w = (wB * 0.00392156862745098) * skin;
        if (w > 0.002) {
            var Lf = Ls + (mkBase.L - Ls) * mkBase.luma * w;
            var kS = Ls > 1e-4 ? Lf / Ls : 0;
            var kM = Lf / mkBase.L;
            var c = mkBase.coverage * w;
            lr += (mkBase.r * kM - lr * kS) * c + lr * (kS - 1);
            lg += (mkBase.g * kM - lg * kS) * c + lg * (kS - 1);
            lb += (mkBase.b * kM - lb * kS) * c + lb * (kS - 1);
            src[o] = linearToSrgb(lr);
            src[o + 1] = linearToSrgb(lg);
            src[o + 2] = linearToSrgb(lb);
        }
    }
}

// 只處理底妝。眼影/唇色改回幾何遮罩＋canvas 混合模式，見下面的 drawEye/drawLips。
function compositeMakeup(lm, W, H, baseItem) {
    if (!baseItem) return;
    if (!videoElement.videoWidth) return;

    var fw = faceWidthPx(lm, W);
    if (!(fw > 1)) return;
    var b = faceBounds(lm, W, H, fw);

    // landmark 算在「未鏡像」的原始影格上，權重圖也畫在同一個座標系，
    // 所以這裡不鏡像；鏡像統一在 onResults 疊回主畫布時做一次
    var srcCanvas = getReadbackCanvas('src-frame', W, H);
    var sctx = srcCanvas.getContext('2d');
    resetCtx(sctx);
    sctx.drawImage(videoElement, 0, 0, W, H);

    var packed = buildWeightMap(lm, W, H, b, fw, baseItem);

    var srcData = sctx.getImageData(b.x, b.y, b.w, b.h);
    var wData = packed.getContext('2d').getImageData(0, 0, b.w, b.h);

    var skinRef = sampleRef(srcData.data, b.x, b.y, b.w, b.h, W, H,
                            SKIN_REF_POINTS.map(function(i){ return lm[i]; }));
    if (!skinRef) return;

    var exposure = exposureFrom(skinRef.y);
    // 濃淡倍率同時放大覆蓋率跟顯色度，夾在 1 以內（超過 1 公式會過衝）
    var finish = baseFinishOf(baseItem.subtitle);
    var k = intensity.base;
    var scaledFinish = {
        coverage: Math.min(1, finish.coverage * k),
        luma: Math.min(1, finish.luma * k),
        glow: finish.glow
    };
    compositePixels(
        srcData.data, wData.data, b.w * b.h, skinRef,
        makeupParamsOf(baseItem, scaledFinish, exposure)
    );

    // 合成結果貼回主畫布。putImageData 不吃 transform，所以先放進離屏畫布，
    // 再用 drawImage 走 onResults 那層鏡像矩陣疊上去。這張畫布跟 bbox 同尺寸
    // （bbox 已經量化到網格，臉部平滑移動時大多數幀不會觸發重新配置）。
    var outCanvas = getScratchCanvas('composited', b.w, b.h);
    var octx = outCanvas.getContext('2d');
    resetCtx(octx);
    octx.putImageData(srcData, 0, 0);
    canvasCtx.drawImage(outCanvas, 0, 0, b.w, b.h, b.x, b.y, b.w, b.h);
}

// ---------- 眼影 / 唇色：改回最初版本的渲染方式 ----------
//
// 底妝維持現在這套逐像素合成（皮膚跟其他部位色差夠大，判斷得準，效果最好）。
// 眼影和唇色則改回本次改動之前、最初的做法：純幾何遮罩（不判斷像素顏色）
// 搭配「往重心縮放疊層」羽化，直接用 canvas 混合模式畫上去，不套質感/
// 高光系統。

// 原本靠 ctx.filter 的 CSS blur 做羽化；實測在部分行動瀏覽器上不管把模糊
// 半徑調多大都完全沒有效果（filter 沒有真的生效），導致邊緣一直是硬的。
// 改成完全不依賴 filter 的做法：把同一個形狀往「重心」方向一圈一圈縮小，
// 疊很多層（steps 層），每一層都用同一個很低的透明度。疊圖時透明度會自然
// 複合——最外圈只被 1 層蓋到，幾乎看不見；越靠中心被越多層蓋到，濃度越高，
// 疊出平滑的漸層。純粹是圖形合成的數學（source-over alpha 疊加），
// 不管瀏覽器支不支援模糊濾鏡都保證會生效。
//
// featherRatio 控制縮小的範圍（0~1，例如 0.4 代表最內圈縮到只剩 60% 大小，
// 範圍越大羽化帶越寬）；maxAlpha 是疊滿 steps 層後、正中心逼近的總透明度。
function fillFeathered(ctx, pts, W, H, rgb, maxAlpha, featherRatio, steps) {
    steps = steps || 16;
    var cx = 0, cy = 0;
    pts.forEach(function(p) { cx += p.x; cy += p.y; });
    cx /= pts.length; cy /= pts.length;

    // 疊 steps 層、每層透明度 a 之後，中心的複合透明度 = 1-(1-a)^steps，
    // 反推出每層要用的 a 才能讓最終正好逼近 maxAlpha
    var a = 1 - Math.pow(1 - maxAlpha, 1 / steps);

    ctx.save();
    ctx.fillStyle = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
    ctx.globalAlpha = a;
    for (var i = 0; i < steps; i++) {
        var k = i / (steps - 1); // 0：最外圈（原尺寸）→ 1：最內圈（縮最多）
        var scale = 1 - featherRatio * k;
        var scaledPts = pts.map(function(p) {
            return { x: cx + (p.x - cx) * scale, y: cy + (p.y - cy) * scale };
        });
        tracePath(ctx, scaledPts, W, H);
        ctx.fill();
    }
    ctx.restore();
}

// 眼影範圍改用「上眼瞼往上長出一塊」的多邊形，蓋的是眼皮而不是整個眼睛開口
function drawEye(lm, W, H, item) {
    var rgb = hexToRgb(item.color);
    var regions = [
        buildEyelidPolygon(lm, LEFT_UPPER_LID),
        buildEyelidPolygon(lm, RIGHT_UPPER_LID)
    ];
    regions.forEach(function(region, idx) {
        var layer = getScratchCanvas('eye-layer-' + idx, W, H);
        var layerCtx = layer.getContext('2d');
        layerCtx.clearRect(0, 0, W, H);
        fillFeathered(layerCtx, region.all, W, H, rgb, 0.85, 0.45, 16);

        // 光靠模糊只有色塊「邊緣」會變淡，中心到邊緣之間仍是均勻濃度，
        // 大範圍時看起來像一整塊平塗的色塊。這裡疊一個縱向漸層遮罩（destination-in），
        // 讓濃度從睫毛根部往上自然遞減到透明，比較像真實眼影暈染的手法而不是色塊+模糊邊
        var grad = layerCtx.createLinearGradient(0, region.lashY * H, 0, region.topY * H);
        grad.addColorStop(0, 'rgba(0,0,0,1)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        layerCtx.save();
        layerCtx.globalCompositeOperation = 'destination-in';
        layerCtx.fillStyle = grad;
        layerCtx.fillRect(0, 0, W, H);
        layerCtx.restore();

        // 'color' 是主要機制（保留眼窩原本明暗），中心透明度抓在 45% 上下、
        // 靠漸層遮罩+模糊自然退到 0%；'overlay' 疊一點點加強眼摺/眼尾的立體深淺
        // （用 overlay 而不是 color-burn，是因為 color-burn 疊加彩色底之後很容易死黑糊成一團）
        canvasCtx.save();
        canvasCtx.globalCompositeOperation = 'color';
        canvasCtx.globalAlpha = Math.min(1, 0.45 * intensity.eye);
        canvasCtx.drawImage(layer, 0, 0);
        canvasCtx.globalCompositeOperation = 'overlay';
        canvasCtx.globalAlpha = Math.min(1, 0.15 * intensity.eye);
        canvasCtx.drawImage(layer, 0, 0);
        canvasCtx.restore();
    });
}

function drawLips(lm, W, H, item) {
    var rgb = hexToRgb(item.color);
    var parts = [
        UPPER_LIP.map(function(i){ return lm[i]; }),
        LOWER_LIP.map(function(i){ return lm[i]; })
    ];
    parts.forEach(function(pts, idx) {
        var layer = getScratchCanvas('lip-layer-' + idx, W, H);
        var layerCtx = layer.getContext('2d');
        layerCtx.clearRect(0, 0, W, H);
        fillFeathered(layerCtx, pts, W, H, rgb, 0.85, 0.35, 14);

        // 唇色需要比眼影更明顯，中心透明度抓在 72% 左右（落在 70-90% 區間，
        // 比原本 80% 略降一點搭配更寬的羽化），'multiply' 疊一點點加深唇縫/唇珠陰影，強化立體感
        canvasCtx.save();
        canvasCtx.globalCompositeOperation = 'color';
        canvasCtx.globalAlpha = Math.min(1, 0.72 * intensity.lip);
        canvasCtx.drawImage(layer, 0, 0);
        canvasCtx.globalCompositeOperation = 'multiply';
        canvasCtx.globalAlpha = Math.min(1, 0.15 * intensity.lip);
        canvasCtx.drawImage(layer, 0, 0);
        canvasCtx.restore();
    });
}

initBtn.addEventListener('click', async function() {
    try { await navigator.mediaDevices.getUserMedia({ video: true }); }
    catch(e) { alert('請允許瀏覽器存取鏡頭，並重新整理頁面'); return; }
    startScreen.style.opacity = '0';
    appContent.style.opacity  = '1';
    setTimeout(function(){ startScreen.style.display = 'none'; startCamera(); }, 700);
});

function startCamera() {
    var faceMesh = new FaceMesh({ locateFile: function(file){ return "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/" + file; } });
    faceMesh.setOptions({ refineLandmarks: true, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });
    faceMesh.onResults(onResults);
    var camera = new Camera(videoElement, {
        onFrame: async function(){ await faceMesh.send({ image: videoElement }); },
        width: 640, height: 480, facingMode: 'user'
    });
    camera.start();
}

var intensitySlider = document.getElementById('intensity-slider');
var intensityValue  = document.getElementById('intensity-value');
var intensityLabel  = document.getElementById('intensity-label');

function syncIntensityUI() {
    var pct = Math.round(intensity[currentMode] * 100);
    intensitySlider.value = pct;
    intensityValue.textContent = pct + '%';
    intensityLabel.textContent = MODE_LABELS[currentMode] + '濃淡';
}

intensitySlider.addEventListener('input', function() {
    intensity[currentMode] = parseInt(intensitySlider.value, 10) / 100;
    intensityValue.textContent = intensitySlider.value + '%';
});

function changeUIMode(mode) {
    currentMode = mode;
    ['lip','eye','base'].forEach(function(m){
        var panel = document.getElementById(m + '-panel');
        var tab   = document.getElementById('tab-' + m);
        if (panel) panel.style.display = (m === mode) ? 'block' : 'none';
        if (tab)   tab.classList.toggle('active-tab', m === mode);
    });
    syncIntensityUI();
}

function buildSwatch(containerId, cssClass, items, clickFn) {
    var container = document.getElementById(containerId);
    items.forEach(function(item){
        var card = el('div', 'flex-shrink-0 w-20 cursor-pointer text-center swatch-item ' + cssClass);
        card.dataset.id = item.id;
        card.onclick    = function(){ clickFn(item); };
        var circle = el('div', 'w-14 h-14 rounded-full border border-[#E7E5DE] mb-2 swatch-circle mx-auto');
        circle.style.background = item.color;
        card.appendChild(circle);
        card.appendChild(el('p', 'text-[9px] font-medium text-[#26251F] leading-tight line-clamp-2', item.name));
        if (item.subtitle) card.appendChild(el('p', 'text-[8px] text-[#8C8B85] leading-tight line-clamp-1', item.subtitle));
        container.appendChild(card);
    });
}

// 原本只聽 mouseup/touchend：手指滑出按鈕、被系統手勢打斷（touchcancel）時
// 收不到放開事件，showMakeup 會卡在 false、妝一直消失。改用 pointer events
// 並 capture 住指標，不管在哪放開都會收到；任何「中斷」類事件也一律恢復
compareBtn.addEventListener('pointerdown', function(e){
    e.preventDefault();
    showMakeup = false;
    try { compareBtn.setPointerCapture(e.pointerId); } catch (err) {}
});
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function(type){
    compareBtn.addEventListener(type, function(){ showMakeup = true; });
});
window.addEventListener('blur', function(){ showMakeup = true; });
compareBtn.addEventListener('contextmenu', function(e){ e.preventDefault(); }); // 擋長按跳出選單

saveBtn.addEventListener('click', async function(){
    var filename = 'ai-makeup-' + Date.now() + '.png';
    var dataUrl = canvasElement.toDataURL('image/png');

    // 手機瀏覽器（尤其 iOS Safari）大多不支援 <a download> 存圖，點了會直接開新分頁
    // 顯示圖片而不是存進相簿，使用者常常因此找不到檔案。改用原生分享面板，
    // 讓使用者直接選「儲存影像」存進相簿，這是行動裝置上唯一穩定可靠的做法。
    if (navigator.canShare) {
        try {
            var blob = await (await fetch(dataUrl)).blob();
            var file = new File([blob], filename, { type: 'image/png' });
            if (navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: 'AI 試妝結果' });
                return;
            }
        } catch (err) {
            if (err && err.name === 'AbortError') return; // 使用者自己取消分享，不需要 fallback
        }
    }

    var link = document.createElement('a');
    link.download = filename;
    link.href = dataUrl;
    link.click();
});
buildSwatch('lip-selector',  'lip-swatch',  lipColors,  setLipColor);
buildSwatch('eye-selector',  'eye-swatch',  eyeColors,  setEyeColor);
buildSwatch('base-selector', 'base-swatch', baseColors, setBaseColor);