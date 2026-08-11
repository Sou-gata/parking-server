const { prisma } = require("../utils/db");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

const DEFAULT_USER_TERMS = `ParkingLocation Customer Terms & Conditions

1. Acceptance of Terms: By creating a customer account on ParkingLocation, you agree to abide by all platform policies, terms of service, and parking venue rules.
2. Booking & Cancellation: Parking space reservations are subject to availability. Bookings must be made with valid vehicle and time parameters.
3. Vehicle & Personal Safety: ParkingLocation facilitates space reservation but is not liable for loss, theft, or damage to personal property inside vehicles. Drivers are responsible for securing their vehicles.
4. Conduct & Compliance: You agree to park exclusively within assigned spaces, follow site speed limits, and adhere to posted operating hours.
5. Wallet & Payments: Account balances and transaction charges are subject to authorized payment gateway terms.`;

const DEFAULT_AGENCY_TERMS = `ParkingLocation Partner Agency Terms & Conditions

1. Facility Operating Rights: By registering your parking venue as a Partner Agency, you affirm that you possess all valid operating licenses, permits, and property rights required to offer parking services.
2. Data Accuracy & Schedules: You agree to maintain correct and up-to-date information regarding operating hours, slot capacities, pricing rates, and holiday closures on the platform.
3. Booking Honor Guarantee: Partner Agencies agree to honor all confirmed reservations placed by customers through ParkingLocation.
4. Payouts & Platform Fees: Financial settlements, commission rates, and payouts will be conducted according to platform administrator guidelines.
5. Compliance & Security: Agencies must maintain reasonable security, staff support, and safety measures within the parking premises.`;

/**
 * Get Terms and Conditions by type ("user" or "agency") - Public
 */
const getTerms = async (req, res) => {
    try {
        const { type } = req.params;
        const normalizedType = (type || "").toLowerCase();

        if (normalizedType !== "user" && normalizedType !== "agency") {
            throw new ApiError(400, "Invalid terms type. Must be 'user' or 'agency'");
        }

        const configKey = normalizedType === "agency"
            ? "terms_and_conditions_agency"
            : "terms_and_conditions_user";

        const config = await prisma.configuration.findUnique({
            where: { config_key: configKey },
        });

        const fallback = normalizedType === "agency"
            ? DEFAULT_AGENCY_TERMS
            : DEFAULT_USER_TERMS;

        return new ApiResponse(
            200,
            {
                type: normalizedType,
                content: config?.config_value || fallback,
            },
            "Terms and conditions fetched successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in getTerms:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Update Terms and Conditions by type ("user" or "agency") - Super Admin Only
 */
const updateTerms = async (req, res) => {
    try {
        if (req.user?.role !== "super_admin") {
            throw new ApiError(403, "Access denied: Super Admin permission required");
        }

        const { type } = req.params;
        const normalizedType = (type || "").toLowerCase();

        if (normalizedType !== "user" && normalizedType !== "agency") {
            throw new ApiError(400, "Invalid terms type. Must be 'user' or 'agency'");
        }

        const { content } = req.body;
        if (typeof content !== "string" || !content.trim()) {
            throw new ApiError(400, "Terms and conditions content cannot be empty");
        }

        const configKey = normalizedType === "agency"
            ? "terms_and_conditions_agency"
            : "terms_and_conditions_user";

        const updated = await prisma.configuration.upsert({
            where: { config_key: configKey },
            update: { config_value: content.trim() },
            create: { config_key: configKey, config_value: content.trim() },
        });

        return new ApiResponse(
            200,
            {
                type: normalizedType,
                content: updated.config_value,
            },
            "Terms and conditions updated successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in updateTerms:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

module.exports = {
    getTerms,
    updateTerms,
};
