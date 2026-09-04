const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const {
    sendOtp,
    sendForgotPasswordOtp,
    verifyOtp,
} = require("../controllers/otp.controller");

// Rate Limiter: Max 10 send-otp requests per IP per 15 minutes
const sendOtpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: {
        statusCode: 429,
        success: false,
        message: "Too many OTP requests from this IP. Please try again after 15 minutes.",
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Rate Limiter: Max 15 verify-otp requests per IP per 15 minutes
const verifyOtpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    message: {
        statusCode: 429,
        success: false,
        message: "Too many OTP verification attempts from this IP. Please try again after 15 minutes.",
    },
    standardHeaders: true,
    legacyHeaders: false,
});

router.post("/send", sendOtpLimiter, sendOtp);
router.post("/send-forgot-password", sendOtpLimiter, sendForgotPasswordOtp);
router.post("/verify", verifyOtpLimiter, verifyOtp);

module.exports = router;
