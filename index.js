const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const waf = require("@mertcanureten/node-waf");
const app = express();
require("dotenv").config();
const cookieParser = require("cookie-parser");
const cors = require("cors");
const Logger = require("./utils/log");

const port = process.env.PORT || 4444;
const isHttps = false;

app.set("trust proxy", 1);

app.use(
    cors({
        origin: function (origin, callback) {
            // Allow requests with no origin (mobile apps, curl, same-origin)
            if (!origin) return callback(null, true);

            const envOrigins = process.env.ALLOWED_ORIGINS
                ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
                : [];

            const allowedOrigins = [
                "http://localhost:4000",
                "http://localhost:4444",
                "http://localhost:5173",
                "http://127.0.0.1:4000",
                "http://127.0.0.1:4444",
                "http://127.0.0.1:5173",
                ...envOrigins,
            ];

            // Match localhost / 127.0.0.1 on any port or LAN IPs (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
            const isLocalhostOrLAN =
                /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/.test(
                    origin
                );

            if (
                allowedOrigins.includes(origin) ||
                isLocalhostOrLAN ||
                process.env.NODE_ENV !== "production"
            ) {
                callback(null, true);
            } else {
                callback(null, false);
            }
        },
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allowedHeaders: [
            "Content-Type",
            "Authorization",
            "X-Requested-With",
            "Accept",
        ],
        exposedHeaders: ["Content-Length", "X-Knowledge"],
    })
);

// Security Middlewares
app.use(
    helmet({
        crossOriginResourcePolicy: false, // Allows client applications (React Native) to fetch static images
        contentSecurityPolicy: false, // Allows HTML documentation and client applications to execute scripts, inline handlers, and load fonts
    })
);

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: process.env.NODE_ENV === "production" ? 1000 : 10000, // Allow up to 10,000 requests per 15 minutes in dev
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message:
            "Too many requests from this IP, please try again after 15 minutes.",
    },
});

app.use("/api", limiter);

// Web Application Firewall (WAF)
app.use(waf({ threshold: 30 }).middleware());

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(cookieParser());

// Routes
app.use("/api/v1/otp", require("./routes/otp.routes"));
app.use("/api/otp", require("./routes/otp.routes"));
app.use("/api/v1/users", require("./routes/user.routes"));
app.use("/api/v1/agencies", require("./routes/agency.routes"));
app.use("/api/v1/bookings", require("./routes/booking.routes"));
app.use("/api/v1/wallets", require("./routes/wallet.routes"));
app.use("/api/v1/ratings", require("./routes/rating.routes"));
app.use("/api/v1/notifications", require("./routes/notification.routes"));
app.use("/api/v1/working-hours", require("./routes/workingHours.routes"));
app.use("/api/v1/config", require("./routes/config.routes"));
app.use("/api/v1/complaints", require("./routes/complaint.routes"));
app.use("/api/v1/dashboard", require("./routes/dashboard.routes"));
app.use("/api/v1/excel", require("./routes/excel.routes"));

// API Documentation Routes
app.use("/docs", express.static(path.join(__dirname, "docs")));
app.use("/api-docs", express.static(path.join(__dirname, "docs")));

app.get(
    [
        "/docs",
        "/api-docs",
        "/api/docs",
        "/api-docs.html",
        "/docs.html",
        "/docs/single",
    ],
    (req, res) => {
        res.sendFile(path.join(__dirname, "api-docs.html"));
    }
);

// Test Route
app.get("/api/v1/test", (req, res) => {
    res.json({ message: "Your server is running" });
});

app.use("/images", express.static("uploads"));
app.use("/apk", express.static(path.join(__dirname, "apk")));

// Static File Hosting for Compiled React App (public folder)
app.use(express.static(path.join(__dirname, "public")));

// SPA Catch-All Route: Serves index.html for React client-side routing (Express 5 compatible)
app.use((req, res, next) => {
    if (req.method !== "GET") {
        return next();
    }
    if (
        req.path.startsWith("/api") ||
        req.path.startsWith("/images") ||
        req.path.startsWith("/docs") ||
        req.path.startsWith("/api-docs") ||
        req.path.startsWith("/apk")
    ) {
        return next();
    }
    const publicIndexPath = path.join(__dirname, "public", "index.html");
    if (fs.existsSync(publicIndexPath)) {
        return res.sendFile(publicIndexPath);
    }
    res.status(404).send(
        "Frontend build not found. Place your compiled React app files inside the 'public' directory."
    );
});

const errorHandler = require("./middlewares/errorHandler.middleware");
app.use(errorHandler);

const { getLocalIPv4 } = require("./utils/helperFunctions");
const { init } = require("./utils/socket");

let server;
if (isHttps) {
    const sslOptions = {
        key: fs.readFileSync(path.join(__dirname, "certs", "private.key")),
        cert: fs.readFileSync(path.join(__dirname, "certs", "certificate.crt")),
    };
    server = https.createServer(sslOptions, app);
} else {
    server = http.createServer(app);
}

init(server);

server.listen(port, () => {
    const protocol = isHttps ? "https" : "http";
    Logger.warn(`\nServer running at:`);
    Logger.info(`   Local:   ${protocol}://localhost:${port}`);
    Logger.info(`   Network: ${protocol}://${getLocalIPv4()}:${port}\n`);
});

const { createTables } = require("./utils/createTables");
const { spawnBackgroundWorker } = require("./jobs/launcher");

createTables().then(() => {
    spawnBackgroundWorker();
});


