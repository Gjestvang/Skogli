// Only used for push notifications; pages are always fetched fresh.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: "Nytt bet", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Nytt bet", {
    body: d.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: "bet",
    renotify: true,
    data: { url: d.url || "/betting.html" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/betting.html";
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) if (w.url.includes(url) && "focus" in w) return w.focus();
    return clients.openWindow(url);
  })());
});
