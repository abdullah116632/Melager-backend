import jwt from 'jsonwebtoken';
import Manager from '../models/managerModel.js';
import customError from '../utils/customErrorClass.js';

export const protectManager = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new customError(401, 'You are not logged in. Please provide a valid token'));
    }

    const token = authHeader.split(' ')[1];

    if (!process.env.JWT_SECRET) {
      return next(new customError(500, 'JWT_SECRET is not configured'));
    }

    let decodedToken;

    try {
      decodedToken = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      return next(new customError(401, 'Invalid or expired token. Please login again'));
    }

    const manager = await Manager.findById(decodedToken.id);

    if (!manager) {
      return next(new customError(401, 'The manager belonging to this token no longer exists'));
    }

    if (!manager.verified) {
      return next(new customError(403, 'Your account is not verified yet'));
    }

    req.manager = manager;
    next();
  } catch (error) {
    next(error);
  }
};
