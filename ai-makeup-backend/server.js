require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// 部署在 Render/Railway 這類 PaaS，或透過 cloudflared/ngrok 本機隧道對外時，
// request 都會多一段「平台反向代理 -> 這支 app」的 hop，對方會附上
// X-Forwarded-For。Express 預設不信任這個表頭，express-rate-limit 偵測到
// 就直接丟例外讓整個請求 502。這裡設成信任「最前面那一層」代理——
// 這些平台的架構都是 app 外面正好只有一層反向代理，是安全且通用的設定。
app.set('trust proxy', 1);

if (!GEMINI_API_KEY) {
    console.error('缺少 GEMINI_API_KEY，請在 .env 中設定後再啟動伺服器。');
    process.exit(1);
}

app.use(express.json({ limit: '200kb' }));
app.use(cors({ origin: ALLOWED_ORIGIN }));

// 同源提供前端頁面，讓手機打開同一個網址就能用鏡頭 + 呼叫 API，不用另外處理 CORS
const FRONTEND_DIR = path.join(__dirname, '..', 'ai-makeup-frontend');
app.use(express.static(FRONTEND_DIR));
app.get('/', (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

const analyzeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false
});

function extractJson(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            try { return JSON.parse(match[0]); } catch (e2) { return null; }
        }
        return null;
    }
}

app.post('/api/analyze', analyzeLimiter, async (req, res) => {
    const { matchedBaseName, lipCandidates, eyeCandidates, undertone, faceShape } = req.body || {};

    if (!matchedBaseName || !faceShape || !Array.isArray(lipCandidates) || !Array.isArray(eyeCandidates) ||
        lipCandidates.length === 0 || eyeCandidates.length === 0) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const prompt =
        'You are a professional, trend-aware makeup consultant writing a short personalized skin analysis for a user. ' +
        'A user\'s face has been measured locally (trust this data): ' +
        'foundation match: ' + matchedBaseName + ', undertone: ' + undertone + ', face shape: ' + faceShape + '. ' +
        'These lip color candidates were already pre-filtered by color-distance math to exclude anything that would clash with the skin tone ' +
        '(do not reject them, do not add new options): ' + JSON.stringify(lipCandidates) + '. ' +
        'These eye color candidates were pre-filtered the same way: ' + JSON.stringify(eyeCandidates) + '. ' +
        'From EACH list, pick the ONE color (by id) that would look most flattering and give a healthy, radiant glow in person — ' +
        'not necessarily the one numerically closest to the skin tone. A deliberate, tasteful contrast against the skin tone is encouraged ' +
        'when it makes the look more vivid and memorable. Consider general mainstream makeup aesthetic tendencies when choosing. ' +
        'Return ONLY JSON with keys: recommended_lip_id, recommended_eye_id, advice. ' +
        'advice must be a zh-TW paragraph of about 120-200 characters, written the way a real human makeup consultant would talk to the client ' +
        'face-to-face (warm, specific, no bullet points, no markdown). It must cover, in flowing sentences (not labeled sections): ' +
        '(1) 這位使用者屬於哪個色系／色調的膚色（根據 undertone 與 foundation match 說明這個色系通常的特質，例如冷調適合的顏色方向、容易顯白或黯沉的狀況）；' +
        '(2) 這個臉型（' + faceShape + '）的輪廓特徵，以及化妝時可以如何利用色彩或修容技巧來呼應這個臉型的優勢；' +
        '(3) 承接以上兩點，說明為什麼選出的唇色和眼影特別適合這位使用者，並可提及整體風格走向（例如日系日常、韓系、歐美濃郁）。' +
        'Do not start with any address/greeting term (e.g. 親愛的、您好、Hi) — begin directly with the skin tone analysis. ' +
        'Do not explain using numeric color differences. No markdown, no extra text, no line breaks.';

    try {
        const response = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        // 溫度調低：同樣的輸入應該得到語氣/內容相近的文案，
                        // 只保留一點點變化讓建議文字不會每次一字不差
                        temperature: 0.15,
                        maxOutputTokens: 700,
                        // 這是簡單的結構化輸出任務，不需要延伸思考；
                        // 關掉思考可避免 token 額度被思考過程吃光導致回應被截斷
                        thinkingConfig: { thinkingBudget: 0 }
                    }
                })
            }
        );

        if (!response.ok) {
            // 原本這裡直接回 502 沒有印任何東西到 console，Render 的 log 上完全看不出
            // Gemini 真正的錯誤原因（常見的是 API 金鑰有 IP/referrer 限制擋掉部署環境、
            // 或免費額度用完回 429）。印出 Gemini 實際的狀態碼跟錯誤內容，才診斷得出來。
            const errText = await response.text().catch(function () { return '(無法讀取錯誤內容)'; });
            console.error('Gemini API 呼叫失敗，狀態碼 ' + response.status + '：' + errText.slice(0, 500));
            return res.status(502).json({ error: 'Upstream Gemini API error', status: response.status });
        }

        const data = await response.json();
        const text = data.candidates && data.candidates[0] && data.candidates[0].content &&
            data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
            data.candidates[0].content.parts[0].text;
        const parsed = text ? extractJson(text) : null;

        if (!parsed) {
            console.error('Gemini 回應解析失敗，原始內容：' + JSON.stringify(data).slice(0, 500));
            return res.status(502).json({ error: 'Failed to parse Gemini response' });
        }

        res.json(parsed);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.listen(PORT, () => console.log('AI makeup backend running on port ' + PORT));
