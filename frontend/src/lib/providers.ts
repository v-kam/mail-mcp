// Provider catalog: pre-baked IMAP/SMTP defaults + step-by-step setup
// instructions surfaced in the wizard and the /setup page.
//
// Each provider supplies the host/port pairs you'd otherwise have to
// google, the auth options the provider actually accepts (Google for
// example killed Basic Auth in 2022 but still allows app-passwords),
// and a deep link that takes the user straight to the page where they
// can mint the credentials.

export type AuthMethod = "app_password" | "password" | "oauth2";

export type ProviderId =
  | "gmail"
  | "microsoft"
  | "icloud"
  | "yahoo"
  | "fastmail"
  | "zoho"
  | "custom";

export interface ProviderTemplate {
  id: ProviderId;
  /** Display name in the wizard tile. */
  name: string;
  /** One-liner shown under the title in the tile. */
  tagline: string;
  /** Single-letter avatar (used because we ship no logo bitmaps). */
  initial: string;
  /** Tailwind classes that colour the avatar circle. */
  badgeClass: string;
  /** IMAP defaults applied when the wizard loads this template. */
  imap?: { host: string; port: number; secure: boolean };
  /** SMTP defaults applied when the wizard loads this template. */
  smtp?: { host: string; port: number; security: "starttls" | "tls" | "plain" };
  /** Auth methods the provider supports, in order of preference. */
  authMethods: AuthMethod[];
  /** Default auth method used when the wizard loads the template. */
  defaultAuth: AuthMethod;
  /**
   * Direct deep-link to the provider page where the user mints the
   * credential the wizard needs (app password or OAuth2 client). May
   * be `null` for "custom" / "password" cases.
   */
  credentialUrl?: string;
  /** Step-by-step instructions rendered on the /setup page. */
  steps: string[];
  /** Free-form notes (rendered as a callout in the wizard). */
  notes?: string;
}

const GMAIL_APP_PASSWORDS = "https://myaccount.google.com/apppasswords";
const ICLOUD_PASSWORDS = "https://account.apple.com/account/manage";
const YAHOO_SECURITY = "https://login.yahoo.com/account/security";
const FASTMAIL_PASSWORDS =
  "https://app.fastmail.com/settings/security/integrations";
const ZOHO_APP_PASSWORDS = "https://accounts.zoho.com/home#security/app_password";
const AZURE_APP_REGISTRATIONS =
  "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";

