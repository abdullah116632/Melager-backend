import { Router } from 'express';
import authRoutes from './authRoutes.js';

const router = Router();

router.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Mela Management API is running.',
  });
});

// Feature routes will be registered here
router.use('/auth', authRoutes);
// router.use('/meals', mealRoutes);

export default router;
