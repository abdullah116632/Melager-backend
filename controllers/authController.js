import Manager from '../models/managerModel.js';
import Otp from '../models/otpModel.js';
import customError from '../utils/customErrorClass.js';
import sendMail from '../utils/sendMail.js';
import generateToken from '../utils/generateToken.js';
import bcrypt from 'bcryptjs';

const createSixDigitOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

const sendOtpEmail = async (email, otp) => {
  await sendMail(
    email,
    'Your Manager Account Verification OTP',
    `
      <div style="margin: 0; padding: 24px; background-color: #f4f6f8; font-family: Arial, sans-serif; color: #1f2937;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden;">
          <tr>
            <td style="padding: 24px; background-color: #111827; color: #ffffff; text-align: center;">
              <h2 style="margin: 0; font-size: 20px; font-weight: 700;">Account Verification</h2>
            </td>
          </tr>
          <tr>
            <td style="padding: 28px 24px;">
              <p style="margin: 0 0 14px; font-size: 15px; line-height: 1.6;">Hello,</p>
              <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.6;">Use the one-time password (OTP) below to verify your manager account.</p>
              <div style="margin: 0 0 20px; text-align: center;">
                <span style="display: inline-block; padding: 12px 22px; font-size: 30px; font-weight: 700; letter-spacing: 8px; color: #111827; background: #f9fafb; border: 1px dashed #d1d5db; border-radius: 8px;">${otp}</span>
              </div>
              <p style="margin: 0 0 10px; font-size: 14px; line-height: 1.6;">This OTP will expire in <strong>10 minutes</strong>.</p>
              <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #6b7280;">If you didn’t request this, you can safely ignore this email.</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 24px; border-top: 1px solid #e5e7eb; background: #f9fafb; text-align: center; font-size: 12px; color: #6b7280;">
              Meal Management System
            </td>
          </tr>
        </table>
      </div>
    `
  );
};

const sendPasswordResetOtpEmail = async (email, otp) => {
  await sendMail(
    email,
    'Your Password Reset OTP',
    `
      <div style="margin: 0; padding: 24px; background-color: #f4f6f8; font-family: Arial, sans-serif; color: #1f2937;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden;">
          <tr>
            <td style="padding: 24px; background-color: #111827; color: #ffffff; text-align: center;">
              <h2 style="margin: 0; font-size: 20px; font-weight: 700;">Password Reset</h2>
            </td>
          </tr>
          <tr>
            <td style="padding: 28px 24px;">
              <p style="margin: 0 0 14px; font-size: 15px; line-height: 1.6;">Hello,</p>
              <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.6;">Use the one-time password (OTP) below to verify your password reset request.</p>
              <div style="margin: 0 0 20px; text-align: center;">
                <span style="display: inline-block; padding: 12px 22px; font-size: 30px; font-weight: 700; letter-spacing: 8px; color: #111827; background: #f9fafb; border: 1px dashed #d1d5db; border-radius: 8px;">${otp}</span>
              </div>
              <p style="margin: 0 0 10px; font-size: 14px; line-height: 1.6;">This OTP will expire in <strong>10 minutes</strong>.</p>
              <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #6b7280;">If you didn’t request this, you can safely ignore this email.</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 24px; border-top: 1px solid #e5e7eb; background: #f9fafb; text-align: center; font-size: 12px; color: #6b7280;">
              Meal Management System
            </td>
          </tr>
        </table>
      </div>
    `
  );
};

