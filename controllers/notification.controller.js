const { prisma } = require("../utils/db");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

const getMyNotifications = async (req, res) => {
    try {
        const recipientId = req.user.id;
        const notifications = await prisma.notification.findMany({
            where: { recipient_id: recipientId },
            orderBy: { created_at: "desc" },
            take: 30,
        });

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
            mapped,
            "Notifications fetched successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in getMyNotifications:", error);
        return res.status(500).json(new ApiError(500, error.message));
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

// ---- NEW: clear all notifications for the current user ----
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

// ---- NEW: get current on/off preference ----
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

// ---- NEW: turn notifications on/off ----
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

module.exports = {
    getMyNotifications,
    markAllAsRead,
    clearAllNotifications,
    getPreference,
    updatePreference,
};
