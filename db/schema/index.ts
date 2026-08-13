import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  jsonb,
  unique,
  index,
} from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  // The immutable Google account identifier. Keeping it separate from email
  // lets an email/password account be safely linked to Google later.
  googleSubject: text("google_subject").unique(),
  mobileNumber: text("mobile_number"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const messesTable = pgTable("messes", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  messKey: text("mess_key").notNull().unique(),
  adminUserId: integer("admin_user_id")
    .notNull()
    .references(() => usersTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const consumersTable = pgTable(
  "consumers",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id),
    name: text("name").notNull(),
    userId: integer("user_id").references(() => usersTable.id),
    isAdmin: boolean("is_admin").notNull().default(false),
    // Kept after a linked user deletes their account so historical meals,
    // deposits and balances remain consistent without retaining identity data.
    accountDeletedAt: timestamp("account_deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("consumers_mess_idx").on(t.messId),
    index("consumers_user_mess_idx").on(t.userId, t.messId),
  ],
);

export const mealsTable = pgTable(
  "meals",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id),
    consumerId: integer("consumer_id")
      .notNull()
      .references(() => consumersTable.id),
    yearMonth: text("year_month").notNull(),
    day: integer("day").notNull(),
    count: numeric("count", { precision: 12, scale: 3, mode: "number" })
      .notNull()
      .default(0),
  },
  (t) => [
    unique("meals_uq").on(t.messId, t.consumerId, t.yearMonth, t.day),
    index("meals_mess_month_idx").on(t.messId, t.yearMonth),
  ],
);

export const expenseDaysTable = pgTable(
  "expense_days",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id),
    yearMonth: text("year_month").notNull(),
    day: integer("day").notNull(),
    items: jsonb("items")
      .notNull()
      .$type<Array<{ id: string; name: string; amount: number }>>()
      .default([]),
  },
  (t) => [
    unique("expense_days_uq").on(t.messId, t.yearMonth, t.day),
    index("expense_days_mess_month_idx").on(t.messId, t.yearMonth),
  ],
);

export const depositsTable = pgTable(
  "deposits",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id),
    consumerId: integer("consumer_id")
      .notNull()
      .references(() => consumersTable.id),
    yearMonth: text("year_month").notNull(),
    day: integer("day").notNull(),
    amount: numeric("amount", { precision: 14, scale: 3, mode: "number" })
      .notNull()
      .default(0),
  },
  (t) => [
    unique("deposits_uq").on(t.messId, t.consumerId, t.yearMonth, t.day),
    index("deposits_mess_month_idx").on(t.messId, t.yearMonth),
  ],
);

export const passwordResetsTable = pgTable("password_resets", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  otp: text("otp").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const accountDeletionOtpsTable = pgTable(
  "account_deletion_otps",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull().unique(),
    otp: text("otp").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("account_deletion_otps_email_idx").on(t.email)],
);

export const otpVerificationsTable = pgTable("otp_verifications", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  mobileNumber: text("mobile_number"),
  otp: text("otp").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const securityOtpsTable = pgTable(
  "security_otps",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    action: text("action").notNull(),
    otp: text("otp").notNull(),
    payload: text("payload"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("security_otps_user_action_uq").on(t.userId, t.action)],
);

export const memberRequestsTable = pgTable(
  "member_requests",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    name: text("name").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("member_requests_mess_user_uq").on(t.messId, t.userId),
    index("member_requests_user_status_idx").on(t.userId, t.status),
  ],
);

// One complete snapshot per mess/date: all three availability flags, windows,
// and menus live in the same row for compact storage and a single-row read.
export const mealControlTable = pgTable(
  "meal_control",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id),
    date: text("date").notNull(),
    breakfastEnabled: boolean("breakfast_enabled").notNull().default(true),
    lunchEnabled: boolean("lunch_enabled").notNull().default(true),
    dinnerEnabled: boolean("dinner_enabled").notNull().default(true),
    breakfastOptOutStart: text("breakfast_start_window"),
    breakfastOptOutEnd: text("breakfast_end_window"),
    lunchOptOutStart: text("lunch_start_window"),
    lunchOptOutEnd: text("lunch_end_window"),
    dinnerOptOutStart: text("dinner_start_window"),
    dinnerOptOutEnd: text("dinner_end_window"),
    breakfastMenu: text("breakfast_menu"),
    lunchMenu: text("lunch_menu"),
    dinnerMenu: text("dinner_menu"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("meal_control_mess_date_uq").on(t.messId, t.date),
    index("meal_control_mess_date_idx").on(t.messId, t.date),
  ],
);

export const mealOptOutsTable = pgTable(
  "meal_opt_outs",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id),
    consumerId: integer("consumer_id")
      .notNull()
      .references(() => consumersTable.id),
    date: text("date").notNull(),
    mealType: text("meal_type").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("meal_opt_outs_uq").on(t.messId, t.consumerId, t.date, t.mealType),
    index("meal_opt_outs_mess_date_idx").on(t.messId, t.date),
  ],
);

export const depositEntriesTable = pgTable(
  "deposit_entries",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id),
    consumerId: integer("consumer_id")
      .notNull()
      .references(() => consumersTable.id),
    amount: numeric("amount", {
      precision: 14,
      scale: 3,
      mode: "number",
    }).notNull(),
    depositedAt: timestamp("deposited_at").notNull().defaultNow(),
    note: text("note"),
  },
  (t) => [
    index("deposit_entries_mess_date_idx").on(t.messId, t.depositedAt),
    index("deposit_entries_consumer_idx").on(t.consumerId),
  ],
);

export type User = typeof usersTable.$inferSelect;
export type Mess = typeof messesTable.$inferSelect;
export type Consumer = typeof consumersTable.$inferSelect;
export type MemberRequest = typeof memberRequestsTable.$inferSelect;
