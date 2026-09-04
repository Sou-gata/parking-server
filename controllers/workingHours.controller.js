const { prisma } = require("../utils/db");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

const safeJsonParse = (str, fallback = null) => {
    try {
        return str ? JSON.parse(str) : fallback;
    } catch (e) {
        return fallback;
    }
};

const DEFAULT_DAYS = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];

const buildDefaultDailySchedules = (
    activeDays = DEFAULT_DAYS,
    openTime = "08:00",
    closeTime = "20:00",
    is247 = false
) => {
    const schedules = {};
    DEFAULT_DAYS.forEach((day) => {
        const isOpen = Array.isArray(activeDays) ? activeDays.includes(day) : true;
        schedules[day] = {
            isOpen,
            is247: Boolean(is247),
            openTime: openTime || "08:00",
            closeTime: closeTime || "20:00",
        };
    });
    return schedules;
};

const formatWorkingHoursResponse = (wh, orgDetails = null) => {
    if (!wh) {
        const defaultDaily = buildDefaultDailySchedules();
        return {
            id: null,
            orgId: orgDetails ? orgDetails.org_id : null,
            workingDays: DEFAULT_DAYS,
            openTime: "08:00",
            closeTime: "20:00",
            is247: false,
            specialVacations: [],
            dailySchedules: defaultDaily,
            pendingWorkingDays: null,
            pendingOpenTime: null,
            pendingCloseTime: null,
            pendingIs247: false,
            pendingSpecialVacations: null,
            pendingDailySchedules: null,
            status: "approved",
            rejectionReason: null,
            orgName: orgDetails ? orgDetails.org_name : null,
            orgOwner: orgDetails ? orgDetails.username : null,
        };
    }

    const workingDaysParsed = safeJsonParse(wh.working_days, DEFAULT_DAYS);
    const openTimeVal = wh.open_time || "08:00";
    const closeTimeVal = wh.close_time || "20:00";
    const is247Val = Boolean(wh.is_24_7);

    let dailySchedules = safeJsonParse(wh.daily_schedules, null);
    if (!dailySchedules || typeof dailySchedules !== "object") {
        dailySchedules = buildDefaultDailySchedules(
            workingDaysParsed,
            openTimeVal,
            closeTimeVal,
            is247Val
        );
    }

    let pendingDailySchedules = safeJsonParse(wh.pending_daily_schedules, null);
    if (!pendingDailySchedules && wh.status === "pending" && wh.pending_working_days) {
        pendingDailySchedules = buildDefaultDailySchedules(
            safeJsonParse(wh.pending_working_days, DEFAULT_DAYS),
            wh.pending_open_time || "08:00",
            wh.pending_close_time || "20:00",
            Boolean(wh.pending_is_24_7)
        );
    }

    return {
        id: wh.id,
        orgId: wh.org_id,
        workingDays: workingDaysParsed,
        openTime: openTimeVal,
        closeTime: closeTimeVal,
        is247: is247Val,
        specialVacations: safeJsonParse(wh.special_vacations, []),
        dailySchedules,
        pendingWorkingDays: safeJsonParse(wh.pending_working_days, null),
        pendingOpenTime: wh.pending_open_time || null,
        pendingCloseTime: wh.pending_close_time || null,
        pendingIs247: Boolean(wh.pending_is_24_7),
        pendingSpecialVacations: safeJsonParse(wh.pending_special_vacations, null),
        pendingDailySchedules,
        status: wh.status || "approved",
        rejectionReason: wh.rejection_reason || null,
        updatedAt: wh.updated_at,
        orgName: orgDetails ? orgDetails.org_name : wh.org_name || null,
        orgOwner: orgDetails ? orgDetails.username : wh.org_owner || null,
    };
};

/**
 * Get working hours for an agency (Public/Secured)
 */
