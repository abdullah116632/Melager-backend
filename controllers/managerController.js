import mongoose from 'mongoose';
import Manager from '../models/managerModel.js';
import Consumer from '../models/consumerModel.js';
import ConsumerRequest from '../models/consumerRequestModel.js';
import MessMember from '../models/messMemberModel.js';
import MonthlyMeal from '../models/monthlyMealModel.js';
import customError from '../utils/customErrorClass.js';

const formatManager = (manager) => ({
  id: manager._id,
  nameOfMess: manager.nameOfMess,
  phnNumber: manager.phnNumber,
  email: manager.email,
  subscriptionStartDate: manager.subscriptionStartDate,
  subscriptionEndDate: manager.subscriptionEndDate,
  fullControl: manager.fullControl,
  language: manager.language,
});

const formatMessMember = (membership) => ({
  id: membership._id,
  managerId: membership.manager,
  consumerId: membership.consumer?._id || null,
  isActive: membership.isActive,
  joinedAt: membership.joinedAt,
  consumer: membership.consumer
    ? {
        id: membership.consumer._id,
        name: membership.consumer.name,
        phnNumber: membership.consumer.phnNumber,
        email: membership.consumer.email,
      }
    : null,
});

const formatConsumerRequest = (requestDoc) => ({
  id: requestDoc._id,
  status: requestDoc.status,
  note: requestDoc.note,
  requestedAt: requestDoc.requestedAt,
  reviewedAt: requestDoc.reviewedAt,
  consumer: requestDoc.consumer
    ? {
        id: requestDoc.consumer._id,
        name: requestDoc.consumer.name,
        phnNumber: requestDoc.consumer.phnNumber,
        email: requestDoc.consumer.email,
      }
    : null,
});

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ensureCurrentMonthlyMealSheet = async ({ consumerId, managerId }) => {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  await MonthlyMeal.findOneAndUpdate(
    {
      consumerId,
      managerId,
      month,
      year,
    },
    {
      $setOnInsert: {
        consumerId,
        managerId,
        month,
        year,
      },
    },
    {
      upsert: true,
      new: true,
    }
  );
};

//done
export const searchManager = async (req, res, next) => {
  try {
    const rawEmail = req.query.email?.toString().trim();
    const rawPhnNumber = req.query.phnNumber?.toString().trim();
    const rawMessName = (req.query.messName || req.query.nameOfMess)?.toString().trim();

    if (!rawEmail && !rawPhnNumber && !rawMessName) {
      return next(new customError(400, 'Provide email, phnNumber, or messName to search'));
    }

    const email = rawEmail ? rawEmail.toLowerCase() : null;
    const phnNumber = rawPhnNumber || null;
    const messName = rawMessName || null;

    const exactOrFilters = [];
    const partialOrFilters = [];

    if (email) {
      const escapedEmail = escapeRegex(email);
      exactOrFilters.push({ email: { $regex: `^${escapedEmail}$`, $options: 'i' } });
      partialOrFilters.push({ email: { $regex: escapedEmail, $options: 'i' } });
    }

    if (phnNumber) {
      const escapedPhnNumber = escapeRegex(phnNumber);
      exactOrFilters.push({ phnNumber: { $regex: `^${escapedPhnNumber}$`, $options: 'i' } });
      partialOrFilters.push({ phnNumber: { $regex: escapedPhnNumber, $options: 'i' } });
    }

    if (messName) {
      const escapedMessName = escapeRegex(messName);
      exactOrFilters.push({ nameOfMess: { $regex: `^${escapedMessName}$`, $options: 'i' } });
      partialOrFilters.push({ nameOfMess: { $regex: escapedMessName, $options: 'i' } });
    }

    const managers = await Manager.find({
      verified: true,
      $or: [...exactOrFilters, ...partialOrFilters],
    });

    res.status(200).json({
      status: 'success',
      results: managers.length,
      data: {
        managers: managers.map(formatManager),
      },
    });
  } catch (error) {
    next(error);
  }
};
// done
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
        manager: formatManager(manager),
      },
    });
  } catch (error) {
    next(error);
  }
};

