const { prisma } = require("../utils/db");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const { getIsTestUser } = require("../middlewares/auth.middleware");

/**
 * Helper to enrich complaint object with booking, user, agency, and ordered steps timeline.
 */
/**
 * Helper to enrich complaint object with booking, user, agency, and ordered steps timeline.
 */
const enrichComplaint = async (c) => {
    const booking = c.booking_id
        ? await prisma.booking.findUnique({
              where: { booking_id: c.booking_id },
          })
        : null;
    const user = c.user_id
        ? await prisma.user.findUnique({
              where: { user_id: c.user_id },
              select: {
                  user_id: true,
                  full_name: true,
                  phone_number: true,
                  email: true,
              },
          })
        : null;
    const agency = c.agency_id
        ? await prisma.orgUser.findUnique({
              where: { org_id: c.agency_id },
              select: {
                  org_id: true,
                  org_name: true,
                  phone_number: true,
                  email: true,
              },
          })
        : null;

    // Fetch steps timeline
    let steps = [];
    try {
        steps = await prisma.complaintStep.findMany({
            where: { complaint_id: c.complaint_id },
            orderBy: { step_number: "asc" },
        });
    } catch (err) {
        console.warn("Could not fetch steps for complaint:", err.message);
    }

    return {
        ...c,
        booking,
        user,
        agency,
        steps,
    };
};

/**
 * Submit a complaint.
 * Supports User -> Agency, Agency -> User, Admin -> User, and Admin -> Agency complaints.
 * Creates the complaint and automatically logs Step #1 with initial comment/description.
 */
