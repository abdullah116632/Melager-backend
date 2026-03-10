import mongoose from 'mongoose';

const consumerRequestSchema = new mongoose.Schema(
  {
    consumer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Consumer',
      required: true,
      index: true,
    },
    manager: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Manager',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected'],
      default: 'pending',
      index: true,
    },
    requestedAt: {
      type: Date,
      default: Date.now,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Manager',
      default: null,
    },
    note: {
      type: String,
      trim: true,
      default: '',
      maxlength: [300, 'Note cannot exceed 300 characters'],
    },
  },
  {
    timestamps: true,
  }
);

// Prevent duplicate pending requests from the same consumer to the same manager.
consumerRequestSchema.index(
  { consumer: 1, manager: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'pending' },
  }
);

const ConsumerRequest = mongoose.model('ConsumerRequest', consumerRequestSchema);

export default ConsumerRequest;
