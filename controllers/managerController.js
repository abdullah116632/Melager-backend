import mongoose from 'mongoose';
import Manager from '../models/managerModel.js';
import customError from '../utils/customErrorClass.js';

export const getManagerProfileById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new customError(400, 'Invalid manager id'));
    }

    if (req.manager._id.toString() !== id) {
      return next(new customError(403, 'You are not allowed to access this manager profile'));
    }

    const manager = await Manager.findById(id);

    if (!manager) {
      return next(new customError(404, 'Manager not found'));
    }

    res.status(200).json({
      status: 'success',
      data: {
        manager: {
          id: manager._id,
          nameOfMess: manager.nameOfMess,
          phnNumber: manager.phnNumber,
          email: manager.email,
          subscriptionStartDate: manager.subscriptionStartDate,
          subscriptionEndDate: manager.subscriptionEndDate,
          fullControl: manager.fullControl,
          language: manager.language,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