const getWorkingHours = async (req, res) => {
    try {
        const { id } = req.params;
        const orgId = parseInt(id, 10);

        if (isNaN(orgId)) {
            throw new ApiError(400, "Invalid agency ID");
        }

        const agency = await prisma.orgUser.findUnique({
            where: { org_id: orgId },
        });

        if (!agency) {
            throw new ApiError(404, "Agency not found");
        }

        let wh = await prisma.orgWorkingHours.findUnique({
            where: { org_id: orgId },
        });

        const formatted = formatWorkingHoursResponse(wh, agency);

        return new ApiResponse(
            200,
            formatted,
            "Working hours fetched successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in getWorkingHours:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Update working hours & special vacations (Agency Admin or Super Admin)
 */
const updateWorkingHours = async (req, res) => {
    try {
        const { id } = req.params;
        const orgId = parseInt(id, 10);

        if (isNaN(orgId)) {
            throw new ApiError(400, "Invalid agency ID");
        }

        const userAgencyId =
            req.user.agencyId ||
            req.user.agency_id ||
            req.user.org_id ||
            req.user.id;
        if (
            req.user.role !== "super_admin" &&
            String(userAgencyId) !== String(orgId)
        ) {
            throw new ApiError(
                403,
                "Access denied: You can only update working hours for your own agency"
            );
        }

        const {
            workingDays,
            openTime,
            closeTime,
            is247,
            specialVacations,
            dailySchedules,
        } = req.body;

        let compiledDailySchedules = dailySchedules;
        if (!compiledDailySchedules || typeof compiledDailySchedules !== "object") {
            compiledDailySchedules = buildDefaultDailySchedules(
                workingDays,
                openTime,
                closeTime,
                is247
            );
        }

        const activeWorkingDays = DEFAULT_DAYS.filter(
            (day) => compiledDailySchedules[day]?.isOpen !== false
        );

        const workingDaysStr = JSON.stringify(activeWorkingDays);
        const vacationsStr = Array.isArray(specialVacations)
            ? JSON.stringify(specialVacations)
            : typeof specialVacations === "string"
            ? specialVacations
            : JSON.stringify([]);
        const dailySchedulesStr = JSON.stringify(compiledDailySchedules);

        const firstOpenDay = DEFAULT_DAYS.find(
            (d) => compiledDailySchedules[d]?.isOpen
        );
        const openTimeVal =
            (firstOpenDay && compiledDailySchedules[firstOpenDay]?.openTime) ||
            openTime ||
            "08:00";
        const closeTimeVal =
            (firstOpenDay && compiledDailySchedules[firstOpenDay]?.closeTime) ||
            closeTime ||
            "20:00";
        const is247Val =
            activeWorkingDays.length > 0 &&
            activeWorkingDays.every(
                (d) => compiledDailySchedules[d]?.is247
            );

        const parseTimeVal = (tStr) => {
            if (!tStr) return 0;
            const [h, m] = tStr.split(":").map(Number);
            return (h || 0) + (m || 0) / 60;
        };

        for (const day of activeWorkingDays) {
            const sched = compiledDailySchedules[day];
            if (sched && !sched.is247) {
                const openVal = parseTimeVal(sched.openTime);
                const closeVal = parseTimeVal(sched.closeTime);

                if (openVal >= closeVal) {
                    throw new ApiError(
                        400,
                        `Opening time (${sched.openTime}) must be earlier than closing time (${sched.closeTime}) on ${day}.`
                    );
                }

                if (closeVal - openVal < 2) {
                    throw new ApiError(
                        400,
                        `Operating hours duration on ${day} (${sched.openTime} to ${sched.closeTime}) must be at least 2 hours.`
                    );
                }
            }
        }

        let existing = await prisma.orgWorkingHours.findUnique({
            where: { org_id: orgId },
        });

        const isSuperAdmin = req.user.role === "super_admin";

        // Validate 7-day advance notice for newly added special vacations (unless modified by Super Admin)
        if (!isSuperAdmin && Array.isArray(specialVacations)) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            let existingVacations = [];
            if (existing) {
                const existingStr = existing.pending_special_vacations || existing.special_vacations;
                if (existingStr) {
                    try {
                        existingVacations = JSON.parse(existingStr);
                    } catch (e) {}
                }
            }

            for (const vac of specialVacations) {
                if (vac.startDate) {
                    const isAlreadySaved = existingVacations.some((ev) => ev.id === vac.id);
                    if (!isAlreadySaved) {
                        const vStart = new Date(`${vac.startDate}T00:00:00`);
                        const diffTime = vStart.getTime() - today.getTime();
                        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
                        if (diffDays < 7) {
                            throw new ApiError(
                                400,
                                `Special vacation '${vac.title || "Holiday"}' starting on ${vac.startDate} must be declared at least 7 days in advance.`
                            );
                        }
                    }
                }
            }
        }

        let updated;
        if (isSuperAdmin) {
            // Super Admin updates directly to active working hours
            if (existing) {
                updated = await prisma.orgWorkingHours.update({
                    where: { org_id: orgId },
                    data: {
                        working_days: workingDaysStr,
                        open_time: openTimeVal,
                        close_time: closeTimeVal,
                        is_24_7: is247Val,
                        special_vacations: vacationsStr,
                        daily_schedules: dailySchedulesStr,
                        pending_working_days: null,
                        pending_open_time: null,
                        pending_close_time: null,
                        pending_is_24_7: false,
                        pending_special_vacations: null,
                        pending_daily_schedules: null,
                        status: "approved",
                        rejection_reason: null,
                    },
                });
            } else {
                updated = await prisma.orgWorkingHours.create({
                    data: {
                        org_id: orgId,
                        working_days: workingDaysStr,
                        open_time: openTimeVal,
                        close_time: closeTimeVal,
                        is_24_7: is247Val,
                        special_vacations: vacationsStr,
                        daily_schedules: dailySchedulesStr,
                        status: "approved",
                    },
                });
            }
        } else {
            // Agency Admin updates go into pending_* fields awaiting Super Admin approval
            if (existing) {
                updated = await prisma.orgWorkingHours.update({
                    where: { org_id: orgId },
                    data: {
                        pending_working_days: workingDaysStr,
                        pending_open_time: openTimeVal,
                        pending_close_time: closeTimeVal,
                        pending_is_24_7: is247Val,
                        pending_special_vacations: vacationsStr,
                        pending_daily_schedules: dailySchedulesStr,
                        status: "pending",
                        rejection_reason: null,
                    },
                });
            } else {
                const defaultDailyStr = JSON.stringify(buildDefaultDailySchedules());
                updated = await prisma.orgWorkingHours.create({
                    data: {
                        org_id: orgId,
                        working_days: JSON.stringify(DEFAULT_DAYS),
                        open_time: "08:00",
                        close_time: "20:00",
                        is_24_7: false,
                        special_vacations: JSON.stringify([]),
                        daily_schedules: defaultDailyStr,
                        pending_working_days: workingDaysStr,
                        pending_open_time: openTimeVal,
                        pending_close_time: closeTimeVal,
                        pending_is_24_7: is247Val,
                        pending_special_vacations: vacationsStr,
                        pending_daily_schedules: dailySchedulesStr,
                        status: "pending",
                    },
                });
            }
        }

        const agency = await prisma.orgUser.findUnique({
            where: { org_id: orgId },
        });

        const formatted = formatWorkingHoursResponse(updated, agency);

        return new ApiResponse(
            200,
            formatted,
            isSuperAdmin
                ? "Working hours updated successfully."
                : "Working hours update submitted successfully for Super Admin approval."
        ).send(res);
    } catch (error) {
        console.error("Error in updateWorkingHours:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Get all pending working hours requests (Super Admin operation)
 */
const getPendingWorkingHoursRequests = async (req, res) => {
    try {
        if (req.user.role !== "super_admin") {
            throw new ApiError(
                403,
                "Access denied: Super Admin permission required"
            );
        }

        const pendingRecords = await prisma.orgWorkingHours.findMany({
            where: { status: "pending" },
            orderBy: { updated_at: "desc" },
        });

        const orgIds = pendingRecords.map((r) => r.org_id);
        const agencies = await prisma.orgUser.findMany({
            where: { org_id: { in: orgIds } },
        });

        const agencyMap = {};
        agencies.forEach((a) => {
            agencyMap[a.org_id] = a;
        });

        const formattedList = pendingRecords.map((wh) =>
            formatWorkingHoursResponse(wh, agencyMap[wh.org_id])
        );

        return new ApiResponse(
            200,
            formattedList,
            "Pending working hours requests fetched successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in getPendingWorkingHoursRequests:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Approve a pending working hours request (Super Admin operation)
 */
const approveWorkingHoursRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const orgId = parseInt(id, 10);

        if (isNaN(orgId)) {
            throw new ApiError(400, "Invalid agency ID");
        }

        if (req.user.role !== "super_admin") {
            throw new ApiError(
                403,
                "Access denied: Super Admin permission required"
            );
        }

        const existing = await prisma.orgWorkingHours.findUnique({
            where: { org_id: orgId },
        });

        if (!existing) {
            throw new ApiError(404, "Working hours record not found");
        }

        if (existing.status !== "pending" && !existing.pending_working_days) {
            throw new ApiError(400, "No pending working hours request to approve");
        }

        const updated = await prisma.orgWorkingHours.update({
            where: { org_id: orgId },
            data: {
                working_days: existing.pending_working_days || existing.working_days,
                open_time: existing.pending_open_time || existing.open_time,
                close_time: existing.pending_close_time || existing.close_time,
                is_24_7: Boolean(existing.pending_is_24_7),
                special_vacations:
                    existing.pending_special_vacations || existing.special_vacations,
                daily_schedules:
                    existing.pending_daily_schedules || existing.daily_schedules,
                pending_working_days: null,
                pending_open_time: null,
                pending_close_time: null,
                pending_is_24_7: false,
                pending_special_vacations: null,
                pending_daily_schedules: null,
                status: "approved",
                rejection_reason: null,
            },
        });

        const agency = await prisma.orgUser.findUnique({
            where: { org_id: orgId },
        });

        const formatted = formatWorkingHoursResponse(updated, agency);

        return new ApiResponse(
            200,
            formatted,
            "Working hours request approved successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in approveWorkingHoursRequest:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Reject a pending working hours request (Super Admin operation)
 */
const rejectWorkingHoursRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const orgId = parseInt(id, 10);

        if (isNaN(orgId)) {
            throw new ApiError(400, "Invalid agency ID");
        }

        if (req.user.role !== "super_admin") {
            throw new ApiError(
                403,
                "Access denied: Super Admin permission required"
            );
        }

        const { rejectionReason } = req.body;

        const existing = await prisma.orgWorkingHours.findUnique({
            where: { org_id: orgId },
        });

        if (!existing) {
            throw new ApiError(404, "Working hours record not found");
        }

        const updated = await prisma.orgWorkingHours.update({
            where: { org_id: orgId },
            data: {
                status: "rejected",
                rejection_reason: rejectionReason || "Request rejected by Super Admin",
            },
        });

        const agency = await prisma.orgUser.findUnique({
            where: { org_id: orgId },
        });

        const formatted = formatWorkingHoursResponse(updated, agency);

        return new ApiResponse(
            200,
            formatted,
            "Working hours request rejected"
        ).send(res);
    } catch (error) {
        console.error("Error in rejectWorkingHoursRequest:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

module.exports = {
    getWorkingHours,
    updateWorkingHours,
    getPendingWorkingHoursRequests,
    approveWorkingHoursRequest,
    rejectWorkingHoursRequest,
};
