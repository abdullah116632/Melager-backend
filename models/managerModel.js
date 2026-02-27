import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const managerSchema = new mongoose.Schema(
  {
    nameOfMess: {
      type: String,
      required: [true, 'Mess name is required'],
      trim: true,
    },
    phnNumber: {
      type: String,
      required: [true, 'Phone number is required'],
      unique: true,
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    address: {
      type: String,
      required: [true, 'Address is required'],
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters long'],
      select: false,
    },
    subscriptionStartDate: {
      type: Date,
      default: Date.now,
    },
    subscriptionEndDate: {
      type: Date,
      default: null,
    },
    isMain: {
      type: Boolean,
      default: true,
    },
    language: {
      type: String,
      enum: ['bn', 'en'],
      default: 'bn',
    },
    verified: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

managerSchema.pre('save', async function () {
  if (!this.isModified('password')) return; // no next needed
  this.password = await bcrypt.hash(this.password, 12);
});

managerSchema.methods.comparePassword = async function comparePassword(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

const Manager = mongoose.model('Manager', managerSchema);

export default Manager;
