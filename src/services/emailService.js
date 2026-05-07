import { Resend } from 'resend';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

let resendClient = null;

function getClient() {
  if (!config.resend.apiKey) return null;
  if (!resendClient) resendClient = new Resend(config.resend.apiKey);
  return resendClient;
}

function logToConsole({ to, subject, text }) {
  // eslint-disable-next-line no-console
  console.log(
    `\n=== EMAIL (DEV CONSOLE — NOT ACTUALLY SENT) ===\nFrom: ${config.emailFrom}\nTo: ${to}\nSubject: ${subject}\n\n${text}\n=== END EMAIL ===\n`
  );
}

async function sendEmail({ to, subject, text, html }) {
  const client = getClient();

  if (!client) {
    if (config.nodeEnv === 'production') {
      logger.error({ to, subject }, 'RESEND_API_KEY missing in production — email NOT sent');
    } else {
      logger.info({ to, subject }, 'No RESEND_API_KEY set; logging email to console');
    }
    logToConsole({ to, subject, text });
    return { sent: false, transport: 'console' };
  }

  try {
    const { data, error } = await client.emails.send({
      from: config.emailFrom,
      to,
      subject,
      text,
      ...(html ? { html } : {}),
    });

    if (error) {
      logger.error({ to, subject, error }, 'Resend rejected the email');
      if (config.nodeEnv !== 'production') logToConsole({ to, subject, text });
      return { sent: false, transport: 'resend', error };
    }

    logger.info({ to, subject, id: data?.id, transport: 'resend' }, 'Email sent');
    return { sent: true, transport: 'resend', id: data?.id };
  } catch (err) {
    logger.error({ to, subject, err: err.message }, 'Resend client threw an error');
    if (config.nodeEnv !== 'production') logToConsole({ to, subject, text });
    return { sent: false, transport: 'resend', error: err.message };
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlButton(label, url) {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0">
      <tr>
        <td align="center" style="border-radius:6px;background:#2563eb;">
          <a href="${escapeHtml(url)}" target="_blank"
             style="display:inline-block;padding:12px 24px;font-family:Arial,sans-serif;font-size:14px;color:#ffffff;text-decoration:none;border-radius:6px;">
            ${escapeHtml(label)}
          </a>
        </td>
      </tr>
    </table>`;
}

function brandedHtml({ greeting, intro, buttonLabel, url, fallback, signoff }) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f3f4f6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"
             style="background:#ffffff;border-radius:8px;overflow:hidden;font-family:Arial,sans-serif;color:#111827;">
        <tr><td style="padding:24px 32px;border-bottom:1px solid #e5e7eb;">
          <span style="font-size:18px;font-weight:700;color:#111827;">Call Coach Lab</span>
        </td></tr>
        <tr><td style="padding:24px 32px;font-size:14px;line-height:1.55;">
          <p>${escapeHtml(greeting)}</p>
          <p>${escapeHtml(intro)}</p>
          ${htmlButton(buttonLabel, url)}
          <p style="font-size:12px;color:#6b7280;">
            If the button doesn't work, copy this link into your browser:<br>
            <a href="${escapeHtml(url)}" style="color:#2563eb;word-break:break-all;">${escapeHtml(url)}</a>
          </p>
          <p style="font-size:12px;color:#6b7280;">${escapeHtml(fallback)}</p>
          <p>${escapeHtml(signoff)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export async function sendVerificationEmail({ to, name, verifyUrl }) {
  const subject = 'Verify your Call Coach Lab account';
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const text = `${greeting}

Welcome to Call Coach Lab! Please verify your email by clicking the link below:

${verifyUrl}

This link will expire in ${config.emailVerificationTtlHours} hours. If you didn't sign up, you can safely ignore this email.

— The Call Coach Lab Team`;

  const html = brandedHtml({
    greeting,
    intro: 'Welcome to Call Coach Lab! Click the button below to verify your email and complete sign-up.',
    buttonLabel: 'Verify email',
    url: verifyUrl,
    fallback: `This link expires in ${config.emailVerificationTtlHours} hours. If you didn't request this, ignore this email.`,
    signoff: '— The Call Coach Lab Team',
  });

  return sendEmail({ to, subject, text, html });
}

export async function sendInviteEmail({ to, inviterName, workspaceName, role, inviteUrl, expiresInDays }) {
  const subject = `You've been invited to join ${workspaceName} on Call Coach Lab`;
  const greeting = 'Hi,';
  const text = `${greeting}

${inviterName || 'A team admin'} has invited you to join ${workspaceName} on Call Coach Lab as a ${role}.

Click the link below to accept the invitation and set up your account:

${inviteUrl}

This invite expires in ${expiresInDays} days. If you weren't expecting this, you can safely ignore this email.

— The Call Coach Lab Team`;

  const html = brandedHtml({
    greeting,
    intro: `${inviterName || 'A team admin'} has invited you to join ${workspaceName} on Call Coach Lab as a ${role}. Click below to accept and set up your account.`,
    buttonLabel: 'Accept invitation',
    url: inviteUrl,
    fallback: `This invite expires in ${expiresInDays} days. If you weren't expecting this, ignore this email.`,
    signoff: '— The Call Coach Lab Team',
  });

  return sendEmail({ to, subject, text, html });
}

export async function sendPasswordResetEmail({ to, name, resetUrl }) {
  const subject = 'Reset your Call Coach Lab password';
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const text = `${greeting}

We received a request to reset your password. Click the link below to choose a new one:

${resetUrl}

This link expires in ${config.passwordResetTtlMinutes} minutes. If you didn't request a reset, you can safely ignore this email — your password won't change.

— The Call Coach Lab Team`;

  const html = brandedHtml({
    greeting,
    intro: 'We received a request to reset your password. Click the button below to choose a new one.',
    buttonLabel: 'Reset password',
    url: resetUrl,
    fallback: `This link expires in ${config.passwordResetTtlMinutes} minutes. If you didn't request a reset, ignore this email.`,
    signoff: '— The Call Coach Lab Team',
  });

  return sendEmail({ to, subject, text, html });
}
