import { Hono } from 'hono';
import type { AppEnv } from '../app';

// The two self-service password reset pages, served by the Worker (wrangler.jsonc assets.run_worker_first lists both
// paths so the SPA does not take them). Self-contained: inline CSS and script, no external resources. The token is in
// the URL fragment, so Referrer-Policy: no-referrer and no-store keep it out of referrers and caches.

// script-src allows only the page's own inline script, by its SHA-256 hash.
const csp = (scriptHash: string) =>
  `default-src 'none'; style-src 'unsafe-inline'; script-src '${scriptHash}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

async function sha256Base64(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest));
}

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f4; --card: #ffffff; --text: #1c1c1e; --muted: #5f6368; --border: #d0d0d5;
  --accent: #4250af; --accent-text: #ffffff; --ok: #1e7a3c; --err: #b3261e; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #111113; --card: #1c1c1f; --text: #ececf0; --muted: #a0a0a8; --border: #3a3a40;
    --accent: #adcbfa; --accent-text: #0b1a33; --ok: #7fd49a; --err: #f2b8b5; }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px;
  background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 400px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
h1 { font-size: 1.4rem; margin: 0 0 8px; }
p { margin: 0 0 16px; color: var(--muted); }
label { display: block; font-weight: 600; margin: 0 0 4px; }
input { width: 100%; font: inherit; padding: 10px 12px; margin: 0 0 16px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text); }
button { width: 100%; font: inherit; font-weight: 600; padding: 10px 12px; border: 0; border-radius: 8px;
  background: var(--accent); color: var(--accent-text); cursor: pointer; }
button:disabled { opacity: 0.6; cursor: default; }
a { color: var(--accent); }
#msg { margin: 16px 0 0; min-height: 1.5em; }
#msg.ok { color: var(--ok); }
#msg.err { color: var(--err); }
.back { margin: 16px 0 0; font-size: 0.9rem; }
`;

interface Page {
  html: string;
  /** The exact text of the page's one inline script element, which its CSP hash covers. */
  script: string;
}

function page(body: string, code: string): Page {
  const script = `
const msg = document.getElementById('msg');
function show(text, kind) { msg.textContent = text; msg.className = kind; }
${code}
`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Immich</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
<p id="msg" role="status" aria-live="polite"></p>
<p class="back"><a href="/auth/login">Back to sign in</a></p>
</main>
<script>${script}</script>
</body>
</html>`;
  return { html, script };
}

const FORGOT = page(
  `<h1>Forgot password?</h1>
<p>Enter the email address of your account. If it exists, we will email you a link to choose a new password.</p>
<form id="form" novalidate>
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required autofocus>
<button id="submit" type="submit">Send reset link</button>
</form>`,
  `const form = document.getElementById('form');
const button = document.getElementById('submit');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.getElementById('email').value.trim();
  if (!email) { show('Enter your email address.', 'err'); return; }
  button.disabled = true;
  show('Sending…', '');
  try {
    const res = await fetch('/api/auth/password-reset/request', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
    });
    if (res.status === 204) {
      show('If an account exists for that email, a reset link is on its way. It expires in 30 minutes.', 'ok');
      form.reset();
    } else if (res.status === 400) {
      const body = await res.json().catch(() => ({}));
      show(body.message === 'Password login is disabled' ? 'Password login is disabled on this server.' : 'Enter a valid email address.', 'err');
    } else {
      show('Something went wrong. Try again in a minute.', 'err');
    }
  } catch {
    show('Could not reach the server. Check your connection and try again.', 'err');
  } finally {
    button.disabled = false;
  }
});`,
);

const RESET = page(
  `<h1>Choose a new password</h1>
<p>Your new password must be at least 8 characters. This signs you out everywhere.</p>
<form id="form" novalidate>
<label for="password">New password</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required autofocus>
<label for="confirm">Repeat new password</label>
<input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" required>
<button id="submit" type="submit">Change password</button>
</form>`,
  `const form = document.getElementById('form');
const button = document.getElementById('submit');
const token = new URLSearchParams(location.hash.slice(1)).get('token');
// drop the token from the address bar and history once it has been read
if (location.hash) history.replaceState(null, '', location.pathname);
function invalidLink() {
  form.hidden = true;
  msg.className = 'err';
  msg.textContent = 'This link is invalid or has expired. ';
  const a = document.createElement('a');
  a.href = '/forgot-password';
  a.textContent = 'Request a new link.';
  msg.appendChild(a);
}
if (!token) invalidLink();
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = document.getElementById('password').value;
  if (password.length < 8) { show('The password must be at least 8 characters.', 'err'); return; }
  if (password !== document.getElementById('confirm').value) { show('The passwords do not match.', 'err'); return; }
  button.disabled = true;
  show('Saving…', '');
  try {
    const res = await fetch('/api/auth/password-reset/confirm', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password }),
    });
    if (res.status === 204) {
      form.hidden = true;
      show('Your password has been changed. Sign in with your new password.', 'ok');
      return;
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 400 && body.message === 'Invalid or expired link') invalidLink();
    else if (res.status === 400) show(body.message || 'Check the password and try again.', 'err');
    else show('Something went wrong. Try again in a minute.', 'err');
  } catch {
    show('Could not reach the server. Check your connection and try again.', 'err');
  } finally {
    button.disabled = false;
  }
});`,
);

// The hashes are computed once per isolate, on the first request (crypto.subtle is async, so not at module load).
const headerCache = new Map<Page, Promise<Record<string, string>>>();

function headersFor(p: Page): Promise<Record<string, string>> {
  let headers = headerCache.get(p);
  if (!headers) {
    headers = sha256Base64(p.script).then((hash) => ({
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp(`sha256-${hash}`),
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    }));
    headerCache.set(p, headers);
  }
  return headers;
}

export const resetPageRoutes = new Hono<AppEnv>();
resetPageRoutes.get('/forgot-password', async (c) => c.body(FORGOT.html, 200, await headersFor(FORGOT)));
resetPageRoutes.get('/reset-password', async (c) => c.body(RESET.html, 200, await headersFor(RESET)));
