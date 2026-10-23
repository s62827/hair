// 前端用的 Tailwind 是預先編譯成 ai-makeup-frontend/tailwind.css 的靜態檔。
// 在 HTML 或 script.js 裡新增／修改 Tailwind class 之後，要在 repo 根目錄重新產生：
//   npx tailwindcss@3 -i tailwind.input.css -o ai-makeup-frontend/tailwind.css --minify
module.exports = {
    content: ['./ai-makeup-frontend/index.html', './ai-makeup-frontend/script.js']
};
