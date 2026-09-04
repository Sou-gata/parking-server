const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
const path = require("path");
const fs = require("fs");
const Logger = require("./log");

let initialized = false;

try {
    const serviceAccountPath = path.join(__dirname, "..", "serviceAccountKey.json");
    if (fs.existsSync(serviceAccountPath)) {
        const serviceAccount = require(serviceAccountPath);
        if (getApps().length === 0) {
            initializeApp({
                credential: cert(serviceAccount),
            });
        }
        initialized = true;
        Logger.info("[Firebase Admin] Initialized successfully with project: " + (serviceAccount.project_id || "default"));
    } else {
        Logger.warn("[Firebase Admin] serviceAccountKey.json not found. FCM push notifications will be skipped.");
    }
} catch (error) {
    Logger.error("[Firebase Admin] Initialization failed: " + error.message);
}

module.exports = {
    getMessaging: () => (initialized ? getMessaging() : null),
    isFcmInitialized: () => initialized,
};
