'use strict'

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character])
}

// Server-rendered so an anonymous visitor never downloads the application
// bundle. Sign-in is a link, not a form: the CSP sets `form-action 'none'`
// and link navigation is unaffected by it.
//
// `message` is the only interpolated value and every caller's text is a fixed
// string chosen by this server — never a provider's or a query parameter's —
// but it is escaped regardless, so a future caller cannot turn this into an
// injection point.
function loginPage(message = '') {
  const notice = message ? `<p class="notice">${escapeHtml(message)}</p>` : ''

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenFit</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;color:#edf4f5;background:#080c11;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.card{width:min(380px,calc(100vw - 40px));padding:34px;border:1px solid #ffffff12;border-radius:20px;background:#111820;text-align:center}h1{margin:0 0 8px;font-size:22px}p{margin:0 0 22px;color:#83909b;font-size:13px;line-height:1.55}.notice{color:#ff7b74}a.button{display:block;padding:12px 18px;border-radius:12px;background:#5ae4c0;color:#08121a;font-size:14px;font-weight:600;text-decoration:none}</style></head><body><main class="card"><h1>OpenFit</h1><p>Sign in with the Google account your Fitbit app uses.</p>${notice}<a class="button" href="/auth/login">Sign in with Google</a></main></body></html>`
}

module.exports = { loginPage, escapeHtml }