const createComplaint = async (req, res) => {
    try {
        const {
            bookingId,
            targetUserId,
            userId,
            targetAgencyId,
            agencyId,
            subject,
            description,
        } = req.body;
        let { complainantType } = req.body;
        const userRole = req.user.role;
        const reqUserId = req.user.id;
        const reqAgencyId = req.user.agencyId || req.user.id;

        if (!description || !description.trim()) {
            throw new ApiError(400, "Complaint description is required");
        }

        if (description.trim().length > 1000) {
            throw new ApiError(
                400,
                "Complaint description cannot exceed 1000 characters"
            );
        }

        // Infer complainantType if not provided
        if (!complainantType) {
            if (userRole === "super_admin") {
                const effectiveAgencyId = targetAgencyId || agencyId;
                complainantType = effectiveAgencyId
                    ? "admin_to_agency"
                    : "admin_to_user";
            } else if (userRole === "user") {
                complainantType = "user_to_agency";
            } else if (
                userRole === "agency_admin" ||
                userRole === "agency_user" ||
                userRole === "org"
            ) {
                complainantType = "agency_to_user";
            } else {
                complainantType = "user_to_agency";
            }
        }

        const VALID_COMPLAINANT_TYPES = [
            "user_to_agency",
            "agency_to_user",
            "admin_to_user",
            "admin_to_agency",
        ];

        if (!VALID_COMPLAINANT_TYPES.includes(complainantType)) {
            throw new ApiError(
                400,
                `Invalid complainantType. Must be one of: ${VALID_COMPLAINANT_TYPES.join(", ")}`
            );
        }

        // Admin-initiated complaints check
        if (
            (complainantType === "admin_to_user" ||
                complainantType === "admin_to_agency") &&
            userRole !== "super_admin"
        ) {
            throw new ApiError(
                403,
                "Only Super Admin can file admin complaints"
            );
        }

        let parsedBookingId = null;
        let booking = null;

        if (bookingId) {
            parsedBookingId = parseInt(bookingId);
            if (isNaN(parsedBookingId)) {
                throw new ApiError(400, "Invalid bookingId");
            }
            booking = await prisma.booking.findUnique({
                where: { booking_id: parsedBookingId },
            });
            if (!booking) {
                throw new ApiError(404, "Booking not found");
            }
        }

        // Non-admin users/agencies must provide bookingId
        if (
            !bookingId &&
            (complainantType === "user_to_agency" ||
                complainantType === "agency_to_user")
        ) {
            throw new ApiError(
                400,
                "bookingId is required to lodge this complaint"
            );
        }

        const now = Date.now();
        const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

        let finalUserId = null;
        let finalAgencyId = null;

        if (complainantType === "user_to_agency") {
            if (userRole === "user" && reqUserId !== booking.user_id) {
                throw new ApiError(
                    403,
                    "You can only lodge complaints for your own bookings"
                );
            }

            let deadlineMs = null;
            if (booking.checkout_time) {
                deadlineMs =
                    new Date(booking.checkout_time).getTime() + SIX_HOURS_MS;
            } else {
                let bookingEndTime =
                    booking.booking_end_time || booking.end_time;
                let endMs = bookingEndTime
                    ? new Date(bookingEndTime).getTime()
                    : null;

                if (!endMs || isNaN(endMs)) {
                    const baseStart =
                        booking.booking_start_time ||
                        booking.start_time ||
                        booking.created_at;
                    if (baseStart) {
                        const durationHours = parseFloat(
                            booking.booked_duration || 1
                        );
                        endMs =
                            new Date(baseStart).getTime() +
                            durationHours * 3600000;
                    }
                }

                if (endMs) {
                    deadlineMs = endMs + SIX_HOURS_MS;
                }
            }

            if (deadlineMs && now > deadlineMs) {
                throw new ApiError(
                    400,
                    "The complaint filing window for this booking has expired (limited to 6 hours after checkout or booking end time)."
                );
            }

            finalUserId = booking.user_id || reqUserId;
            finalAgencyId = booking.agency_id;
        } else if (complainantType === "agency_to_user") {
            if (
                userRole !== "super_admin" &&
                reqAgencyId !== booking.agency_id
            ) {
                throw new ApiError(
                    403,
                    "Access denied: Staff does not belong to this agency"
                );
            }
            if (!booking.user_id) {
                throw new ApiError(
                    400,
                    "Cannot lodge complaint against walk-in/guest booking without registered user"
                );
            }
            finalUserId = booking.user_id;
            finalAgencyId = booking.agency_id;
        } else if (complainantType === "admin_to_user") {
            const rawTargetUserId =
                targetUserId || userId || (booking ? booking.user_id : null);
            if (!rawTargetUserId) {
                throw new ApiError(
                    400,
                    "Target User ID is required to lodge complaint against a user"
                );
            }
            finalUserId = parseInt(rawTargetUserId);
            if (isNaN(finalUserId)) {
                throw new ApiError(400, "Invalid target user ID");
            }
            const targetUser = await prisma.user.findUnique({
                where: { user_id: finalUserId },
            });
            if (!targetUser) {
                throw new ApiError(404, "Target user not found");
            }
            finalAgencyId = booking
                ? booking.agency_id
                : targetAgencyId || agencyId
                  ? parseInt(targetAgencyId || agencyId)
                  : null;
        } else if (complainantType === "admin_to_agency") {
            const rawTargetAgencyId =
                targetAgencyId ||
                agencyId ||
                (booking ? booking.agency_id : null);
            if (!rawTargetAgencyId) {
                throw new ApiError(
                    400,
                    "Target Agency ID is required to lodge complaint against an agency"
                );
            }
            finalAgencyId = parseInt(rawTargetAgencyId);
            if (isNaN(finalAgencyId)) {
                throw new ApiError(400, "Invalid target agency ID");
            }
            const targetAgency = await prisma.orgUser.findUnique({
                where: { org_id: finalAgencyId },
            });
            if (!targetAgency) {
                throw new ApiError(
                    404,
                    "Target agency owner/organization not found"
                );
            }
            finalUserId = booking
                ? booking.user_id
                : targetUserId || userId
                  ? parseInt(targetUserId || userId)
                  : null;
        }

        // Check single complaint constraint per booking & complainantType if bookingId exists
        if (parsedBookingId) {
            const existingComplaint = await prisma.complaint.findFirst({
                where: {
                    booking_id: parsedBookingId,
                    complainant_type: complainantType,
                },
            });

            if (existingComplaint) {
                throw new ApiError(
                    400,
                    "A complaint has already been submitted for this booking under this category"
                );
            }
        }

        // Default subjects by type
        const defaultSubjects = {
            user_to_agency: "User Complaint",
            agency_to_user: "Agency Complaint",
            admin_to_user: "Admin Complaint against User",
            admin_to_agency: "Admin Complaint against Agency",
        };

        // Create main complaint entry
        const newComplaint = await prisma.complaint.create({
            data: {
                booking_id: parsedBookingId,
                user_id: finalUserId,
                agency_id: finalAgencyId,
                complainant_type: complainantType,
                complainant_id: reqUserId,
                subject:
                    subject?.trim() ||
                    defaultSubjects[complainantType] ||
                    "Admin Complaint",
                description: description.trim(),
                status: "pending",
            },
        });

        // Automatically record Step #1 with initial comment
        try {
            await prisma.complaintStep.create({
                data: {
                    complaint_id: newComplaint.complaint_id,
                    step_number: 1,
                    action_by_role: userRole,
                    action_by_id: reqUserId,
                    previous_status: null,
                    new_status: "pending",
                    comment: description.trim(),
                },
            });
        } catch (stepErr) {
            console.error("Failed to create Step 1 for complaint:", stepErr);
        }

        const enriched = await enrichComplaint(newComplaint);

        return res
            .status(201)
            .json(
                new ApiResponse(
                    201,
                    enriched,
                    "Complaint submitted successfully"
                )
            );
    } catch (error) {
        console.error("createComplaint Error:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res
            .status(500)
            .json(
                new ApiError(500, error.message || "Failed to submit complaint")
            );
    }
};

/**
 * Fetch booking IDs where current user has filed complaints.
 */
const getUserBookingComplaintStatus = async (req, res) => {
    try {
        const userId = req.user.id;
        const userComplaints = await prisma.complaint.findMany({
            where: {
                user_id: userId,
                complainant_type: "user_to_agency",
            },
            select: {
                booking_id: true,
                created_at: true,
            },
        });

        const complainedBookingIds = userComplaints.map((c) => c.booking_id);

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    { userComplainedBookingIds: complainedBookingIds },
                    "User complaint booking status retrieved"
                )
            );
    } catch (error) {
        console.error("getUserBookingComplaintStatus Error:", error);
        return res
            .status(500)
            .json(new ApiError(500, "Failed to fetch user complaint status"));
    }
};

