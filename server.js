import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mongoSanitize from 'express-mongo-sanitize';
import xss from 'xss-clean';
import rateLimit from 'express-rate-limit';
import connectDB from './config/db.js';
import { app, server } from './config/socket.js';
import globalErrorHandler from "./controllers/errorController.js";
import customError from './utils/customErrorClass.js';

dotenv.config();

const corsOptions = {
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  credentials: true,
}

app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(mongoSanitize());
app.use(xss());

const authLimiter = rateLimit({
  max: 20,
  windowMs: 15 * 60 * 1000,
  message: 'Too many requests from this IP. Please try again after 15 minutes.',
});

app.use('/api/auth', authLimiter);

app.use((req, res, next) => {
  const error = new customError(404, `Can't find ${req.originalUrl} on this server`);
  next(error);
});

app.use(globalErrorHandler);

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  await connectDB();

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer();
