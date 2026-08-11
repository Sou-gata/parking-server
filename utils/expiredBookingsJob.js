const { prisma } = require("./db");
const Logger = require("./log");
const { distributePaymentCommission } = require("./commission");


const checkExpiredBookings = async () => {
    try {
        const now = new Date();

        // Find all bookings with status "booked" that have expired
        const expiredBookings = await prisma.booking.findMany({
            where: {
                status: "booked",
                booking_end_time: {
                    lt: now,
                },
            },
        });

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
                            const newBalance = parseFloat((currentBalance - bookingCost).toFixed(2));

                            await tx.user.update({
                                where: { user_id: booking.user_id },
                                data: { wallet_balance: newBalance },
                            });

                            await tx.walletTransaction.create({
                                data: {
                                    user_id: booking.user_id,
                                    amount: bookingCost,
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
                            },
                        });
                    });
                } else {
                    // Non-user bookings (offline reservations)
                    await prisma.booking.update({
                        where: { booking_id: booking.booking_id },
                        data: {
                            status: "cancelled",
                            total_bill: bookingCost,
                            payment_status: "paid",
                        },
                    });
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
};
