const axios = require("axios");
const Logger = require("./log");

/**
 * Send OTP SMS using mtalkz API (matching visitor.controller.js) or Mock Mode
 * @param {string} phoneNumber - Recipient phone number
 * @returns {Promise<{ success: boolean, sessionId?: string, message?: string }>}
 */
const sendMtalkzOtp = async (phoneNumber) => {
    const provider = (process.env.SMS_PROVIDER || "mtalkz").toLowerCase();
    const apiKey = process.env.SMS_API_KEY;
    const senderId = process.env.SMS_SENDER_ID || "TEPLTA";
    const apiUrl =
        process.env.SMS_API_URL ||
        "https://msg.mtalkz.com//V2/http-api-sms.php";

    const cleanNumber = phoneNumber.replace(/[^0-9]/g, "").slice(-10);

    Logger.info(`[SMS Utility] Requesting mtalkz OTP for ${cleanNumber}...`);

    if (provider === "mtalkz" && apiKey && apiUrl) {
        try {
            const response = await axios.post(
                apiUrl,
                {
                    apikey: apiKey,
                    senderid: senderId,
                    number: cleanNumber,
                    message: "Your Access Code for test is {OTP}. \n -TEPL",
                    format: "json",
                    digit: "6",
                    intl: "1",
                },
                {
                    headers: { "Content-Type": "application/json" },
                }
            );

            const data = response.data;
            Logger.info(`[mtalkz Response]:`, data);

            if (data && data.Status === "Success") {
                Logger.success(
                    `[SMS Utility] mtalkz sent OTP to ${cleanNumber}. SessionId: ${data.Details}`
                );
                return { success: true, sessionId: data.Details };
            } else {
                Logger.error(`[SMS Utility] mtalkz send error:`, data);
                return {
                    success: false,
                    message:
                        data?.message || "Failed to send OTP via SMS gateway",
                };
            }
        } catch (error) {
            Logger.error(`[SMS Utility] mtalkz request failed:`, error.message);
            return { success: false, message: error.message };
        }
    }

    // Mock Mode fallback for local dev when no SMS API key is configured
    const mockSessionId = `MOCK_SESS_${Date.now()}`;
    Logger.info(`[SMS MOCK] ========================================`);
    Logger.info(`[SMS MOCK] Phone Number : ${cleanNumber}`);
    Logger.info(`[SMS MOCK] Session ID   : ${mockSessionId}`);
    Logger.info(`[SMS MOCK] ========================================`);
    return { success: true, sessionId: mockSessionId };
};

/**
 * @param {string} otp - OTP code entered by user
 * @param {string} sessionId - mtalkz session ID stored during send
 * @returns {Promise<boolean>}
 */
const verifyMtalkzOtp = async (otp, sessionId) => {
    const provider = (process.env.SMS_PROVIDER || "mtalkz").toLowerCase();
    const apiKey = process.env.SMS_API_KEY;
    const verificationUrl =
        process.env.SMS_VERIFICATION_URL ||
        "http://msg.mtalkz.com/V2/http-verifysms-api.php";

    if (
        provider === "mtalkz" &&
        apiKey &&
        verificationUrl &&
        sessionId &&
        !sessionId.startsWith("MOCK_")
    ) {
        try {
            const response = await axios.post(
                verificationUrl,
                {
                    apikey: apiKey,
                    otp: otp,
                    sessionid: sessionId,
                },
                {
                    headers: { "Content-Type": "application/json" },
                }
            );

            const data = response.data;
            Logger.info(`[mtalkz Verify Response]:`, data);

            return data && data.Status === "Success";
        } catch (error) {
            Logger.error(
                `[SMS Utility] mtalkz verify request failed:`,
                error.message
            );
            return false;
        }
    }

    // Mock verification (accept any 6-digit OTP in mock mode)
    return otp && otp.length === 6;
};

module.exports = {
    sendMtalkzOtp,
    verifyMtalkzOtp,
};
