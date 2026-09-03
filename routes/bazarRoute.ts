import { Router } from "express";
import {
  assignBazarMember,
  createBazarItem,
  deleteBazarItem,
  getBazar,
  unassignBazarMember,
  updateBazarItem,
} from "../controllers/bazarController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/mess/bazar", requireAuth, getBazar);
router.post("/mess/bazar/items", requireAuth, createBazarItem);
router.patch("/mess/bazar/items/:id", requireAuth, updateBazarItem);
router.delete("/mess/bazar/items/:id", requireAuth, deleteBazarItem);
router.post("/mess/bazar/assignments", requireAuth, assignBazarMember);
router.delete("/mess/bazar/assignments/:id", requireAuth, unassignBazarMember);

export default router;