// done
export const getManagerMembersById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new customError(400, 'Invalid manager id'));
    }

    if (req.manager._id.toString() !== id) {
      return next(new customError(403, 'You are not allowed to access these members'));
    }

    const memberships = await MessMember.find({
      manager: id,
      isActive: true,
    })
      .populate({ path: 'consumer', select: 'name phnNumber email' })
      .sort({ joinedAt: -1 });

    res.status(200).json({
      status: 'success',
      results: memberships.length,
      data: {
        members: memberships.map(formatMessMember),
      },
    });
  } catch (error) {
    next(error);
  }
};
// done
export const getManagerConsumerRequestsById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new customError(400, 'Invalid manager id'));
    }

    if (req.manager._id.toString() !== id) {
      return next(new customError(403, 'You are not allowed to access these requests'));
    }

    const requests = await ConsumerRequest.find({ manager: id })
      .populate({ path: 'consumer', select: 'name phnNumber email' })
      .sort({ requestedAt: -1 });

    res.status(200).json({
      status: 'success',
      results: requests.length,
      data: {
        requests: requests.map(formatConsumerRequest),
      },
    });
  } catch (error) {
    next(error);
  }
};
// done
export const acceptConsumerRequest = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new customError(400, 'Invalid request id'));
    }

    const requestDoc = await ConsumerRequest.findById(id);

    if (!requestDoc) {
      return next(new customError(404, 'Consumer request not found'));
    }

    if (requestDoc.manager.toString() !== req.manager._id.toString()) {
      return next(new customError(403, 'You are not allowed to accept this request'));
    }

    if (requestDoc.status !== 'accepted') {
      requestDoc.status = 'accepted';
      requestDoc.reviewedAt = new Date();
      requestDoc.reviewedBy = req.manager._id;
      await requestDoc.save({ validateBeforeSave: false });
    }

    await MessMember.findOneAndUpdate(
      {
        consumer: requestDoc.consumer,
        manager: requestDoc.manager,
      },
      {
        $set: {
          isActive: true,
          role: 'consumer',
        },
        $setOnInsert: {
          joinedAt: new Date(),
        },
      },
      {
        upsert: true,
        new: true,
      }
    );

    await ensureCurrentMonthlyMealSheet({
      consumerId: requestDoc.consumer,
      managerId: requestDoc.manager,
    });

    res.status(200).json({
      status: 'success',
      data: {
        request: {
          id: requestDoc._id,
          status: requestDoc.status,
          reviewedAt: requestDoc.reviewedAt,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
// done
export const rejectConsumerRequest = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new customError(400, 'Invalid request id'));
    }

    const requestDoc = await ConsumerRequest.findById(id);

    if (!requestDoc) {
      return next(new customError(404, 'Consumer request not found'));
    }

    if (requestDoc.manager.toString() !== req.manager._id.toString()) {
      return next(new customError(403, 'You are not allowed to reject this request'));
    }

    if (requestDoc.status !== 'rejected') {
      requestDoc.status = 'rejected';
      requestDoc.reviewedAt = new Date();
      requestDoc.reviewedBy = req.manager._id;
      await requestDoc.save({ validateBeforeSave: false });
    }

    await MessMember.findOneAndUpdate(
      {
        consumer: requestDoc.consumer,
        manager: requestDoc.manager,
      },
      {
        $set: {
          isActive: false,
        },
      }
    );

    res.status(200).json({
      status: 'success',
      data: {
        request: {
          id: requestDoc._id,
          status: requestDoc.status,
          reviewedAt: requestDoc.reviewedAt,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// done
export const createConsumerAndAddToMess = async (req, res, next) => {
  try {
    const rawName = req.body.name?.toString().trim();
    const rawPhnNumber = req.body.phnNumber?.toString().trim();
    const rawEmail = req.body.email?.toString().trim();

    if (!rawName || !rawPhnNumber || !rawEmail) {
      return next(new customError(400, 'name, phnNumber and email are required'));
    }

    const email = rawEmail.toLowerCase();
    const phnNumber = rawPhnNumber;

    const [consumerByEmail, consumerByPhone] = await Promise.all([
      Consumer.findOne({ email }),
      Consumer.findOne({ phnNumber }),
    ]);

    if (
      consumerByEmail &&
      consumerByPhone &&
      consumerByEmail._id.toString() !== consumerByPhone._id.toString()
    ) {
      return next(
        new customError(
          409,
          'Consumer conflict: this email and phone number belong to different consumers'
        )
      );
    }

    let consumer = consumerByEmail || consumerByPhone;
    let consumerCreated = false;

    if (!consumer) {
      consumer = await Consumer.create({
        name: rawName,
        phnNumber,
        email,
      });
      consumerCreated = true;
    } else {
      let hasChanges = false;

      if (consumer.name !== rawName) {
        consumer.name = rawName;
        hasChanges = true;
      }

      if (consumer.phnNumber !== phnNumber) {
        consumer.phnNumber = phnNumber;
        hasChanges = true;
      }

      if (consumer.email !== email) {
        consumer.email = email;
        hasChanges = true;
      }

      if (!consumer.isActive) {
        consumer.isActive = true;
        hasChanges = true;
      }

      consumer.lastSeenAt = new Date();
      hasChanges = true;

      if (hasChanges) {
        await consumer.save();
      }
    }

    const membership = await MessMember.findOneAndUpdate(
      {
        consumer: consumer._id,
        manager: req.manager._id,
      },
      {
        $set: {
          isActive: true,
          role: 'consumer',
        },
        $setOnInsert: {
          joinedAt: new Date(),
        },
      },
      {
        new: true,
        upsert: true,
      }
    );

    await ensureCurrentMonthlyMealSheet({
      consumerId: consumer._id,
      managerId: req.manager._id,
    });

    res.status(consumerCreated ? 201 : 200).json({
      status: 'success',
      data: {
        consumer: {
          id: consumer._id,
          name: consumer.name,
          phnNumber: consumer.phnNumber,
          email: consumer.email,
        },
        membership: {
          id: membership._id,
          managerId: membership.manager,
          consumerId: membership.consumer,
          isActive: membership.isActive,
          joinedAt: membership.joinedAt,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
