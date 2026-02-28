import { Router } from 'express';
import {
	loginManager,
	registerManager,
	resendManagerOtp,
	verifyManagerOtp,
} from '../controllers/authController.js';

const router = Router();

router.post('/register', registerManager);
router.post('/verify-otp', verifyManagerOtp);
router.post('/resend-otp', resendManagerOtp);
router.post('/login', loginManager);

export default router;
