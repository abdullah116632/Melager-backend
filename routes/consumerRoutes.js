import { Router } from 'express';
import {
	getMessMembershipByIds,
	getMyMesses,
	getMyRequests,
	loadConsumerSession,
	requestJoinMess,
} from '../controllers/consumerController.js';

const router = Router();

router.post('/request-join', requestJoinMess);
router.post('/load-session', loadConsumerSession);
router.get('/membership', getMessMembershipByIds);
router.get('/my-requests', getMyRequests); // get all requests of the logged-in consumer
router.get('/my-messes', getMyMesses);

export default router;