export const registerManager = async (req, res, next) => {
  try {
    const manager = await Manager.create({ ...req.body, verified: false });

    const otp = createSixDigitOtp();
    const otpHash = await bcrypt.hash(otp, 12);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await Otp.deleteMany({ manager: manager._id, purpose: 'account_verification' });
    await Otp.create({
      manager: manager._id,
      email: manager.email,
      otpHash,
      purpose: 'account_verification',
      expiresAt,
    });

    await sendOtpEmail(manager.email, otp);

    res.status(201).json({
      status: 'success',
      message: 'Manager account created. Please verify OTP sent to email.',
      data: {
        manager: {
          id: manager._id,
          email: manager.email,
          verified: manager.verified,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

export const verifyManagerOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return next(new customError(400, 'Email and OTP are required'));
    }

    const manager = await Manager.findOne({ email });

    if (!manager) {
      return next(new customError(404, 'Manager account not found'));
    }

    const otpDoc = await Otp.findOne({ manager: manager._id, purpose: 'account_verification' }).sort({ createdAt: -1 });

    if (!otpDoc) {
      return next(new customError(400, 'OTP not found. Please register again.'));
    }

    if (otpDoc.expiresAt < new Date()) {
      await Otp.deleteMany({ manager: manager._id, purpose: 'account_verification' });
      return next(new customError(400, 'OTP has expired. Please request a new OTP.'));
    }

    const isOtpValid = await bcrypt.compare(otp, otpDoc.otpHash);

    if (!isOtpValid) {
      return next(new customError(400, 'Invalid OTP'));
    }

    manager.verified = true;
    await manager.save({ validateBeforeSave: false });

    await Otp.deleteMany({ manager: manager._id, purpose: 'account_verification' });

    const token = generateToken(manager);

    res.status(200).json({
      status: 'success',
      message: 'Manager verified successfully',
      data: {
        token,
        manager: {
          id: manager._id,
          nameOfMess: manager.nameOfMess,
          phnNumber: manager.phnNumber,
          email: manager.email,
          subscriptionStartDate: manager.subscriptionStartDate,
          subscriptionEndDate: manager.subscriptionEndDate,
          fullControl: manager.fullControl,
          language: manager.language,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

export const resendManagerOtp = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return next(new customError(400, 'Email is required'));
    }

    const manager = await Manager.findOne({ email });

    if (!manager) {
      return next(new customError(404, 'Manager account not found'));
    }

    if (manager.verified) {
      return next(new customError(400, 'Manager is already verified'));
    }

    const otp = createSixDigitOtp();
    const otpHash = await bcrypt.hash(otp, 12);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await Otp.deleteMany({ manager: manager._id, purpose: 'account_verification' });
    await Otp.create({
      manager: manager._id,
      email: manager.email,
      otpHash,
      purpose: 'account_verification',
      expiresAt,
    });

    await sendOtpEmail(manager.email, otp);

    res.status(200).json({
      status: 'success',
      message: 'A new OTP has been sent to your email.',
    });
  } catch (error) {
    next(error);
  }
};

export const loginManager = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return next(new customError(400, 'Email and password are required'));
    }

    const manager = await Manager.findOne({ email }).select('+password');

    if (!manager) {
      return next(new customError(401, 'Invalid email or password'));
    }

    if (!manager.verified) {
      return next(new customError(403, 'Please verify your account with OTP first'));
    }

    const isPasswordValid = await manager.comparePassword(password);

    if (!isPasswordValid) {
      return next(new customError(401, 'Invalid email or password'));
    }

    const token = generateToken(manager);

    res.status(200).json({
      status: 'success',
      message: 'Login successful',
      data: {
        token,
        manager: {
          id: manager._id,
          nameOfMess: manager.nameOfMess,
          phnNumber: manager.phnNumber,
          email: manager.email,
          subscriptionStartDate: manager.subscriptionStartDate,
          subscriptionEndDate: manager.subscriptionEndDate,
          fullControl: manager.fullControl,
          language: manager.language,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

export const requestPasswordResetOtp = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return next(new customError(400, 'Email is required'));
    }

    const manager = await Manager.findOne({ email });

    if (!manager) {
      return next(new customError(404, 'Manager account not found'));
    }

    const otp = createSixDigitOtp();
    const otpHash = await bcrypt.hash(otp, 12);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await Otp.deleteMany({ manager: manager._id, purpose: 'password_reset' });
    await Otp.create({
      manager: manager._id,
      email: manager.email,
      otpHash,
      purpose: 'password_reset',
      isVerified: false,
      expiresAt,
    });

    await sendPasswordResetOtpEmail(manager.email, otp);

    res.status(200).json({
      status: 'success',
      message: 'Password reset OTP sent to your email.',
    });
  } catch (error) {
    next(error);
  }
};

export const verifyPasswordResetOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return next(new customError(400, 'Email and OTP are required'));
    }

    const manager = await Manager.findOne({ email });

    if (!manager) {
      return next(new customError(404, 'Manager account not found'));
    }

    const otpDoc = await Otp.findOne({ manager: manager._id, purpose: 'password_reset' }).sort({ createdAt: -1 });

    if (!otpDoc) {
      return next(new customError(400, 'OTP not found. Please request a new OTP.'));
    }

    if (otpDoc.expiresAt < new Date()) {
      await Otp.deleteMany({ manager: manager._id, purpose: 'password_reset' });
      return next(new customError(400, 'OTP has expired. Please request a new OTP.'));
    }

    const isOtpValid = await bcrypt.compare(otp, otpDoc.otpHash);

    if (!isOtpValid) {
      return next(new customError(400, 'Invalid OTP'));
    }

    otpDoc.isVerified = true;
    await otpDoc.save({ validateBeforeSave: false });

    res.status(200).json({
      status: 'success',
      message: 'OTP verified successfully. You can now reset your password.',
    });
  } catch (error) {
    next(error);
  }
};

export const resetPasswordWithOtp = async (req, res, next) => {
  try {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
      return next(new customError(400, 'Email and newPassword are required'));
    }

    const manager = await Manager.findOne({ email }).select('+password');

    if (!manager) {
      return next(new customError(404, 'Manager account not found'));
    }

    const otpDoc = await Otp.findOne({ manager: manager._id, purpose: 'password_reset' }).sort({ createdAt: -1 });

    if (!otpDoc) {
      return next(new customError(400, 'OTP not found. Please request a new OTP.'));
    }

    if (otpDoc.expiresAt < new Date()) {
      await Otp.deleteMany({ manager: manager._id, purpose: 'password_reset' });
      return next(new customError(400, 'OTP has expired. Please request a new OTP.'));
    }

    if (!otpDoc.isVerified) {
      return next(new customError(400, 'Please verify OTP before resetting password'));
    }

    manager.password = newPassword;
    await manager.save();

    await Otp.deleteMany({ manager: manager._id, purpose: 'password_reset' });

    res.status(200).json({
      status: 'success',
      message: 'Password reset successful. Please login with your new password.',
    });
  } catch (error) {
    next(error);
  }
};
