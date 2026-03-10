import mongoose from 'mongoose';
import MonthlyMeal from '../models/monthlyMealModel.js';
import customError from '../utils/customErrorClass.js';

const formatMonthlyMeal = (doc) => ({
  id: doc._id,
  consumerId: doc.consumerId?._id || doc.consumerId,
  managerId: doc.managerId,
  month: doc.month,
  year: doc.year,
  meals: doc.meals,
  totalsMela: doc.totalsMela,
  consumer: doc.consumerId
    ? {
        id: doc.consumerId._id,
        name: doc.consumerId.name,
        phnNumber: doc.consumerId.phnNumber,
        email: doc.consumerId.email,
      }
    : null,
});

export const getMonthlyMealsByManagerId = async (req, res, next) => {
  try {
    const { managerId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(managerId)) {
      return next(new customError(400, 'Invalid manager id'));
    }

    if (req.manager._id.toString() !== managerId) {
      return next(new customError(403, 'You are not allowed to access these monthly meals'));
    }

    const monthlyMeals = await MonthlyMeal.find({ managerId })
      .populate({ path: 'consumerId', select: 'name phnNumber email' })
      .sort({ year: -1, month: -1, createdAt: -1 });

    res.status(200).json({
      status: 'success',
      results: monthlyMeals.length,
      data: {
        monthlyMeals: monthlyMeals.map(formatMonthlyMeal),
      },
    });
  } catch (error) {
    next(error);
  }
};
