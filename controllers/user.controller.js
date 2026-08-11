const { prisma } = require("../utils/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const {
    saveBase64File,
    cleanupUploadedFiles,
} = require("../utils/helperFunctions");

/**
 * Register a new user (Customer)
 */
const registerUser = async (req, res) => {
    const savedFiles = [];
    try {
        const {
            full_name,
            name,
            username,
            email,
            phone_number,
            password,
            user_address,
            address,
            landmark,
            latitude,
            longitude,
            profile_photo, // Base64 string from app
        } = req.body;

        const resolvedFullName = full_name || name;
        const resolvedAddress = user_address || address;

        // 1. Validation - check for required fields
        if (
            [resolvedFullName, username, email, password].some(
                (field) => !field || field.trim() === ""
            )
        ) {
            throw new ApiError(400, "All required fields must be provided");
        }

        // FormData / Multer File Upload Process
        let profilePhotoPath = null;
        if (req.file?.path) {
            profilePhotoPath = req.file.path
                .replace(/\\/g, "/")
                .replace(/^uploads\//, "");
        } else if (profile_photo) {
            const saved = saveBase64File(profile_photo, "profile", "profile");
            if (saved) {
                savedFiles.push(saved);
                profilePhotoPath = saved.replace(/^uploads\//, "");
            }
        }

        // 3. Hash password
        const passwordHash = await bcrypt.hash(password, 10);

        // 4. Run checking and insertion in an interactive transaction
        await prisma.$transaction(async (tx) => {
            // Check if user already exists
            const existingUser = await tx.user.findFirst({
                where: {
                    OR: [{ username: username }, { email: email }],
                },
            });

            if (existingUser) {
                throw new ApiError(
                    409,
                    "User with email or username already exists"
                );
            }

            // Insert into database
            const createdUser = await tx.user.create({
                data: {
                    full_name: resolvedFullName,
                    username,
                    email,
                    phone_number: phone_number || null,
                    password_hash: passwordHash,
                    user_address: resolvedAddress || null,
                    landmark: landmark || null,
                    latitude:
                        latitude !== undefined && latitude !== null
                            ? parseFloat(latitude)
                            : null,
                    longitude:
                        longitude !== undefined && longitude !== null
                            ? parseFloat(longitude)
                            : null,
                    profile_photo_path: profilePhotoPath,
                    role: "user",
                    status: "active",
                    agency_id: null,
                    wallet_balance: 100.0,
                },
            });

            // Create a welcome bonus wallet transaction
            await tx.walletTransaction.create({
                data: {
                    user_id: createdUser.user_id,
                    amount: 100.0,
                    type: "deposit",
                    status: "approved",
                    transaction_number: `WELCOME_BONUS_${createdUser.user_id}_${Math.floor(1000 + Math.random() * 9000)}`,
                    screenshot_path: null,
                },
            });
        });

        return res
            .status(201)
            .json(new ApiResponse(201, null, "User registered successfully"));
    } catch (error) {
        console.error("Error in registerUser:", error);
        cleanupUploadedFiles(req.file, savedFiles);
        if (error instanceof ApiError) {
            return res.status(error.statusCode).json(error);
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Login a user, staff, or organization
 */
const loginUser = async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            throw new ApiError(400, "Username/Email and password are required");
        }

        // Check in standard users table first (handles customer, super_admin, agency_user)
        let user = await prisma.user.findFirst({
            where: {
                OR: [{ username: username }, { email: username }],
            },
        });
        let role = null;
        let isOrgUser = false;

        if (user) {
            role = user.role || "user";
        } else {
            // Check in organizations (org_users)
            user = await prisma.orgUser.findFirst({
                where: {
                    OR: [{ username: username }, { email: username }],
                },
            });
            if (user) {
                role = "agency_admin";
                isOrgUser = true;
            }
        }

        if (!user) {
            throw new ApiError(404, "User not found");
        }

        // Check status
        if (user.status === "blocked") {
            throw new ApiError(
                403,
                "Your account has been blocked. Please contact support."
            );
        }
        if (isOrgUser && user.status === "pending") {
            throw new ApiError(
                403,
                "Your organization registration is pending approval."
            );
        }
        if (isOrgUser && user.status === "rejected") {
            throw new ApiError(
                403,
                "Your organization registration request has been rejected."
            );
        }

        // Verify password
        const isPasswordValid = await bcrypt.compare(
            password,
            user.password_hash
        );
        if (!isPasswordValid) {
            throw new ApiError(401, "Invalid credentials");
        }

        // Build user object for token & response
        const agencyId = isOrgUser ? user.org_id : user.agency_id || null;
        const resolvedUserId = isOrgUser ? user.org_id : user.user_id;

        // Generate JWT Token
        const token = jwt.sign(
            {
                id: resolvedUserId,
                username: user.username,
                role: role,
                agencyId: agencyId,
                agency_id: agencyId,
                org_id: isOrgUser ? user.org_id : undefined,
            },
            process.env.JWT_SECRET || "your_secret_key",
            { expiresIn: "7d" }
        );

        // Success response
        const userData = {
            ...user,
            id: resolvedUserId,
            name: isOrgUser ? user.org_name : user.full_name,
            role: role,
            agencyId: agencyId,
            agency_id: agencyId,
            org_id: isOrgUser ? user.org_id : undefined,
        };
        if (role === "user") {
            userData.walletBalance = user.wallet_balance
                ? parseFloat(user.wallet_balance)
                : 0.0;
        }
        delete userData.password_hash;

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    { user: userData, token, role },
                    "Login successful"
                )
            );
    } catch (error) {
        console.error("Error in loginUser:", error);
        if (error instanceof ApiError) {
            return res.status(error.statusCode).json(error);
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Login a user, staff, or organization
 */

const loginUserSuperAdmin = async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            throw new ApiError(400, "Username/Email and password are required");
        }

        // 1. Check in standard users table first
        let user = await prisma.user.findFirst({
            where: {
                OR: [{ username: username }, { email: username }],
            },
        });
        let role = null;
        let isOrgUser = false;

        if (user) {
            role = user.role || "user";
        } else {
            user = await prisma.orgUser.findFirst({
                where: {
                    OR: [{ username: username }, { email: username }],
                },
            });
            if (user) {
                role = "agency_admin";
                isOrgUser = true;
            }
        }

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        // 🔒 ALLOW ONLY SUPER_ADMIN AND AUTHORITY_ADMIN
        const allowedRoles = ["super_admin", "authority_admin"];
        if (!allowedRoles.includes(role)) {
            console.log(`Login attempt denied for role: ${role}`);
            return res.status(403).json({
                success: false,
                message:
                    "Access denied. Only Super Administrators and Authority Administrators can login.",
            });
        }

        // Check status
        if (user.status === "blocked") {
            return res.status(403).json({
                success: false,
                message:
                    "Your account has been blocked. Please contact support.",
            });
        }
        if (isOrgUser && user.status === "pending") {
            return res.status(403).json({
                success: false,
                message: "Your organization registration is pending approval.",
            });
        }
        if (isOrgUser && user.status === "rejected") {
            return res.status(403).json({
                success: false,
                message:
                    "Your organization registration request has been rejected.",
            });
        }

        // Verify password
        const isPasswordValid = await bcrypt.compare(
            password,
            user.password_hash
        );
        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: "Invalid credentials",
            });
        }

        // Build user object
        const agencyId = isOrgUser ? user.org_id : user.agency_id || null;
        const resolvedUserId = isOrgUser ? user.org_id : user.user_id;

        // Generate JWT Token
        const token = jwt.sign(
            {
                id: resolvedUserId,
                username: user.username,
                email: user.email,
                role: role,
                agencyId: agencyId,
            },
            process.env.JWT_SECRET || "your_secret_key",
            { expiresIn: "7d" }
        );

        // Prepare user data
        const userData = {
            id: resolvedUserId,
            username: user.username,
            email: user.email,
            name: isOrgUser ? user.org_name : user.full_name,
            role: role,
            agencyId: agencyId,
            status: user.status,
        };
        if (role === "user") {
            userData.walletBalance = user.wallet_balance
                ? parseFloat(user.wallet_balance)
                : 0.0;
        }

        // Set cookie with token (optional)
        res.cookie("token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        });

        // Send response
        return res.status(200).json({
            success: true,
            message: "Login successful",
            data: {
                user: userData,
                token: token,
                role: role,
            },
        });
    } catch (error) {
        console.error("Error in loginUserSuperAdmin:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Internal server error",
        });
    }
};

