import bcrypt from "bcryptjs";

const PASSWORD_SALT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 6;

export const isPasswordValid = (password: string): boolean =>
  password.length >= MIN_PASSWORD_LENGTH;

export const hashPassword = async (password: string): Promise<string> =>
  bcrypt.hash(password, PASSWORD_SALT_ROUNDS);

export const verifyPassword = async (
  password: string,
  passwordHash: string,
): Promise<boolean> => bcrypt.compare(password, passwordHash);
