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
const isHttps = true;

app.use(
    cors({
        origin: function (origin, callback) {
            if (!origin) return callback(null, true);

            const allowedOrigins = [
                "http://localhost:4000",
                "http://localhost:5173",
                "http://127.0.0.1:4000",
                "http://127.0.0.1:5173",
            ];

            if (allowedOrigins.indexOf(origin) !== -1) {
                callback(null, true);
            } else {
                callback(new Error("Not allowed by CORS"));
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
    })
);

const limiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    limit: 100, // Limit each IP to 100 requests per 15 minutes
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
app.use(waf().middleware());

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(cookieParser());

// Routes
app.use("/api/v1/users", require("./routes/user.routes"));
app.use("/api/v1/agencies", require("./routes/agency.routes"));
app.use("/api/v1/bookings", require("./routes/booking.routes"));
app.use("/api/v1/wallets", require("./routes/wallet.routes"));
app.use("/api/v1/ratings", require("./routes/rating.routes"));
app.use("/api/v1/notifications", require("./routes/notification.routes"));
app.use("/api/v1/working-hours", require("./routes/workingHours.routes"));
app.use("/api/v1/config", require("./routes/config.routes"));
app.use("/api/v1/complaints", require("./routes/complaint.routes"));

// Test Route
app.get("/api/v1/test", (req, res) => {
    res.json({ message: "Your server is running" });
});

app.use("/images", express.static("uploads"));

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
const { startExpiredBookingsJob } = require("./utils/expiredBookingsJob");

createTables().then(() => {
    startExpiredBookingsJob();
});
