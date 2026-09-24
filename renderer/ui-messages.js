// Turns an error from window.api into the message shown to the user. The main process already
// sends user-facing Arabic messages; this strips Electron's technical IPC prefix
// ("Error invoking remote method '...': Error: ") and never shows an empty or English-only text.
(function (root) {
  const GENERIC = 'حدث خطأ غير متوقع. حاول مرة أخرى، وإذا تكرر الخطأ تواصل مع الدعم الفني.';
  const ARABIC_RE = /[؀-ۿ]/;

  function userMessage(err) {
    const raw = String(err && err.message ? err.message : err || '');
    const text = raw
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^(\w*Error):\s*/, '')
      .trim();
    return text && ARABIC_RE.test(text) ? text : GENERIC;
  }

  const api = { userMessage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UiMessages = api;
})(typeof window !== 'undefined' ? window : this);
