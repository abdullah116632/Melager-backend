import { Resend } from "resend";

function getResend(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not configured");
  return new Resend(key);
}

const FROM =
  process.env.RESEND_FROM_EMAIL ?? "Mess Manager <onboarding@resend.dev>";

export async function sendOtpEmail(
  to: string,
  name: string,
  otp: string,
): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to,
    subject: `${otp} — your Mess Manager verification code`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
        <h2 style="color:#0F766E;margin-bottom:8px;">Verify your email</h2>
        <p style="color:#374151;">Hi <strong>${name}</strong>,</p>
        <p style="color:#374151;">Enter the code below in the Mess Manager app to verify your email address:</p>
        <div style="font-size:40px;font-weight:700;letter-spacing:12px;text-align:center;
                    padding:24px;background:#F0FDFA;border:2px solid #14B8A6;
                    border-radius:12px;margin:24px 0;color:#0F766E;">
          ${otp}
        </div>
        <p style="color:#6B7280;font-size:14px;">This code expires in <strong>10 minutes</strong>. If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(
  to: string,
  name: string,
  otp: string,
): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to,
    subject: `${otp} — reset your Mess Manager password`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
        <h2 style="color:#0F766E;margin-bottom:8px;">Reset your password</h2>
        <p style="color:#374151;">Hi <strong>${name}</strong>,</p>
        <p style="color:#374151;">Use the code below to reset your Mess Manager password:</p>
        <div style="font-size:40px;font-weight:700;letter-spacing:12px;text-align:center;
                    padding:24px;background:#FFF7ED;border:2px solid #F97316;
                    border-radius:12px;margin:24px 0;color:#EA580C;">
          ${otp}
        </div>
        <p style="color:#6B7280;font-size:14px;">This code expires in <strong>10 minutes</strong>. If you didn't request a password reset, you can safely ignore this email.</p>
      </div>
    `,
  });
}

type SecurityAction =
  | "change_password"
  | "update_email"
  | "add_admin"
  | "add_co_admin"
  | "remove_self_admin";

const actionMeta: Record<
  SecurityAction,
  { subject: string; heading: string; body: string; accent: string; bg: string }
> = {
  change_password: {
    subject: "verification code — change your password",
    heading: "Change Password Request",
    body: "Someone (hopefully you) requested a password change on your Mess Manager account. Use the code below to confirm:",
    accent: "#2563EB",
    bg: "#EFF6FF",
  },
  update_email: {
    subject: "verification code — update your email",
    heading: "Email Change Request",
    body: "Someone (hopefully you) requested an email address change on your Mess Manager account. Use the code below to confirm:",
    accent: "#0D9488",
    bg: "#F0FDFA",
  },
  add_admin: {
    subject: "verification code — transfer admin role",
    heading: "Admin Transfer Request",
    body: "Someone (hopefully you) requested to transfer the admin role in your Mess Manager mess. Use the code below to confirm:",
    accent: "#EA580C",
    bg: "#FFF7ED",
  },
  add_co_admin: {
    subject: "verification code — add new admin",
    heading: "Add New Admin Request",
    body: "Someone (hopefully you) requested to grant admin privileges to a member in your Mess Manager mess. Use the code below to confirm:",
    accent: "#2563EB",
    bg: "#EFF6FF",
  },
  remove_self_admin: {
    subject: "verification code — remove your admin role",
    heading: "Remove Admin Role Request",
    body: "Someone (hopefully you) requested to remove your admin privileges from a Mess Manager mess. Use the code below to confirm:",
    accent: "#DC2626",
    bg: "#FEF2F2",
  },
};

export async function sendSecurityOtpEmail(
  to: string,
  name: string,
  action: SecurityAction,
  otp: string,
): Promise<void> {
  const resend = getResend();
  const meta = actionMeta[action];
  await resend.emails.send({
    from: FROM,
    to,
    subject: `${otp} — ${meta.subject}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
        <h2 style="color:${meta.accent};margin-bottom:8px;">${meta.heading}</h2>
        <p style="color:#374151;">Hi <strong>${name}</strong>,</p>
        <p style="color:#374151;">${meta.body}</p>
        <div style="font-size:40px;font-weight:700;letter-spacing:12px;text-align:center;
                    padding:24px;background:${meta.bg};border:2px solid ${meta.accent};
                    border-radius:12px;margin:24px 0;color:${meta.accent};">
          ${otp}
        </div>
        <p style="color:#6B7280;font-size:14px;">This code expires in <strong>10 minutes</strong>. If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

