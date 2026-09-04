const { prisma } = require("./db");
const { sendNotificationToUser } = require("./socket");

/**
 * Persists a notification to the DB, then pushes it live over the socket.
 * Skips entirely if the recipient has notifications turned off.
 */
async function notifyUser(recipientId, notification) {
    const { type, title, message, data } = notification;

    // Respect the recipient's preference (default: enabled if no row exists)
    try {
        const pref = await prisma.notificationPreference.findUnique({
            where: { recipient_id: recipientId },
        });
        if (pref && pref.enabled === false) {
            return null; // notifications turned off, skip silently
        }
    } catch (prefErr) {
        console.error("[Notify] Failed to check preference, proceeding anyway:", prefErr);
    }

    let saved = null;
    // Promo notifications are NOT saved to the database (push-only)
    if (type !== "promo") {
        try {
            saved = await prisma.notification.create({
                data: {
                    recipient_id: recipientId,
                    type,
                    title,
                    message,
                    data: data ? JSON.stringify(data) : null,
                },
            });
        } catch (dbErr) {
            console.error("[Notify] Failed to persist notification:", dbErr);
        }
    }

    try {
        sendNotificationToUser(recipientId, {
            id: saved?.notification_id,
            type,
            title,
            message,
            data,
            createdAt: saved?.created_at || new Date(),
            isRead: false,
        });
    } catch (socketErr) {
        console.error("[Notify] Failed to emit notification:", socketErr);
    }

    return saved;
}

/**
 * Sends a push notification directly to specific FCM registration tokens.
 * Automatically cleans up invalid / stale tokens from the user_devices table.
 */
async function sendPushNotificationToDevices(tokens, { title, message, data = {} }) {
    if (!tokens || tokens.length === 0) return { successCount: 0, failureCount: 0 };

    const { getMessaging, isFcmInitialized } = require("./firebase");
    if (!isFcmInitialized()) {
        console.warn("[FCM] Firebase Admin not initialized. Skipping push notification.");
        return { successCount: 0, failureCount: 0 };
    }

    // FCM data values must be strings
    const stringifiedData = {};
    if (data && typeof data === "object") {
        for (const [key, val] of Object.entries(data)) {
            stringifiedData[key] = typeof val === "string" ? val : JSON.stringify(val);
        }
    }

    const payload = {
        tokens,
        notification: {
            title: title || "Parking Notification",
            body: message || "",
        },
        data: stringifiedData,
        android: {
            priority: "high",
            notification: {
                sound: "default",
                channelId: "parking_notifications",
                priority: "high",
            },
        },
        apns: {
            payload: {
                aps: {
                    sound: "default",
                    badge: 1,
                },
            },
        },
    };

    try {
        const messaging = getMessaging();
        const response = await messaging.sendEachForMulticast(payload);
        const tokensToRemove = [];

        response.responses.forEach((resp, idx) => {
            if (!resp.success) {
                const errorCode = resp.error?.code;
                console.error(`[FCM] Error sending to token ${tokens[idx]}:`, errorCode, resp.error?.message);
                if (
                    errorCode === "messaging/invalid-registration-token" ||
                    errorCode === "messaging/registration-token-not-registered"
                ) {
                    tokensToRemove.push(tokens[idx]);
                }
            }
        });

        // Clean up invalid tokens from user_devices table
        if (tokensToRemove.length > 0) {
            try {
                await prisma.userDevice.deleteMany({
                    where: {
                        fcm_token: { in: tokensToRemove },
                    },
                });
                console.log(`[FCM] Cleaned up ${tokensToRemove.length} invalid device tokens.`);
            } catch (cleanupErr) {
                console.error("[FCM] Failed to cleanup invalid tokens:", cleanupErr);
            }
        }

        return {
            successCount: response.successCount,
            failureCount: response.failureCount,
        };
    } catch (err) {
        console.error("[FCM] sendEachForMulticast error:", err);
        return { successCount: 0, failureCount: tokens.length, error: err.message };
    }
}

/**
 * High-level method: Persists to DB, emits over socket (via notifyUser),
 * AND sends Firebase Cloud Messaging (FCM) push notifications to all user devices.
 */
async function notifyUserWithFCM(recipientId, notification) {
    // 1. Call notifyUser to save in DB and push over socket
    const saved = await notifyUser(recipientId, notification);

    // 2. Look up all active devices for recipient
    try {
        const devices = await prisma.userDevice.findMany({
            where: { user_id: Number(recipientId) },
            select: { fcm_token: true },
        });

        if (devices && devices.length > 0) {
            const tokens = devices.map((d) => d.fcm_token).filter(Boolean);
            if (tokens.length > 0) {
                const { title, message, data, type } = notification;
                await sendPushNotificationToDevices(tokens, {
                    title,
                    message,
                    data: {
                        notification_id: saved?.notification_id?.toString() || "",
                        type: type || "general",
                        ...(data || {}),
                    },
                });
            }
        }
    } catch (pushErr) {
        console.error(`[FCM] Failed to send push notification to user ${recipientId}:`, pushErr);
    }

    return saved;
}

module.exports = {
    notifyUser,
    notifyUserWithFCM,
    sendPushNotificationToUser: notifyUserWithFCM,
    sendPushNotificationToDevices,
};
