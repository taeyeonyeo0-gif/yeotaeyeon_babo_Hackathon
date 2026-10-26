(function (root) {
  const storageKey = 'nightpath-theme-mode';

  function themeAtSeoulTime(date = new Date()) {
    const hour = Number(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Seoul',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(date));
    return hour >= 6 && hour < 18 ? 'light' : 'dark';
  }

  function resolveTheme(mode, date = new Date()) {
    return mode === 'light' || mode === 'dark' ? mode : themeAtSeoulTime(date);
  }

  let mode = 'auto';
  try {
    const saved = root.localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark' || saved === 'auto') mode = saved;
  } catch {}

  const api = { storageKey, mode, themeAtSeoulTime, resolveTheme };
  root.nightpathTheme = api;
  if (root.document?.documentElement) {
    const theme = resolveTheme(mode);
    const favicon = root.document.querySelector('link[rel="icon"]');
    const faviconSources = {
      dark: favicon?.href || './favicon-night.png',
      light: root.document.querySelector('#favicon-day-source')?.href || './favicon-day.png',
    };
    root.themeFaviconSources = faviconSources;
    root.document.documentElement.dataset.theme = theme;
    if (root.document.body) root.document.body.dataset.theme = theme;
    const meta = root.document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#0d171b' : '#F3F4F2';
    if (favicon) favicon.href = faviconSources[theme];
  }
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