/**
 * Get complaints for the logged-in user with step timeline.
 */
const getUserComplaints = async (req, res) => {
    try {
        const userId = req.user.id;
        const complaints = await prisma.complaint.findMany({
            where: { user_id: userId },
            orderBy: { created_at: "desc" },
        });

        const enriched = await Promise.all(complaints.map(enrichComplaint));

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    enriched,
                    "User complaints retrieved successfully"
                )
            );
    } catch (error) {
        console.error("getUserComplaints Error:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res
            .status(500)
            .json(new ApiError(500, "Failed to retrieve user complaints"));
    }
};

/**
 * Get complaints for an Agency Admin (or Super Admin).
 */
const getAgencyComplaints = async (req, res) => {
    try {
        const userRole = req.user.role;
        const reqAgencyId = req.user.agencyId || req.user.id;

        if (userRole === "user") {
            throw new ApiError(
                403,
                "Users are not authorized to view agency complaints"
            );
        }

        const isTestUser = await getIsTestUser(req);
        let whereCondition = {};
        if (userRole !== "super_admin") {
            whereCondition.agency_id = reqAgencyId;
        }

        if (!isTestUser) {
            const testUsers = await prisma.user.findMany({
                where: { is_test_data: true },
                select: { user_id: true },
            });
            const testUserIds = testUsers.map((u) => u.user_id);
            if (testUserIds.length > 0) {
                whereCondition.user_id = { notIn: testUserIds };
            }

            const testAgencies = await prisma.orgUser.findMany({
                where: { is_test_data: true },
                select: { org_id: true },
            });
            const testAgencyIds = testAgencies.map((a) => a.org_id);
            if (testAgencyIds.length > 0) {
                whereCondition.agency_id = { notIn: testAgencyIds };
            }
        }

        const complaints = await prisma.complaint.findMany({
            where: whereCondition,
            orderBy: { created_at: "desc" },
        });

        const enriched = await Promise.all(complaints.map(enrichComplaint));

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    enriched,
                    "Agency complaints retrieved successfully"
                )
            );
    } catch (error) {
        console.error("getAgencyComplaints Error:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res
            .status(500)
            .json(new ApiError(500, "Failed to retrieve agency complaints"));
    }
};

/**
 * Get all complaints for Super Admin.
 */
