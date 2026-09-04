const crypto = require("crypto");
const { prisma } = require("../utils/db");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const { sendMtalkzOtp, verifyMtalkzOtp } = require("../utils/sms.util");
const Logger = require("../utils/log");

const RESEND_COOLDOWN_SECONDS = 60; // 1 minute resend lock
const OTP_EXPIRY_MINUTES = 5;       // Valid for 5 mins
const MAX_VERIFY_ATTEMPTS = 5;      // Max 5 wrong attempts

/**
 * Clean & normalize phone number
 */
const normalizePhoneNumber = (phone) => {
    if (!phone) return "";
    return String(phone).trim().replace(/[^0-9+]/g, "");
};

/**
 * Helper to safely access OtpVerification model on Prisma Client
 */
const getOtpModel = (client = prisma) => {
    const model = client.otpVerification || client.OtpVerification || client.otp_verifications;
    if (!model) {
        throw new ApiError(500, "Prisma OtpVerification model not initialized. Please restart server.");
    }
    return model;
};

/**
 * Controller: Send OTP to Phone Number (via mtalkz API matching visitor.controller.js)
 */
const sendOtp = async (req, res) => {
    const { phone_number } = req.body;
    const cleanPhone = normalizePhoneNumber(phone_number);

    if (!cleanPhone || cleanPhone.length < 8) {
        throw new ApiError(400, "Valid phone number is required");
    }

    // 1. Check if phone number is already registered with an existing user or organization
    const existingUser = await prisma.user.findFirst({
        where: { phone_number: cleanPhone },
    });
    if (existingUser) {
        throw new ApiError(
            409,
            "This phone number is already registered. Please login or use a different phone number."
        );
    }

    const existingOrgUser = await prisma.orgUser.findFirst({
        where: { phone_number: cleanPhone },
    });
    if (existingOrgUser) {
        throw new ApiError(
            409,
            "This phone number is already registered with an organization. Please login or use a different phone number."
        );
    }

    const otpModel = getOtpModel(prisma);

    // 2. Protection: Check 1-minute lock per phone number
    const now = new Date();
    const lastOtpRecord = await otpModel.findFirst({
        where: { phone_number: cleanPhone },
        orderBy: { created_at: "desc" },
    });

    if (lastOtpRecord) {
        const timeDiffSeconds = Math.floor((now - new Date(lastOtpRecord.created_at)) / 1000);
        if (timeDiffSeconds < RESEND_COOLDOWN_SECONDS) {
            const remaining = RESEND_COOLDOWN_SECONDS - timeDiffSeconds;
            throw new ApiError(
                429,
                `Resend locked for ${remaining} more second(s). Please wait before requesting another OTP.`
            );
        }
    }

    // 2. Send SMS via mtalkz Gateway API (returns sessionId)
    const smsResult = await sendMtalkzOtp(cleanPhone);
    if (!smsResult.success || !smsResult.sessionId) {
        throw new ApiError(500, smsResult.message || "Failed to send OTP via SMS gateway");
    }

    const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // 3. Save record with mtalkz Session ID in DB
    await otpModel.create({
        data: {
            phone_number: cleanPhone,
            otp: smsResult.sessionId, // Store mtalkz Session ID
            attempts: 0,
            is_verified: false,
            is_consumed: false,
            expires_at: expiresAt,
        },
    });

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                phone_number: cleanPhone,
                cooldown_seconds: RESEND_COOLDOWN_SECONDS,
                expires_in_minutes: OTP_EXPIRY_MINUTES,
            },
            "OTP sent to your mobile for verification."
        )
    );
};

/**
 * Controller: Send Forgot Password OTP to Registered Phone Number
 */
