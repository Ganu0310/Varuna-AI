/**
 * Pre-paint theme application. Loaded from index.html as a same-origin script so it
 * satisfies the strict nginx CSP (`script-src 'self'`, no inline). Mirrors
 * src/app/providers/ThemeProvider.tsx — localStorage key `varuna.theme`.
 */
(function () {
  try {
    var p = localStorage.getItem('varuna.theme') || 'system';
    var sys = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    var t = p === 'system' ? sys : p;
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.style.colorScheme = t;
  } catch (e) {
    /* default data-theme="dark" already on <html> */
  }
})();
