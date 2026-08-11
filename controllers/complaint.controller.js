const { prisma } = require("../utils/db");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

/**
 * Helper to enrich complaint object with booking, user, agency, and ordered steps timeline.
 */
const enrichComplaint = async (c) => {
    const booking = await prisma.booking.findUnique({
        where: { booking_id: c.booking_id },
    });
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
 * Submit a complaint for a booking.
 * Creates the complaint and automatically logs Step #1 with initial comment/description.
 */
const createComplaint = async (req, res) => {
    try {
        const { bookingId, subject, description } = req.body;
        let { complainantType } = req.body;
        const userRole = req.user.role;
        const reqUserId = req.user.id;
        const reqAgencyId = req.user.agencyId || req.user.id;

        if (!bookingId) {
            throw new ApiError(400, "bookingId is required to lodge a complaint");
        }

        const parsedBookingId = parseInt(bookingId);
        if (isNaN(parsedBookingId)) {
            throw new ApiError(400, "Invalid bookingId");
        }

        if (!description || !description.trim()) {
            throw new ApiError(400, "Complaint description is required");
        }

        if (description.trim().length > 500) {
            throw new ApiError(400, "Complaint description cannot exceed 500 characters");
        }

        // Infer complainantType if not provided
        if (!complainantType) {
            if (userRole === "user") {
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

        if (!["user_to_agency", "agency_to_user"].includes(complainantType)) {
            throw new ApiError(
                400,
                "Invalid complainantType. Must be 'user_to_agency' or 'agency_to_user'"
            );
        }

        // Fetch booking
        const booking = await prisma.booking.findUnique({
            where: { booking_id: parsedBookingId },
        });

        if (!booking) {
            throw new ApiError(404, "Booking not found");
        }

        const now = Date.now();
        const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

        if (complainantType === "user_to_agency") {
            if (userRole === "user" && reqUserId !== booking.user_id) {
                throw new ApiError(
                    403,
                    "You can only lodge complaints for your own bookings"
                );
            }

            // Determine complaint submission deadline (6 hours after checkout OR 6 hours after booking end time)
            let deadlineMs = null;

            if (booking.checkout_time) {
                deadlineMs = new Date(booking.checkout_time).getTime() + SIX_HOURS_MS;
            } else {
                let bookingEndTime = booking.booking_end_time || booking.end_time;
                let endMs = bookingEndTime ? new Date(bookingEndTime).getTime() : null;

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
                "A complaint has already been submitted for this booking"
            );
        }

        // Create main complaint entry
        const newComplaint = await prisma.complaint.create({
            data: {
                booking_id: parsedBookingId,
                user_id: booking.user_id || reqUserId,
                agency_id: booking.agency_id,
                complainant_type: complainantType,
                complainant_id: reqUserId,
                subject:
                    subject?.trim() ||
                    (complainantType === "user_to_agency"
                        ? "User Complaint"
                        : "Agency Complaint"),
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
            return res.status(error.statusCode).json(error);
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

        return res.status(200).json(
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
            return res.status(error.statusCode).json(error);
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
            throw new ApiError(403, "Users are not authorized to view agency complaints");
        }

        let whereCondition = {};
        if (userRole !== "super_admin") {
            whereCondition.agency_id = reqAgencyId;
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
            return res.status(error.statusCode).json(error);
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
        const complaints = await prisma.complaint.findMany({
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
            return res.status(error.statusCode).json(error);
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
            return res.status(error.statusCode).json(error);
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
            if (complaint.user_id !== reqUserId && complaint.complainant_id !== reqUserId) {
                throw new ApiError(403, "Access denied: You can only access your own complaints");
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
            throw new ApiError(403, "Access denied: Complaint does not belong to your agency");
        }

        const VALID_STATUSES = [
            "pending",
            "under_review",
            "waiting_for_user",
            "waiting_for_agency",
            "resolved",
            "dismissed",
        ];

        let targetStatus = newStatus && VALID_STATUSES.includes(newStatus)
            ? newStatus
            : complaint.status;

        // If user replies while status is waiting_for_user, transition status to waiting_for_agency by default
        if (userRole === "user" && complaint.status === "waiting_for_user" && (!newStatus || newStatus === "waiting_for_user")) {
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
                    resolutionNotes?.trim() || comment.trim() || complaint.resolution_notes,
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
            return res.status(error.statusCode).json(error);
        }
        return res
            .status(500)
            .json(new ApiError(500, error.message || "Failed to add complaint step"));
    }
};

/**
 * Update complaint status & resolution notes (Backward compatibility wrapper).
 */
const updateComplaintStatus = async (req, res) => {
    try {
        const { complaintId } = req.params;
        const { status, resolutionNotes, comment } = req.body;
        const stepComment = comment || resolutionNotes || `Status updated to ${status}`;

        req.body.comment = stepComment;
        req.body.newStatus = status;

        return await addComplaintStep(req, res);
    } catch (error) {
        console.error("updateComplaintStatus Error:", error);
        if (error instanceof ApiError) {
            return res.status(error.statusCode).json(error);
        }
        return res
            .status(500)
            .json(new ApiError(500, "Failed to update complaint status"));
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
};