const getAllComplaints = async (req, res) => {
    try {
        const isTestUser = await getIsTestUser(req);
        let whereCondition = {};

        if (!isTestUser) {
            const testUsers = await prisma.user.findMany({
                where: { is_test_data: true },
                select: { user_id: true },
            });
            const testUserIds = testUsers.map((u) => u.user_id);
            if (testUserIds.length > 0) {
                whereCondition.user_id = { notIn: testUserIds };
            }

            const testAgencies = await prisma.orgUser.findMany({
                where: { is_test_data: true },
                select: { org_id: true },
            });
            const testAgencyIds = testAgencies.map((a) => a.org_id);
            if (testAgencyIds.length > 0) {
                whereCondition.agency_id = { notIn: testAgencyIds };
            }
        }

        const complaints = await prisma.complaint.findMany({
            where: whereCondition,
            orderBy: { created_at: "desc" },
        });

        const enriched = await Promise.all(complaints.map(enrichComplaint));

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    enriched,
                    "All complaints retrieved successfully"
                )
            );
    } catch (error) {
        console.error("getAllComplaints Error:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res
            .status(500)
            .json(new ApiError(500, "Failed to retrieve all complaints"));
    }
};

/**
 * Get single complaint timeline details.
 */
const getComplaintById = async (req, res) => {
    try {
        const { complaintId } = req.params;
        const parsedId = parseInt(complaintId);
        if (isNaN(parsedId)) {
            throw new ApiError(400, "Invalid complaintId");
        }

        const complaint = await prisma.complaint.findUnique({
            where: { complaint_id: parsedId },
        });

        if (!complaint) {
            throw new ApiError(404, "Complaint not found");
        }

        const isTestUser = await getIsTestUser(req);
        if (!isTestUser) {
            if (complaint.user_id) {
                const u = await prisma.user.findUnique({
                    where: { user_id: complaint.user_id },
                    select: { is_test_data: true },
                });
                if (u && u.is_test_data) throw new ApiError(404, "Complaint not found");
            }
            if (complaint.agency_id) {
                const a = await prisma.orgUser.findUnique({
                    where: { org_id: complaint.agency_id },
                    select: { is_test_data: true },
                });
                if (a && a.is_test_data) throw new ApiError(404, "Complaint not found");
            }
        }

        const userRole = req.user.role;
        const reqUserId = req.user.id;
        const reqAgencyId = req.user.agencyId || req.user.id;

        if (
            userRole === "user" &&
            complaint.user_id !== reqUserId &&
            complaint.complainant_id !== reqUserId
        ) {
            throw new ApiError(403, "Access denied to this complaint");
        }

        if (
            userRole !== "super_admin" &&
            userRole !== "user" &&
            complaint.agency_id !== reqAgencyId
        ) {
            throw new ApiError(403, "Access denied to this agency complaint");
        }

        const enriched = await enrichComplaint(complaint);
        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    enriched,
                    "Complaint details retrieved successfully"
                )
            );
    } catch (error) {
        console.error("getComplaintById Error:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res
            .status(500)
            .json(new ApiError(500, "Failed to fetch complaint details"));
    }
};

/**
 * Add a new step (comment + optional status change) to a complaint.
 * Allows step-by-step progress with comments by User, Agency, or Admin.
 */
