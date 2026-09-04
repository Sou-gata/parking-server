const { prisma } = require("./db");
const Logger = require("./log");
const { notifyUserWithFCM } = require("./notifications");

/**
 * Helper to fetch overtime notification settings from DB (configurations table)
 * with sensible fallback defaults.
 */
const getOvertimeConfigValues = async () => {
    try {
        const configs = await prisma.configuration.findMany({
            where: {
                config_key: {
                    in: [
                        "overtime_first_reminder_mins",
                        "overtime_second_reminder_mins",
                        "overdue_reminder_interval_mins",
                        "overtime_notifications_enabled",
                    ],
                },
            },
        });

        const configMap = {};
        for (const item of configs) {
            configMap[item.config_key] = item.config_value;
        }

        const firstReminderMins =
            parseInt(configMap["overtime_first_reminder_mins"] || "60", 10) ||
            60;
        const secondReminderMins =
            parseInt(configMap["overtime_second_reminder_mins"] || "15", 10) ||
            15;
        const overdueIntervalMins =
            parseInt(configMap["overdue_reminder_interval_mins"] || "15", 10) ||
            15;
        const enabled = configMap["overtime_notifications_enabled"] !== "false";

        return {
            firstReminderMins,
            secondReminderMins,
            overdueIntervalMins,
            enabled,
        };
    } catch (err) {
        Logger.error(
            "[Notification Job] Error reading overtime notification configs from DB, using defaults:",
            err
        );
        return {
            firstReminderMins: 60,
            secondReminderMins: 15,
            overdueIntervalMins: 15,
            enabled: true,
        };
    }
};

const formatTimeLabel = (mins) => {
    if (mins >= 60 && mins % 60 === 0) {
        const hrs = mins / 60;
        return `${hrs} hour${hrs > 1 ? "s" : ""}`;
    }
    return `${mins} minutes`;
};

