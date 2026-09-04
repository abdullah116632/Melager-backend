import { Router } from "express";
import {
  assignBazarMember,
  assignBazarMembers,
  createBazarItem,
  deleteBazarItem,
  deleteBazarItems,
  addBazarItemsToExpense,
  getBazar,
  getUnreadBazarAssignmentCount,
  markBazarAssignmentNotificationsRead,
  notifyAssignedBazarMembers,
  unassignBazarMember,
  updateBazarItem,
  updateBazarItemStatus,
} from "../controllers/bazarController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/mess/bazar", requireAuth, getBazar);
router.get(
  "/mess/bazar/assignments/unread-count",
  requireAuth,
  getUnreadBazarAssignmentCount,
);
router.post("/mess/bazar/items", requireAuth, createBazarItem);
router.patch("/mess/bazar/items/:id", requireAuth, updateBazarItem);
router.patch(
  "/mess/bazar/items/:id/status",
  requireAuth,
  updateBazarItemStatus,
);
router.delete("/mess/bazar/items/:id", requireAuth, deleteBazarItem);
router.delete("/mess/bazar/items", requireAuth, deleteBazarItems);
router.post(
  "/mess/bazar/items/add-to-expense",
  requireAuth,
  addBazarItemsToExpense,
);
router.post("/mess/bazar/assignments", requireAuth, assignBazarMember);
router.post("/mess/bazar/assignments/bulk", requireAuth, assignBazarMembers);
router.post(
  "/mess/bazar/assignments/notify",
  requireAuth,
  notifyAssignedBazarMembers,
);
router.post(
  "/mess/bazar/assignments/read",
  requireAuth,
  markBazarAssignmentNotificationsRead,
);
router.delete("/mess/bazar/assignments/:id", requireAuth, unassignBazarMember);

export default router;
