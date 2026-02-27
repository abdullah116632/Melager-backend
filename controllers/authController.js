import Manager from '../models/managerModel.js';
import Otp from '../models/otpModel.js';
import customError from '../utils/customErrorClass.js';
import sendMail from '../utils/sendMail.js';
import crypto from 'crypto';

const createSixDigitOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

const hashOtp = (otp) => crypto.createHash('sha256').update(otp).digest('hex');

const sendOtpEmail = async (email, otp) => {
  await sendMail(
    email,
    'Your Manager Account Verification OTP',
    `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h2>Account Verification</h2>
        <p>Your OTP code is:</p>
        <h1 style="letter-spacing: 4px;">${otp}</h1>
        <p>This code will expire in 10 minutes.</p>
      </div>
    `
  );
};

export const registerManager = async (req, res, next) => {
  try {
    const manager = await Manager.create({ ...req.body, verified: false });

    const otp = createSixDigitOtp();
    const otpHash = hashOtp(otp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await Otp.deleteMany({ manager: manager._id });
    await Otp.create({
      manager: manager._id,
      email: manager.email,
      otpHash,
      expiresAt,
    });

    await sendOtpEmail(manager.email, otp);

    res.status(201).json({
      status: 'success',
      message: 'Manager account created. Please verify OTP sent to email.',
      data: {
        manager: {
          id: manager._id,
          nameOfMess: manager.nameOfMess,
          phnNumber: manager.phnNumber,
          email: manager.email,
          address: manager.address,
          subscriptionStartDate: manager.subscriptionStartDate,
          subscriptionEndDate: manager.subscriptionEndDate,
          isMain: manager.isMain,
          language: manager.language,
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

    const otpDoc = await Otp.findOne({ manager: manager._id }).sort({ createdAt: -1 });

    if (!otpDoc) {
      return next(new customError(400, 'OTP not found. Please register again.'));
    }

    if (otpDoc.expiresAt < new Date()) {
      await Otp.deleteMany({ manager: manager._id });
      return next(new customError(400, 'OTP has expired. Please request a new OTP.'));
    }

    const isOtpValid = otpDoc.otpHash === hashOtp(otp);

    if (!isOtpValid) {
      return next(new customError(400, 'Invalid OTP'));
    }

    manager.verified = true;
    await manager.save({ validateBeforeSave: false });

    await Otp.deleteMany({ manager: manager._id });

    res.status(200).json({
      status: 'success',
      message: 'Manager verified successfully',
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

    res.status(200).json({
      status: 'success',
      message: 'Login successful',
      data: {
        manager: {
          id: manager._id,
          nameOfMess: manager.nameOfMess,
          phnNumber: manager.phnNumber,
          email: manager.email,
          address: manager.address,
          subscriptionStartDate: manager.subscriptionStartDate,
          subscriptionEndDate: manager.subscriptionEndDate,
          isMain: manager.isMain,
          language: manager.language,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
