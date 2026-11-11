// Light/dark choice from the header button, applied before the page paints
// (a plain script in <head>; the server's CSP allows no inline scripts).
// No saved choice: the device's own setting decides (styles.css).
(function () {
  var saved = null;
  try {
    saved = localStorage.getItem('theme');
  } catch (error) {
    saved = null; // blocked storage: follow the device
  }
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
})();
