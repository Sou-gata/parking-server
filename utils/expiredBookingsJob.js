const { prisma } = require("./db");
const Logger = require("./log");
const { distributePaymentCommission } = require("./commission");
const { notifyUserWithFCM } = require("./notifications");

/**
 * Helper to determine if a booking has exceeded the allowed check-in grace period.
 * Rule: Cancelled only if user does not show up (check in) after 1h of booking time started
 * OR booking time is completely over (whichever comes earlier).
 */
const isBookingNoShowOrExpired = (booking, now) => {
    const start = booking.booking_start_time
        ? new Date(booking.booking_start_time)
        : null;
    const end = booking.booking_end_time
        ? new Date(booking.booking_end_time)
        : null;

    if (!start && !end) return false;

    if (start && end) {
        const oneHourAfterStart = new Date(start.getTime() + 60 * 60 * 1000);
        const threshold = end < oneHourAfterStart ? end : oneHourAfterStart;
        return now >= threshold;
    }

    if (start) {
        const oneHourAfterStart = new Date(start.getTime() + 60 * 60 * 1000);
        return now >= oneHourAfterStart;
    }

    return now >= end;
};

const checkExpiredBookings = async () => {
    try {
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

        // 1. Auto-cancel bookings pending approval whose allowed check-in time expired (Zero deduction)
        // Rule: Cancelled only if 1 hour after booking start time has passed OR booking time is over (whichever comes earlier)
        const candidatePendingBookings = await prisma.booking.findMany({
            where: {
                status: { in: ["pending_approval", "pending"] },
                OR: [
                    {
                        booking_start_time: {
                            lte: oneHourAgo,
                        },
                    },
                    {
                        booking_end_time: {
                            lte: now,
                        },
                    },
                ],
            },
        });

        const expiredPendingBookings = candidatePendingBookings.filter((b) =>
            isBookingNoShowOrExpired(b, now)
        );

        if (expiredPendingBookings.length > 0) {
            Logger.warn(
                `[Auto-Cancel Job] Found ${expiredPendingBookings.length} expired pending-approval booking(s) to auto-cancel without deduction.`
            );

            for (const booking of expiredPendingBookings) {
                try {
                    await prisma.booking.update({
                        where: { booking_id: booking.booking_id },
                        data: {
                            status: "cancelled",
                            total_bill: 0,
                            payment_status: "cancelled",
                            is_force_cancelled: true,
                            cancelled_by: "system",
                            cancellation_reason:
                                "Auto-cancelled: User did not show up within 1 hour of scheduled start time or booking time ended without agency approval.",
                        },
                    });

                    // Notify customer (Zero deduction)
                    if (booking.user_id) {
                        await notifyUserWithFCM(booking.user_id, {
                            type: "booking_cancelled",
                            title: "Booking Request Expired",
                            message: `Your booking request (${booking.booking_code}) at ${booking.agency_name} was automatically cancelled because it was not approved or checked in within the allowed time (1 hour after start time or end of booking). No amount was deducted.`,
                            data: {
                                type: "booking_cancelled",
                                bookingId: booking.booking_id.toString(),
                                bookingCode: booking.booking_code,
                                status: "cancelled",
                            },
                        }).catch((err) =>
                            console.error(
                                `[Auto-Cancel Job] Error notifying user ${booking.user_id}:`,
                                err
                            )
                        );
                    }

                    // Notify agency admin & staff
                    try {
                        const agencyStaff = await prisma.user.findMany({
                            where: { agency_id: booking.agency_id },
                            select: { user_id: true },
                        });
                        const recipientIds = Array.from(
                            new Set([
                                booking.agency_id,
                                ...agencyStaff.map((u) => u.user_id),
                            ])
                        );

                        for (const recipientId of recipientIds) {
                            await notifyUserWithFCM(recipientId, {
                                type: "booking_approval_expired",
                                title: "Pending Booking Expired",
                                message: `Booking request (${booking.booking_code}) for ${booking.vehicle_number} has been automatically cancelled because the allowed time (1 hour after start time or end of booking) passed without approval.`,
                                data: {
                                    type: "booking_approval_expired",
                                    bookingId: booking.booking_id.toString(),
                                    bookingCode: booking.booking_code,
                                    status: "cancelled",
                                },
                            }).catch((err) =>
                                console.error(
                                    `[Auto-Cancel Job] Error notifying agency recipient ${recipientId}:`,
                                    err
                                )
                            );
                        }
                    } catch (agencyNotifyErr) {
                        console.error(
                            "[Auto-Cancel Job] Error querying/notifying agency staff:",
                            agencyNotifyErr
                        );
                    }

                    Logger.info(
                        `[Auto-Cancel Job] Successfully auto-cancelled expired pending booking ${booking.booking_code} (₹0 charged).`
                    );
                } catch (pendingCancelErr) {
                    console.error(
                        `[Auto-Cancel Job] Error auto-cancelling pending booking ${booking.booking_code}:`,
                        pendingCancelErr
                    );
                }
            }
        }

        // 2. Find all bookings with status "booked" that have expired (No-show auto-cancel and charge)
        // Rule: Cancelled only if user did not check in after 1 hour of booking start time OR booking time is over (whichever comes earlier)
        const candidateBooked = await prisma.booking.findMany({
            where: {
                status: "booked",
                checkin_time: null,
                OR: [
                    {
                        booking_start_time: {
                            lte: oneHourAgo,
                        },
                    },
                    {
                        booking_end_time: {
                            lte: now,
                        },
                    },
                ],
            },
        });

        const expiredBookings = candidateBooked.filter((b) =>
            isBookingNoShowOrExpired(b, now)
        );

        if (expiredBookings.length === 0) return;

        Logger.warn(`[Auto-Cancel Job] Found ${expiredBookings.length} expired bookings to auto-cancel and charge.`);

        for (const booking of expiredBookings) {
            try {
                const bookingCost = parseFloat(booking.booked_duration) * parseFloat(booking.hourly_rate);

                if (booking.user_id) {
                    await prisma.$transaction(async (tx) => {
                        // Deduct booking cost from user's wallet
                        const user = await tx.user.findUnique({
                            where: { user_id: booking.user_id },
                        });

                        if (user) {
                            const currentBalance = parseFloat(user.wallet_balance || 0);
                            // No-show auto-cancel is not parking overtime, so balance cannot drop below 0
                            const newBalance = Math.max(0, parseFloat((currentBalance - bookingCost).toFixed(2)));

                            await tx.user.update({
                                where: { user_id: booking.user_id },
                                data: { wallet_balance: newBalance },
                            });

                            await tx.walletTransaction.create({
                                data: {
                                    user_id: booking.user_id,
                                    amount: bookingCost,
                                    previous_balance: currentBalance,
                                    new_balance: newBalance,
                                    type: "withdrawal",
                                    status: "approved",
                                    transaction_number: `NOSHOW-${booking.booking_code}`,
                                },
                            });

                            // Distribute no-show payment commission between Agency Admin and Super Admin
                            await distributePaymentCommission(tx, {
                                agencyId: booking.agency_id,
                                bookingId: booking.booking_id,
                                bookingCode: booking.booking_code,
                                amount: bookingCost,
                            });
                        }

                        // Update booking status
                        await tx.booking.update({
                            where: { booking_id: booking.booking_id },
                            data: {
                                status: "cancelled",
                                total_bill: bookingCost,
                                payment_status: "paid",
                                is_force_cancelled: true,
                                cancelled_by: "system",
                                cancellation_reason:
                                    "Auto-cancelled: No-show. User did not check in within 1 hour of scheduled start time or before booking ended.",
                            },
                        });
                    });

                    // Notify customer (No-show deduction)
                    await notifyUserWithFCM(booking.user_id, {
                        type: "booking_cancelled",
                        title: "Booking Cancelled (No-Show)",
                        message: `Your booking (${booking.booking_code}) at ${booking.agency_name} was automatically cancelled due to no-show. ₹${bookingCost.toFixed(2)} was charged.`,
                        data: {
                            type: "booking_cancelled",
                            bookingId: booking.booking_id.toString(),
                            bookingCode: booking.booking_code,
                            status: "cancelled",
                        },
                    }).catch((err) =>
                        console.error(
                            `[Auto-Cancel Job] Error notifying user ${booking.user_id} of no-show:`,
                            err
                        )
                    );
                } else {
                    // Non-user bookings (offline reservations)
                    await prisma.booking.update({
                        where: { booking_id: booking.booking_id },
                        data: {
                            status: "cancelled",
                            total_bill: bookingCost,
                            payment_status: "paid",
                            is_force_cancelled: true,
                            cancelled_by: "system",
                            cancellation_reason:
                                "Auto-cancelled: No-show. User did not check in within 1 hour of scheduled start time or before booking ended.",
                        },
                    });
                }

                // Notify agency admin & staff
                try {
                    const agencyStaff = await prisma.user.findMany({
                        where: { agency_id: booking.agency_id },
                        select: { user_id: true },
                    });
                    const recipientIds = Array.from(
                        new Set([
                            booking.agency_id,
                            ...agencyStaff.map((u) => u.user_id),
                        ])
                    );

                    for (const recipientId of recipientIds) {
                        await notifyUserWithFCM(recipientId, {
                            type: "booking_noshow_cancelled",
                            title: "Booking No-Show Cancelled",
                            message: `Booking (${booking.booking_code}) for ${booking.vehicle_number} was automatically cancelled as no-show (₹${bookingCost.toFixed(2)} charged).`,
                            data: {
                                type: "booking_noshow_cancelled",
                                bookingId: booking.booking_id.toString(),
                                bookingCode: booking.booking_code,
                                status: "cancelled",
                            },
                        }).catch((err) =>
                            console.error(
                                `[Auto-Cancel Job] Error notifying agency recipient ${recipientId} of no-show:`,
                                err
                            )
                        );
                    }
                } catch (agencyNotifyErr) {
                    console.error(
                        "[Auto-Cancel Job] Error querying/notifying agency staff for no-show:",
                        agencyNotifyErr
                    );
                }

                Logger.info(`[Auto-Cancel Job] Successfully auto-cancelled and billed booking ${booking.booking_code} (₹${bookingCost})`);
            } catch (err) {
                console.error(`[Auto-Cancel Job] Error processing expired booking ${booking.booking_code}:`, err);
            }
        }
    } catch (error) {
        console.error("[Auto-Cancel Job] Error in checkExpiredBookings run:", error);
    }
};

const startExpiredBookingsJob = () => {
    // Run once at startup, then every minute
    checkExpiredBookings();
    setInterval(checkExpiredBookings, 60000);
    Logger.info("[Auto-Cancel Job] Started expired bookings auto-cancellation background job (runs every 60s).");
};

module.exports = {
    startExpiredBookingsJob,
    isBookingNoShowOrExpired,
};