const addComplaintStep = async (req, res) => {
    try {
        const { complaintId } = req.params;
        const { comment, newStatus, resolutionNotes } = req.body;
        const userRole = req.user.role;
        const reqUserId = req.user.id;
        const reqAgencyId = req.user.agencyId || req.user.id;

        if (!complaintId) {
            throw new ApiError(400, "complaintId is required");
        }

        const parsedId = parseInt(complaintId);
        if (isNaN(parsedId)) {
            throw new ApiError(400, "Invalid complaintId");
        }

        if (!comment || !comment.trim()) {
            throw new ApiError(400, "Step comment is required");
        }

        const complaint = await prisma.complaint.findUnique({
            where: { complaint_id: parsedId },
        });

        if (!complaint) {
            throw new ApiError(404, "Complaint not found");
        }

        // Authorization check - Users can ONLY add a step/reply when complaint status is currently 'waiting_for_user'
        if (userRole === "user") {
            if (
                complaint.user_id !== reqUserId &&
                complaint.complainant_id !== reqUserId
            ) {
                throw new ApiError(
                    403,
                    "Access denied: You can only access your own complaints"
                );
            }
            if (complaint.status !== "waiting_for_user") {
                throw new ApiError(
                    403,
                    "Access denied: You can only reply to a complaint when status is 'Waiting for User'"
                );
            }
        } else if (
            userRole !== "super_admin" &&
            complaint.agency_id !== reqAgencyId
        ) {
            throw new ApiError(
                403,
                "Access denied: Complaint does not belong to your agency"
            );
        }

        const VALID_STATUSES = [
            "pending",
            "under_review",
            "waiting_for_user",
            "waiting_for_agency",
            "resolved",
            "dismissed",
        ];

        let targetStatus =
            newStatus && VALID_STATUSES.includes(newStatus)
                ? newStatus
                : complaint.status;

        // If user replies while status is waiting_for_user, transition status to waiting_for_agency by default
        if (
            userRole === "user" &&
            complaint.status === "waiting_for_user" &&
            (!newStatus || newStatus === "waiting_for_user")
        ) {
            targetStatus = "waiting_for_agency";
        }

        // Calculate next step number
        let nextStepNumber = 1;
        try {
            const lastStep = await prisma.complaintStep.findFirst({
                where: { complaint_id: parsedId },
                orderBy: { step_number: "desc" },
            });
            if (lastStep && lastStep.step_number) {
                nextStepNumber = lastStep.step_number + 1;
            }
        } catch (e) {
            console.warn("Error finding last step:", e.message);
        }

        // Create new step entry
        await prisma.complaintStep.create({
            data: {
                complaint_id: parsedId,
                step_number: nextStepNumber,
                action_by_role: userRole,
                action_by_id: reqUserId,
                previous_status: complaint.status,
                new_status: targetStatus,
                comment: comment.trim(),
            },
        });

        // Update parent complaint status and notes
        const updatedComplaint = await prisma.complaint.update({
            where: { complaint_id: parsedId },
            data: {
                status: targetStatus,
                resolution_notes:
                    resolutionNotes?.trim() ||
                    comment.trim() ||
                    complaint.resolution_notes,
                resolved_by:
                    targetStatus === "resolved" || targetStatus === "dismissed"
                        ? reqUserId
                        : complaint.resolved_by,
                resolved_at:
                    targetStatus === "resolved" || targetStatus === "dismissed"
                        ? new Date()
                        : complaint.resolved_at,
            },
        });

        const enriched = await enrichComplaint(updatedComplaint);

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    enriched,
                    `Step #${nextStepNumber} added successfully`
                )
            );
    } catch (error) {
        console.error("addComplaintStep Error:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res
            .status(500)
            .json(
                new ApiError(
                    500,
                    error.message || "Failed to add complaint step"
                )
            );
    }
};

/**
 * Update complaint status & resolution notes (Backward compatibility wrapper).
 */
