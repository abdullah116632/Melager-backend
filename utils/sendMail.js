import getResendClient from '../config/resend.js';
import customError from './customErrorClass.js';

const sendMail = async (to, subject, html) => {
  if (!to) {
    throw new customError(400, 'Recipient email is required');
  }

  if (!subject || !html) {
    throw new customError(400, 'Email subject and html are required');
  }

  if (!process.env.RESEND_FROM_EMAIL) {
    throw new customError(500, 'RESEND_FROM_EMAIL is not configured');
  }

  const resend = getResendClient();

  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL,
    to,
    subject,
    html,
  });
};

export default sendMail;
