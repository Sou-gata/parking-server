const { prisma } = require("../utils/db");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const { distributePaymentCommission } = require("../utils/commission");

/**
 * Create a new booking
 */
const createBooking = async (req, res) => {
    try {
        const {
            userId,
            userName,
            userPhone,
            agencyId,
            agencyName,
            vehicleType,
            vehicleNumber,
            bookedDuration,
            hourlyRate,
            startTime,
            endTime,
        } = req.body;

        if (
            !userName ||
            !agencyId ||
            !agencyName ||
            !vehicleType ||
            !vehicleNumber ||
            !bookedDuration ||
            !hourlyRate
        ) {
            throw new ApiError(400, "Required booking fields are missing");
        }

        const parsedAgencyId = parseInt(agencyId);
        if (isNaN(parsedAgencyId)) {
            throw new ApiError(400, "Invalid agency ID");
        }

        // Validate working hours, working days, and special vacations for the agency
        const workingHoursRecord = await prisma.orgWorkingHours.findUnique({
            where: { org_id: parsedAgencyId },
        });

        if (workingHoursRecord) {
            const safeParse = (str, fallback) => {
                try {
                    return str ? JSON.parse(str) : fallback;
                } catch (e) {
                    return fallback;
                }
            };

            const activeDays = safeParse(workingHoursRecord.working_days, [
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
                "Sunday",
            ]);
            const is247 = Boolean(workingHoursRecord.is_24_7);
            const openTime = workingHoursRecord.open_time || "08:00";
            const closeTime = workingHoursRecord.close_time || "20:00";
            const vacations = safeParse(
                workingHoursRecord.special_vacations,
                []
            );

            const bStart = startTime ? new Date(startTime) : new Date();
            const durationHours = parseFloat(bookedDuration) || 1;
            const bEnd = endTime
                ? new Date(endTime)
                : new Date(bStart.getTime() + durationHours * 3600000);

            // 1. Check Special Vacations
            for (const v of vacations) {
                if (v.startDate && v.endDate) {
                    const vStart = new Date(`${v.startDate}T00:00:00`);
                    const vEnd = new Date(`${v.endDate}T23:59:59`);
                    if (
                        (bStart >= vStart && bStart <= vEnd) ||
                        (bEnd >= vStart && bEnd <= vEnd) ||
                        (bStart <= vStart && bEnd >= vEnd)
                    ) {
                        throw new ApiError(
                            400,
                            `Parking location is closed for special vacation/holiday '${
                                v.title || "Holiday"
                            }' (${v.startDate} to ${v.endDate}).`
                        );
                    }
                }
            }

            // 2. Check Working Days & Hours per weekday
            const daysOfWeek = [
                "Sunday",
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
            ];
            const startDay = daysOfWeek[bStart.getDay()];
            const endDay = daysOfWeek[bEnd.getDay()];

            let dailySchedules = safeParse(workingHoursRecord.daily_schedules, null);
            if (!dailySchedules || typeof dailySchedules !== "object") {
                const ALL_DAYS = [
                    "Monday",
                    "Tuesday",
                    "Wednesday",
                    "Thursday",
                    "Friday",
                    "Saturday",
                    "Sunday",
                ];
                dailySchedules = {};
                ALL_DAYS.forEach((day) => {
                    dailySchedules[day] = {
                        isOpen: Array.isArray(activeDays) ? activeDays.includes(day) : true,
                        is247: is247,
                        openTime: openTime,
                        closeTime: closeTime,
                    };
                });
            }

            const startDaySched = dailySchedules[startDay];
            const endDaySched = dailySchedules[endDay];

            if (!startDaySched || startDaySched.isOpen === false) {
                throw new ApiError(
                    400,
                    `Parking location is closed on ${startDay}s.`
                );
            }
            if (!endDaySched || endDaySched.isOpen === false) {
                throw new ApiError(
                    400,
                    `Parking location is closed on ${endDay}s.`
                );
            }

            const parseTimeVal = (tStr) => {
                const [h, m] = (tStr || "00:00").split(":").map(Number);
                return h + (m || 0) / 60;
            };

            const startVal = bStart.getHours() + bStart.getMinutes() / 60;
            const endVal = bEnd.getHours() + bEnd.getMinutes() / 60;
            const isDifferentDay = bStart.toDateString() !== bEnd.toDateString();

            if (!startDaySched.is247) {
                const dayOpenVal = parseTimeVal(startDaySched.openTime || "08:00");
                const dayCloseVal = parseTimeVal(startDaySched.closeTime || "20:00");

                if (dayCloseVal > dayOpenVal) {
                    if (startVal < dayOpenVal || startVal > dayCloseVal) {
                        throw new ApiError(
                            400,
                            `Parking location is closed at start time on ${startDay}. Operating hours are ${startDaySched.openTime} to ${startDaySched.closeTime}.`
                        );
                    }
                    if (!isDifferentDay && endVal > dayCloseVal) {
                        throw new ApiError(
                            400,
                            `Parking location is closed before booking end time on ${startDay}. Operating hours are ${startDaySched.openTime} to ${startDaySched.closeTime}.`
                        );
                    }
                } else if (dayCloseVal < dayOpenVal) {
                    const isStartOpen = startVal >= dayOpenVal || startVal <= dayCloseVal;
                    if (!isStartOpen) {
                        throw new ApiError(
                            400,
                            `Parking location is closed at start time on ${startDay}. Operating hours are ${startDaySched.openTime} to ${startDaySched.closeTime}.`
                        );
                    }
                }
            }

            if (isDifferentDay && !endDaySched.is247) {
                const endOpenVal = parseTimeVal(endDaySched.openTime || "08:00");
                const endCloseVal = parseTimeVal(endDaySched.closeTime || "20:00");

                if (endCloseVal > endOpenVal) {
                    if (endVal > endCloseVal || endVal < endOpenVal) {
                        throw new ApiError(
                            400,
                            `Parking location operating hours on ${endDay} are ${endDaySched.openTime} to ${endDaySched.closeTime}.`
                        );
                    }
                }
            }
        }

        let parsedUserId = null;
        if (userId) {
            parsedUserId = parseInt(userId);
            if (isNaN(parsedUserId)) {
                throw new ApiError(400, "Invalid user ID");
            }
        } else if (req.user && req.user.id) {
            parsedUserId = parseInt(req.user.id);
        }

        if (parsedUserId) {
            const user = await prisma.user.findUnique({
                where: { user_id: parsedUserId },
            });
            if (!user) {
                throw new ApiError(404, "User associated with this booking not found");
            }
            const bookingCost = parseFloat(bookedDuration) * parseFloat(hourlyRate);
            const requiredBalance = bookingCost * 1.5;

            // Compute dynamically reserved balance from active bookings (status: booked, checked_in, pending_approval)
            const activeBookings = await prisma.booking.findMany({
                where: {
                    user_id: parsedUserId,
                    status: { in: ["booked", "checked_in", "pending_approval"] },
                },
                select: {
                    booked_duration: true,
                    hourly_rate: true,
                },
            });

            const reservedBalance = activeBookings.reduce((sum, b) => {
                return sum + (parseFloat(b.booked_duration || 0) * parseFloat(b.hourly_rate || 0));
            }, 0);

            const currentBalance = parseFloat(user.wallet_balance || 0);
            const usableBalance = currentBalance - reservedBalance;

            if (usableBalance < requiredBalance) {
                throw new ApiError(
                    400,
                    `Insufficient usable wallet balance. You have ₹${currentBalance.toFixed(2)} total (with ₹${reservedBalance.toFixed(2)} reserved). You need at least ₹${requiredBalance.toFixed(2)} of usable balance (1.5x of the booking cost ₹${bookingCost.toFixed(2)}) to book.`
                );
            }
        }

        // Check if agency requires booking approval
        const agencyRecord = await prisma.orgUser.findUnique({
            where: { org_id: parsedAgencyId },
            select: { require_booking_approval: true },
        });
        const requireApproval = agencyRecord ? Boolean(agencyRecord.require_booking_approval) : false;
        const initialStatus = requireApproval ? "pending_approval" : "booked";

        // Generate a unique booking code: PK-XXXX
        let bookingCode = "";
        let isUnique = false;
        while (!isUnique) {
            const randomCode = Math.floor(1000 + Math.random() * 9000);
            bookingCode = `PK-${randomCode}`;
            const existing = await prisma.booking.findUnique({
                where: { booking_code: bookingCode },
            });
            if (!existing) isUnique = true;
        }

        // Generate a random 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        const newBooking = await prisma.booking.create({
            data: {
                booking_code: bookingCode,
                user_id: parsedUserId,
                user_name: userName,
                user_phone: userPhone || null,
                agency_id: parsedAgencyId,
                agency_name: agencyName,
                vehicle_type: vehicleType,
                vehicle_number: vehicleNumber,
                status: initialStatus,
                booking_start_time: startTime ? new Date(startTime) : null,
                booking_end_time: endTime ? new Date(endTime) : null,
                checkin_time: null,
                checkout_time: null,
                start_time: null,
                end_time: null,
                booked_duration: parseFloat(bookedDuration),
                hourly_rate: parseFloat(hourlyRate),
                total_bill: 0,
                payment_status: "pending",
                otp,
            },
        });

        const cleanBooking = mapBookingToCamelCase(newBooking);

        return new ApiResponse(
            201,
            cleanBooking,
            requireApproval
                ? "Booking request submitted! Waiting for agency admin approval."
                : "Booking created successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in createBooking:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Fetch booking history for a specific customer
 */
const getUserBookings = async (req, res) => {
    try {
        const { userId } = req.params;

        const parsedUserId = parseInt(userId);
        if (isNaN(parsedUserId)) {
            throw new ApiError(400, "Invalid user ID");
        }

        // Ensure user is fetching their own bookings, or is admin/staff
        if (req.user.role === "user" && req.user.id !== parsedUserId) {
            throw new ApiError(
                403,
                "Access denied: You cannot view bookings of other users"
            );
        }

        const bookings = await prisma.booking.findMany({
            where: { user_id: parsedUserId },
            orderBy: { created_at: "desc" },
        });

        const mappedBookings = bookings.map(mapBookingToCamelCase);

        return new ApiResponse(
            200,
            mappedBookings,
            "User bookings fetched successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in getUserBookings:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Helper — map DB snake_case fields to React Native camelCase names
 */
function mapBookingToCamelCase(b) {
    if (!b) return null;
    return {
        id: b.booking_id,
        bookingCode: b.booking_code,
        userId: b.user_id,
        userName: b.user_name,
        userPhone: b.user_phone,
        agencyId: b.agency_id,
        agencyName: b.agency_name,
        vehicleType: b.vehicle_type,
        vehicleNumber: b.vehicle_number,
        status: b.status,
        startTime: b.start_time,
        endTime: b.end_time,
        bookingStartTime: b.booking_start_time,
        bookingEndTime: b.booking_end_time,
        checkinTime: b.checkin_time,
        checkoutTime: b.checkout_time,
        bookedDuration: parseFloat(b.booked_duration || 0),
        hourlyRate: parseFloat(b.hourly_rate || 0),
        totalBill: parseFloat(b.total_bill || 0),
        paymentStatus: b.payment_status,
        otp: b.otp,
        refundAmount: parseFloat(b.refund_amount || 0),
        refundNotes: b.refund_notes || null,
        refundedAt: b.refunded_at || null,
        refundedBy: b.refunded_by || null,
        approvedBy: b.approved_by || null,
        approvedAt: b.approved_at || null,
        rejectedBy: b.rejected_by || null,
        rejectedAt: b.rejected_at || null,
        rejectionReason: b.rejection_reason || null,
        createdAt: b.created_at,
    };
}

/**
 * Fetch booking history / active bookings for an agency
 * Supports query params: status, search, page, limit
 */
const getAgencyBookings = async (req, res) => {
    try {
        const { agencyId } = req.params;
        const { status, search, page, limit } = req.query;

        const parsedAgencyId = parseInt(agencyId);
        if (isNaN(parsedAgencyId)) {
            throw new ApiError(400, "Invalid agency ID");
        }

        // Ensure staff/admin belongs to this agency
        const reqAgencyId = parseInt(req.user.agencyId || req.user.agency_id || req.user.org_id || req.user.id || 0);
        if (
            req.user.role !== "super_admin" &&
            reqAgencyId !== parsedAgencyId
        ) {
            throw new ApiError(
                403,
                "Access denied: You do not belong to this agency"
            );
        }

        const whereClause = { agency_id: parsedAgencyId };

        if (status && status.trim()) {
            whereClause.status = status.trim();
        }

        if (search && search.trim()) {
            const q = search.trim();
            whereClause.OR = [
                { vehicle_number: { contains: q } },
                { booking_code: { contains: q } },
                { user_name: { contains: q } },
                { user_phone: { contains: q } },
            ];
        }

        const isPaginated =
            page !== undefined || limit !== undefined || status !== undefined;

        if (isPaginated && (page !== undefined || limit !== undefined)) {
            const pageNum = Math.max(1, parseInt(page) || 1);
            const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 10));
            const skip = (pageNum - 1) * limitNum;

            const [bookings, totalCount] = await Promise.all([
                prisma.booking.findMany({
                    where: whereClause,
                    orderBy: { created_at: "desc" },
                    skip,
                    take: limitNum,
                }),
                prisma.booking.count({ where: whereClause }),
            ]);

            const mappedBookings = bookings.map(mapBookingToCamelCase);

            return new ApiResponse(
                200,
                {
                    items: mappedBookings,
                    pagination: {
                        page: pageNum,
                        limit: limitNum,
                        totalCount,
                        hasMore: skip + mappedBookings.length < totalCount,
                    },
                },
                "Agency bookings fetched successfully"
            ).send(res);
        }

        const bookings = await prisma.booking.findMany({
            where: whereClause,
            orderBy: { created_at: "desc" },
        });

        const mappedBookings = bookings.map(mapBookingToCamelCase);

        return new ApiResponse(
            200,
            mappedBookings,
            "Agency bookings fetched successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in getAgencyBookings:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Fetch single booking details by booking code
 */
const getBookingDetailsByCode = async (req, res) => {
    try {
        const { bookingCode } = req.params;
        const booking = await prisma.booking.findUnique({
            where: { booking_code: bookingCode },
        });

        if (!booking) {
            throw new ApiError(
                404,
                `Booking with code ${bookingCode} not found`
            );
        }

        // Ensure authorization
        if (
            req.user.role !== "super_admin" &&
            req.user.agencyId !== booking.agency_id &&
            req.user.id !== booking.user_id
        ) {
            throw new ApiError(403, "Access denied");
        }

        const cleanBooking = {
            id: booking.booking_id,
            bookingCode: booking.booking_code,
            userId: booking.user_id,
            userName: booking.user_name,
            userPhone: booking.user_phone,
            agencyId: booking.agency_id,
            agencyName: booking.agency_name,
            vehicleType: booking.vehicle_type,
            vehicleNumber: booking.vehicle_number,
            status: booking.status,
            startTime: booking.start_time,
            endTime: booking.end_time,
            bookingStartTime: booking.booking_start_time,
            bookingEndTime: booking.booking_end_time,
            bookedDuration: parseFloat(booking.booked_duration),
            hourlyRate: parseFloat(booking.hourly_rate),
            totalBill: parseFloat(booking.total_bill),
            paymentStatus: booking.payment_status,
            otp: booking.otp,
            createdAt: booking.created_at,
        };

        return new ApiResponse(
            200,
            cleanBooking,
            "Booking details fetched successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in getBookingDetailsByCode:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Check-in booking (Staff operations)
 */
const checkIn = async (req, res) => {
    try {
        const { bookingCode, otp } = req.body;

        const booking = await prisma.booking.findUnique({
            where: { booking_code: bookingCode },
        });

        if (!booking) {
            throw new ApiError(
                404,
                `Booking with code ${bookingCode} not found`
            );
        }

        const reqAgencyId = parseInt(req.user.agencyId || req.user.agency_id || req.user.org_id || req.user.id || 0);
        if (
            req.user.role !== "super_admin" &&
            reqAgencyId !== parseInt(booking.agency_id)
        ) {
            throw new ApiError(
                403,
                "Access denied: Staff does not belong to this agency"
            );
        }

        if (booking.status !== "booked") {
            throw new ApiError(
                400,
                `Cannot check in. Booking status is '${booking.status}'`
            );
        }

        // Validate OTP if booking has it
        if (booking.otp) {
            if (!otp) {
                throw new ApiError(400, "OTP is required for check-in");
            }
            if (booking.otp !== otp.trim()) {
                throw new ApiError(400, "Invalid OTP. Verification failed.");
            }
        }

        const updated = await prisma.booking.update({
            where: { booking_code: bookingCode },
            data: {
                status: "checked_in",
                start_time: new Date(),
                checkin_time: new Date(),
            },
        });

        return new ApiResponse(
            200,
            {
                bookingCode: updated.booking_code,
                status: updated.status,
                startTime: updated.start_time,
                checkinTime: updated.checkin_time,
            },
            "Vehicle checked in successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in checkIn:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Check-out booking (Staff operations)
 */
const checkOut = async (req, res) => {
    try {
        const { bookingCode } = req.body;

        const booking = await prisma.booking.findUnique({
            where: { booking_code: bookingCode },
        });

        if (!booking) {
            throw new ApiError(
                404,
                `Booking with code ${bookingCode} not found`
            );
        }

        const reqAgencyId = parseInt(req.user.agencyId || req.user.agency_id || req.user.org_id || req.user.id || 0);
        if (
            req.user.role !== "super_admin" &&
            reqAgencyId !== parseInt(booking.agency_id)
        ) {
            throw new ApiError(
                403,
                "Access denied: Staff does not belong to this agency"
            );
        }

        if (booking.status !== "checked_in") {
            throw new ApiError(
                400,
                `Cannot check out. Booking status is '${booking.status}'`
            );
        }

        const endTime = new Date();
        const startTime = new Date(
            booking.checkin_time || booking.start_time || new Date()
        );

        // Calculate duration and bill (minimum billing 1 hour)
        const durationMs = endTime - startTime;
        const durationHours = Math.max(1, durationMs / (1000 * 60 * 60));
        const totalBill = parseFloat(
            (durationHours * parseFloat(booking.hourly_rate)).toFixed(2)
        );

        const bookingCost = parseFloat(booking.booked_duration || 0) * parseFloat(booking.hourly_rate);
        const finalBill = parseFloat(Math.max(totalBill, bookingCost).toFixed(2));

        let updated;
        if (booking.user_id) {
            await prisma.$transaction(async (tx) => {
                const user = await tx.user.findUnique({
                    where: { user_id: booking.user_id },
                });

                if (!user) {
                    throw new ApiError(404, "User associated with the booking not found");
                }

                const currentBalance = parseFloat(user.wallet_balance || 0);
                const newBalance = currentBalance - finalBill;

                await tx.user.update({
                    where: { user_id: booking.user_id },
                    data: { wallet_balance: newBalance },
                });

                await tx.walletTransaction.create({
                    data: {
                        user_id: booking.user_id,
                        amount: finalBill,
                        type: "withdrawal",
                        status: "approved",
                        transaction_number: `PARKING-${booking.booking_code}`,
                    },
                });

                // Distribute payment commission between Agency Admin and Super Admin
                await distributePaymentCommission(tx, {
                    agencyId: booking.agency_id,
                    bookingId: booking.booking_id,
                    bookingCode: booking.booking_code,
                    amount: finalBill,
                });

                updated = await tx.booking.update({
                    where: { booking_code: bookingCode },
                    data: {
                        status: "completed",
                        end_time: endTime,
                        checkout_time: endTime,
                        total_bill: finalBill,
                        payment_status: "paid",
                    },
                });
            });
        } else {
            updated = await prisma.booking.update({
                where: { booking_code: bookingCode },
                data: {
                    status: "completed",
                    end_time: endTime,
                    checkout_time: endTime,
                    total_bill: finalBill,
                    payment_status: "paid",
                },
            });
        }

        return new ApiResponse(
            200,
            {
                bookingCode: updated.booking_code,
                status: updated.status,
                startTime: updated.start_time,
                endTime: updated.end_time,
                checkinTime: updated.checkin_time,
                checkoutTime: updated.checkout_time,
                totalBill: parseFloat(updated.total_bill),
                paymentStatus: updated.payment_status,
            },
            "Vehicle checked out successfully and billed"
        ).send(res);
    } catch (error) {
        console.error("Error in checkOut:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

const evaluateCancellationPolicy = (policyRules, minutesRemaining) => {
    // Sort rules by timeBeforeStartMinutes ascending
    const sortedRules = [...policyRules].sort((a, b) => a.timeBeforeStartMinutes - b.timeBeforeStartMinutes);

    // Find the first rule where minutesRemaining is less than or equal to timeBeforeStartMinutes
    const activeRule = sortedRules.find(rule => minutesRemaining <= rule.timeBeforeStartMinutes);

    if (activeRule) {
        return {
            allowCancellation: activeRule.allowCancellation,
            chargeType: activeRule.chargeType,
            chargeValue: activeRule.chargeValue,
            ruleMinutes: activeRule.timeBeforeStartMinutes
        };
    }

    // If no rule matches, free cancellation is allowed.
    return {
        allowCancellation: true,
        chargeType: "percentage",
        chargeValue: 0,
        ruleMinutes: null
    };
};

/**
 * Preview booking cancellation (calculate fees and restrictions)
 */
const previewCancelBooking = async (req, res) => {
    try {
        const { bookingCode } = req.params;

        const booking = await prisma.booking.findUnique({
            where: { booking_code: bookingCode },
        });

        if (!booking) {
            throw new ApiError(
                404,
                `Booking with code ${bookingCode} not found`
            );
        }

        // Access checks: only super_admin, agency staff/admin from same agency, or the user who made the booking
        const reqAgencyId = parseInt(req.user.agencyId || req.user.agency_id || req.user.org_id || req.user.id || 0);
        if (
            req.user.role !== "super_admin" &&
            reqAgencyId !== parseInt(booking.agency_id) &&
            parseInt(req.user.id) !== parseInt(booking.user_id)
        ) {
            throw new ApiError(403, "Access denied: Unauthorized to preview this booking cancellation");
        }

        if (booking.status !== "booked") {
            throw new ApiError(
                400,
                `Cannot cancel booking because it is already '${booking.status}'`
            );
        }

        // Default response (exemptions apply to super_admin and agency staff/admin)
        let allowCancellation = true;
        let chargeAmount = 0;
        let minutesRemaining = 0;
        let policyApplied = null;

        const bookingStartTime = booking.booking_start_time ? new Date(booking.booking_start_time) : null;

        if (bookingStartTime) {
            const now = new Date();
            minutesRemaining = (bookingStartTime.getTime() - now.getTime()) / (1000 * 60);
        }

        // Apply rules only if user is customer ("user")
        if (req.user.role === "user") {
            if (bookingStartTime && minutesRemaining <= 0) {
                allowCancellation = false;
            } else {
                const agency = await prisma.orgUser.findUnique({
                    where: { org_id: booking.agency_id },
                });

                if (agency && agency.cancellation_policy) {
                    const policyRules = JSON.parse(agency.cancellation_policy);
                    if (Array.isArray(policyRules) && policyRules.length > 0) {
                        const result = evaluateCancellationPolicy(policyRules, minutesRemaining);
                        allowCancellation = result.allowCancellation;
                        policyApplied = result;

                        const scheduledAmount = parseFloat(booking.booked_duration) * parseFloat(booking.hourly_rate);
                        if (result.chargeType === "percentage") {
                            chargeAmount = (scheduledAmount * result.chargeValue) / 100;
                        } else if (result.chargeType === "fixed") {
                            chargeAmount = result.chargeValue;
                        }
                        chargeAmount = Math.min(chargeAmount, scheduledAmount);
                        chargeAmount = parseFloat(chargeAmount.toFixed(2));
                    }
                }
            }
        }

        return new ApiResponse(
            200,
            {
                bookingCode: booking.booking_code,
                allowCancellation,
                cancellationFee: chargeAmount,
                minutesRemaining: bookingStartTime ? parseFloat(minutesRemaining.toFixed(1)) : null,
                policyApplied,
            },
            "Cancellation preview generated successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in previewCancelBooking:", error);
        if (error instanceof ApiError) {
            return res.status(error.statusCode).json({
                success: false,
                statusCode: error.statusCode,
                message: error.message,
            });
        }
        return res.status(500).json({
            success: false,
            statusCode: 500,
            message: error.message,
        });
    }
};

/**
 * Cancel booking
 */
const cancelBooking = async (req, res) => {
    try {
        const { bookingCode } = req.body;

        const booking = await prisma.booking.findUnique({
            where: { booking_code: bookingCode },
        });

        if (!booking) {
            throw new ApiError(
                404,
                `Booking with code ${bookingCode} not found`
            );
        }

        // Access checks
        if (req.user.role === "user" && req.user.id !== booking.user_id) {
            throw new ApiError(
                403,
                "Access denied: You cannot cancel someone else's booking"
            );
        }

        if (booking.status !== "booked") {
            throw new ApiError(
                400,
                `Cannot cancel booking because it is already '${booking.status}'`
            );
        }

        let allowCancellation = true;
        let chargeAmount = 0;
        let minutesRemaining = 0;
        let policyApplied = null;

        const bookingStartTime = booking.booking_start_time ? new Date(booking.booking_start_time) : null;

        if (bookingStartTime) {
            const now = new Date();
            minutesRemaining = (bookingStartTime.getTime() - now.getTime()) / (1000 * 60);
        }

        // Apply rules only if user is customer ("user")
        if (req.user.role === "user") {
            if (bookingStartTime && minutesRemaining <= 0) {
                throw new ApiError(400, "Cannot cancel booking. The scheduled start time has already passed.");
            }

            const agency = await prisma.orgUser.findUnique({
                where: { org_id: booking.agency_id },
            });

            if (agency && agency.cancellation_policy) {
                const policyRules = JSON.parse(agency.cancellation_policy);
                if (Array.isArray(policyRules) && policyRules.length > 0) {
                    const result = evaluateCancellationPolicy(policyRules, minutesRemaining);
                    allowCancellation = result.allowCancellation;
                    policyApplied = result;

                    if (!allowCancellation) {
                        throw new ApiError(
                            400,
                            `Cancellation is not allowed within ${result.ruleMinutes} minutes of the booking start time.`
                        );
                    }

                    const scheduledAmount = parseFloat(booking.booked_duration) * parseFloat(booking.hourly_rate);
                    if (result.chargeType === "percentage") {
                        chargeAmount = (scheduledAmount * result.chargeValue) / 100;
                    } else if (result.chargeType === "fixed") {
                        chargeAmount = result.chargeValue;
                    }
                    chargeAmount = Math.min(chargeAmount, scheduledAmount);
                    chargeAmount = parseFloat(chargeAmount.toFixed(2));
                }
            }
        }

        // Perform updates inside a transaction if there is a cancellation fee
        let updatedBooking;
        if (chargeAmount > 0 && booking.user_id) {
            await prisma.$transaction(async (tx) => {
                const user = await tx.user.findUnique({
                    where: { user_id: booking.user_id },
                });

                if (!user) {
                    throw new ApiError(404, "User associated with the booking not found");
                }

                const currentBalance = parseFloat(user.wallet_balance || 0);
                const newBalance = currentBalance - chargeAmount;

                await tx.user.update({
                    where: { user_id: booking.user_id },
                    data: { wallet_balance: newBalance },
                });

                await tx.walletTransaction.create({
                    data: {
                        user_id: booking.user_id,
                        amount: chargeAmount,
                        type: "withdrawal",
                        status: "approved",
                        transaction_number: `CANCEL-${booking.booking_code}`,
                    },
                });

                // Distribute cancellation fee commission between Agency Admin and Super Admin
                await distributePaymentCommission(tx, {
                    agencyId: booking.agency_id,
                    bookingId: booking.booking_id,
                    bookingCode: booking.booking_code,
                    amount: chargeAmount,
                });

                updatedBooking = await tx.booking.update({
                    where: { booking_code: bookingCode },
                    data: {
                        status: "cancelled",
                        total_bill: chargeAmount,
                        payment_status: "paid",
                    },
                });
            });
        } else {
            updatedBooking = await prisma.booking.update({
                where: { booking_code: bookingCode },
                data: {
                    status: "cancelled",
                    total_bill: 0,
                    payment_status: "cancelled",
                },
            });
        }

        return new ApiResponse(
            200,
            {
                bookingCode: updatedBooking.booking_code,
                status: updatedBooking.status,
                cancellationFee: chargeAmount,
                paymentStatus: updatedBooking.payment_status,
            },
            "Booking cancelled successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in cancelBooking:", error);
        if (error instanceof ApiError) {
            return res.status(error.statusCode).json({
                success: false,
                statusCode: error.statusCode,
                message: error.message,
            });
        }
        return res.status(500).json({
            success: false,
            statusCode: 500,
            message: error.message,
        });
    }
};

/**
 * Refund money to user for a booking (Super Admin and Agency Admin/Staff)
 */
const processBookingRefund = async (req, res) => {
    try {
        const { bookingId, bookingCode, refundReason, refundAmount: inputAmount } = req.body;

        if (!bookingId && !bookingCode) {
            throw new ApiError(400, "bookingId or bookingCode is required to process refund");
        }

        let whereClause = {};
        if (bookingId) {
            const parsedId = parseInt(bookingId);
            if (isNaN(parsedId)) throw new ApiError(400, "Invalid bookingId");
            whereClause.booking_id = parsedId;
        } else {
            whereClause.booking_code = String(bookingCode).trim();
        }

        const booking = await prisma.booking.findUnique({
            where: whereClause,
        });

        if (!booking) {
            throw new ApiError(404, "Booking not found");
        }

        // Authorization check: Agency Admin/Staff can only refund bookings for their agency
        const reqAgencyId = parseInt(req.user.agencyId || req.user.agency_id || req.user.org_id || req.user.id || 0);
        if (
            req.user.role !== "super_admin" &&
            reqAgencyId !== parseInt(booking.agency_id)
        ) {
            throw new ApiError(
                403,
                "Access denied: You do not have permission to refund bookings for this agency"
            );
        }

        // Check if already refunded
        if (
            booking.payment_status === "refunded" ||
            parseFloat(booking.refund_amount || 0) > 0
        ) {
            throw new ApiError(
                400,
                `Booking ${booking.booking_code} has already been refunded (₹${parseFloat(booking.refund_amount || 0).toFixed(2)})`
            );
        }

        if (!booking.user_id) {
            throw new ApiError(400, "Cannot refund booking without a registered user ID");
        }

        // Verify if any money was actually deducted from the user
        const totalBill = parseFloat(booking.total_bill || 0);
        const isPaid = booking.payment_status === "paid";
        let deductedAmount = totalBill;

        if (!isPaid && deductedAmount <= 0) {
            // Check wallet transactions for any deduction (e.g. cancellation charge)
            const deductionTx = await prisma.walletTransaction.findFirst({
                where: {
                    user_id: booking.user_id,
                    type: "withdrawal",
                    transaction_number: { contains: booking.booking_code },
                },
            });
            if (deductionTx) {
                deductedAmount = parseFloat(deductionTx.amount || 0);
            }
        }

        if (deductedAmount <= 0) {
            throw new ApiError(
                400,
                "Refund cannot be issued because no money was deducted from the user for this booking."
            );
        }

        let refundAmount = 0;
        if (inputAmount && !isNaN(parseFloat(inputAmount))) {
            refundAmount = Math.min(parseFloat(inputAmount), deductedAmount);
        } else {
            refundAmount = deductedAmount;
        }

        if (refundAmount <= 0) {
            throw new ApiError(
                400,
                "Refund cannot be issued because no money was deducted from the user for this booking."
            );
        }

        // If booking is non-checked-in (or active), set status to "cancelled" upon refund
        const newBookingStatus = booking.status === "completed" ? "completed" : "cancelled";

        let updatedBooking;

        await prisma.$transaction(async (tx) => {
            // 1. Credit User's Wallet
            const targetUser = await tx.user.findUnique({
                where: { user_id: booking.user_id },
            });
            if (!targetUser) {
                throw new ApiError(404, "User associated with this booking not found");
            }

            const currentBalance = parseFloat(targetUser.wallet_balance || 0);
            const newBalance = parseFloat((currentBalance + refundAmount).toFixed(2));

            await tx.user.update({
                where: { user_id: booking.user_id },
                data: { wallet_balance: newBalance },
            });

            // 2. Record Wallet Transaction for User
            await tx.walletTransaction.create({
                data: {
                    user_id: booking.user_id,
                    amount: refundAmount,
                    type: "deposit",
                    status: "approved",
                    transaction_number: `REFUND-${booking.booking_code}`,
                    rejection_reason: refundReason || `Full refund for booking #${booking.booking_code}`,
                },
            });

            // 3. Reverse Commission Split if AgencyTransaction exists
            const agencyTx = await tx.agencyTransaction.findFirst({
                where: { booking_id: booking.booking_id },
            });

            if (agencyTx) {
                if (agencyTx.status === "pending") {
                    // Money is currently held 100% in Super Admin wallet
                    const superAdmin = await tx.user.findFirst({
                        where: { role: "super_admin" },
                    });
                    if (superAdmin) {
                        const adminBal = parseFloat(superAdmin.wallet_balance || 0);
                        const newAdminBal = Math.max(0, adminBal - refundAmount);
                        await tx.user.update({
                            where: { user_id: superAdmin.user_id },
                            data: { wallet_balance: newAdminBal },
                        });
                    }
                    await tx.agencyTransaction.update({
                        where: { transaction_id: agencyTx.transaction_id },
                        data: {
                            status: "rejected",
                            rejection_reason: `Refund issued for booking #${booking.booking_code}`,
                            approved_at: new Date(),
                        },
                    });
                } else if (agencyTx.status === "approved") {
                    const agencyShare = parseFloat(agencyTx.agency_share || 0);
                    const adminShare = parseFloat(agencyTx.admin_share || 0);

                    if (agencyShare > 0) {
                        const agency = await tx.orgUser.findUnique({
                            where: { org_id: booking.agency_id },
                        });
                        if (agency) {
                            const agencyBal = parseFloat(agency.wallet_balance || 0);
                            const newAgencyBal = Math.max(0, agencyBal - agencyShare);
                            await tx.orgUser.update({
                                where: { org_id: booking.agency_id },
                                data: { wallet_balance: newAgencyBal },
                            });
                        }
                    }

                    if (adminShare > 0) {
                        const superAdmin = await tx.user.findFirst({
                            where: { role: "super_admin" },
                        });
                        if (superAdmin) {
                            const adminBal = parseFloat(superAdmin.wallet_balance || 0);
                            const newAdminBal = Math.max(0, adminBal - adminShare);
                            await tx.user.update({
                                where: { user_id: superAdmin.user_id },
                                data: { wallet_balance: newAdminBal },
                            });
                        }
                    }
                }
            }

            // 4. Update Booking record (sets status to cancelled if non-checked-in / active)
            updatedBooking = await tx.booking.update({
                where: { booking_id: booking.booking_id },
                data: {
                    status: newBookingStatus,
                    payment_status: "refunded",
                    refund_amount: refundAmount,
                    refund_notes: refundReason || "Refunded by admin",
                    refunded_at: new Date(),
                    refunded_by: req.user.id,
                },
            });

            // 5. Send notification to user
            try {
                await tx.notification.create({
                    data: {
                        recipient_id: booking.user_id,
                        type: "wallet_refund",
                        title: "Wallet Refund Received",
                        message: `A refund of ₹${refundAmount.toFixed(2)} for booking #${booking.booking_code} has been credited to your wallet.`,
                        data: JSON.stringify({
                            bookingCode: booking.booking_code,
                            refundAmount,
                            refundReason,
                        }),
                    },
                });
            } catch (notifErr) {
                console.error("Failed to send refund notification:", notifErr);
            }
        });

        return new ApiResponse(
            200,
            mapBookingToCamelCase(updatedBooking),
            `Refund of ₹${refundAmount.toFixed(2)} processed successfully`
        ).send(res);
    } catch (error) {
        console.error("Error in processBookingRefund:", error);
        if (error instanceof ApiError) {
            return res.status(error.statusCode).json({
                success: false,
                statusCode: error.statusCode,
                message: error.message,
            });
        }
        return res.status(500).json({
            success: false,
            statusCode: 500,
            message: error.message,
        });
    }
};

/**
 * Force cancel booking by agency/admin (0 fee deducted from user)
 */
const forceCancelBooking = async (req, res) => {
    try {
        const { bookingCode, reason } = req.body;

        if (!bookingCode) {
            throw new ApiError(400, "Booking code is required");
        }

        const booking = await prisma.booking.findUnique({
            where: { booking_code: bookingCode },
        });

        if (!booking) {
            throw new ApiError(404, `Booking with code ${bookingCode} not found`);
        }

        // Access check: agency users can only cancel bookings for their own agency
        const userRole = req.user.role;
        if (userRole === "agency_admin" || userRole === "agency_user") {
            const userAgencyId = req.user.agency_id || req.user.org_id || req.user.id;
            if (String(booking.agency_id) !== String(userAgencyId)) {
                throw new ApiError(
                    403,
                    "Access denied: You can only force cancel bookings for your own agency"
                );
            }
        } else if (userRole !== "super_admin") {
            throw new ApiError(
                403,
                "Access denied: Only agency staff or super admins can force cancel bookings"
            );
        }

        if (booking.status === "cancelled") {
            throw new ApiError(400, "Booking is already cancelled");
        }

        if (booking.status === "completed") {
            throw new ApiError(400, "Cannot cancel a completed booking");
        }

        const updatedBooking = await prisma.booking.update({
            where: { booking_code: bookingCode },
            data: {
                status: "cancelled",
                is_force_cancelled: true,
                cancelled_by: req.user.role || "agency",
                cancellation_reason: reason || "Force cancelled by agency",
                total_bill: 0,
                payment_status: "cancelled",
            },
        });

        return new ApiResponse(
            200,
            {
                bookingCode: updatedBooking.booking_code,
                status: updatedBooking.status,
                isForceCancelled: true,
                cancellationFee: 0,
                paymentStatus: updatedBooking.payment_status,
            },
            "Booking force cancelled successfully by agency. No charges applied."
        ).send(res);
    } catch (error) {
        console.error("Error in forceCancelBooking:", error);
        if (error instanceof ApiError) {
            return res.status(error.statusCode).json({
                success: false,
                statusCode: error.statusCode,
                message: error.message,
            });
        }
        return res.status(500).json({
            success: false,
            statusCode: 500,
            message: error.message || "Failed to force cancel booking",
        });
    }
};

/**
 * Approve or Reject one or multiple bookings (Agency Admin / Staff / Super Admin)
 */
const updateBookingApprovalStatus = async (req, res) => {
    try {
        const { bookingIds, action, rejectionReason } = req.body;

        if (!Array.isArray(bookingIds) || bookingIds.length === 0) {
            throw new ApiError(400, "bookingIds must be a non-empty array");
        }

        const validAction = (action || "").toLowerCase().trim();
        if (validAction !== "approve" && validAction !== "reject") {
            throw new ApiError(400, "action must be either 'approve' or 'reject'");
        }

        if (validAction === "reject" && (!rejectionReason || !rejectionReason.trim())) {
            throw new ApiError(400, "Rejection reason is required when rejecting booking(s)");
        }

        const parsedIds = bookingIds.map((id) => parseInt(id)).filter((id) => !isNaN(id));
        if (parsedIds.length === 0) {
            throw new ApiError(400, "No valid booking IDs provided");
        }

        // Fetch bookings to check permissions and status
        const bookings = await prisma.booking.findMany({
            where: { booking_id: { in: parsedIds } },
        });

        if (bookings.length === 0) {
            throw new ApiError(404, "No matching bookings found");
        }

        // Permission check: agency_admin / agency_user / org can only update bookings for their agency
        if (req.user.role !== "super_admin") {
            const userAgencyId = parseInt(req.user.agencyId || req.user.agency_id || req.user.org_id || req.user.id || 0);
            const invalidBookings = bookings.filter((b) => parseInt(b.agency_id) !== userAgencyId);
            if (invalidBookings.length > 0) {
                throw new ApiError(403, "Access denied: Some bookings do not belong to your agency");
            }
        }

        const operatorId = parseInt(req.user.id || 0) || null;
        const now = new Date();

        // Filter bookings that can be updated based on action
        const targetBookingIds = bookings
            .filter((b) => {
                const s = (b.status || "").toLowerCase().trim();
                return s === "pending_approval" || s === "pending" || s === "booked" || s === "rejected";
            })
            .map((b) => b.booking_id);

        if (targetBookingIds.length === 0) {
            throw new ApiError(
                400,
                `None of the selected bookings can be ${validAction}d in their current state`
            );
        }

        // Find bookings that actually need status change (not already in target state)
        const bookingsToUpdate = bookings.filter((b) => {
            const s = (b.status || "").toLowerCase().trim();
            if (validAction === "approve") return s !== "booked";
            if (validAction === "reject") return s !== "rejected";
            return true;
        });

        const pendingBookingIds = bookingsToUpdate.map((b) => b.booking_id);

        if (pendingBookingIds.length > 0) {
            const updatePayload =
                validAction === "approve"
                    ? {
                          status: "booked",
                          approved_by: operatorId,
                          approved_at: now,
                          rejected_by: null,
                          rejected_at: null,
                          rejection_reason: null,
                      }
                    : {
                          status: "rejected",
                          rejected_by: operatorId,
                          rejected_at: now,
                          rejection_reason: rejectionReason.trim(),
                      };

            await prisma.booking.updateMany({
                where: { booking_id: { in: pendingBookingIds } },
                data: updatePayload,
            });

            // Send notifications to affected users asynchronously
            const { notifyUser } = require("../utils/notifications");
            for (const b of bookingsToUpdate) {
                if (b.user_id) {
                    const title = validAction === "approve" ? "Booking Approved!" : "Booking Rejected";
                    const message =
                        validAction === "approve"
                            ? `Your booking (${b.booking_code}) at ${b.agency_name} has been approved.`
                            : `Your booking (${b.booking_code}) at ${b.agency_name} was rejected. Reason: ${rejectionReason.trim()}`;
                    notifyUser(b.user_id, {
                        type: validAction === "approve" ? "booking_approved" : "booking_rejected",
                        title,
                        message,
                        data: {
                            bookingId: b.booking_id,
                            bookingCode: b.booking_code,
                            rejectionReason: validAction === "reject" ? rejectionReason.trim() : null,
                        },
                    }).catch((err) => console.error("Error sending notification:", err));
                }
            }
        }

        const count = targetBookingIds.length;
        return new ApiResponse(
            200,
            { updatedCount: count, action: validAction },
            `Successfully ${validAction === "approve" ? "approved" : "rejected"} ${count} booking(s)`
        ).send(res);
    } catch (error) {
        console.error("Error in updateBookingApprovalStatus:", error);
        if (error instanceof ApiError)
            return res.status(error.statusCode).json(error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

module.exports = {
    createBooking,
    getUserBookings,
    getAgencyBookings,
    getBookingDetailsByCode,
    checkIn,
    checkOut,
    cancelBooking,
    forceCancelBooking,
    previewCancelBooking,
    processBookingRefund,
    updateBookingApprovalStatus,
};
