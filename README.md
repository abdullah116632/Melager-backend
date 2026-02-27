# Mela Management Backend

This is the backend server for a **Mela Management Application**.

The goal of this project is to solve daily meal-management problems where records are usually kept on paper. This system helps digitize the process and automatically calculates meal-related data.

## Project Purpose

- Replace paper-based daily meal tracking
- Manage meal data in a structured way
- Automatically calculate totals and related values
- Provide a scalable backend for future web/mobile clients

## Tech Stack

- Node.js
- Express.js
- MongoDB + Mongoose
- Socket.IO (real-time notifications)

## Security Middleware

- Helmet
- Mongo sanitize
- XSS clean
- Rate limiter on `/api/auth`

## Run Locally

1. Install dependencies:
	- `npm install`
2. Add environment variables in `.env` (see `.env.example`)
3. Run development server:
	- `npm run dev`

## Available Scripts

- `npm run dev` → Start with nodemon
- `npm start` → Start with node

---

This repository currently contains the backend foundation. API modules for auth, meals, and management features will be added next.
