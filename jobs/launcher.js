const { fork } = require("child_process");
const path = require("path");
const Logger = require("../utils/log");
const {
    sendNotificationToUser,
    sendNotificationToAll,
} = require("../utils/socket");

let workerProcess = null;

function spawnBackgroundWorker() {
    const workerPath = path.join(__dirname, "worker.js");
    Logger.info("[Main Process] Spawning background worker child process...");

    workerProcess = fork(workerPath, [], {
        stdio: "inherit",
        env: { ...process.env },
    });

    workerProcess.on("message", (msg) => {
        if (!msg || typeof msg !== "object") return;

        try {
            if (msg.type === "SOCKET_NOTIFY_USER") {
                sendNotificationToUser(msg.userId, msg.notification);
            } else if (msg.type === "SOCKET_NOTIFY_ALL") {
                sendNotificationToAll(msg.notification);
            }
        } catch (err) {
            Logger.error(
                "[Main Process] Error handling worker IPC socket message:",
                err
            );
        }
    });

    workerProcess.on("exit", (code, signal) => {
        if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
            Logger.warn(
                `[Main Process] Background worker child process exited unexpectedly (code: ${code}, signal: ${signal}). Restarting worker in 5s...`
            );
            setTimeout(spawnBackgroundWorker, 5000);
        } else {
            Logger.info(
                `[Main Process] Background worker process stopped cleanly (code: ${code}, signal: ${signal}).`
            );
        }
    });

    workerProcess.on("error", (err) => {
        Logger.error("[Main Process] Background worker process error:", err);
    });
}

const cleanupWorker = () => {
    if (workerProcess) {
        Logger.info("[Main Process] Terminating background worker process...");
        workerProcess.kill("SIGTERM");
        workerProcess = null;
    }
};

process.on("SIGINT", () => {
    cleanupWorker();
});

process.on("SIGTERM", () => {
    cleanupWorker();
});

module.exports = {
    spawnBackgroundWorker,
};
