const { prisma } = require("../utils/db");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const axios = require("axios");

const safeJsonParse = (str) => {
    try {
        return str ? JSON.parse(str) : null;
    } catch (e) {
        return null;
    }
};

const mapAgencyResponse = (a) => {
    if (!a) return null;
    const item = {
        ...a,
        id: a.org_id,
        name: a.org_name,
        owner: a.username,
        address: a.org_address,
        latitude: a.latitude ? parseFloat(a.latitude) : 0,
        longitude: a.longitude ? parseFloat(a.longitude) : 0,
        two_wheeler_rate: a.two_wheeler_rate
            ? parseFloat(a.two_wheeler_rate)
            : 0,
        three_wheeler_rate: a.three_wheeler_rate
            ? parseFloat(a.three_wheeler_rate)
            : 0,
        car_rate: a.car_rate ? parseFloat(a.car_rate) : 0,
        suv_rate: a.suv_rate ? parseFloat(a.suv_rate) : 0,
        van_rate: a.van_rate ? parseFloat(a.van_rate) : 0,
        pickup_rate: a.pickup_rate ? parseFloat(a.pickup_rate) : 0,
        ev_rate: a.ev_rate ? parseFloat(a.ev_rate) : 0,
        commission_percentage: a.commission_percentage
            ? parseFloat(a.commission_percentage)
            : 0,
        wallet_balance: a.wallet_balance ? parseFloat(a.wallet_balance) : 0,
        require_booking_approval: Boolean(a.require_booking_approval),
        requireBookingApproval: Boolean(a.require_booking_approval),
        cancellationPolicy: safeJsonParse(a.cancellation_policy),
    };
    delete item.password_hash;
    delete item.cancellation_policy;
    return item;
};

/**
 * List all active/approved agencies (for mapping/home list)
 */
