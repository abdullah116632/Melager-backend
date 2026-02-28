import { Router } from 'express';
import { getManagerProfileById } from '../controllers/managerController.js';
import { protectManager } from '../middleware/authMiddleware.js';

const router = Router();

router.get('/:id/profile', protectManager, getManagerProfileById);

export default router;