const sendForgotPasswordOtp = async (req, res) => {
    const { phone_number } = req.body;
    const cleanPhone = normalizePhoneNumber(phone_number);

    if (!cleanPhone || cleanPhone.length < 8) {
        throw new ApiError(400, "Valid phone number is required");
    }

    // 1. Check if user or organization exists with this phone number
    const phoneSuffix = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
    const phoneFilter = {
        OR: [
            { phone_number: cleanPhone },
            { phone_number: phoneSuffix },
            { phone_number: `+91${phoneSuffix}` },
            { phone_number: `91${phoneSuffix}` },
        ],
    };

    const existingUser = await prisma.user.findFirst({
        where: phoneFilter,
    });
    const existingOrgUser = await prisma.orgUser.findFirst({
        where: phoneFilter,
    });

    if (!existingUser && !existingOrgUser) {
        throw new ApiError(
            404,
            "No registered account found with this phone number. Please check the number and try again."
        );
    }

    const otpModel = getOtpModel(prisma);

    // 2. Protection: Check 1-minute resend cooldown per phone number
    const now = new Date();
    const lastOtpRecord = await otpModel.findFirst({
        where: { phone_number: cleanPhone },
        orderBy: { created_at: "desc" },
    });

    if (lastOtpRecord) {
        const timeDiffSeconds = Math.floor((now - new Date(lastOtpRecord.created_at)) / 1000);
        if (timeDiffSeconds < RESEND_COOLDOWN_SECONDS) {
            const remaining = RESEND_COOLDOWN_SECONDS - timeDiffSeconds;
            throw new ApiError(
                429,
                `Resend locked for ${remaining} more second(s). Please wait before requesting another OTP.`
            );
        }
    }

    // 3. Send SMS via mtalkz Gateway API (returns sessionId)
    const smsResult = await sendMtalkzOtp(cleanPhone);
    if (!smsResult.success || !smsResult.sessionId) {
        throw new ApiError(500, smsResult.message || "Failed to send OTP via SMS gateway");
    }

    const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // 4. Save record with mtalkz Session ID in DB
    await otpModel.create({
        data: {
            phone_number: cleanPhone,
            otp: smsResult.sessionId,
            attempts: 0,
            is_verified: false,
            is_consumed: false,
            expires_at: expiresAt,
        },
    });

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                phone_number: cleanPhone,
                cooldown_seconds: RESEND_COOLDOWN_SECONDS,
                expires_in_minutes: OTP_EXPIRY_MINUTES,
            },
            "Password reset OTP sent to your registered mobile number."
        )
    );
};

/**
 * Controller: Verify OTP (via mtalkz Verification API)
 */
const verifyOtp = async (req, res) => {
    const { phone_number, otp } = req.body;
    const cleanPhone = normalizePhoneNumber(phone_number);
    const cleanOtp = String(otp || "").trim();

    if (!cleanPhone || !cleanOtp) {
        throw new ApiError(400, "Phone number and OTP digits are required");
    }

    const otpModel = getOtpModel(prisma);

    // Find the latest active OTP request for this phone number
    const otpRecord = await otpModel.findFirst({
        where: {
            phone_number: cleanPhone,
            is_consumed: false,
        },
        orderBy: { created_at: "desc" },
    });

    if (!otpRecord) {
        throw new ApiError(404, "No active OTP request found. Please request a new OTP.");
    }

    // Check if already verified
    if (otpRecord.is_verified && otpRecord.verification_token) {
        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    verification_token: otpRecord.verification_token,
                    phone_number: cleanPhone,
                },
                "Phone number is already verified."
            )
        );
    }

    // Check expiration
    if (new Date() > new Date(otpRecord.expires_at)) {
        throw new ApiError(400, "OTP code has expired. Please request a new OTP.");
    }

    // Check max attempts
    if (otpRecord.attempts >= MAX_VERIFY_ATTEMPTS) {
        throw new ApiError(
            429,
            "Maximum verification attempts exceeded. Please request a new OTP."
        );
    }

    // Verify OTP with mtalkz API
    const mtalkzSessionId = otpRecord.otp;
    const isMatched = await verifyMtalkzOtp(cleanOtp, mtalkzSessionId);

    if (!isMatched) {
        const newAttempts = otpRecord.attempts + 1;
        await otpModel.update({
            where: { id: otpRecord.id },
            data: { attempts: newAttempts },
        });

        const remaining = MAX_VERIFY_ATTEMPTS - newAttempts;
        if (remaining <= 0) {
            throw new ApiError(
                400,
                "Invalid OTP. Maximum attempts reached. Please request a new OTP."
            );
        }
        throw new ApiError(400, `Invalid OTP. ${remaining} attempt(s) remaining.`);
    }

    // OTP Correct! Generate single-use verification token for signup
    const verificationToken = crypto.randomBytes(32).toString("hex");

    await otpModel.update({
        where: { id: otpRecord.id },
        data: {
            is_verified: true,
            verification_token: verificationToken,
        },
    });

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                verification_token: verificationToken,
                phone_number: cleanPhone,
            },
            "OTP verified successfully."
        )
    );
};

/**
 * Internal Helper: Validate verification token during registration
 */
const consumeVerificationToken = async (phoneNumber, token, tx = prisma) => {
    const cleanPhone = normalizePhoneNumber(phoneNumber);
    if (!cleanPhone || !token) {
        throw new ApiError(400, "OTP verification is mandatory. Please verify your phone number with OTP first.");
    }

    const otpModel = getOtpModel(tx);

    const record = await otpModel.findFirst({
        where: {
            phone_number: cleanPhone,
            verification_token: token,
            is_verified: true,
            is_consumed: false,
        },
        orderBy: { created_at: "desc" },
    });

    if (!record) {
        throw new ApiError(
            400,
            "Invalid or expired OTP verification token. Please verify your phone number via OTP again."
        );
    }

    // Mark as consumed
    await otpModel.update({
        where: { id: record.id },
        data: { is_consumed: true },
    });

    return true;
};

module.exports = {
    sendOtp,
    sendForgotPasswordOtp,
    verifyOtp,
    consumeVerificationToken,
    normalizePhoneNumber,
};