const listAgencies = async (req, res) => {
    try {
        const { latitude, longitude, radius } = req.query;

        const agencies = await prisma.orgUser.findMany({
            where: {
                status: {
                    in: ["active", "approved", "pending"],
                },
            },
        });

        // Fetch staff counts for each agency
        const staffCounts = await prisma.user.groupBy({
            by: ["agency_id"],
            where: {
                role: "agency_user",
            },
            _count: {
                user_id: true,
            },
        });

        const countsMap = {};
        staffCounts.forEach((c) => {
            if (c.agency_id) {
                countsMap[c.agency_id] = c._count.user_id;
            }
        });

        // Fetch rating stats for each agency
        const allRatings = await prisma.rating.findMany({
            where: {
                rating_type: "user_to_agency",
            },
            select: {
                agency_id: true,
                rating: true,
            },
        });

        const ratingMap = {};
        allRatings.forEach((r) => {
            if (r.agency_id) {
                if (!ratingMap[r.agency_id]) {
                    ratingMap[r.agency_id] = { sum: 0, count: 0 };
                }
                ratingMap[r.agency_id].sum += r.rating;
                ratingMap[r.agency_id].count += 1;
            }
        });

        const getDistance = (lat1, lon1, lat2, lon2) => {
            const R = 6371; // Radius of the earth in km
            const dLat = (lat2 - lat1) * (Math.PI / 180);
            const dLon = (lon2 - lon1) * (Math.PI / 180);
            const a =
                Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1 * (Math.PI / 180)) *
                    Math.cos(lat2 * (Math.PI / 180)) *
                    Math.sin(dLon / 2) *
                    Math.sin(dLon / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c; // Distance in km
        };

        let cleanAgencies = agencies.map((a) => {
            const mapped = mapAgencyResponse(a);
            const rStats = ratingMap[a.org_id];
            const averageRating =
                rStats && rStats.count > 0
                    ? parseFloat((rStats.sum / rStats.count).toFixed(1))
                    : 0;
            const ratingCount = rStats ? rStats.count : 0;

            return {
                ...mapped,
                staffCount: countsMap[a.org_id] || 0,
                rating: averageRating,
                averageRating,
                ratingCount,
            };
        });

        if (latitude !== undefined && longitude !== undefined) {
            const latVal = parseFloat(latitude);
            const lonVal = parseFloat(longitude);
            const radVal = radius ? parseFloat(radius) : 5.0; // Default 5 km

            if (!isNaN(latVal) && !isNaN(lonVal)) {
                cleanAgencies = cleanAgencies.filter((a) => {
                    const dist = getDistance(
                        latVal,
                        lonVal,
                        a.latitude,
                        a.longitude
                    );
                    return dist <= radVal;
                });
            }
        }

        return new ApiResponse(
            200,
            cleanAgencies,
            "Agencies list fetched successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in listAgencies:", error);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Get details of a single agency
 */
const getAgencyDetails = async (req, res) => {
    try {
        const { id } = req.params;
        const parsedId = parseInt(id);
        if (isNaN(parsedId)) {
            throw new ApiError(400, "Invalid agency ID");
        }
        const agency = await prisma.orgUser.findUnique({
            where: { org_id: parsedId },
        });

        if (!agency) {
            throw new ApiError(404, "Agency not found");
        }

        const agencyRatings = await prisma.rating.findMany({
            where: { agency_id: parsedId, rating_type: "user_to_agency" },
            select: { rating: true },
        });

        const rSum = agencyRatings.reduce((acc, curr) => acc + curr.rating, 0);
        const averageRating =
            agencyRatings.length > 0
                ? parseFloat((rSum / agencyRatings.length).toFixed(1))
                : 0;
        const ratingCount = agencyRatings.length;

        const cleanAgency = {
            ...mapAgencyResponse(agency),
            rating: averageRating,
            averageRating,
            ratingCount,
        };

        return new ApiResponse(
            200,
            cleanAgency,
            "Agency details fetched successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in getAgencyDetails:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Update basic details of an agency
 */
const updateAgencyDetails = async (req, res) => {
    try {
        const { id } = req.params;
        const parsedId = parseInt(id);
        if (isNaN(parsedId)) {
            throw new ApiError(400, "Invalid agency ID");
        }
        const {
            org_name,
            phone_number,
            org_address,
            landmark,
            latitude,
            longitude,
            commission_percentage,
            require_booking_approval,
            requireBookingApproval,
        } = req.body;

        // Ensure user updating is either a super_admin or the owner of this agency
        if (req.user.role !== "super_admin" && req.user.agencyId !== parsedId) {
            throw new ApiError(
                403,
                "Access denied: You cannot update details of another agency"
            );
        }

        const updateData = {
            org_name,
            phone_number: phone_number || null,
            org_address: org_address || null,
            landmark: landmark || null,
            latitude:
                latitude !== undefined && latitude !== null
                    ? parseFloat(latitude)
                    : undefined,
            longitude:
                longitude !== undefined && longitude !== null
                    ? parseFloat(longitude)
                    : undefined,
        };

        if (req.user.role === "super_admin") {
            if (
                commission_percentage !== undefined &&
                commission_percentage !== null
            ) {
                updateData.commission_percentage = parseFloat(
                    commission_percentage
                );
            }
            const approvalVal = require_booking_approval !== undefined ? require_booking_approval : requireBookingApproval;
            if (approvalVal !== undefined && approvalVal !== null) {
                updateData.require_booking_approval = Boolean(approvalVal);
            }
        }

        const updated = await prisma.orgUser.update({
            where: { org_id: parsedId },
            data: updateData,
        });

        const cleanUpdated = mapAgencyResponse(updated);

        return new ApiResponse(
            200,
            cleanUpdated,
            "Agency updated successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in updateAgencyDetails:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Toggle agency booking approval setting (Super Admin only)
 */
const toggleBookingApprovalSetting = async (req, res) => {
    try {
        const { id } = req.params;
        const parsedId = parseInt(id);
        if (isNaN(parsedId)) {
            throw new ApiError(400, "Invalid agency ID");
        }

        const approvalVal =
            req.body.require_booking_approval !== undefined
                ? req.body.require_booking_approval
                : req.body.requireBookingApproval;

        if (approvalVal === undefined || approvalVal === null) {
            throw new ApiError(
                400,
                "require_booking_approval boolean value is required"
            );
        }

        const agency = await prisma.orgUser.findUnique({
            where: { org_id: parsedId },
        });

        if (!agency) {
            throw new ApiError(404, "Agency not found");
        }

        const updated = await prisma.orgUser.update({
            where: { org_id: parsedId },
            data: {
                require_booking_approval: Boolean(approvalVal),
            },
        });

        return new ApiResponse(
            200,
            mapAgencyResponse(updated),
            `Booking approval setting ${
                Boolean(approvalVal) ? "enabled" : "disabled"
            } for agency`
        ).send(res);
    } catch (error) {
        console.error("Error in toggleBookingApprovalSetting:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Update agency capacities
 */
const updateAgencyCapacities = async (req, res) => {
    try {
        const { id } = req.params;
        const parsedId = parseInt(id);
        if (isNaN(parsedId)) {
            throw new ApiError(400, "Invalid agency ID");
        }
        const { capacities } = req.body;

        // Ensure user updating is either a super_admin or the owner of this agency
        if (req.user.role !== "super_admin" && req.user.agencyId !== parsedId) {
            throw new ApiError(
                403,
                "Access denied: You cannot update capacities of another agency"
            );
        }

        if (!capacities) {
            throw new ApiError(400, "Capacities object is required");
        }

        // Map capacities to db field names
        const updateData = {};
        if (capacities.twoWheeler !== undefined)
            updateData.two_wheeler_capacity =
                parseInt(capacities.twoWheeler) || 0;
        if (capacities.threeWheeler !== undefined)
            updateData.three_wheeler_capacity =
                parseInt(capacities.threeWheeler) || 0;
        if (capacities.car !== undefined)
            updateData.car_capacity = parseInt(capacities.car) || 0;
        if (capacities.suv !== undefined)
            updateData.suv_capacity = parseInt(capacities.suv) || 0;
        if (capacities.van !== undefined)
            updateData.van_capacity = parseInt(capacities.van) || 0;
        if (capacities.pickup !== undefined)
            updateData.pickup_capacity = parseInt(capacities.pickup) || 0;
        if (capacities.ev !== undefined)
            updateData.ev_capacity = parseInt(capacities.ev) || 0;
        if (capacities.evChargingSupport !== undefined)
            updateData.ev_charging_support = capacities.evChargingSupport
                ? true
                : false;

        const updated = await prisma.orgUser.update({
            where: { org_id: parsedId },
            data: updateData,
        });

        const cleanUpdated = mapAgencyResponse(updated);

        return new ApiResponse(
            200,
            cleanUpdated,
            "Capacities updated successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in updateAgencyCapacities:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Update agency hourly rates
 */
const updateAgencyRates = async (req, res) => {
    try {
        const { id } = req.params;
        const parsedId = parseInt(id);
        if (isNaN(parsedId)) {
            throw new ApiError(400, "Invalid agency ID");
        }
        const { rates } = req.body;

        // Ensure user updating is either a super_admin or the owner of this agency
        if (req.user.role !== "super_admin" && req.user.agencyId !== parsedId) {
            throw new ApiError(
                403,
                "Access denied: You cannot update rates of another agency"
            );
        }

        if (!rates) {
            throw new ApiError(400, "Rates object is required");
        }

        // Map rates to db field names
        const updateData = {};
        if (rates.twoWheeler !== undefined)
            updateData.two_wheeler_rate = parseFloat(rates.twoWheeler) || 0;
        if (rates.threeWheeler !== undefined)
            updateData.three_wheeler_rate = parseFloat(rates.threeWheeler) || 0;
        if (rates.car !== undefined)
            updateData.car_rate = parseFloat(rates.car) || 0;
        if (rates.suv !== undefined)
            updateData.suv_rate = parseFloat(rates.suv) || 0;
        if (rates.van !== undefined)
            updateData.van_rate = parseFloat(rates.van) || 0;
        if (rates.pickup !== undefined)
            updateData.pickup_rate = parseFloat(rates.pickup) || 0;
        if (rates.ev !== undefined)
            updateData.ev_rate = parseFloat(rates.ev) || 0;

        const updated = await prisma.orgUser.update({
            where: { org_id: parsedId },
            data: updateData,
        });

        const cleanUpdated = mapAgencyResponse(updated);

        return new ApiResponse(
            200,
            cleanUpdated,
            "Rates updated successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in updateAgencyRates:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Proxy OSRM route requests through the backend
 */
const getRouteGeometry = async (req, res) => {
    try {
        const { startLat, startLon, endLat, endLon } = req.query;

        if (!startLat || !startLon || !endLat || !endLon) {
            throw new ApiError(400, "Missing start or end coordinates");
        }

        const url = `https://router.project-osrm.org/route/v1/driving/${startLon},${startLat};${endLon},${endLat}?overview=full&geometries=geojson`;

        const response = await axios.get(url);
        if (
            response.data.code === "Ok" &&
            response.data.routes &&
            response.data.routes.length > 0
        ) {
            const routeData = response.data.routes[0];
            return new ApiResponse(
                200,
                {
                    route: routeData.geometry,
                    distance: (routeData.distance / 1000).toFixed(1), // Convert to km
                },
                "Route details fetched successfully"
            ).send(res);
        } else {
            throw new ApiError(
                502,
                "OSRM router returned an error or no routes"
            );
        }
    } catch (error) {
        console.error("Error in getRouteGeometry:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Update cancellation policy of an agency
 */
const updateCancellationPolicy = async (req, res) => {
    try {
        const { id } = req.params;
        const parsedId = parseInt(id);
        if (isNaN(parsedId)) {
            throw new ApiError(400, "Invalid agency ID");
        }
        const { policy } = req.body;

        // Ensure user updating is a super_admin
        if (req.user.role !== "super_admin") {
            throw new ApiError(
                403,
                "Access denied: Only Super Admin can update cancellation policy"
            );
        }

        if (policy !== null && policy !== undefined) {
            if (!Array.isArray(policy)) {
                throw new ApiError(
                    400,
                    "Cancellation policy must be an array of rules"
                );
            }
            const times = [];
            for (const rule of policy) {
                if (
                    typeof rule.timeBeforeStartMinutes !== "number" ||
                    rule.timeBeforeStartMinutes < 0
                ) {
                    throw new ApiError(
                        400,
                        "timeBeforeStartMinutes must be a non-negative number"
                    );
                }
                if (typeof rule.allowCancellation !== "boolean") {
                    throw new ApiError(
                        400,
                        "allowCancellation must be a boolean value"
                    );
                }
                if (!["percentage", "fixed"].includes(rule.chargeType)) {
                    throw new ApiError(
                        400,
                        "chargeType must be either 'percentage' or 'fixed'"
                    );
                }
                if (
                    typeof rule.chargeValue !== "number" ||
                    rule.chargeValue < 0
                ) {
                    throw new ApiError(
                        400,
                        "chargeValue must be a non-negative number"
                    );
                }
                if (
                    rule.chargeType === "percentage" &&
                    rule.chargeValue > 100
                ) {
                    throw new ApiError(
                        400,
                        "chargeValue cannot exceed 100 for percentage charge type"
                    );
                }
                times.push(rule.timeBeforeStartMinutes);
            }

            const hasDuplicates = times.some(
                (time, index) => times.indexOf(time) !== index
            );
            if (hasDuplicates) {
                throw new ApiError(
                    400,
                    "Each rule must have a unique timeBeforeStartMinutes threshold"
                );
            }
        }

        const policyString = policy ? JSON.stringify(policy) : null;

        const updated = await prisma.orgUser.update({
            where: { org_id: parsedId },
            data: {
                cancellation_policy: policyString,
            },
        });

        const cleanUpdated = mapAgencyResponse(updated);

        return new ApiResponse(
            200,
            cleanUpdated,
            "Cancellation policy updated successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in updateCancellationPolicy:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Update commission rate of an agency (Super Admin operation)
 */
const updateAgencyCommissionRate = async (req, res) => {
    try {
        const { id } = req.params;
        const parsedId = parseInt(id);
        if (isNaN(parsedId)) {
            throw new ApiError(400, "Invalid agency ID");
        }
        const { commission_percentage, commissionRate } = req.body;
        const rateValue =
            commission_percentage !== undefined
                ? commission_percentage
                : commissionRate;

        if (req.user.role !== "super_admin") {
            throw new ApiError(
                403,
                "Access denied: Only Super Admin can update agency commission rate"
            );
        }

        if (
            rateValue === undefined ||
            rateValue === null ||
            isNaN(parseFloat(rateValue))
        ) {
            throw new ApiError(400, "Valid commission rate is required");
        }

        const parsedRate = parseFloat(rateValue);
        if (parsedRate < 0 || parsedRate > 100) {
            throw new ApiError(
                400,
                "Commission rate must be between 0 and 100 percentage"
            );
        }

        const updated = await prisma.orgUser.update({
            where: { org_id: parsedId },
            data: {
                commission_percentage: parsedRate,
            },
        });

        const cleanUpdated = mapAgencyResponse(updated);

        return new ApiResponse(
            200,
            cleanUpdated,
            "Agency commission rate updated successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in updateAgencyCommissionRate:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

const { saveBase64File } = require("../utils/helperFunctions");

/**
 * Get media items for an agency
 */
const getAgencyMedia = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.query;
        const orgId = parseInt(id, 10);

        if (isNaN(orgId)) {
            throw new ApiError(400, "Invalid agency ID");
        }

        const userRole = req.user?.role;
        const reqOrgId = req.user?.org_id || req.user?.agency_id;

        let whereClause = { org_id: orgId };

        const isAuthorizedStaff =
            userRole === "super_admin" ||
            (userRole === "agency_admin" && reqOrgId === orgId);

        if (!isAuthorizedStaff) {
            whereClause.status = "approved";
        } else if (status) {
            whereClause.status = status;
        }

        const media = await prisma.orgMedia.findMany({
            where: whereClause,
            orderBy: { created_at: "desc" },
        });

        return new ApiResponse(
            200,
            media,
            "Agency media fetched successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in getAgencyMedia:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Add a new photo/video for an agency (Agency Admin or Super Admin)
 */
const addAgencyMedia = async (req, res) => {
    try {
        const { id } = req.params;
        const orgId = parseInt(id, 10);

        if (isNaN(orgId)) {
            throw new ApiError(400, "Invalid agency ID");
        }

        const count = await prisma.orgMedia.count({
            where: { org_id: orgId },
        });

        if (count >= 10) {
            throw new ApiError(
                400,
                "Maximum limit of 10 photos/videos reached for this organization"
            );
        }

        let mediaPath = null;
        let isVideo = false;

        if (req.file) {
            mediaPath = req.file.path
                .replace(/\\/g, "/")
                .replace(/^uploads\//, "");
            isVideo =
                req.file.mimetype?.includes("video") ||
                /\.(mp4|mov|avi|mkv|webm)$/i.test(req.file.originalname);
        } else if (req.body.media || req.body.file) {
            const rawMedia = req.body.media || req.body.file;
            const b64Str =
                typeof rawMedia === "string"
                    ? rawMedia
                    : rawMedia?.base64 || rawMedia?.uri;
            isVideo =
                req.body.file_type === "video" || b64Str?.includes("video/");
            const saved = saveBase64File(
                b64Str,
                "media",
                isVideo ? "vid" : "img"
            );
            if (saved) {
                mediaPath = saved.replace(/^uploads\//, "");
            }
        }

        if (!mediaPath) {
            throw new ApiError(400, "No photo or video file provided");
        }

        const newMedia = await prisma.orgMedia.create({
            data: {
                org_id: orgId,
                file_path: mediaPath,
                file_type: isVideo ? "video" : "photo",
                status: "pending",
            },
        });

        return new ApiResponse(
            201,
            newMedia,
            "Photo/video uploaded successfully. It will be live after Super Admin approval."
        ).send(res);
    } catch (error) {
        console.error("Error in addAgencyMedia:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Edit/Replace an existing photo/video (Agency Admin or Super Admin)
 */
const updateAgencyMedia = async (req, res) => {
    try {
        const { mediaId } = req.params;
        const mId = parseInt(mediaId, 10);

        if (isNaN(mId)) {
            throw new ApiError(400, "Invalid media ID");
        }

        const existingMedia = await prisma.orgMedia.findUnique({
            where: { media_id: mId },
        });

        if (!existingMedia) {
            throw new ApiError(404, "Media item not found");
        }

        let newPath = null;
        let isVideo = existingMedia.file_type === "video";

        if (req.file) {
            newPath = req.file.path
                .replace(/\\/g, "/")
                .replace(/^uploads\//, "");
            isVideo =
                req.file.mimetype?.includes("video") ||
                /\.(mp4|mov|avi|mkv|webm)$/i.test(req.file.originalname);
        } else if (req.body.media || req.body.file) {
            const rawMedia = req.body.media || req.body.file;
            const b64Str =
                typeof rawMedia === "string"
                    ? rawMedia
                    : rawMedia?.base64 || rawMedia?.uri;
            if (req.body.file_type) isVideo = req.body.file_type === "video";
            else if (b64Str?.includes("video/")) isVideo = true;

            const saved = saveBase64File(
                b64Str,
                "media",
                isVideo ? "vid" : "img"
            );
            if (saved) {
                newPath = saved.replace(/^uploads\//, "");
            }
        }

        if (!newPath) {
            throw new ApiError(400, "No new photo or video file provided");
        }

        const updated = await prisma.orgMedia.update({
            where: { media_id: mId },
            data: {
                pending_file_path: newPath,
                file_type: isVideo ? "video" : "photo",
                status: "pending",
            },
        });

        return new ApiResponse(
            200,
            updated,
            "Replacement uploaded successfully. Changes will reflect after Super Admin approval."
        ).send(res);
    } catch (error) {
        console.error("Error in updateAgencyMedia:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Delete a photo/video (Agency Admin or Super Admin)
 */
const deleteAgencyMedia = async (req, res) => {
    try {
        const { mediaId } = req.params;
        const mId = parseInt(mediaId, 10);

        if (isNaN(mId)) {
            throw new ApiError(400, "Invalid media ID");
        }

        const existing = await prisma.orgMedia.findUnique({
            where: { media_id: mId },
        });

        if (!existing) {
            throw new ApiError(404, "Media item not found");
        }

        await prisma.orgMedia.delete({
            where: { media_id: mId },
        });

        return new ApiResponse(
            200,
            null,
            "Media item deleted successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in deleteAgencyMedia:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Approve or Reject individual photo/video (Super Admin only)
 */
const updateMediaStatus = async (req, res) => {
    try {
        const { mediaId } = req.params;
        const { status, rejection_reason } = req.body;
        const mId = parseInt(mediaId, 10);

        if (isNaN(mId)) {
            throw new ApiError(400, "Invalid media ID");
        }

        if (!["approved", "rejected"].includes(status)) {
            throw new ApiError(400, "Status must be 'approved' or 'rejected'");
        }

        const existingMedia = await prisma.orgMedia.findUnique({
            where: { media_id: mId },
        });

        if (!existingMedia) {
            throw new ApiError(404, "Media item not found");
        }

        let updateData = {
            status: status,
            rejection_reason: rejection_reason || null,
        };

        if (status === "approved") {
            if (existingMedia.pending_file_path) {
                updateData.file_path = existingMedia.pending_file_path;
                updateData.pending_file_path = null;
            }
        } else if (status === "rejected") {
            updateData.pending_file_path = null;
        }

        const updated = await prisma.orgMedia.update({
            where: { media_id: mId },
            data: updateData,
        });

        return new ApiResponse(
            200,
            updated,
            `Media item ${status} successfully`
        ).send(res);
    } catch (error) {
        console.error("Error in updateMediaStatus:", error);
        if (error instanceof ApiError)
            return new ApiError(error.statusCode, error.message).send(res);
        return new ApiError(500, error.message).send(res);
    }
};

module.exports = {
    listAgencies,
    getAgencyDetails,
    updateAgencyDetails,
    toggleBookingApprovalSetting,
    updateAgencyCapacities,
    updateAgencyRates,
    getRouteGeometry,
    updateCancellationPolicy,
    updateAgencyCommissionRate,
    getAgencyMedia,
    addAgencyMedia,
    updateAgencyMedia,
    deleteAgencyMedia,
    updateMediaStatus,
};
