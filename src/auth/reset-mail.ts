// Password reset email, sent through Resend's HTTP API. The API key is the RESEND_API_KEY secret and the sender is the
// MAIL_FROM var (its domain must be verified in Resend); without either nothing is sent. APP_NAME names the product
// in the message (default "Immich"). Failures are logged (status and Resend's error name only, never the key or the
// link) and swallowed, so the reset request still answers 204 with the same timing.

export interface ResetMailer {
  send(to: string, link: string, name: string): Promise<void>;
}

export interface ResetMailEnv {
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  APP_NAME?: string;
}

const RESEND_URL = 'https://api.resend.com/emails';
const DEFAULT_APP_NAME = 'Immich';
const SUBJECT = 'Reset your password';
const TIMEOUT_MS = 10_000;
const IGNORE = "If you didn't ask for this, ignore this email.";
const EFFECT = 'This signs you out everywhere.';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const asked = (appName: string) =>
  `Someone asked to reset the password of your ${appName} account. Open this link to choose a new password:`;

export function resetText(link: string, name: string, appName = DEFAULT_APP_NAME): string {
  return [`Hi ${name},`, '', asked(appName), '', link, '', 'The link works once and expires in 30 minutes.', EFFECT, '', IGNORE, ''].join(
    '\n',
  );
}

export function resetHtml(link: string, name: string, appName = DEFAULT_APP_NAME): string {
  const href = escapeHtml(link);
  return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#222">
<p>Hi ${escapeHtml(name)},</p>
<p>${escapeHtml(asked(appName))}</p>
<p><a href="${href}">${href}</a></p>
<p>The link works once and expires in 30 minutes. ${EFFECT}</p>
<p>${IGNORE}</p>
</body></html>`;
}

export function resendMailer(env: ResetMailEnv): ResetMailer {
  const appName = env.APP_NAME || DEFAULT_APP_NAME;
  return {
    async send(to, link, name) {
      if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
        console.log('password reset email not configured');
        return;
      }
      try {
        const res = await fetch(RESEND_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            from: env.MAIL_FROM,
            to: [to],
            subject: SUBJECT,
            text: resetText(link, name, appName),
            html: resetHtml(link, name, appName),
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          const error = (await res.json().catch(() => null)) as { name?: unknown } | null;
          console.error('password reset email failed', res.status, typeof error?.name === 'string' ? error.name : 'unknown');
        }
      } catch (err) {
        console.error('password reset email failed', err instanceof Error ? err.name : 'error');
      }
    },
  };
}

/** The mailer the reset routes use; tests replace `create` to capture mail instead of sending it. */
export const mailers = {
  create: (env: Env): ResetMailer => resendMailer(env),
};
