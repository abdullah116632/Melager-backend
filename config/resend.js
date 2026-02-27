import { Resend } from 'resend';
import customError from '../utils/customErrorClass.js';

let resendClient;

const getResendClient = () => {
	if (!process.env.RESEND_API_KEY) {
		throw new customError(500, 'RESEND_API_KEY is not configured');
	}

	if (!resendClient) {
		resendClient = new Resend(process.env.RESEND_API_KEY);
	}

	return resendClient;
};

export default getResendClient;
