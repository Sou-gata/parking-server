const express = require("express");
const router = express.Router();
const {
    getMyNotifications,
    getUnreadCount,
    markOneAsRead,
    markAllAsRead,
    clearAllNotifications,
    getPreference,
    updatePreference,
    registerDevice,
    unregisterDevice,
    sendPushNotification,
} = require("../controllers/notification.controller");
const { verifyJWT } = require("../middlewares/auth.middleware");

router.get("/", verifyJWT, getMyNotifications);
router.get("/unread-count", verifyJWT, getUnreadCount);
router.post("/mark-read", verifyJWT, markAllAsRead);
router.post("/mark-read/:id", verifyJWT, markOneAsRead);
router.patch("/:id/read", verifyJWT, markOneAsRead);
router.delete("/clear", verifyJWT, clearAllNotifications);
router.get("/preference", verifyJWT, getPreference);
router.post("/preference", verifyJWT, updatePreference);

// FCM Device Registration & Notification Dispatch
router.post("/register-device", verifyJWT, registerDevice);
router.delete("/unregister-device", verifyJWT, unregisterDevice);
router.post("/send-push", verifyJWT, sendPushNotification);

module.exports = router;

