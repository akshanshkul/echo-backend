import { config } from './config.js';
/** Sent mail is captured here when no ZeptoMail token is configured (development / tests only). */
export const outbox = [];
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

export async function sendMail({ to, name, subject, html, text }) {
  const { token, host, fromAddress, fromName } = config.mail;
  if (!token || !fromAddress) {
    if (config.isProd) {
      const e = new Error('Email service is not configured');
      e.status = 503;
      throw e;
    }
    outbox.push({ to, subject, html, text });
    console.log(
      `\n[mail:dev] ZeptoMail not configured — email to ${to} not sent.\n  ${subject}\n  ${text}\n`,
    );
    return { dev: true };
  }
  // ZeptoMail HTTP API (https://www.zoho.com/zeptomail/help/api/email-sending.html)
  const res = await fetch(`https://${host}/v1.1/email`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Zoho-enczapikey ${token.replace(/^Zoho-enczapikey\s+/i, '')}`,
    },
    body: JSON.stringify({
      from: { address: fromAddress, name: fromName },
      to: [{ email_address: { address: to, name: name || to } }],
      subject,
      htmlbody: html,
      textbody: text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('ZeptoMail error', res.status, body.slice(0, 300));
    const e = new Error('We could not send the email. Please try again shortly.');
    e.status = 502;
    throw e;
  }
  return res.json().catch(() => ({}));
}

// ---------- branded HTML email (table layout + inline styles so it renders in Gmail/Outlook/Apple Mail) ----------
const C = {
  accent: '#3b6fd8',
  text: '#161a23',
  text2: '#515a6b',
  text3: '#7d8697',
  border: '#e1e5ec',
  bg: '#eceff4',
  soft: '#eef3fd',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif";

/** Logo image needs a public URL; on localhost no email client can load it, so fall back to a drawn badge. */
let logoCache = { at: 0, url: '' };
/** Public URL of the logo (MAIL_LOGO_URL, e.g. an S3 object). Checked with a HEAD request and cached, so a private/missing image falls back to the drawn badge instead of a broken icon. */
export async function resolveLogoUrl() {
  if (Date.now() - logoCache.at < 10 * 60 * 1000) return logoCache.url;
  const candidate =
    process.env.MAIL_LOGO_URL ||
    (/localhost|127\.0\.0\.1/.test(config.clientUrl) ? '' : `${config.clientUrl}/logo/logo-96.png`);
  let url = '';
  if (candidate) {
    try {
      const r = await fetch(candidate, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
      if (r.ok && /^image\//.test(r.headers.get('content-type') || '')) url = candidate;
      else
        console.warn(
          `[mail] logo ${candidate} is not publicly readable (HTTP ${r.status}); showing the name only`,
        );
    } catch (e) {
      console.warn('[mail] logo check failed:', e.message);
    }
  }
  logoCache = { at: Date.now(), url };
  return url;
}
function logoHtml(app, url) {
  const name = `<td style="font:700 20px ${FONT};color:${C.text};letter-spacing:-.01em">${esc(app)}</td>`;
  if (!url)
    return `<table role="presentation" cellpadding="0" cellspacing="0"><tr>${name}</tr></table>`; // no logo available: show the name only, no placeholder image
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-right:12px"><img src="${esc(url)}" width="44" height="44" alt="${esc(app)}" style="display:block;border:0;border-radius:11px"></td>${name}</tr></table>`;
}

export function layout({ preheader, title, bodyHtml, footer, logoUrl }) {
  const app = config.appName;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(title)}</title>
<style>@media (prefers-color-scheme:dark){.bg{background:#0d1016!important}.card{background:#141821!important;border-color:#252b39!important}.t1{color:#e7eaf1!important}.t2{color:#a2abbd!important}.t3{color:#778095!important}.box{background:#1d2230!important;border-color:#252b39!important}}
@media (max-width:540px){.card{border-radius:0!important}.pad{padding:24px 20px!important}}</style></head>
<body class="bg" style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;&#8203;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg" style="background:${C.bg}"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px">
<tr><td style="padding:0 4px 18px">${logoHtml(app, logoUrl)}</td></tr>
<tr><td class="card" style="background:#ffffff;border:1px solid ${C.border};border-radius:14px;box-shadow:0 1px 2px rgba(20,25,40,.06)">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="pad" style="padding:36px 36px 32px;font-family:${FONT}">${bodyHtml}</td></tr></table>
</td></tr>
<tr><td style="padding:20px 8px 0;font:12px/1.6 ${FONT};color:${C.text3};text-align:center" class="t3">${footer}<br>&copy; ${new Date().getFullYear()} ${esc(app)}</td></tr>
</table></td></tr></table></body></html>`;
}

const button = (href, label) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0"><tr><td align="center" bgcolor="${C.accent}" style="border-radius:8px;background:${C.accent}"><a href="${esc(href)}" target="_blank" style="display:inline-block;padding:14px 30px;font:600 15px ${FONT};color:#ffffff;text-decoration:none;border-radius:8px">${esc(label)}</a></td></tr></table>`;

export function verificationEmail(user, link, logoUrl = '') {
  const app = config.appName;
  const first = String(user.name || '').split(' ')[0] || 'there';
  const text = `Hi ${first},\n\nWelcome to ${app}! Confirm your email address to finish creating your account:\n\n${link}\n\nThis link expires in 24 hours and can be used once. After verifying, you'll add your mobile number and you're in.\n\nIf you didn't create an ${app} account, you can safely ignore this email.`;
  const bodyHtml = `
    <div style="display:inline-block;padding:5px 12px;border-radius:999px;background:${C.soft};color:${C.accent};font:600 12px ${FONT};letter-spacing:.02em;margin-bottom:18px">VERIFY YOUR EMAIL</div>
    <h1 class="t1" style="margin:0 0 12px;font:700 24px/1.25 ${FONT};color:${C.text};letter-spacing:-.02em">Welcome to ${esc(app)}, ${esc(first)}!</h1>
    <p class="t2" style="margin:0;font:15px/1.6 ${FONT};color:${C.text2}">You're one step away. Confirm your email address to activate your account and start chatting.</p>
    ${button(link, 'Verify my email')}
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td class="t2" style="font:13px/1.6 ${FONT};color:${C.text2}">
      <b class="t1" style="color:${C.text}">What happens next</b><br>1. Click the button above<br>2. Add your mobile number<br>3. Start messaging</td></tr></table>
    <hr style="border:0;border-top:1px solid ${C.border};margin:26px 0 20px">
    <p class="t3" style="margin:0 0 8px;font:12px/1.5 ${FONT};color:${C.text3}">Button not working? Copy and paste this link into your browser:</p>
    <div class="box" style="background:#f6f7f9;border:1px solid ${C.border};border-radius:8px;padding:10px 12px;font:12px/1.5 'SFMono-Regular',Consolas,Menlo,monospace;color:${C.text2};word-break:break-all"><a href="${esc(link)}" style="color:${C.accent};text-decoration:none">${esc(link)}</a></div>
    <p class="t3" style="margin:16px 0 0;font:12px/1.5 ${FONT};color:${C.text3}">This link expires in 24 hours and works once.</p>`;
  const html = layout({
    preheader: `Confirm your email to activate your ${app} account.`,
    title: `Verify your email for ${app}`,
    logoUrl,
    bodyHtml,
    footer: `You received this because someone signed up to ${esc(app)} with this address.<br>If that wasn't you, just ignore this email &mdash; no account will be activated.`,
  });
  return { subject: `Verify your email for ${app}`, html, text };
}

export function approvalEmail(user, logoUrl = '') {
  const app = config.appName;
  const first = String(user.name || '').split(' ')[0] || 'there';
  const link = config.clientUrl;
  const text = `Hi ${first},\n\nGood news — your ${app} account has been approved. You can sign in now:\n${link}\n\nSee you inside!`;
  const bodyHtml = `
    <div style="display:inline-block;padding:5px 12px;border-radius:999px;background:#e8f6ee;color:#1f8a52;font:600 12px ${FONT};letter-spacing:.02em;margin-bottom:18px">ACCOUNT APPROVED</div>
    <h1 class="t1" style="margin:0 0 12px;font:700 24px/1.25 ${FONT};color:${C.text};letter-spacing:-.02em">You're in, ${esc(first)}!</h1>
    <p class="t2" style="margin:0;font:15px/1.6 ${FONT};color:${C.text2}">An administrator approved your ${esc(app)} account. You can start chatting right away.</p>
    ${button(link, 'Open ' + app)}
    <p class="t3" style="margin:0;font:12px/1.5 ${FONT};color:${C.text3}">Or open: <a href="${esc(link)}" style="color:${C.accent};text-decoration:none">${esc(link)}</a></p>`;
  const html = layout({
    preheader: `Your ${app} account has been approved.`,
    title: `Your ${app} account is approved`,
    logoUrl,
    bodyHtml,
    footer: `You received this because you registered on ${esc(app)}.`,
  });
  return { subject: `Your ${app} account is approved`, html, text };
}

export function passwordResetEmail(user, link, logoUrl = '') {
  const app = config.appName;
  const first = String(user.name || '').split(' ')[0] || 'there';
  const text = `Hi ${first},\n\nWe received a request to reset your ${app} password. Use this link to choose a new one:\n\n${link}\n\nThis link expires in 1 hour and can be used once.\n\nIf you didn't ask for this, you can ignore this email — your password won't change.`;
  const bodyHtml = `
    <div style="display:inline-block;padding:5px 12px;border-radius:999px;background:${C.soft};color:${C.accent};font:600 12px ${FONT};letter-spacing:.02em;margin-bottom:18px">PASSWORD RESET</div>
    <h1 class="t1" style="margin:0 0 12px;font:700 24px/1.25 ${FONT};color:${C.text};letter-spacing:-.02em">Reset your password</h1>
    <p class="t2" style="margin:0;font:15px/1.6 ${FONT};color:${C.text2}">Hi ${esc(first)}, we received a request to reset your ${esc(app)} password. Click the button to choose a new one.</p>
    ${button(link, 'Reset password')}
    <p class="t2" style="margin:0;font:13px/1.6 ${FONT};color:${C.text2}">This link expires in <b>1 hour</b> and works once. If you didn't request it, you can safely ignore this email &mdash; your password stays the same.</p>
    <hr style="border:0;border-top:1px solid ${C.border};margin:26px 0 20px">
    <p class="t3" style="margin:0 0 8px;font:12px/1.5 ${FONT};color:${C.text3}">Button not working? Copy and paste this link into your browser:</p>
    <div class="box" style="background:#f6f7f9;border:1px solid ${C.border};border-radius:8px;padding:10px 12px;font:12px/1.5 'SFMono-Regular',Consolas,Menlo,monospace;color:${C.text2};word-break:break-all"><a href="${esc(link)}" style="color:${C.accent};text-decoration:none">${esc(link)}</a></div>`;
  const html = layout({
    preheader: `Reset your ${app} password — the link expires in 1 hour.`,
    title: `Reset your ${app} password`,
    logoUrl,
    bodyHtml,
    footer: `You received this because a password reset was requested for your ${esc(app)} account.<br>If that wasn't you, no action is needed.`,
  });
  return { subject: `Reset your ${app} password`, html, text };
}

export function passwordChangedEmail(user, logoUrl = '') {
  const app = config.appName;
  const first = String(user.name || '').split(' ')[0] || 'there';
  const when = new Date().toUTCString();
  const text = `Hi ${first},\n\nYour ${app} password was just changed (${when}). You've been signed out everywhere.\n\nIf this wasn't you, reset your password right away using "Forgot password" on the sign-in page.`;
  const bodyHtml = `
    <div style="display:inline-block;padding:5px 12px;border-radius:999px;background:${C.soft};color:${C.accent};font:600 12px ${FONT};letter-spacing:.02em;margin-bottom:18px">SECURITY NOTICE</div>
    <h1 class="t1" style="margin:0 0 12px;font:700 24px/1.25 ${FONT};color:${C.text};letter-spacing:-.02em">Your password was changed</h1>
    <p class="t2" style="margin:0;font:15px/1.6 ${FONT};color:${C.text2}">Hi ${esc(first)}, your ${esc(app)} password was changed on ${esc(when)}. For your safety you've been signed out of all devices.</p>
    <p class="t2" style="margin:18px 0 0;font:13px/1.6 ${FONT};color:${C.text2}">If this wasn't you, use <b>Forgot password</b> on the sign-in page right away.</p>`;
  const html = layout({
    preheader: `Your ${app} password was changed.`,
    title: `Your ${app} password was changed`,
    logoUrl,
    bodyHtml,
    footer: `This is an automated security message from ${esc(app)}.`,
  });
  return { subject: `Your ${app} password was changed`, html, text };
}