export async function sendInviteEmail(
  to: string,
  inviterName: string,
  messName: string,
  messKey: string,
): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to,
    subject: `${inviterName} invited you to join ${messName} on Melager`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
        <h2 style="color:#0F766E;margin-bottom:8px;">You're invited!</h2>
        <p style="color:#374151;">Hi there,</p>
        <p style="color:#374151;"><strong>${inviterName}</strong> has invited you to join <strong>${messName}</strong> on Mess Manager.</p>
        <p style="color:#374151;">Download the app and use the key below to join:</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:10px;text-align:center;
                    padding:24px;background:#F0FDFA;border:2px solid #14B8A6;
                    border-radius:12px;margin:24px 0;color:#0F766E;">
          ${messKey}
        </div>
        <p style="color:#6B7280;font-size:14px;">Open Mess Manager → Sign up or log in → Join a mess → Enter the key above.</p>
        <p style="color:#9CA3AF;font-size:12px;margin-top:32px;">This is an automated message from Mess Manager.</p>
      </div>
    `,
  });
}

export interface ConsumerSummary {
  name: string;
  meals: number;
  cost: number;
  deposits: number;
  balance: number;
}

export async function sendMonthlySummaryEmail(
  to: string,
  name: string,
  messName: string,
  yearMonth: string,
  summary: {
    meals: number;
    cost: number;
    deposits: number;
    balance: number;
    mealRate: number;
    totalExpenses: number;
    totalMeals: number;
  },
): Promise<void> {
  const resend = getResend();

  const [year, month] = yearMonth.split("-");
  const monthLabel = new Date(
    parseInt(year!),
    parseInt(month!) - 1,
    1,
  ).toLocaleString("en-US", { month: "long", year: "numeric" });

  const fmt = (n: number) =>
    n.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const balColor = summary.balance >= 0 ? "#059669" : "#DC2626";
  const balSign = summary.balance >= 0 ? "+" : "";

  await resend.emails.send({
    from: FROM,
    to,
    subject: `Your mess summary for ${monthLabel} — ${messName}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
        <h2 style="color:#0F766E;margin-bottom:4px;">${messName}</h2>
        <p style="color:#6B7280;margin-top:0;margin-bottom:24px;">Monthly summary for <strong>${monthLabel}</strong></p>

        <p style="color:#374151;">Hi <strong>${name}</strong>, here's your breakdown for ${monthLabel}:</p>

        <!-- Per-consumer breakdown -->
        <table style="width:100%;border-collapse:collapse;margin:24px 0;border-radius:10px;overflow:hidden;">
          <thead>
            <tr style="background:#0F766E;color:#fff;">
              <th style="text-align:left;padding:10px 14px;font-size:13px;">Item</th>
              <th style="text-align:right;padding:10px 14px;font-size:13px;">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr style="background:#F9FAFB;">
              <td style="padding:10px 14px;color:#374151;font-size:14px;">Meals eaten</td>
              <td style="padding:10px 14px;color:#374151;font-size:14px;text-align:right;">${summary.meals} meals</td>
            </tr>
            <tr style="background:#fff;border-top:1px solid #E5E7EB;">
              <td style="padding:10px 14px;color:#374151;font-size:14px;">Meal rate</td>
              <td style="padding:10px 14px;color:#374151;font-size:14px;text-align:right;">৳${fmt(summary.mealRate)} / meal</td>
            </tr>
            <tr style="background:#F9FAFB;border-top:1px solid #E5E7EB;">
              <td style="padding:10px 14px;color:#374151;font-size:14px;">Your cost</td>
              <td style="padding:10px 14px;color:#DC2626;font-size:14px;font-weight:600;text-align:right;">− ৳${fmt(summary.cost)}</td>
            </tr>
            <tr style="background:#fff;border-top:1px solid #E5E7EB;">
              <td style="padding:10px 14px;color:#374151;font-size:14px;">Your deposits</td>
              <td style="padding:10px 14px;color:#059669;font-size:14px;font-weight:600;text-align:right;">+ ৳${fmt(summary.deposits)}</td>
            </tr>
            <tr style="background:#0F766E;border-top:1px solid #0F766E;">
              <td style="padding:12px 14px;color:#fff;font-size:15px;font-weight:700;">Balance</td>
              <td style="padding:12px 14px;font-size:15px;font-weight:700;text-align:right;color:${balColor === "#059669" ? "#A7F3D0" : "#FCA5A5"};">${balSign}৳${fmt(Math.abs(summary.balance))}</td>
            </tr>
          </tbody>
        </table>

        <!-- Mess totals -->
        <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:16px 20px;margin-bottom:24px;">
          <p style="margin:0 0 8px;color:#6B7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Mess Totals for ${monthLabel}</p>
          <p style="margin:4px 0;color:#374151;font-size:13px;">Total meals: <strong>${summary.totalMeals}</strong></p>
          <p style="margin:4px 0;color:#374151;font-size:13px;">Total expenses: <strong>৳${fmt(summary.totalExpenses)}</strong></p>
        </div>

        ${
          summary.balance < 0
            ? `<div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:10px;padding:14px 18px;margin-bottom:24px;">
               <p style="margin:0;color:#DC2626;font-size:14px;font-weight:600;">⚠️ You have an outstanding balance of ৳${fmt(Math.abs(summary.balance))}. Please deposit to clear it.</p>
             </div>`
            : `<div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:10px;padding:14px 18px;margin-bottom:24px;">
               <p style="margin:0;color:#059669;font-size:14px;font-weight:600;">✓ You're all clear! You have a positive balance of ৳${fmt(summary.balance)}.</p>
             </div>`
        }

        <p style="color:#9CA3AF;font-size:12px;margin-top:32px;">This is an automated summary from Mess Manager.</p>
      </div>
    `,
  });
}

export async function sendWelcomeEmail(
  to: string,
  name: string,
  messName: string,
  password: string,
): Promise<void> {
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to,
    subject: `You've been added to ${messName} on Mess Manager`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
        <h2 style="color:#0F766E;margin-bottom:8px;">Welcome to ${messName}!</h2>
        <p style="color:#374151;">Hi <strong>${name}</strong>,</p>
        <p style="color:#374151;">You've been added to <strong>${messName}</strong> on Mess Manager. Use the credentials below to log in:</p>
        <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:20px;margin:24px 0;">
          <p style="margin:0 0 10px;color:#374151;"><strong>Email:</strong> ${to}</p>
          <p style="margin:0;color:#374151;"><strong>Password:</strong> <code style="background:#F3F4F6;padding:2px 6px;border-radius:4px;">${password}</code></p>
        </div>
        <p style="color:#DC2626;font-size:14px;">For security, please change your password after your first login.</p>
        <p style="color:#9CA3AF;font-size:12px;margin-top:32px;">This is an automated message from Mess Manager.</p>
      </div>
    `,
  });
}
