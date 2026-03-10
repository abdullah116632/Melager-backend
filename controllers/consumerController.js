import mongoose from 'mongoose';
import Consumer from '../models/consumerModel.js';
import ConsumerRequest from '../models/consumerRequestModel.js';
import Manager from '../models/managerModel.js';
import MessMember from '../models/messMemberModel.js';
import customError from '../utils/customErrorClass.js';
import { getConsumerSessionFromRequest, setConsumerSessionCookie } from '../utils/consumerSession.js';

const formatRequest = (requestDoc) => ({
  id: requestDoc._id,
  status: requestDoc.status,
  note: requestDoc.note,
  requestedAt: requestDoc.requestedAt,
  reviewedAt: requestDoc.reviewedAt,
  manager: requestDoc.manager
    ? {
        id: requestDoc.manager._id,
        nameOfMess: requestDoc.manager.nameOfMess,
        email: requestDoc.manager.email,
        phnNumber: requestDoc.manager.phnNumber,
      }
    : null,
});

const formatMembership = (membershipDoc) => ({
  id: membershipDoc._id,
  joinedAt: membershipDoc.joinedAt,
  manager: membershipDoc.manager
    ? {
        id: membershipDoc.manager._id,
        nameOfMess: membershipDoc.manager.nameOfMess,
        email: membershipDoc.manager.email,
        phnNumber: membershipDoc.manager.phnNumber,
        language: membershipDoc.manager.language,
      }
    : null,
});

