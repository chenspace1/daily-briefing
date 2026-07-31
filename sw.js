// 八点日报 — Service Worker
const CACHE = 'daily-briefing-v1';
const SHELL = [
  '.',
  'index.html',
  'style.css',
  'manifest.json',
  'icon.svg',
  'ai.html',
  'paper.html',
  'econ.html',
  'leaders.html',
  'learn.html',
];

// 安装：预缓存核心文件
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

// 激活：清理旧缓存
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// 请求：缓存优先，网络回退
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