export const PROVIDERS: ProviderTemplate[] = [
  {
    id: "gmail",
    name: "Gmail / Google Workspace",
    tagline: "@gmail.com or any Google Workspace domain",
    initial: "G",
    badgeClass: "bg-red-500/15 text-red-400",
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
    authMethods: ["app_password", "oauth2"],
    defaultAuth: "app_password",
    credentialUrl: GMAIL_APP_PASSWORDS,
    steps: [
      "Sign in to your Google account and turn on 2-Step Verification under Security if it's not already on.",
      "Open Google App Passwords (the link below).",
      "Choose 'Mail' and the device of your choice, then click Generate.",
      "Copy the 16-character password — Google won't show it again.",
      "Paste it into the IMAP password field in mail-mcp.",
    ],
    notes:
      "App Passwords work for IMAP and SMTP. For Microsoft Graph or admin-controlled domains you may need OAuth2 instead.",
  },
  {
    id: "microsoft",
    name: "Microsoft 365 / Outlook.com",
    tagline: "@outlook.com, @hotmail.com, or any Microsoft 365 tenant",
    initial: "M",
    badgeClass: "bg-blue-500/15 text-blue-400",
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp.office365.com", port: 587, security: "starttls" },
    authMethods: ["oauth2", "app_password"],
    defaultAuth: "oauth2",
    credentialUrl: AZURE_APP_REGISTRATIONS,
    steps: [
      "Microsoft disabled basic auth on most tenants — use OAuth2 unless you've explicitly re-enabled it.",
      "Open Microsoft Entra → App registrations and create a new app (or reuse one).",
      "Add a Web redirect URI of https://localhost (used only during the consent flow).",
      "Under API permissions, grant 'IMAP.AccessAsUser.All', 'SMTP.Send' and 'offline_access' (Mail.Send / Mail.ReadWrite for the Graph tools).",
      "Generate a client secret and complete an OAuth2 authorization code flow to obtain a refresh token.",
      "Paste the client_id, client_secret and refresh_token into the OAuth2 fields below.",
    ],
    notes:
      "If your tenant administrator allows app passwords (uncommon), you can use them via the personal account flow at https://account.live.com/proofs/AppPassword.",
  },
  {
    id: "icloud",
    name: "iCloud Mail",
    tagline: "@icloud.com / @me.com / @mac.com",
    initial: "i",
    badgeClass: "bg-zinc-200/10 text-zinc-200",
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
    authMethods: ["app_password"],
    defaultAuth: "app_password",
    credentialUrl: ICLOUD_PASSWORDS,
    steps: [
      "Apple requires app-specific passwords for IMAP/SMTP. Two-factor auth must already be on.",
      "Open the Apple ID account page (link below) and sign in.",
      "Go to 'App-Specific Passwords' → 'Generate Password'.",
      "Give it a label like 'mail-mcp' and copy the 19-character password.",
      "Paste it into both the IMAP and SMTP password fields below — they share one credential.",
    ],
    notes:
      "Use your full @icloud.com address for the username, not just the local part.",
  },
  {
    id: "yahoo",
    name: "Yahoo Mail",
    tagline: "@yahoo.com",
    initial: "Y",
    badgeClass: "bg-purple-500/15 text-purple-400",
    imap: { host: "imap.mail.yahoo.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, security: "tls" },
    authMethods: ["app_password"],
    defaultAuth: "app_password",
    credentialUrl: YAHOO_SECURITY,
    steps: [
      "Yahoo requires an app password — your normal account password won't work.",
      "Open Yahoo Account Security (link below) and sign in.",
      "Click 'Generate app password' under 'Other ways to sign in'.",
      "Pick a name like 'mail-mcp' and copy the displayed password.",
      "Paste it into the IMAP password field below.",
    ],
  },
  {
    id: "fastmail",
    name: "Fastmail",
    tagline: "@fastmail.com and custom domains",
    initial: "F",
    badgeClass: "bg-emerald-500/15 text-emerald-400",
    imap: { host: "imap.fastmail.com", port: 993, secure: true },
    smtp: { host: "smtp.fastmail.com", port: 465, security: "tls" },
    authMethods: ["app_password"],
    defaultAuth: "app_password",
    credentialUrl: FASTMAIL_PASSWORDS,
    steps: [
      "Fastmail uses scoped 'app passwords' for IMAP/SMTP access.",
      "Open Settings → Privacy & Security → Integrations (link below).",
      "Click 'New app password', give it a name, and grant the 'Mail (IMAP/POP/SMTP)' scope.",
      "Copy the displayed password.",
      "Use your full Fastmail email address as the username and paste the password below.",
    ],
  },
  {
    id: "zoho",
    name: "Zoho Mail",
    tagline: "Zoho-hosted personal and team mailboxes",
    initial: "Z",
    badgeClass: "bg-orange-500/15 text-orange-400",
    imap: { host: "imap.zoho.com", port: 993, secure: true },
    smtp: { host: "smtp.zoho.com", port: 465, security: "tls" },
    authMethods: ["app_password", "password"],
    defaultAuth: "app_password",
    credentialUrl: ZOHO_APP_PASSWORDS,
    steps: [
      "Open Zoho Accounts → Security → App Passwords (link below).",
      "Click 'Generate New Password', name it 'mail-mcp', and copy the value.",
      "If your account uses a regional domain (zoho.eu, zoho.in), substitute that suffix in the IMAP/SMTP host fields below.",
      "Paste the password into the IMAP password field.",
    ],
    notes:
      "Regional servers exist as imap.zoho.eu, imap.zoho.in, etc. Adjust the host if your account is hosted outside the US.",
  },
  {
    id: "custom",
    name: "Custom IMAP / SMTP",
    tagline: "Self-hosted, ProtonMail Bridge, or any other server",
    initial: "✱",
    badgeClass: "bg-slate-500/15 text-slate-300",
    authMethods: ["password", "oauth2", "app_password"],
    defaultAuth: "password",
    steps: [
      "Enter the IMAP and SMTP hostnames your provider documents.",
      "TLS port for IMAP is usually 993; STARTTLS-on-587 or implicit-TLS-on-465 for SMTP.",
      "If your server only supports OAuth2 (e.g. corporate SSO), pick OAuth2 and paste the refresh token your IdP issues.",
    ],
    notes:
      "ProtonMail Bridge usage: host=127.0.0.1, port=1143/IMAP, 1025/SMTP, 'plain' security. Run Bridge on the same host as mail-mcp.",
  },
];

export function findProvider(id: ProviderId): ProviderTemplate {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1]!;
}

/**
 * Best-effort guess of the provider from an IMAP hostname. Used by the
 * edit flow so existing accounts get the same provider context (deep
 * links, recommended auth methods) as new ones.
 */
export function detectProviderFromImapHost(host?: string | null): ProviderId {
  if (!host) return "custom";
  const h = host.toLowerCase();
  if (h.includes("gmail")) return "gmail";
  if (h.includes("office365") || h.includes("outlook")) return "microsoft";
  if (h.includes("me.com") || h.includes("icloud")) return "icloud";
  if (h.includes("yahoo")) return "yahoo";
  if (h.includes("fastmail")) return "fastmail";
  if (h.includes("zoho")) return "zoho";
  return "custom";
}

export function authLabel(method: AuthMethod): string {
  switch (method) {
    case "app_password":
      return "App Password";
    case "password":
      return "Password";
    case "oauth2":
      return "OAuth2";
  }
}
