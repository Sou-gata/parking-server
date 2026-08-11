const { Server } = require("socket.io");
const Logger = require("./log");

let io = null;

function init(server) {
    if (io) {
        console.warn(
            "[Socket] Warning: Socket.io has already been initialized!"
        );
        return io;
    }

    io = new Server(server, {
        cors: {
            origin: true,
            methods: ["GET", "POST"],
            credentials: true,
        },
    });

    io.on("connection", (socket) => {
        console.log(`[Socket] New client connected: ${socket.id}`);

        const userId =
            socket.handshake.query.userId ||
            (socket.handshake.auth && socket.handshake.auth.userId);
        if (userId) {
            socket.join(`user_${userId}`);
            console.log(
                `[Socket] Socket ${socket.id} automatically joined room: user_${userId}`
            );
        }

        socket.on("register", (data) => {
            const id = data && typeof data === "object" ? data.userId : data;
            if (id) {
                socket.join(`user_${id}`);
                console.log(
                    `[Socket] Socket ${socket.id} manually joined room: user_${id}`
                );
            }
        });

        socket.on("disconnect", () => {
            console.log(`[Socket] Client disconnected: ${socket.id}`);
        });
    });

    Logger.success("[Socket] Socket.io initialized successfully.");
    return io;
}

function getIO() {
    if (!io) {
        throw new Error(
            "[Socket] Error: Socket.io has not been initialized. Please call init(server) first!"
        );
    }
    return io;
}

function sendNotificationToUser(userId, notification) {
    if (!io) {
        throw new Error("[Socket] Error: Socket.io has not been initialized.");
    }
    const payload =
        typeof notification === "string"
            ? { message: notification }
            : notification;
    io.to(`user_${userId}`).emit("notification", {
        ...payload,
        timestamp: new Date(),
    });
    console.log(`[Socket] Sent notification to user_${userId}:`, payload);
}

function sendNotificationToAll(notification) {
    if (!io) {
        throw new Error("[Socket] Error: Socket.io has not been initialized.");
    }
    const payload =
        typeof notification === "string"
            ? { message: notification }
            : notification;
    io.emit("notification", {
        ...payload,
        timestamp: new Date(),
    });
    console.log("[Socket] Broadcasted notification to all clients:", payload);
}

module.exports = {
    init,
    getIO,
    sendNotificationToUser,
    sendNotificationToAll,
};
