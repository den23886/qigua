const CACHE = 'xuanyige-v3';
const ASSETS = ['./', './index.html', './icon-192.png', './icon-512.png', './manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 大模型接口不缓存
  if (url.pathname.startsWith('/api/')) return; // 订单/接口请求永不走缓存

  const isDoc = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html');

  // 页面文档：先网络，失败再回退缓存，保证每次拿到最新页面
  if (isDoc) {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // 静态资源：先缓存后网络
  event.respondWith(
    caches.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
