// Inline FOUC-prevention script. Reads `siteTheme` from localStorage
// (or falls back to system preference) and applies data-theme to <html>
// before the page paints.
//
// IMPORTANT: this is rendered as inline JS in <head>, so it runs synchronously.

export const themeInitScript = `
(function(){
  try {
    var stored = localStorage.getItem('siteTheme');
    var theme = stored;
    if (!theme) {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', theme);
  } catch(e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`.trim();