/**
 * Get profile of logged-in user
 */
const getProfile = async (req, res) => {
    try {
        const { id, role } = req.user;
        let userData;

        if (role === "agency_admin") {
            userData = await prisma.orgUser.findUnique({
                where: { org_id: id },
            });
            if (userData) {
                userData = {
                    ...userData,
                    id: userData.org_id,
                    name: userData.org_name,
                    agencyId: userData.org_id,
                    role: "agency_admin",
                };
            }
        } else {
            userData = await prisma.user.findUnique({
                where: { user_id: id },
            });
            if (userData) {
                userData = {
                    ...userData,
                    id: userData.user_id,
                    name: userData.full_name,
                    agencyId: userData.agency_id,
                };
                if (userData.role === "user") {
                    userData.walletBalance = userData.wallet_balance
                        ? parseFloat(userData.wallet_balance)
                        : 0.0;
                }
            }
        }

        if (!userData) {
            throw new ApiError(404, "User not found");
        }

        delete userData.password_hash;

        return res
            .status(200)
            .json(
                new ApiResponse(200, userData, "Profile fetched successfully")
            );
    } catch (error) {
        console.error("Error in getProfile:", error);
        if (error instanceof ApiError)
            return res.status(error.statusCode).json(error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Get pending organization registration requests
 */
const getPendingRequests = async (req, res) => {
    try {
        const requests = await prisma.orgUser.findMany({
            where: { status: "pending" },
        });

        const orgIds = requests.map((r) => r.org_id);
        const mediaList = await prisma.orgMedia.findMany({
            where: {
                org_id: { in: orgIds },
            },
            orderBy: { created_at: "desc" },
        });

        const mediaMap = {};
        mediaList.forEach((m) => {
            if (!mediaMap[m.org_id]) mediaMap[m.org_id] = [];
            mediaMap[m.org_id].push(m);
        });

        const cleanRequests = requests.map((r) => {
            const item = {
                ...r,
                id: r.org_id,
                name: r.org_name,
                owner: r.username,
                address: r.org_address,
                media: mediaMap[r.org_id] || [],
            };
            delete item.password_hash;
            return item;
        });
        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    cleanRequests,
                    "Pending requests fetched successfully"
                )
            );
    } catch (error) {
        console.error("Error in getPendingRequests:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Approve organization registration request
 */
const approveOrgRequest = async (req, res) => {
    try {
        const { orgId } = req.params;
        const parsedOrgId = parseInt(orgId);
        if (isNaN(parsedOrgId)) {
            throw new ApiError(400, "Invalid organization ID");
        }
        const org = await prisma.orgUser.update({
            where: { org_id: parsedOrgId },
            data: { status: "active" },
        });
        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    null,
                    `Organization '${org.org_name}' approved successfully`
                )
            );
    } catch (error) {
        console.error("Error in approveOrgRequest:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Reject organization registration request
 */
const rejectOrgRequest = async (req, res) => {
    try {
        const { orgId } = req.params;
        const parsedOrgId = parseInt(orgId);
        if (isNaN(parsedOrgId)) {
            throw new ApiError(400, "Invalid organization ID");
        }
        const org = await prisma.orgUser.update({
            where: { org_id: parsedOrgId },
            data: { status: "rejected" },
        });
        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    null,
                    `Organization '${org.org_name}' rejected`
                )
            );
    } catch (error) {
        console.error("Error in rejectOrgRequest:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Agency Admin: Register a new staff user
 */
const registerStaff = async (req, res) => {
    try {
        const { full_name, username, email, phone_number, password, role } =
            req.body;
        const agencyId = req.user.agencyId;

        if (!full_name || !username || !email || !password || !agencyId) {
            throw new ApiError(400, "Required fields are missing");
        }

        const existingUser = await prisma.user.findFirst({
            where: { OR: [{ username }, { email }] },
        });

        if (existingUser) {
            throw new ApiError(
                409,
                "User with this username or email already exists"
            );
        }

        const parsedAgencyId = parseInt(agencyId);
        if (isNaN(parsedAgencyId)) {
            throw new ApiError(400, "Invalid agency ID");
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const newStaff = await prisma.user.create({
            data: {
                full_name,
                username,
                email,
                phone_number: phone_number || null,
                password_hash: passwordHash,
                role: role || "agency_user",
                status: "active",
                agency_id: parsedAgencyId,
            },
        });

        const cleanStaff = {
            ...newStaff,
            id: newStaff.user_id,
            name: newStaff.full_name,
            agencyId: newStaff.agency_id,
        };
        delete cleanStaff.password_hash;

        return res
            .status(201)
            .json(
                new ApiResponse(
                    201,
                    cleanStaff,
                    "Staff registered successfully"
                )
            );
    } catch (error) {
        console.error("Error in registerStaff:", error);
        if (error instanceof ApiError)
            return res.status(error.statusCode).json(error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Agency Admin: List all staff in their agency
 */
const listStaff = async (req, res) => {
    try {
        const agencyId = req.user.agencyId || req.params.agencyId;
        if (!agencyId) {
            throw new ApiError(400, "Agency ID is required");
        }

        const parsedAgencyId = parseInt(agencyId);
        if (isNaN(parsedAgencyId)) {
            throw new ApiError(400, "Invalid agency ID");
        }

        const staff = await prisma.user.findMany({
            where: {
                agency_id: parsedAgencyId,
                role: { in: ["agency_user", "agency_admin"] },
            },
        });

        const cleanStaff = staff.map((s) => {
            const item = {
                ...s,
                id: s.user_id,
                name: s.full_name,
                agencyId: s.agency_id,
            };
            delete item.password_hash;
            return item;
        });

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    cleanStaff,
                    "Staff list fetched successfully"
                )
            );
    } catch (error) {
        console.error("Error in listStaff:", error);
        if (error instanceof ApiError)
            return res.status(error.statusCode).json(error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Agency Admin: Update staff details
 */
const updateStaff = async (req, res) => {
    try {
        const { userId } = req.params;
        const parsedUserId = parseInt(userId);
        if (isNaN(parsedUserId)) {
            throw new ApiError(400, "Invalid user ID");
        }
        const { full_name, username, email, phone_number, role } = req.body;

        const updated = await prisma.user.update({
            where: { user_id: parsedUserId },
            data: {
                full_name,
                username,
                email,
                phone_number: phone_number || null,
                role: role || "agency_user",
            },
        });

        const cleanUpdated = {
            ...updated,
            id: updated.user_id,
            name: updated.full_name,
            agencyId: updated.agency_id,
        };
        delete cleanUpdated.password_hash;

        return res
            .status(200)
            .json(
                new ApiResponse(200, cleanUpdated, "Staff updated successfully")
            );
    } catch (error) {
        console.error("Error in updateStaff:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Agency Admin: Delete a staff user
 */
const deleteStaff = async (req, res) => {
    try {
        const { userId } = req.params;
        const parsedUserId = parseInt(userId);
        if (isNaN(parsedUserId)) {
            throw new ApiError(400, "Invalid user ID");
        }
        await prisma.user.delete({
            where: { user_id: parsedUserId },
        });
        return res
            .status(200)
            .json(new ApiResponse(200, null, "Staff deleted successfully"));
    } catch (error) {
        console.error("Error in deleteStaff:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Agency Admin: Toggle staff block/active status
 */
const toggleStaffStatus = async (req, res) => {
    try {
        const { userId } = req.params;
        const parsedUserId = parseInt(userId);
        if (isNaN(parsedUserId)) {
            throw new ApiError(400, "Invalid user ID");
        }
        const user = await prisma.user.findUnique({
            where: { user_id: parsedUserId },
        });

        if (!user) {
            throw new ApiError(404, "User not found");
        }

        const newStatus = user.status === "active" ? "blocked" : "active";
        const updated = await prisma.user.update({
            where: { user_id: parsedUserId },
            data: { status: newStatus },
        });

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    { status: updated.status },
                    `Staff status updated to ${updated.status}`
                )
            );
    } catch (error) {
        console.error("Error in toggleStaffStatus:", error);
        if (error instanceof ApiError)
            return res.status(error.statusCode).json(error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Update profile of logged-in user (Customer/Admin)
 */
const updateProfile = async (req, res) => {
    try {
        const { id, role } = req.user;
        const {
            vehicle_numbers,
            driving_licence,
            phone_number,
            user_address,
            landmark,
        } = req.body;

        let updatedData;

        if (role === "agency_admin") {
            // Agency Admin / OrgUser profile update
            updatedData = await prisma.orgUser.update({
                where: { org_id: id },
                data: {
                    phone_number:
                        phone_number !== undefined ? phone_number : undefined,
                    org_address:
                        user_address !== undefined ? user_address : undefined,
                    landmark: landmark !== undefined ? landmark : undefined,
                },
            });
            if (updatedData) {
                updatedData = {
                    ...updatedData,
                    id: updatedData.org_id,
                    name: updatedData.org_name,
                    agencyId: updatedData.org_id,
                    role: "agency_admin",
                };
            }
        } else {
            // Customer or other user profile update
            updatedData = await prisma.user.update({
                where: { user_id: id },
                data: {
                    phone_number:
                        phone_number !== undefined ? phone_number : undefined,
                    user_address:
                        user_address !== undefined ? user_address : undefined,
                    landmark: landmark !== undefined ? landmark : undefined,
                    vehicle_numbers:
                        vehicle_numbers !== undefined
                            ? vehicle_numbers
                            : undefined,
                    driving_licence:
                        driving_licence !== undefined
                            ? driving_licence
                            : undefined,
                },
            });
            if (updatedData) {
                updatedData = {
                    ...updatedData,
                    id: updatedData.user_id,
                    name: updatedData.full_name,
                    agencyId: updatedData.agency_id,
                };
                if (updatedData.role === "user") {
                    updatedData.walletBalance = updatedData.wallet_balance
                        ? parseFloat(updatedData.wallet_balance)
                        : 0.0;
                }
            }
        }

        if (!updatedData) {
            throw new ApiError(404, "User not found");
        }

        delete updatedData.password_hash;

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    updatedData,
                    "Profile updated successfully"
                )
            );
    } catch (error) {
        console.error("Error in updateProfile:", error);
        if (error instanceof ApiError)
            return res.status(error.statusCode).json(error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Get dashboard statistics according to user role
 */
const getDashboardStats = async (req, res) => {
    try {
        const { id, role, agency_id, org_id } = req.user;
        const userRole = role || "user";

        let stats = { role: userRole };

        if (userRole === "user") {
            // Customer stats
            const user = await prisma.user.findUnique({
                where: { user_id: id },
                select: { wallet_balance: true, full_name: true },
            });

            const bookings = await prisma.booking.findMany({
                where: { user_id: id },
                orderBy: { created_at: "desc" },
                take: 5,
            });

            const totalBookingsCount = await prisma.booking.count({
                where: { user_id: id },
            });

            const activeBookingsCount = await prisma.booking.count({
                where: {
                    user_id: id,
                    status: { in: ["booked", "checked_in"] },
                },
            });

            const completedBookingsCount = await prisma.booking.count({
                where: {
                    user_id: id,
                    status: "completed",
                },
            });

            const activeBooking = await prisma.booking.findFirst({
                where: {
                    user_id: id,
                    status: { in: ["booked", "checked_in"] },
                },
                orderBy: { created_at: "desc" },
            });

            const totalSpentAggregate = await prisma.booking.aggregate({
                where: { user_id: id, payment_status: "paid" },
                _sum: { total_bill: true },
            });

            stats = {
                role: "user",
                walletBalance: user?.wallet_balance
                    ? Math.max(0, parseFloat(user.wallet_balance))
                    : 0,
                totalBookings: totalBookingsCount,
                activeBookings: activeBookingsCount,
                completedBookings: completedBookingsCount,
                totalSpent: totalSpentAggregate._sum.total_bill
                    ? Math.max(
                          0,
                          parseFloat(totalSpentAggregate._sum.total_bill)
                      )
                    : 0,
                activeBooking: activeBooking || null,
                recentBookings: bookings,
            };
        } else if (userRole === "agency_admin" || userRole === "agency_user") {
            // Agency Admin / Staff stats
            const agencyIdToUse = agency_id || org_id || id;

            const agency = await prisma.orgUser.findUnique({
                where: { org_id: agencyIdToUse },
            });

            const activeBookingsCount = await prisma.booking.count({
                where: {
                    agency_id: agencyIdToUse,
                    status: { in: ["booked", "checked_in"] },
                },
            });

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const todayBookingsCount = await prisma.booking.count({
                where: {
                    agency_id: agencyIdToUse,
                    created_at: { gte: today },
                },
            });

            const totalBookingsCount = await prisma.booking.count({
                where: { agency_id: agencyIdToUse },
            });

            const staffCount = await prisma.user.count({
                where: { agency_id: agencyIdToUse },
            });

            const recentBookings = await prisma.booking.findMany({
                where: { agency_id: agencyIdToUse },
                orderBy: { created_at: "desc" },
                take: 5,
            });

            const pendingWithdrawalsCount =
                await prisma.walletTransaction.count({
                    where: {
                        agency_id: agencyIdToUse,
                        type: "agency_withdrawal",
                        status: "pending",
                    },
                });

            const forceCancelsCount = await prisma.booking.count({
                where: {
                    agency_id: agencyIdToUse,
                    is_force_cancelled: true,
                },
            });

            stats = {
                role: userRole,
                agencyName: agency?.org_name || "Parking Agency",
                status: agency?.status || "active",
                walletBalance: agency?.wallet_balance
                    ? Math.max(0, parseFloat(agency.wallet_balance))
                    : 0,
                commissionPercentage: agency?.commission_percentage
                    ? parseFloat(agency.commission_percentage)
                    : 0,
                twoWheelerCapacity: agency?.two_wheeler_capacity || 0,
                carCapacity: agency?.car_capacity || 0,
                suvCapacity: agency?.suv_capacity || 0,
                evCapacity: agency?.ev_capacity || 0,
                totalCapacity:
                    (agency?.two_wheeler_capacity || 0) +
                    (agency?.car_capacity || 0) +
                    (agency?.suv_capacity || 0) +
                    (agency?.ev_capacity || 0) +
                    (agency?.three_wheeler_capacity || 0) +
                    (agency?.van_capacity || 0) +
                    (agency?.pickup_capacity || 0),
                activeBookings: activeBookingsCount,
                todayBookings: todayBookingsCount,
                totalBookings: totalBookingsCount,
                forceCancelsCount,
                staffCount,
                pendingWithdrawalsCount,
                recentBookings,
            };
        } else if (userRole === "super_admin") {
            // Super Admin stats
            const totalUsers = await prisma.user.count({
                where: { role: "user" },
            });

            const totalAgencies = await prisma.orgUser.count();

            const pendingAgenciesCount = await prisma.orgUser.count({
                where: { status: "pending" },
            });

            const pendingTopupsCount = await prisma.walletTransaction.count({
                where: {
                    status: "pending",
                    type: { not: "agency_withdrawal" },
                },
            });

            const pendingWithdrawalsCount =
                await prisma.walletTransaction.count({
                    where: { status: "pending", type: "agency_withdrawal" },
                });

            const pendingSettlementsCount =
                await prisma.agencyTransaction.count({
                    where: { status: "pending" },
                });

            const totalBookings = await prisma.booking.count();

            const forceCancelsCount = await prisma.booking.count({
                where: {
                    is_force_cancelled: true,
                },
            });

            const platformRevenueAggregate =
                await prisma.agencyTransaction.aggregate({
                    where: { status: "approved" },
                    _sum: { admin_share: true, total_amount: true },
                });

            const recentAgencies = await prisma.orgUser.findMany({
                orderBy: { created_at: "desc" },
                take: 5,
                select: {
                    org_id: true,
                    org_name: true,
                    email: true,
                    phone_number: true,
                    status: true,
                    created_at: true,
                },
            });

            stats = {
                role: "super_admin",
                totalUsers,
                totalAgencies,
                pendingAgenciesCount,
                pendingTopupsCount,
                pendingWithdrawalsCount,
                pendingSettlementsCount,
                totalBookings,
                forceCancelsCount,
                totalAdminRevenue: platformRevenueAggregate._sum.admin_share
                    ? parseFloat(platformRevenueAggregate._sum.admin_share)
                    : 0,
                totalVolume: platformRevenueAggregate._sum.total_amount
                    ? parseFloat(platformRevenueAggregate._sum.total_amount)
                    : 0,
                recentAgencies,
            };
        }

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    stats,
                    "Dashboard statistics retrieved successfully"
                )
            );
    } catch (error) {
        console.error("Error in getDashboardStats:", error);
        if (error instanceof ApiError)
            return res.status(error.statusCode).json(error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

const parseVehicleNumbers = (raw) => {
    if (!raw) return [];
    const trimmed = String(raw).trim();
    if (trimmed.startsWith("[")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed.map((v) => String(v).trim()).filter(Boolean);
            }
        } catch {
            // fall through to comma-split below
        }
    }
    return trimmed
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
};

const listAllUsersDirectory = async (req, res) => {
    try {
        const { status, search } = req.query;

        // Remove the "blocked" exclusion - fetch ALL users
        const customers = await prisma.user.findMany({
            where: {
                role: "user",
                // REMOVE THIS LINE: status: { not: "blocked" },
            },
            orderBy: { created_at: "desc" },
        });

        let normalizedUsers = customers.map((u) => ({
            id: u.user_id,
            name: u.full_name,
            username: u.username,
            email: u.email,
            phoneNumber: u.phone_number,
            status: u.status,
            walletBalance: u.wallet_balance ? parseFloat(u.wallet_balance) : 0,
            vehicleNumbers: parseVehicleNumbers(u.vehicle_numbers),
            drivingLicence: u.driving_licence || null,
            address: u.user_address || null,
            landmark: u.landmark || null,
            latitude: u.latitude ? parseFloat(u.latitude) : null,
            longitude: u.longitude ? parseFloat(u.longitude) : null,
            profilePhotoPath: u.profile_photo_path || null,
            createdAt: u.created_at,
        }));

        // Apply status filter if provided (including "blocked")
        if (status) {
            normalizedUsers = normalizedUsers.filter(
                (u) => u.status === status
            );
        }

        // Apply search filter if provided
        if (search) {
            const term = search.toLowerCase();
            normalizedUsers = normalizedUsers.filter(
                (u) =>
                    u.name?.toLowerCase().includes(term) ||
                    u.username?.toLowerCase().includes(term) ||
                    u.email?.toLowerCase().includes(term) ||
                    u.phoneNumber?.includes(term)
            );
        }

        const summary = {
            totalUsers: normalizedUsers.length,
            totalWalletBalance: normalizedUsers.reduce(
                (sum, u) => sum + (u.walletBalance || 0),
                0
            ),
        };

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    { users: normalizedUsers, summary },
                    "Customer directory fetched successfully"
                )
            );
    } catch (error) {
        console.error("Error in listAllUsersDirectory:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Update a customer's editable details from the directory
 * edit dialog. Deliberately does NOT allow changing username/email/role —
 * those are identity fields; this only covers contact info, address,
 * vehicle/licence info, and status.
 */

const updateCustomerDetails = async (req, res) => {
    try {
        const { id } = req.params;
        const parsedId = parseInt(id);
        if (isNaN(parsedId)) {
            throw new ApiError(400, "Invalid customer ID");
        }

        const {
            full_name,
            phone_number,
            user_address,
            landmark,
            driving_licence,
            vehicle_numbers,
            status,
            status_reason,
        } = req.body;

        const existing = await prisma.user.findUnique({
            where: { user_id: parsedId },
        });
        if (!existing) {
            throw new ApiError(404, "Customer not found");
        }
        if (existing.role !== "user") {
            throw new ApiError(
                400,
                "This endpoint only supports editing customer accounts"
            );
        }

        const ALLOWED_STATUSES = ["active", "suspended", "blocked"];
        if (status !== undefined && !ALLOWED_STATUSES.includes(status)) {
            throw new ApiError(
                400,
                `Status must be one of: ${ALLOWED_STATUSES.join(", ")}`
            );
        }

        // A status transition requires a reason. No-op "changes" (submitting
        // the same status the account already has) don't require one and
        // don't create a log entry.
        const isStatusChanging =
            status !== undefined && status !== existing.status;
        if (isStatusChanging && (!status_reason || !status_reason.trim())) {
            throw new ApiError(
                400,
                "A reason is required when changing account status"
            );
        }

        const updateData = {};
        if (full_name !== undefined) updateData.full_name = full_name;
        if (phone_number !== undefined)
            updateData.phone_number = phone_number || null;
        if (user_address !== undefined)
            updateData.user_address = user_address || null;
        if (landmark !== undefined) updateData.landmark = landmark || null;
        if (driving_licence !== undefined)
            updateData.driving_licence = driving_licence || null;
        if (status !== undefined) updateData.status = status;

        // Vehicle numbers stored as a JSON-array string (matches how
        // parseVehicleNumbers reads it back on the directory list).
        if (vehicle_numbers !== undefined) {
            if (!Array.isArray(vehicle_numbers)) {
                throw new ApiError(400, "vehicle_numbers must be an array");
            }
            const cleaned = vehicle_numbers
                .map((v) => String(v).trim())
                .filter(Boolean);
            updateData.vehicle_numbers =
                cleaned.length > 0 ? JSON.stringify(cleaned) : null;
        }

        // Run the profile update + status log entry together so a crash
        // mid-way can't leave a status change on the user row with no
        // corresponding audit record.
        const updated = await prisma.$transaction(async (tx) => {
            const result = await tx.user.update({
                where: { user_id: parsedId },
                data: updateData,
            });

            if (isStatusChanging) {
                await tx.userStatusLog.create({
                    data: {
                        user_id: parsedId,
                        previous_status: existing.status,
                        new_status: status,
                        reason: status_reason.trim(),
                        changed_by: req.user.id,
                        changed_by_role: req.user.role,
                    },
                });
            }

            return result;
        });

        const cleanUpdated = {
            id: updated.user_id,
            name: updated.full_name,
            username: updated.username,
            email: updated.email,
            phoneNumber: updated.phone_number,
            status: updated.status,
            walletBalance: updated.wallet_balance
                ? parseFloat(updated.wallet_balance)
                : 0,
            vehicleNumbers: parseVehicleNumbers(updated.vehicle_numbers),
            drivingLicence: updated.driving_licence || null,
            address: updated.user_address || null,
            landmark: updated.landmark || null,
            latitude: updated.latitude ? parseFloat(updated.latitude) : null,
            longitude: updated.longitude ? parseFloat(updated.longitude) : null,
            profilePhotoPath: updated.profile_photo_path || null,
            createdAt: updated.created_at,
        };

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    cleanUpdated,
                    "Customer details updated successfully"
                )
            );
    } catch (error) {
        console.error("Error in updateCustomerDetails:", error);
        if (error instanceof ApiError)
            return res.status(error.statusCode).json(error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

const getUserStatusHistory = async (req, res) => {
    try {
        const { id } = req.params;
        const parsedId = parseInt(id);
        if (isNaN(parsedId)) {
            throw new ApiError(400, "Invalid customer ID");
        }

        const logs = await prisma.userStatusLog.findMany({
            where: { user_id: parsedId },
            orderBy: { created_at: "desc" },
        });

        const changedByIds = [...new Set(logs.map((l) => l.changed_by))];
        const admins = await prisma.user.findMany({
            where: { user_id: { in: changedByIds } },
            select: { user_id: true, full_name: true, username: true },
        });
        const adminMap = {};
        admins.forEach((a) => {
            adminMap[a.user_id] = a;
        });

        const cleanLogs = logs.map((l) => ({
            id: l.log_id,
            previousStatus: l.previous_status,
            newStatus: l.new_status,
            reason: l.reason,
            changedByRole: l.changed_by_role,
            changedByName:
                adminMap[l.changed_by]?.full_name ||
                adminMap[l.changed_by]?.username ||
                (l.changed_by_role === "super_admin" ? "Super Admin" : "Admin"),
            createdAt: l.created_at,
        }));

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    cleanLogs,
                    "Status history fetched successfully"
                )
            );
    } catch (error) {
        console.error("Error in getUserStatusHistory:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

module.exports = {
    registerUser,
    loginUser,
    loginUserSuperAdmin,
    getProfile,
    updateProfile,
    getPendingRequests,
    approveOrgRequest,
    rejectOrgRequest,
    registerStaff,
    listStaff,
    updateStaff,
    deleteStaff,
    toggleStaffStatus,
    getDashboardStats,
    listAllUsersDirectory,
    updateCustomerDetails,
    getUserStatusHistory,
};

// notification
// approve reject rating of user
// trade license mendetory and file upload
// add upi during reg
// handle payout logic
