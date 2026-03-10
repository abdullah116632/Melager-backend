import mongoose from 'mongoose';

const messMemberSchema = new mongoose.Schema(
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
    role: {
      type: String,
      enum: ['consumer'],
      default: 'consumer',
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// One consumer can be a member of a manager's mess only once.
messMemberSchema.index({ consumer: 1, manager: 1 }, { unique: true });

const MessMember = mongoose.model('MessMember', messMemberSchema);

export default MessMember;