const checkBookingNotificationReminders = async () => {
    try {
        const {
            firstReminderMins,
            secondReminderMins,
            overdueIntervalMins,
            enabled,
        } = await getOvertimeConfigValues();

        if (!enabled) {
            return;
        }

        const now = new Date();

        // -------------------------------------------------------------
        // 1. Send first expiration notification (e.g. 60 mins before expiry)
        // -------------------------------------------------------------
        const firstReminderTime = new Date(
            now.getTime() + firstReminderMins * 60 * 1000
        );
        const secondReminderTime = new Date(
            now.getTime() + secondReminderMins * 60 * 1000
        );

        const bookings1h = await prisma.booking.findMany({
            where: {
                status: { in: ["booked", "checked_in"] },
                user_id: { not: null },
                booking_end_time: {
                    gt: secondReminderTime,
                    lte: firstReminderTime,
                },
                notified_1h: false,
            },
        });

        const firstTimeLabel = formatTimeLabel(firstReminderMins);

        for (const booking of bookings1h) {
            try {
                if (booking.user_id) {
                    await notifyUserWithFCM(booking.user_id, {
                        type: "booking_expiry_1h",
                        title: "Booking Expiring Soon",
                        message: `Your booking (${booking.booking_code}) for vehicle ${booking.vehicle_number} at ${booking.agency_name} will expire in ${firstTimeLabel}.`,
                        data: {
                            type: "booking_expiry_1h",
                            bookingId: booking.booking_id.toString(),
                            bookingCode: booking.booking_code,
                            vehicleNumber: booking.vehicle_number,
                            agencyName: booking.agency_name,
                            bookingEndTime: booking.booking_end_time
                                ? booking.booking_end_time.toISOString()
                                : "",
                        },
                    });

                    await prisma.booking.update({
                        where: { booking_id: booking.booking_id },
                        data: { notified_1h: true },
                    });

                    Logger.info(
                        `[Notification Job] Sent 1st (${firstTimeLabel}) expiry notification to user ${booking.user_id} for booking ${booking.booking_code}.`
                    );
                }
            } catch (err1h) {
                console.error(
                    `[Notification Job] Error processing 1st notification for booking ${booking.booking_code}:`,
                    err1h
                );
            }
        }

        // -------------------------------------------------------------
        // 2. Send second expiration notification (e.g. 15 mins before expiry)
        // -------------------------------------------------------------
        const bookings15m = await prisma.booking.findMany({
            where: {
                status: { in: ["booked", "checked_in"] },
                user_id: { not: null },
                booking_end_time: {
                    gt: now,
                    lte: secondReminderTime,
                },
                notified_15m: false,
            },
        });

        const secondTimeLabel = formatTimeLabel(secondReminderMins);

        for (const booking of bookings15m) {
            try {
                if (booking.user_id) {
                    await notifyUserWithFCM(booking.user_id, {
                        type: "booking_expiry_15m",
                        title: `Booking Expiring in ${secondTimeLabel}`,
                        message: `Your booking (${booking.booking_code}) for vehicle ${booking.vehicle_number} at ${booking.agency_name} will expire in ${secondTimeLabel}.`,
                        data: {
                            type: "booking_expiry_15m",
                            bookingId: booking.booking_id.toString(),
                            bookingCode: booking.booking_code,
                            vehicleNumber: booking.vehicle_number,
                            agencyName: booking.agency_name,
                            bookingEndTime: booking.booking_end_time
                                ? booking.booking_end_time.toISOString()
                                : "",
                        },
                    });

                    await prisma.booking.update({
                        where: { booking_id: booking.booking_id },
                        data: { notified_15m: true },
                    });

                    Logger.info(
                        `[Notification Job] Sent 2nd (${secondTimeLabel}) expiry notification to user ${booking.user_id} for booking ${booking.booking_code}.`
                    );
                }
            } catch (err15m) {
                console.error(
                    `[Notification Job] Error processing 2nd notification for booking ${booking.booking_code}:`,
                    err15m
                );
            }
        }

        // -------------------------------------------------------------
        // 3. Send recurring overdue notification with current charge
        // -------------------------------------------------------------
        const overdueBookings = await prisma.booking.findMany({
            where: {
                status: "checked_in",
                user_id: { not: null },
                booking_end_time: {
                    lt: now,
                },
            },
        });

        const overdueIntervalMs = overdueIntervalMins * 60 * 1000;

        for (const booking of overdueBookings) {
            try {
                const lastNotifiedAt = booking.last_overdue_notification_at
                    ? new Date(booking.last_overdue_notification_at).getTime()
                    : 0;

                if (now.getTime() - lastNotifiedAt >= overdueIntervalMs) {
                    const startTime = new Date(
                        booking.checkin_time ||
                            booking.start_time ||
                            booking.booking_start_time ||
                            now
                    );
                    const durationMs = now.getTime() - startTime.getTime();
                    const durationHours = Math.max(
                        1,
                        durationMs / (1000 * 60 * 60)
                    );
                    const hourlyRate = parseFloat(booking.hourly_rate || 0);
                    const totalBill = parseFloat(
                        (durationHours * hourlyRate).toFixed(2)
                    );
                    const bookedCost =
                        parseFloat(booking.booked_duration || 0) * hourlyRate;
                    const currentCharge = Math.max(totalBill, bookedCost);

                    const overdueMs =
                        now.getTime() -
                        new Date(booking.booking_end_time).getTime();
                    const overdueMinutes = Math.max(
                        1,
                        Math.floor(overdueMs / (1000 * 60))
                    );

                    if (booking.user_id) {
                        await notifyUserWithFCM(booking.user_id, {
                            type: "booking_overdue_reminder",
                            title: "Vehicle Overdue - Parking Active",
                            message: `Your vehicle (${booking.vehicle_number}) at ${booking.agency_name} has exceeded booking time by ${overdueMinutes} mins. Current estimated charge: ₹${currentCharge.toFixed(2)}.`,
                            data: {
                                type: "booking_overdue_reminder",
                                bookingId: booking.booking_id.toString(),
                                bookingCode: booking.booking_code,
                                vehicleNumber: booking.vehicle_number,
                                agencyName: booking.agency_name,
                                overdueMinutes: overdueMinutes.toString(),
                                currentCharge: currentCharge.toFixed(2),
                            },
                        });

                        await prisma.booking.update({
                            where: { booking_id: booking.booking_id },
                            data: { last_overdue_notification_at: now },
                        });

                        Logger.info(
                            `[Notification Job] Sent ${overdueIntervalMins}-min overdue reminder to user ${booking.user_id} for booking ${booking.booking_code} (Charge: ₹${currentCharge.toFixed(2)}).`
                        );
                    }
                }
            } catch (errOverdue) {
                console.error(
                    `[Notification Job] Error processing overdue notification for booking ${booking.booking_code}:`,
                    errOverdue
                );
            }
        }
    } catch (error) {
        console.error(
            "[Notification Job] Error in checkBookingNotificationReminders run:",
            error
        );
    }
};

const startBookingNotificationJob = () => {
    // Run once on startup, then every 60 seconds
    checkBookingNotificationReminders();
    setInterval(checkBookingNotificationReminders, 60000);
    Logger.info(
        "[Notification Job] Started booking notification reminders background job (runs every 60s)."
    );
};

module.exports = {
    startBookingNotificationJob,
    checkBookingNotificationReminders,
};
