import { Router } from 'express';
import authRoutes from './authRoutes.js';
import consumerRoutes from './consumerRoutes.js';
import managerRoutes from './managerRoutes.js';
import monthlyMealRoutes from './monthlyMealRoutes.js';

const router = Router();

router.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Meal Management API is running.',
  });
});

// Feature routes will be registered here
router.use('/auth', authRoutes);
router.use('/consumer', consumerRoutes);
router.use('/manager', managerRoutes);
router.use('/monthly-meals', monthlyMealRoutes);
// router.use('/meals', mealRoutes);

export default router;
