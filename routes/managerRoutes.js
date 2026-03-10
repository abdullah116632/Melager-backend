import { Router } from 'express';
import {
	acceptConsumerRequest,
	createConsumerAndAddToMess,
	getManagerProfileById,
	rejectConsumerRequest,
	searchManager,
} from '../controllers/managerController.js';
import { protectManager } from '../middleware/authMiddleware.js';

const router = Router();

router.get('/search', searchManager);
router.post('/consumers', protectManager, createConsumerAndAddToMess);
router.post('/requests/:id/accept', protectManager, acceptConsumerRequest);
router.post('/requests/:id/reject', protectManager, rejectConsumerRequest);
router.get('/:id/profile', protectManager, getManagerProfileById);

export default router;
