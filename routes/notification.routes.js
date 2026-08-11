const express = require("express");
const router = express.Router();
const {
    getMyNotifications,
    markAllAsRead,
    clearAllNotifications,
    getPreference,
    updatePreference,
} = require("../controllers/notification.controller");
const { verifyJWT } = require("../middlewares/auth.middleware");

router.get("/", verifyJWT, getMyNotifications);
router.post("/mark-read", verifyJWT, markAllAsRead);
router.delete("/clear", verifyJWT, clearAllNotifications);
router.get("/preference", verifyJWT, getPreference);
router.post("/preference", verifyJWT, updatePreference);

module.exports = router;