const getSessionConsumer = async (req) => {
  const session = getConsumerSessionFromRequest(req);

  if (!session?.sessionId) {
    return null;
  }

  return Consumer.findOne({ sessionId: session.sessionId, isActive: true });
};
// done
export const loadConsumerSession = async (req, res, next) => {
  try {
    const body = req.body || {};
    const rawEmail = body.email?.toString().trim();
    const rawPhnNumber = body.phnNumber?.toString().trim();

    if (!rawEmail && !rawPhnNumber) {
      return next(new customError(400, 'Provide email or phnNumber to load your data'));
    }

    const email = rawEmail ? rawEmail.toLowerCase() : null;
    const phnNumber = rawPhnNumber || null;

    const filters = [];

    if (email) {
      filters.push({ email });
    }

    if (phnNumber) {
      filters.push({ phnNumber });
    }

    const consumers = await Consumer.find({
      isActive: true,
      $or: filters,
    }).sort({ updatedAt: -1 });

    if (!consumers.length) {
      return next(new customError(404, 'No consumer data found with provided email or phone'));
    }

    const consumer = consumers[0];

    if (email && phnNumber && (consumer.email !== email || consumer.phnNumber !== phnNumber)) {
      return next(new customError(409, 'Provided email and phone do not match the same consumer'));
    }

    consumer.lastSeenAt = new Date();
    await consumer.save({ validateBeforeSave: false });

    setConsumerSessionCookie(res, consumer.sessionId);

    res.status(200).json({
      status: 'success',
      message: 'Consumer session loaded in this browser',
      data: {
        consumer: {
          id: consumer._id,
          name: consumer.name,
          phnNumber: consumer.phnNumber,
          email: consumer.email,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
// done
export const requestJoinMess = async (req, res, next) => {
  try {
    const body = req.body || {};
    const managerId = body.managerId;
    const name = body.name?.toString().trim();
    const phnNumber = body.phnNumber?.toString().trim();
    const email = body.email?.toString().trim().toLowerCase();
    const note = body.note;

    if (!managerId) {
      return next(new customError(400, 'managerId is required'));
    }

    if (!mongoose.Types.ObjectId.isValid(managerId)) {
      return next(new customError(400, 'Invalid managerId'));
    }

    const manager = await Manager.findOne({ _id: managerId, verified: true });

    if (!manager) {
      return next(new customError(404, 'Verified manager not found'));
    }

    const consumerFromSession = await getSessionConsumer(req);
    let consumer = consumerFromSession;
    let shouldSetCookie = false;

    if (email || phnNumber) {
      const [consumerByEmail, consumerByPhone] = await Promise.all([
        email ? Consumer.findOne({ email, isActive: true }) : Promise.resolve(null),
        phnNumber ? Consumer.findOne({ phnNumber, isActive: true }) : Promise.resolve(null),
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

      const identifiedConsumer = consumerByEmail || consumerByPhone;

      if (identifiedConsumer) {
        consumer = identifiedConsumer;
      } else {
        if (!name || !phnNumber || !email) {
          return next(new customError(400, 'name, phnNumber and email are required for first request'));
        }

        consumer = await Consumer.create({
          name,
          phnNumber,
          email,
        });
      }

      if (!consumerFromSession || consumerFromSession._id.toString() !== consumer._id.toString()) {
        shouldSetCookie = true;
      }
    }

    if (!consumer) {
      if (!name || !phnNumber || !email) {
        return next(new customError(400, 'name, phnNumber and email are required for first request'));
      }

      consumer = await Consumer.create({
        name,
        phnNumber,
        email,
      });

      shouldSetCookie = true;
    }

    let hasChange = false;

    if (name && name !== consumer.name) {
      consumer.name = name;
      hasChange = true;
    }

    if (phnNumber && phnNumber !== consumer.phnNumber) {
      consumer.phnNumber = phnNumber;
      hasChange = true;
    }

    if (email && email !== consumer.email) {
      consumer.email = email;
      hasChange = true;
    }

    consumer.lastSeenAt = new Date();
    hasChange = true;

    if (hasChange) {
      await consumer.save();
    }

    const existingPendingRequest = await ConsumerRequest.findOne({
      consumer: consumer._id,
      manager: manager._id,
      status: 'pending',
    });

    if (existingPendingRequest) {
      return next(new customError(409, 'A pending request already exists for this mess'));
    }

    const requestDoc = await ConsumerRequest.create({
      consumer: consumer._id,
      manager: manager._id,
      status: 'pending',
      note: note || '',
    });

    if (shouldSetCookie) {
      setConsumerSessionCookie(res, consumer.sessionId);
    }

    res.status(201).json({
      status: 'success',
      data: {
        request: {
          id: requestDoc._id,
          status: requestDoc.status,
          manager: {
            id: manager._id,
            nameOfMess: manager.nameOfMess,
            email: manager.email,
            phnNumber: manager.phnNumber,
          },
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
// done
export const getMyRequests = async (req, res, next) => {
  try {
    const consumer = await getSessionConsumer(req);

    if (!consumer) {
      return next(new customError(401, 'No consumer session found in this browser'));
    }

    const requests = await ConsumerRequest.find({ consumer: consumer._id })
      .populate({ path: 'manager', select: 'nameOfMess email phnNumber' })
      .sort({ createdAt: -1 });

    res.status(200).json({
      status: 'success',
      results: requests.length,
      data: {
        requests: requests.map(formatRequest),
      },
    });
  } catch (error) {
    next(error);
  }
};

// done
export const getMessMembershipByIds = async (req, res, next) => {
  try {
    const rawConsumerId = req.query.consumerId?.toString().trim();
    const rawManagerId = req.query.managerId?.toString().trim();

    if (!rawConsumerId || !rawManagerId) {
      return next(new customError(400, 'consumerId and managerId are required'));
    }

    if (!mongoose.Types.ObjectId.isValid(rawConsumerId)) {
      return next(new customError(400, 'Invalid consumerId'));
    }

    if (!mongoose.Types.ObjectId.isValid(rawManagerId)) {
      return next(new customError(400, 'Invalid managerId'));
    }

    const membershipDoc = await MessMember.findOne({
      consumer: rawConsumerId,
      manager: rawManagerId,
    })
      .populate({ path: 'consumer', select: 'name email phnNumber' })
      .populate({ path: 'manager', select: 'nameOfMess email phnNumber' });

    if (!membershipDoc) {
      return next(new customError(404, 'Membership not found'));
    }

    res.status(200).json({
      status: 'success',
      data: {
        request: {
          id: membershipDoc._id,
          status: membershipDoc.isActive ? 'accepted' : 'rejected',
          note: '',
          requestedAt: membershipDoc.joinedAt,
          reviewedAt: null,
          consumer: membershipDoc.consumer
            ? {
                id: membershipDoc.consumer._id,
                name: membershipDoc.consumer.name,
                email: membershipDoc.consumer.email,
                phnNumber: membershipDoc.consumer.phnNumber,
              }
            : null,
          manager: membershipDoc.manager
            ? {
                id: membershipDoc.manager._id,
                nameOfMess: membershipDoc.manager.nameOfMess,
                email: membershipDoc.manager.email,
                phnNumber: membershipDoc.manager.phnNumber,
              }
            : null,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
// done
export const getMyMesses = async (req, res, next) => {
  try {
    const consumer = await getSessionConsumer(req);

    if (!consumer) {
      return next(new customError(401, 'No consumer session found in this browser'));
    }

    const memberships = await MessMember.find({
      consumer: consumer._id,
      isActive: true,
    })
      .populate({ path: 'manager', select: 'nameOfMess email phnNumber language' })
      .sort({ joinedAt: -1 });

    res.status(200).json({
      status: 'success',
      results: memberships.length,
      data: {
        messes: memberships.map(formatMembership),
      },
    });
  } catch (error) {
    next(error);
  }
};
