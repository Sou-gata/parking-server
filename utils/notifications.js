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

    let saved;
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

module.exports = { notifyUser };
