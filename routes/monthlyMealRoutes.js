import { Router } from 'express';
import { getMonthlyMealsByManagerId } from '../controllers/monthlyMealController.js';
import { protectManager } from '../middleware/authMiddleware.js';

const router = Router();

router.get('/manager/:managerId', protectManager, getMonthlyMealsByManagerId);

export default router;
