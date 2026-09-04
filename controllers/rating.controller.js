const { prisma } = require("../utils/db");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const { getIsTestUser } = require("../middlewares/auth.middleware");

/**
 * Submit a rating & review after checkout.
 * Handled for both:
 * 1. user -> agency (User rating the parking location)
 * 2. agency_to_user (agency_admin / agency_user rating the customer)
 */
const submitRating = async (req, res) => {
    try {
        let { agencyId, bookingId, rating, review, ratingType } = req.body;
        const userRole = req.user.role;
        const reqUserId = req.user.id;
        const reqAgencyId = req.user.agencyId || req.user.org_id;

        // Automatically infer ratingType if not specified based on role
        if (!ratingType) {
            if (userRole === "user") {
                ratingType = "user_to_agency";
            } else if (userRole === "agency_admin" || userRole === "agency_user") {
                ratingType = "agency_to_user";
            } else {
                ratingType = "user_to_agency";
            }
        }

        if (!["user_to_agency", "agency_to_user"].includes(ratingType)) {
            throw new ApiError(
                400,
                "Invalid ratingType. Must be 'user_to_agency' or 'agency_to_user'"
            );
        }

        const parsedRating = parseInt(rating);
        if (isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5) {
            throw new ApiError(400, "Rating must be a number between 1 and 5");
        }

        if (!bookingId) {
            throw new ApiError(400, "bookingId is required to submit a rating");
        }

        const parsedBookingId = parseInt(bookingId);
        if (isNaN(parsedBookingId)) {
            throw new ApiError(400, "Invalid bookingId");
        }

        // Fetch booking to validate status and association
        const booking = await prisma.booking.findUnique({
            where: { booking_id: parsedBookingId },
        });

        if (!booking) {
            throw new ApiError(404, "Booking not found");
        }

        if (booking.status !== "completed") {
            throw new ApiError(
                400,
                "Rating can only be submitted for a completed booking"
            );
        }

        const parsedUserId = booking.user_id;
        const parsedAgencyId = booking.agency_id;

        if (ratingType === "user_to_agency") {
            if (userRole === "user" && reqUserId !== booking.user_id) {
                throw new ApiError(403, "You can only rate your own bookings");
            }
        } else if (ratingType === "agency_to_user") {
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
                    "Cannot rate walk-in/guest booking without a registered user account"
                );
            }
        }

        // Check for existing rating for this booking & ratingType
        const existingRating = await prisma.rating.findFirst({
            where: {
                booking_id: parsedBookingId,
                rating_type: ratingType,
            },
        });

        if (existingRating) {
            throw new ApiError(
                409,
                `Rating already submitted for this booking (${ratingType === "user_to_agency" ? "User to Agency" : "Agency to User"})`
            );
        }

        const newRating = await prisma.rating.create({
            data: {
                user_id: parsedUserId,
                agency_id: parsedAgencyId,
                booking_id: parsedBookingId,
                rating: parsedRating,
                review: review ? review.trim() : null,
                rating_type: ratingType,
            },
        });

        const result = mapRating(newRating);

        return res
            .status(201)
            .json(
                new ApiResponse(201, result, "Rating submitted successfully")
            );
    } catch (error) {
        console.error("Error in submitRating:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        if (error.code === "P2002") {
            return res
                .status(409)
                .json(
                    new ApiError(
                        409,
                        "A rating for this booking and rating type already exists"
                    )
                );
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Get all ratings for a specific booking (both user-to-agency and agency-to-user)
 * GET /api/v1/ratings/booking/:bookingId
 */
const getBookingRatings = async (req, res) => {
    try {
        const { bookingId } = req.params;
        const parsedBookingId = parseInt(bookingId);
        if (isNaN(parsedBookingId)) {
            throw new ApiError(400, "Invalid bookingId");
        }

        const ratings = await prisma.rating.findMany({
            where: { booking_id: parsedBookingId },
        });

        const userToAgencyRating = ratings.find(
            (r) => r.rating_type === "user_to_agency"
        );
        const agencyToUserRating = ratings.find(
            (r) => r.rating_type === "agency_to_user"
        );

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    bookingId: parsedBookingId,
                    userToAgencyRating: userToAgencyRating
                        ? mapRating(userToAgencyRating)
                        : null,
                    agencyToUserRating: agencyToUserRating
                        ? mapRating(agencyToUserRating)
                        : null,
                },
                "Booking ratings fetched successfully"
            )
        );
    } catch (error) {
        console.error("Error in getBookingRatings:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Get all ratings for a parking agency with aggregate stats.
 * Public endpoint — no auth required.
 * GET /api/v1/ratings/agency/:agencyId?page=1&limit=10
 */
const getAgencyRatings = async (req, res) => {
    try {
        const { agencyId } = req.params;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(
            50,
            Math.max(1, parseInt(req.query.limit) || 10)
        );
        const skip = (page - 1) * limit;

        const parsedAgencyId = parseInt(agencyId);
        if (isNaN(parsedAgencyId)) {
            throw new ApiError(400, "Invalid agencyId");
        }

        const isTestUser = await getIsTestUser(req);

        // Check target agency test status
        const targetAgency = await prisma.orgUser.findUnique({
            where: { org_id: parsedAgencyId },
            select: { is_test_data: true },
        });

        if (!targetAgency || (!isTestUser && targetAgency.is_test_data)) {
            throw new ApiError(404, "Agency not found");
        }

        // Ratings given by users to this agency
        const whereClause = {
            agency_id: parsedAgencyId,
            rating_type: "user_to_agency",
        };

        if (!isTestUser) {
            const testUsers = await prisma.user.findMany({
                where: { is_test_data: true },
                select: { user_id: true },
            });
            const testUserIds = testUsers.map((u) => u.user_id);
            if (testUserIds.length > 0) {
                whereClause.user_id = { notIn: testUserIds };
            }
        }

        const [ratings, totalCount] = await Promise.all([
            prisma.rating.findMany({
                where: whereClause,
                orderBy: { created_at: "desc" },
                skip,
                take: limit,
            }),
            prisma.rating.count({ where: whereClause }),
        ]);

        const allRatings = await prisma.rating.findMany({
            where: whereClause,
            select: { rating: true },
        });

        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        let sum = 0;

        for (const r of allRatings) {
            sum += r.rating;
            if (distribution[r.rating] !== undefined) {
                distribution[r.rating]++;
            }
        }

        const averageRating =
            allRatings.length > 0
                ? parseFloat((sum / allRatings.length).toFixed(2))
                : 0;

        const userIds = [...new Set(ratings.map((r) => r.user_id))];
        const users = await prisma.user.findMany({
            where: { user_id: { in: userIds } },
            select: {
                user_id: true,
                full_name: true,
                profile_photo_path: true,
            },
        });
        const userMap = {};
        for (const u of users) {
            userMap[u.user_id] = u;
        }

        const mappedRatings = ratings.map((r) => ({
            ...mapRating(r),
            userName: userMap[r.user_id]?.full_name || "Anonymous",
            userPhoto: userMap[r.user_id]?.profile_photo_path || null,
        }));

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    agencyId: parsedAgencyId,
                    stats: {
                        averageRating,
                        totalCount,
                        distribution,
                    },
                    pagination: {
                        page,
                        limit,
                        totalPages: Math.ceil(totalCount / limit),
                        totalCount,
                    },
                    ratings: mappedRatings,
                },
                "Agency ratings fetched successfully"
            )
        );
    } catch (error) {
        console.error("Error in getAgencyRatings:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Get all ratings associated with a specific user (ratings received from agencies + ratings given to agencies).
 * Authenticated — user can view their own; super_admin / agency staff can view any.
 * GET /api/v1/ratings/user/:userId
 */
const getUserRatings = async (req, res) => {
    try {
        const { userId } = req.params;

        const parsedUserId = parseInt(userId);
        if (isNaN(parsedUserId)) {
            throw new ApiError(400, "Invalid userId");
        }

        if (
            req.user.role === "user" &&
            req.user.id !== parsedUserId
        ) {
            throw new ApiError(
                403,
                "Access denied: You cannot view ratings of other users"
            );
        }

        const isTestUser = await getIsTestUser(req);

        // Fetch user profile details
        const userObj = await prisma.user.findUnique({
            where: { user_id: parsedUserId },
            select: {
                user_id: true,
                full_name: true,
                username: true,
                email: true,
                phone_number: true,
                profile_photo_path: true,
                status: true,
                is_test_data: true,
                created_at: true,
            },
        });

        if (!userObj || (!isTestUser && userObj.is_test_data)) {
            throw new ApiError(404, "User not found");
        }

        // Fetch ratings received by user from agencies (agency_to_user)
        let receivedRatings = await prisma.rating.findMany({
            where: { user_id: parsedUserId, rating_type: "agency_to_user" },
            orderBy: { created_at: "desc" },
        });

        // Fetch ratings given by user to agencies (user_to_agency)
        let givenRatings = await prisma.rating.findMany({
            where: { user_id: parsedUserId, rating_type: "user_to_agency" },
            orderBy: { created_at: "desc" },
        });

        // Fetch agency details for display & test data filtering
        const agencyIds = [
            ...new Set([
                ...receivedRatings.map((r) => r.agency_id),
                ...givenRatings.map((r) => r.agency_id),
            ]),
        ];
        const agencyWhere = { org_id: { in: agencyIds } };
        if (!isTestUser) {
            agencyWhere.is_test_data = false;
        }
        const agencies = await prisma.orgUser.findMany({
            where: agencyWhere,
            select: { org_id: true, org_name: true, is_test_data: true },
        });
        const validAgencySet = new Set(agencies.map((a) => a.org_id));
        const agencyMap = {};
        for (const a of agencies) {
            agencyMap[a.org_id] = a.org_name;
        }

        if (!isTestUser) {
            receivedRatings = receivedRatings.filter((r) => validAgencySet.has(r.agency_id));
            givenRatings = givenRatings.filter((r) => validAgencySet.has(r.agency_id));
        }

        // Calculate aggregate stats for received ratings (Customer rating score)
        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        let sum = 0;
        for (const r of receivedRatings) {
            sum += r.rating;
            if (distribution[r.rating] !== undefined) {
                distribution[r.rating]++;
            }
        }
        const averageRating =
            receivedRatings.length > 0
                ? parseFloat((sum / receivedRatings.length).toFixed(2))
                : 0;

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    userId: parsedUserId,
                    userProfile: userObj
                        ? {
                              id: userObj.user_id,
                              fullName: userObj.full_name,
                              username: userObj.username,
                              email: userObj.email,
                              phoneNumber: userObj.phone_number,
                              profilePhoto: userObj.profile_photo_path,
                              status: userObj.status,
                              createdAt: userObj.created_at,
                          }
                        : null,
                    stats: {
                        averageRating,
                        totalCount: receivedRatings.length,
                        distribution,
                    },
                    receivedRatings: receivedRatings.map((r) => ({
                        ...mapRating(r),
                        agencyName: agencyMap[r.agency_id] || "Unknown Agency",
                    })),
                    givenRatings: givenRatings.map((r) => ({
                        ...mapRating(r),
                        agencyName: agencyMap[r.agency_id] || "Unknown Agency",
                    })),
                },
                "User ratings fetched successfully"
            )
        );
    } catch (error) {
        console.error("Error in getUserRatings:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Delete a rating.
 * Users can delete their own ratings; agency staff can delete agency ratings; super_admin can delete any.
 * DELETE /api/v1/ratings/:ratingId
 */
const deleteRating = async (req, res) => {
    try {
        const { ratingId } = req.params;

        const parsedRatingId = parseInt(ratingId);
        if (isNaN(parsedRatingId)) {
            throw new ApiError(400, "Invalid ratingId");
        }

        const existingRating = await prisma.rating.findUnique({
            where: { rating_id: parsedRatingId },
        });

        if (!existingRating) {
            throw new ApiError(404, "Rating not found");
        }

        const reqUserId = req.user.id;
        const reqUserRole = req.user.role;

        if (reqUserRole !== "super_admin") {
            if (
                existingRating.rating_type === "user_to_agency" &&
                existingRating.user_id !== reqUserId
            ) {
                throw new ApiError(
                    403,
                    "Access denied: You can only delete your own ratings"
                );
            }
            if (
                existingRating.rating_type === "agency_to_user" &&
                req.user.agencyId !== existingRating.agency_id
            ) {
                throw new ApiError(
                    403,
                    "Access denied: You can only delete ratings from your agency"
                );
            }
        }

        await prisma.rating.delete({
            where: { rating_id: parsedRatingId },
        });

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    { ratingId: parsedRatingId },
                    "Rating deleted successfully"
                )
            );
    } catch (error) {
        console.error("Error in deleteRating:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Helper — map a Rating DB row to a clean camelCase response object.
 */
function mapRating(r) {
    if (!r) return null;
    return {
        id: r.rating_id,
        userId: r.user_id,
        agencyId: r.agency_id,
        bookingId: r.booking_id,
        rating: r.rating,
        review: r.review,
        ratingType: r.rating_type || "user_to_agency",
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

module.exports = {
    submitRating,
    getBookingRatings,
    getAgencyRatings,
    getUserRatings,
    deleteRating,
};
