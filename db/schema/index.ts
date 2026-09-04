import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  jsonb,
  bigserial,
  unique,
  index,
  check,
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

export const noticesTable = pgTable(
  "notices",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id),
    serialNo: integer("serial_no").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    color: text("color").notNull().default("#FFFFFF"),
    createdByUserId: integer("created_by_user_id")
      .notNull()
      .references(() => usersTable.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("notices_mess_serial_uq").on(t.messId, t.serialNo),
    index("notices_mess_serial_idx").on(t.messId, t.serialNo),
  ],
);

export const notificationsTable = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    noticeId: integer("notice_id").references(() => noticesTable.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("notifications_user_created_idx").on(t.userId, t.createdAt),
    index("notifications_mess_created_idx").on(t.messId, t.createdAt),
  ],
);

// Notice read state is kept separately from the general notifications table.
// A numeric watermark stays valid even if an old notice is deleted later.
export const noticeReadStatesTable = pgTable(
  "notice_read_states",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    lastReadNoticeId: integer("last_read_notice_id"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("notice_read_states_mess_user_uq").on(t.messId, t.userId),
    index("notice_read_states_user_idx").on(t.userId),
  ],
);

// A user may sign in on several phones. Tokens belong to a device and are
// replaced when that device signs in with a different account.
export const pushTokensTable = pgTable(
  "push_tokens",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    platform: text("platform").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("push_tokens_user_idx").on(t.userId)],
);

export const messagesTable = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id, { onDelete: "cascade" }),
    senderUserId: integer("sender_user_id")
      .notNull()
      .references(() => usersTable.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("messages_mess_created_id_idx").on(t.messId, t.createdAt, t.id),
    index("messages_sender_created_idx").on(t.senderUserId, t.createdAt),
  ],
);

export const messageReadStatesTable = pgTable(
  "message_read_states",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Keep this as a numeric watermark. Deleting one historical message must
    // not reset a member's whole conversation to unread.
    lastReadMessageId: integer("last_read_message_id"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("message_read_states_mess_user_uq").on(t.messId, t.userId),
    index("message_read_states_user_idx").on(t.userId),
  ],
);

export const bazarItemsTable = pgTable(
  "bazar_items",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id),
    weekday: integer("weekday").notNull(),
    name: text("name").notNull(),
    price: numeric("price", { precision: 14, scale: 3, mode: "number" })
      .notNull()
      .default(0),
    isCompleted: boolean("is_completed").notNull().default(false),
    createdByUserId: integer("created_by_user_id")
      .notNull()
      .references(() => usersTable.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("bazar_items_mess_weekday_idx").on(t.messId, t.weekday),
    index("bazar_items_mess_idx").on(t.messId),
  ],
);

export const bazarAssignmentsTable = pgTable(
  "bazar_assignments",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id),
    weekday: integer("weekday").notNull(),
    consumerId: integer("consumer_id")
      .notNull()
      .references(() => consumersTable.id, { onDelete: "cascade" }),
    assignedByUserId: integer("assigned_by_user_id")
      .notNull()
      .references(() => usersTable.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("bazar_assignments_mess_weekday_consumer_uq").on(
      t.messId,
      t.weekday,
      t.consumerId,
    ),
    index("bazar_assignments_mess_weekday_idx").on(t.messId, t.weekday),
  ],
);

// Bazar-duty alerts deliberately stay outside the general notifications table.
// They only drive the Bazar List shortcut badge and are cleared on opening it.
export const bazarAssignmentNotificationsTable = pgTable(
  "bazar_assignment_notifications",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    weekday: integer("weekday").notNull(),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("bazar_assignment_notifications_user_idx").on(t.userId, t.createdAt),
    index("bazar_assignment_notifications_mess_user_idx").on(
      t.messId,
      t.userId,
    ),
  ],
);

// Consumer Breakdown alerts have their own badge and never appear in the
// shared notification bell.
export const consumerBreakdownNotificationsTable = pgTable(
  "consumer_breakdown_notifications",
  {
    id: serial("id").primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("consumer_breakdown_notifications_user_idx").on(
      t.userId,
      t.createdAt,
    ),
    index("consumer_breakdown_notifications_mess_user_idx").on(
      t.messId,
      t.userId,
    ),
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
    scope: text("scope").notNull().default("day"),
    // For an ongoing opt-out, this is the first date the meal is active again.
    // Keeping the interval preserves correct historical meal status.
    endedDate: text("ended_date"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("meal_opt_outs_uq").on(t.messId, t.consumerId, t.date, t.mealType),
    index("meal_opt_outs_mess_date_idx").on(t.messId, t.date),
    index("meal_opt_outs_ongoing_idx").on(
      t.messId,
      t.consumerId,
      t.mealType,
      t.scope,
    ),
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

// Durable receipt for mutations originating from an offline client. Feature
// handlers must create/complete this row in the same transaction as the
// business write so retries cannot apply the same mutation twice.
export const syncClientMutationsTable = pgTable(
  "sync_client_mutations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    clientMutationId: text("client_mutation_id").notNull(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    messId: integer("mess_id").references(() => messesTable.id, {
      onDelete: "cascade",
    }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<unknown>(),
    completedAt: timestamp("completed_at"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("sync_client_mutations_user_key_uq").on(
      t.userId,
      t.clientMutationId,
    ),
    index("sync_client_mutations_mess_idx").on(t.messId, t.id),
    index("sync_client_mutations_expiry_idx").on(t.expiresAt),
    check(
      "sync_client_mutations_operation_check",
      sql`${t.operation} in ('create', 'update', 'delete', 'upsert', 'command')`,
    ),
  ],
);

// Append-only feed consumed with `id` as the cursor. Payloads are intentionally
// feature-owned so each local repository can normalize them into SQLite.
export const syncChangesTable = pgTable(
  "sync_changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    messId: integer("mess_id")
      .notNull()
      .references(() => messesTable.id, { onDelete: "cascade" }),
    actorUserId: integer("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    operation: text("operation").notNull(),
    payload: jsonb("payload").notNull().$type<unknown>(),
    changedAt: timestamp("changed_at").defaultNow().notNull(),
  },
  (t) => [
    index("sync_changes_mess_cursor_idx").on(t.messId, t.id),
    check(
      "sync_changes_operation_check",
      sql`${t.operation} in ('create', 'update', 'delete', 'upsert')`,
    ),
  ],
);

export type User = typeof usersTable.$inferSelect;
export type Mess = typeof messesTable.$inferSelect;
export type Consumer = typeof consumersTable.$inferSelect;
export type MemberRequest = typeof memberRequestsTable.$inferSelect;
export type Notice = typeof noticesTable.$inferSelect;
export type Notification = typeof notificationsTable.$inferSelect;
export type BazarItem = typeof bazarItemsTable.$inferSelect;
export type BazarAssignment = typeof bazarAssignmentsTable.$inferSelect;
export type SyncClientMutation = typeof syncClientMutationsTable.$inferSelect;
export type SyncChange = typeof syncChangesTable.$inferSelect;
