import jwt from 'jsonwebtoken';

const generateToken = (manager) => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }

  return jwt.sign(
    {
      id: manager._id,
      email: manager.email,
    },
    secret,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || '15d',
    }
  );
};

export default generateToken;
