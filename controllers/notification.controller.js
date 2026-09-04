const { prisma } = require("../utils/db");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const { sendNotificationToAll } = require("../utils/socket");

const getMyNotifications = async (req, res) => {
    try {
        const recipientId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        const [notifications, total, unreadCount] = await Promise.all([
            prisma.notification.findMany({
                where: { recipient_id: recipientId },
                orderBy: { created_at: "desc" },
                skip,
                take: limit,
            }),
            prisma.notification.count({
                where: { recipient_id: recipientId },
            }),
            prisma.notification.count({
                where: { recipient_id: recipientId, is_read: false },
            }),
        ]);

        const mapped = notifications.map((n) => ({
            id: n.notification_id,
            type: n.type,
            title: n.title,
            message: n.message,
            data: n.data ? JSON.parse(n.data) : null,
            isRead: n.is_read,
            createdAt: n.created_at,
        }));

        return new ApiResponse(
            200,
            {
                notifications: mapped,
                pagination: {
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit),
                },
                unreadCount,
            },
            "Notifications fetched successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in getMyNotifications:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

const getUnreadCount = async (req, res) => {
    try {
        const recipientId = req.user.id;
        const count = await prisma.notification.count({
            where: { recipient_id: recipientId, is_read: false },
        });
        return new ApiResponse(
            200,
            { count },
            "Unread count fetched successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in getUnreadCount:", error);
        return new ApiError(500, error.message).send(res);
    }
};

const markOneAsRead = async (req, res) => {
    try {
        const recipientId = req.user.id;
        const notificationId = parseInt(req.params.id || req.body.id);

        if (!notificationId) {
            return new ApiError(400, "Notification ID is required").send(res);
        }

        await prisma.notification.updateMany({
            where: {
                notification_id: notificationId,
                recipient_id: recipientId,
            },
            data: { is_read: true },
        });

        return new ApiResponse(200, null, "Notification marked as read").send(
            res
        );
    } catch (error) {
        console.error("Error in markOneAsRead:", error);
        return new ApiError(500, error.message).send(res);
    }
};

const markAllAsRead = async (req, res) => {
    try {
        const recipientId = req.user.id;
        await prisma.notification.updateMany({
            where: { recipient_id: recipientId, is_read: false },
            data: { is_read: true },
        });
        return new ApiResponse(200, null, "Notifications marked as read").send(
            res
        );
    } catch (error) {
        console.error("Error in markAllAsRead:", error);
        return new ApiError(500, error.message).send(res);
    }
};

// ---- clear all notifications for the current user ----
const clearAllNotifications = async (req, res) => {
    try {
        const recipientId = req.user.id;
        await prisma.notification.deleteMany({
            where: { recipient_id: recipientId },
        });
        return new ApiResponse(200, null, "Notifications cleared").send(res);
    } catch (error) {
        console.error("Error in clearAllNotifications:", error);
        return new ApiError(500, error.message).send(res);
    }
};

// ---- get current on/off preference ----
const getPreference = async (req, res) => {
    try {
        const recipientId = req.user.id;
        const pref = await prisma.notificationPreference.findUnique({
            where: { recipient_id: recipientId },
        });
        // Default to enabled if no row exists yet
        const enabled = pref ? pref.enabled : true;
        return new ApiResponse(
            200,
            { enabled },
            "Preference fetched successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in getPreference:", error);
        return new ApiError(500, error.message).send(res);
    }
};

// ---- turn notifications on/off ----
const updatePreference = async (req, res) => {
    try {
        const recipientId = req.user.id;
        const { enabled } = req.body;

        if (typeof enabled !== "boolean") {
            throw new ApiError(400, "`enabled` must be a boolean");
        }

        const pref = await prisma.notificationPreference.upsert({
            where: { recipient_id: recipientId },
            update: { enabled },
            create: { recipient_id: recipientId, enabled },
        });

        return new ApiResponse(
            200,
            { enabled: pref.enabled },
            "Preference updated"
        ).send(res);
    } catch (error) {
        console.error("Error in updatePreference:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

// ---- Register / update device FCM token ----
const registerDevice = async (req, res) => {
    try {
        const userId = req.user.id;
        const fcmToken = req.body.fcm_token || req.body.fcmToken;
        const deviceType = req.body.device_type || req.body.deviceType || "android";

        if (!fcmToken || typeof fcmToken !== "string") {
            return new ApiError(400, "fcm_token is required and must be a string").send(res);
        }

        const device = await prisma.userDevice.upsert({
            where: { fcm_token: fcmToken.trim() },
            update: {
                user_id: userId,
                device_type: deviceType,
                updated_at: new Date(),
            },
            create: {
                user_id: userId,
                fcm_token: fcmToken.trim(),
                device_type: deviceType,
            },
        });

        return new ApiResponse(
            200,
            device,
            "Device registered successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in registerDevice:", error);
        return new ApiError(500, error.message).send(res);
    }
};

// ---- Unregister device FCM token ----
const unregisterDevice = async (req, res) => {
    try {
        const fcmToken = req.body.fcm_token || req.body.fcmToken || req.query.fcm_token;

        if (!fcmToken) {
            return new ApiError(400, "fcm_token is required").send(res);
        }

        await prisma.userDevice.deleteMany({
            where: { fcm_token: fcmToken.trim() },
        });

        return new ApiResponse(200, null, "Device unregistered successfully").send(res);
    } catch (error) {
        console.error("Error in unregisterDevice:", error);
        return new ApiError(500, error.message).send(res);
    }
};

// ---- Send custom push notification (Admin / In-App trigger) ----
const { notifyUserWithFCM, sendPushNotificationToDevices } = require("../utils/notifications");

const sendPushNotification = async (req, res) => {
    try {
        const { recipient_id, recipientId, title, message, type = "custom", data = {}, broadcast = false } = req.body;
        const targetUserId = recipient_id || recipientId;

        if (!title || !message) {
            return new ApiError(400, "title and message are required").send(res);
        }

        if (broadcast) {
            // 1. If not promo, persist notification in DB for all active users
            if (type !== "promo") {
                try {
                    const allUsers = await prisma.user.findMany({
                        select: { user_id: true },
                    });

                    if (allUsers.length > 0) {
                        const notificationData = allUsers.map((u) => ({
                            recipient_id: u.user_id,
                            type,
                            title,
                            message,
                            data: data && Object.keys(data).length > 0 ? JSON.stringify(data) : null,
                            is_read: false,
                        }));

                        await prisma.notification.createMany({
                            data: notificationData,
                        });
                    }
                } catch (dbErr) {
                    console.error("[Broadcast] Failed to save broadcast notifications to DB:", dbErr);
                }
            }

            // 2. Broadcast via socket to connected clients
            try {
                sendNotificationToAll({
                    type,
                    title,
                    message,
                    data,
                });
            } catch (socketErr) {
                console.error("[Broadcast] Failed to emit socket broadcast:", socketErr);
            }

            // 3. Send FCM push to all registered devices
            const devices = await prisma.userDevice.findMany({
                select: { fcm_token: true },
            });
            const tokens = devices.map((d) => d.fcm_token).filter(Boolean);

            if (tokens.length === 0) {
                return new ApiResponse(200, { sentCount: 0 }, "Broadcast sent (no registered push devices)").send(res);
            }

            const result = await sendPushNotificationToDevices(tokens, {
                title,
                message,
                data: { type, ...data },
            });

            return new ApiResponse(200, result, "Broadcast push notification sent successfully").send(res);
        }

        if (!targetUserId) {
            return new ApiError(400, "recipient_id is required when broadcast is false").send(res);
        }

        const saved = await notifyUserWithFCM(Number(targetUserId), {
            type,
            title,
            message,
            data,
        });

        return new ApiResponse(200, saved, "Push notification sent successfully").send(res);
    } catch (error) {
        console.error("Error in sendPushNotification:", error);
        return new ApiError(500, error.message).send(res);
    }
};

module.exports = {
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
};

