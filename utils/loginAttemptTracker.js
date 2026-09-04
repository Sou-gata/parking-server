const fs = require("fs");
const path = require("path");

const MAX_ATTEMPTS = 5;
const LOCK_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

const DATA_DIR = path.join(__dirname, "..", "data");
const STORAGE_FILE = path.join(DATA_DIR, "failed_login_attempts.json");

// In-memory store: { [userKey]: number[] (array of timestamps) }
let attemptsStore = {};

// Ensure directory exists and load persisted attempts
const loadStore = () => {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        if (fs.existsSync(STORAGE_FILE)) {
            const rawData = fs.readFileSync(STORAGE_FILE, "utf-8");
            attemptsStore = JSON.parse(rawData || "{}");
        }
    } catch (err) {
        console.error("Error loading failed login attempts store:", err.message);
        attemptsStore = {};
    }
};

// Save store to disk
const saveStore = () => {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(attemptsStore, null, 2), "utf-8");
    } catch (err) {
        console.error("Error saving failed login attempts store:", err.message);
    }
};

// Initial load
loadStore();

/**
 * Filter out attempt timestamps older than 24 hours
 */
const getValidAttempts = (key) => {
    const now = Date.now();
    const attempts = attemptsStore[key] || [];
    const valid = attempts.filter((ts) => now - ts < LOCK_WINDOW_MS);
    if (valid.length !== attempts.length) {
        attemptsStore[key] = valid;
        saveStore();
    }
    return valid;
};

/**
 * Check if the user is currently locked out
 * @param {string} identifier - unique user identifier (email, username, etc.)
 */
const isLocked = (identifier) => {
    if (!identifier) return { locked: false, attemptsCount: 0, remainingAttempts: MAX_ATTEMPTS };
    const key = String(identifier).trim().toLowerCase();
    const valid = getValidAttempts(key);

    if (valid.length >= MAX_ATTEMPTS) {
        const oldestAttempt = valid[0];
        const remainingMs = Math.max(0, oldestAttempt + LOCK_WINDOW_MS - Date.now());
        if (remainingMs > 0) {
            return {
                locked: true,
                remainingMs,
                attemptsCount: valid.length,
                remainingAttempts: 0,
            };
        }
    }

    return {
        locked: false,
        remainingMs: 0,
        attemptsCount: valid.length,
        remainingAttempts: Math.max(0, MAX_ATTEMPTS - valid.length),
    };
};

/**
 * Record a failed login attempt
 * @param {string} identifier - unique user identifier
 */
const recordFailedAttempt = (identifier) => {
    if (!identifier) return { locked: false, attemptsCount: 0, remainingAttempts: MAX_ATTEMPTS };
    const key = String(identifier).trim().toLowerCase();
    const valid = getValidAttempts(key);
    valid.push(Date.now());
    attemptsStore[key] = valid;
    saveStore();

    const locked = valid.length >= MAX_ATTEMPTS;
    const remainingAttempts = Math.max(0, MAX_ATTEMPTS - valid.length);

    return {
        locked,
        attemptsCount: valid.length,
        remainingAttempts,
    };
};

/**
 * Clear failed login attempts after successful login
 * @param {string} identifier
 */
const clearAttempts = (identifier) => {
    if (!identifier) return;
    const key = String(identifier).trim().toLowerCase();
    if (attemptsStore[key]) {
        delete attemptsStore[key];
        saveStore();
    }
};

module.exports = {
    isLocked,
    recordFailedAttempt,
    clearAttempts,
    MAX_ATTEMPTS,
    LOCK_WINDOW_MS,
};
