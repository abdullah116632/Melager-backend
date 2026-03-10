import { Router } from 'express';
import {
	requestPasswordResetOtp,
	loginManager,
	registerManager,
	resetPasswordWithOtp,
	resendManagerOtp,
	verifyPasswordResetOtp,
	verifyManagerOtp,
} from '../controllers/authController.js';

const router = Router();

router.post('/register', registerManager);
router.post('/verify-otp', verifyManagerOtp);
router.post('/resend-otp', resendManagerOtp);
router.post('/login', loginManager);
router.post('/forgot-password/request-otp', requestPasswordResetOtp);
router.post('/forgot-password/verify-otp', verifyPasswordResetOtp);
router.post('/forgot-password/reset-password', resetPasswordWithOtp);

export default router;