const updateComplaintStatus = async (req, res) => {
    try {
        const { complaintId } = req.params;
        const { status, resolutionNotes, comment } = req.body;
        const stepComment =
            comment || resolutionNotes || `Status updated to ${status}`;

        req.body.comment = stepComment;
        req.body.newStatus = status;

        return await addComplaintStep(req, res);
    } catch (error) {
        console.error("updateComplaintStatus Error:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res
            .status(500)
            .json(new ApiError(500, "Failed to update complaint status"));
    }
};

const createComplaintSuper = async (req, res) => {
    try {
        const {
            bookingCode,
            targetUserId,
            targetAgencyId,
            subject,
            description,
        } = req.body;
        const userRole = req.user.role;
        const reqUserId = req.user.id;

        // Only Super Admin can use this endpoint
        if (userRole !== "super_admin") {
            throw new ApiError(403, "Only Super Admin can file complaints");
        }

        if (!description || !description.trim()) {
            throw new ApiError(400, "Complaint description is required");
        }

        if (description.trim().length > 1000) {
            throw new ApiError(
                400,
                "Complaint description cannot exceed 1000 characters"
            );
        }

        // Must specify either target user or target agency
        if (!targetUserId && !targetAgencyId) {
            throw new ApiError(
                400,
                "Either targetUserId or targetAgencyId is required"
            );
        }

        let parsedBookingId = null;
        let booking = null;

        // Look up booking by bookingCode if provided (OPTIONAL)
        if (bookingCode) {
            const trimmedCode = bookingCode.trim();
            if (!trimmedCode) {
                throw new ApiError(400, "Booking code cannot be empty");
            }

            booking = await prisma.booking.findUnique({
                where: { booking_code: trimmedCode },
            });

            if (!booking) {
                throw new ApiError(
                    404,
                    "Booking not found with the provided booking code"
                );
            }
            parsedBookingId = booking.booking_id;
        }

        let finalUserId = null; // The user being complained against
        let finalAgencyId = null; // The agency being complained against
        let complainantType = null;

        // Determine complainant type and set IDs
        if (targetAgencyId) {
            // Super Admin → Agency complaint
            complainantType = "admin_to_agency";
            finalAgencyId = parseInt(targetAgencyId);

            if (isNaN(finalAgencyId)) {
                throw new ApiError(400, "Invalid target agency ID");
            }

            const targetAgency = await prisma.orgUser.findUnique({
                where: { org_id: finalAgencyId },
            });

            if (!targetAgency) {
                throw new ApiError(404, "Target agency not found");
            }

            // If booking exists, get user_id from booking (optional)
            if (booking) {
                finalUserId = booking.user_id;
            }
        } else if (targetUserId) {
            // Super Admin → User complaint
            complainantType = "admin_to_user";
            finalUserId = parseInt(targetUserId);

            if (isNaN(finalUserId)) {
                throw new ApiError(400, "Invalid target user ID");
            }

            const targetUser = await prisma.user.findUnique({
                where: { user_id: finalUserId },
            });

            if (!targetUser) {
                throw new ApiError(404, "Target user not found");
            }

            // If booking exists, get agency_id from booking (optional)
            if (booking) {
                finalAgencyId = booking.agency_id;
            }
        }

        // If booking exists, validate it belongs to the target
        if (booking) {
            if (targetAgencyId && booking.agency_id !== finalAgencyId) {
                throw new ApiError(
                    400,
                    "Booking does not belong to the target agency"
                );
            }
            if (targetUserId && booking.user_id !== finalUserId) {
                throw new ApiError(
                    400,
                    "Booking does not belong to the target user"
                );
            }

            // Check single complaint constraint per booking & complainantType
            const existingComplaint = await prisma.complaint.findFirst({
                where: {
                    booking_id: parsedBookingId,
                    complainant_type: complainantType,
                },
            });

            if (existingComplaint) {
                throw new ApiError(
                    400,
                    "A complaint has already been submitted for this booking under this category"
                );
            }
        }

        // Default subjects by type
        const defaultSubjects = {
            admin_to_user: "Admin Complaint against User",
            admin_to_agency: "Admin Complaint against Agency",
        };

        // Create complaint data
        // complainant_id = Super Admin (who filed the complaint)
        // user_id = Target User (who the complaint is against) - for admin_to_user
        // agency_id = Target Agency (who the complaint is against) - for admin_to_agency
        const complaintData = {
            complainant_id: reqUserId, // Super Admin who filed the complaint
            user_id: finalUserId, // Target user (if admin_to_user)
            agency_id: finalAgencyId, // Target agency (if admin_to_agency)
            complainant_type: complainantType,
            subject: subject?.trim() || defaultSubjects[complainantType],
            description: description.trim(),
            status: "pending",
        };

        // Only add booking_id if it exists (OPTIONAL)
        if (parsedBookingId) {
            complaintData.booking_id = parsedBookingId;
        }

        const newComplaint = await prisma.complaint.create({
            data: complaintData,
        });

        // Automatically record Step #1 with initial comment
        try {
            await prisma.complaintStep.create({
                data: {
                    complaint_id: newComplaint.complaint_id,
                    step_number: 1,
                    action_by_role: userRole,
                    action_by_id: reqUserId,
                    previous_status: null,
                    new_status: "pending",
                    comment: description.trim(),
                },
            });
        } catch (stepErr) {
            console.error("Failed to create Step 1 for complaint:", stepErr);
        }

        const enriched = await enrichComplaint(newComplaint);

        return res
            .status(201)
            .json(
                new ApiResponse(201, enriched, "Complaint filed successfully")
            );
    } catch (error) {
        console.error("createComplaintSuper Error:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res
            .status(500)
            .json(
                new ApiError(500, error.message || "Failed to file complaint")
            );
    }
};

module.exports = {
    createComplaint,
    getUserBookingComplaintStatus,
    getUserComplaints,
    getAgencyComplaints,
    getAllComplaints,
    getComplaintById,
    addComplaintStep,
    updateComplaintStatus,
    createComplaintSuper,
};
