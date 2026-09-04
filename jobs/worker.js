const { createTables } = require("../utils/createTables");
const { startExpiredBookingsJob } = require("../utils/expiredBookingsJob");
const {
    startBookingNotificationJob,
} = require("../utils/bookingNotificationJob");
const Logger = require("../utils/log");

Logger.info("[Background Worker] Starting background worker process...");

createTables()
    .then(() => {
        Logger.info(
            "[Background Worker] Database tables verified. Initializing background jobs..."
        );
        startExpiredBookingsJob();
        startBookingNotificationJob();
        Logger.info(
            "[Background Worker] All background jobs running successfully"
        );
    })
    .catch((err) => {
        Logger.error(
            "[Background Worker] Error initializing database or background jobs:",
            err
        );
        process.exit(1);
    });

// Handle termination of worker process
const shutdown = (signal) => {
    Logger.info(
        `[Background Worker] Received ${signal}. Shutting down worker process...`
    );
    process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
