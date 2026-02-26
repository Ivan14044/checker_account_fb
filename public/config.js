// На GitHub Pages — запросы на бэкенд Render. На Render или своём домене — тот же хост.
window.PROXY_BASE = (typeof location !== 'undefined' && /github\.io$/.test(location.hostname))
  ? "https://checker-account-fb.onrender.com"
  : "";


