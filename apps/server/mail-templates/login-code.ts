// The sign-in code letter (email-auth.ts → beginEmailLogin). A pure function:
// the same code gives the same letter, and nothing here reads config.
//
// Deliverability rules kept on purpose: the text part is the whole message on
// its own; the HTML has no images, no web fonts, no tracking, and links to one
// place only, the installation's own address. Mail clients differ a lot, so
// the layout is the old, safe one: nested tables, inline styles, a 560px
// column, and colours that stay readable when Gmail or Яндекс Почта invert
// them. Clients that honour <style> (Apple Mail, Mail.ru, Outlook.com) get a
// proper dark scheme from the prefers-color-scheme block.

export const LOGIN_CODE_TTL_MINUTES = 10;
export const HOSTED_MAIL_SITE = Object.freeze({
  origin: "https://polochka.app",
  contact: "hello@polochka.app",
});

export type LoginCodeMail = { subject: string; text: string; html: string };

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
/** Text or attribute value → HTML; everything interpolated goes through this. */
export const escapeMailHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** «12345678» → «1234 5678»: two groups of four, easier to read aloud and type. */
export function groupCode(code: string) {
  const compact = code.replace(/\s+/g, "");
  if (compact.length <= 4) return compact;
  const half = Math.ceil(compact.length / 2);
  return `${compact.slice(0, half)} ${compact.slice(half)}`;
}

/** «https://polochka.app» → «polochka.app», for the footer. */
const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export function loginCodeMail(input: {
  code: string;
  /** The installation's address, the only link in the letter. */
  origin?: string;
  /** Where people write to; omitted from the footer when unset. */
  contact?: string | null;
}): LoginCodeMail {
  const origin = input.origin ?? HOSTED_MAIL_SITE.origin;
  const contact =
    input.contact === undefined ? HOSTED_MAIL_SITE.contact : input.contact;
  const grouped = groupCode(input.code);
  const host = hostOf(origin);
  const subject = `${grouped} — код для входа в Полку`;
  const text = [
    "Код для входа в Полку",
    "",
    `Ваш код: ${grouped}`,
    "",
    "Введите его на странице входа.",
    `Код действует ${LOGIN_CODE_TTL_MINUTES} минут.`,
    "Если вы не запрашивали вход — просто проигнорируйте письмо.",
    "",
    "—",
    `Полка · ${origin}${contact ? ` · ${contact}` : ""}`,
    "",
  ].join("\n");

  const e = escapeMailHtml;
  const sans =
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const mono =
    "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono','Courier New',monospace";
  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${e(subject)}</title>
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { margin: 0; padding: 0; }
  .code { -webkit-user-select: all; user-select: all; }
  @media (max-width: 600px) {
    .pad { padding-left: 22px !important; padding-right: 22px !important; }
    .code { font-size: 30px !important; letter-spacing: 4px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .page { background: #0b0f17 !important; }
    .card { background: #151b26 !important; border-color: #273041 !important; }
    .ink { color: #eef1f6 !important; }
    .muted { color: #9aa4b5 !important; }
    .codebox { background: #1d2433 !important; border-color: #334059 !important; }
    .code { color: #ffffff !important; }
    .rule { border-color: #273041 !important; }
    .link { color: #8fa9ff !important; }
  }
  [data-ogsc] .ink { color: #eef1f6 !important; }
  [data-ogsc] .muted { color: #9aa4b5 !important; }
  [data-ogsb] .page { background: #0b0f17 !important; }
  [data-ogsb] .card { background: #151b26 !important; }
  [data-ogsb] .codebox { background: #1d2433 !important; }
</style>
</head>
<body class="page" style="margin:0;padding:0;background:#f5f7fa;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">Ваш код: ${e(grouped)}. Действует ${LOGIN_CODE_TTL_MINUTES} минут.&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" class="page" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f5f7fa;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" class="card" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:#ffffff;border:1px solid #e7ebf1;border-radius:12px;">
<tr><td class="pad" style="padding:32px 40px 0 40px;font-family:${sans};">
<span class="ink" style="font-size:20px;line-height:24px;font-weight:700;letter-spacing:-0.5px;color:#0f1420;">полка</span><span class="link" style="font-size:20px;line-height:24px;font-weight:700;color:#1f4fff;">.</span>
</td></tr>
<tr><td class="pad" style="padding:28px 40px 0 40px;font-family:${sans};">
<h1 class="ink" style="margin:0;font-size:22px;line-height:28px;font-weight:700;color:#0f1420;">Код для входа в Полку</h1>
<p class="muted" style="margin:8px 0 0 0;font-size:15px;line-height:22px;color:#647087;">Введите его на странице входа.</p>
</td></tr>
<tr><td class="pad" style="padding:24px 40px 0 40px;">
<table role="presentation" class="codebox" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f5f7fa;border:1px solid #d9dfe9;border-radius:10px;">
<tr><td align="center" style="padding:22px 12px;">
<span class="code ink" style="font-family:${mono};font-size:36px;line-height:44px;font-weight:700;letter-spacing:6px;color:#0f1420;white-space:nowrap;-webkit-user-select:all;user-select:all;">${e(grouped)}</span>
</td></tr>
</table>
</td></tr>
<tr><td class="pad" style="padding:20px 40px 0 40px;font-family:${sans};">
<p class="ink" style="margin:0;font-size:15px;line-height:22px;color:#28354a;">Код действует ${LOGIN_CODE_TTL_MINUTES} минут.</p>
<p class="muted" style="margin:8px 0 0 0;font-size:14px;line-height:21px;color:#647087;">Если вы не запрашивали вход — просто проигнорируйте письмо.</p>
</td></tr>
<tr><td class="pad" style="padding:28px 40px 28px 40px;font-family:${sans};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="rule" style="border-top:1px solid #e7ebf1;padding-top:18px;font-size:12px;line-height:18px;color:#8a95a8;">
<a class="link" href="${e(origin)}" style="color:#1a3fd1;text-decoration:none;">${e(host)}</a>${contact ? `<span class="muted" style="color:#8a95a8;"> &middot; ${e(contact)}</span>` : ""}
</td></tr></table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
  return { subject, text, html };
}
