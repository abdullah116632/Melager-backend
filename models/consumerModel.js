import mongoose from 'mongoose';
import { randomUUID } from 'crypto';

const consumerSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
      default: () => randomUUID(),
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Consumer name is required'],
      trim: true,
    },
    phnNumber: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
      index: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

const Consumer = mongoose.model('Consumer', consumerSchema);

export default Consumer;
