const { prisma } = require("../utils/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const { OAuth2Client } = require("google-auth-library");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const {
    saveBase64File,
    cleanupUploadedFiles,
} = require("../utils/helperFunctions");
const { consumeVerificationToken } = require("./otp.controller");
const { sendPushNotificationToDevices } = require("../utils/notifications");
const loginAttemptTracker = require("../utils/loginAttemptTracker");

const googleClient = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID ||
        "196392862520-nq7una9ib2t866dtf7tgmtr3rkcd6jr7.apps.googleusercontent.com"
);

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
            profile_photo, // Base64 string or remote URL from app
            profile_photo_url,
            otp_verification_token,
        } = req.body;

        const resolvedFullName = full_name || name;

        // 1. Validation - check for required fields
        if (
            [resolvedFullName, username, email, phone_number, password].some(
                (field) => !field || String(field).trim() === ""
            )
        ) {
            throw new ApiError(
                400,
                "All required fields (including Phone Number) must be provided"
            );
        }

        // 2. FormData / Multer File Upload Process
        let profilePhotoPath = null;
        if (req.file?.path) {
            profilePhotoPath = req.file.path
                .replace(/\\/g, "/")
                .replace(/^uploads\//, "");
        } else if (profile_photo && !profile_photo.startsWith("http")) {
            const saved = saveBase64File(profile_photo, "profile", "profile");
            if (saved) {
                savedFiles.push(saved);
                profilePhotoPath = saved.replace(/^uploads\//, "");
            }
        } else if (
            profile_photo_url ||
            (profile_photo && profile_photo.startsWith("http"))
        ) {
            const imgUrl = profile_photo_url || profile_photo;
            try {
                const ext = "jpg";
                const filename = `profile_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
                const uploadDir = path.join(
                    __dirname,
                    "..",
                    "uploads",
                    "profile"
                );
                if (!fs.existsSync(uploadDir)) {
                    fs.mkdirSync(uploadDir, { recursive: true });
                }
                const filePath = path.join(uploadDir, filename);
                const imageRes = await axios.get(imgUrl, {
                    responseType: "arraybuffer",
                    timeout: 10000,
                });
                fs.writeFileSync(filePath, Buffer.from(imageRes.data));
                profilePhotoPath = `profile/${filename}`;
                savedFiles.push(`uploads/profile/${filename}`);
            } catch (e) {
                console.error(
                    "Failed to download Google profile image:",
                    e.message
                );
                profilePhotoPath = imgUrl;
            }
        }

        // 3. Hash password
        const passwordHash = await bcrypt.hash(password, 10);

        // 4. Run checking, OTP verification, and insertion in an interactive transaction
        await prisma.$transaction(async (tx) => {
            // Verify OTP Token before creating account
            await consumeVerificationToken(
                phone_number,
                otp_verification_token,
                tx
            );

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
                    previous_balance: 0.0,
                    new_balance: 100.0,
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
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
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
                OR: [
                    { username: username },
                    { email: username },
                    { phone_number: username },
                ],
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

        const userIdentifier =
            user.email || user.username || String(user.user_id);

        // Check if account is locked due to 5 failed password attempts in 24 hours
        const lockStatus = loginAttemptTracker.isLocked(userIdentifier);
        if (lockStatus.locked) {
            const hoursLeft = Math.max(
                1,
                Math.ceil(lockStatus.remainingMs / (1000 * 60 * 60))
            );
            throw new ApiError(
                429,
                `Account temporarily locked due to 5 failed login attempts. Please try again in ${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}.`
            );
        }

        // Verify password
        const isPasswordValid = await bcrypt.compare(
            password,
            user.password_hash
        );
        if (!isPasswordValid) {
            const attemptResult =
                loginAttemptTracker.recordFailedAttempt(userIdentifier);
            if (attemptResult.locked) {
                throw new ApiError(
                    429,
                    "Too many failed login attempts. You have reached the limit of 5 wrong password attempts today. Your account has been locked for 24 hours."
                );
            }
            const remaining = attemptResult.remainingAttempts;
            throw new ApiError(
                401,
                `Invalid credentials. You have ${remaining} attempt${remaining === 1 ? "" : "s"} remaining today.`
            );
        }

        // Clear failed attempts counter on successful login
        loginAttemptTracker.clearAttempts(userIdentifier);

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
                is_test_data: Boolean(user.is_test_data),
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
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
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

        const userIdentifier =
            user.email || user.username || String(user.user_id);

        // Check if account is locked due to 5 failed password attempts in 24 hours
        const lockStatus = loginAttemptTracker.isLocked(userIdentifier);
        if (lockStatus.locked) {
            const hoursLeft = Math.max(
                1,
                Math.ceil(lockStatus.remainingMs / (1000 * 60 * 60))
            );
            return res.status(429).json({
                success: false,
                message: `Account temporarily locked due to 5 failed login attempts. Please try again in ${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}.`,
            });
        }

        // Verify password
        const isPasswordValid = await bcrypt.compare(
            password,
            user.password_hash
        );
        if (!isPasswordValid) {
            const attemptResult =
                loginAttemptTracker.recordFailedAttempt(userIdentifier);
            if (attemptResult.locked) {
                return res.status(429).json({
                    success: false,
                    message:
                        "Too many failed login attempts. You have reached the limit of 5 wrong password attempts today. Your account has been locked for 24 hours.",
                });
            }
            const remaining = attemptResult.remainingAttempts;
            return res.status(401).json({
                success: false,
                message: `Invalid credentials. You have ${remaining} attempt${remaining === 1 ? "" : "s"} remaining today.`,
            });
        }

        // Clear failed attempts counter on successful login
        loginAttemptTracker.clearAttempts(userIdentifier);

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
                is_test_data: Boolean(user.is_test_data),
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
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
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
        const { reason } = req.body;
        const parsedOrgId = parseInt(orgId);
        if (isNaN(parsedOrgId)) {
            throw new ApiError(400, "Invalid organization ID");
        }
        if (!reason || !reason.trim()) {
            throw new ApiError(400, "A reject reason is required");
        }

        const existing = await prisma.orgUser.findUnique({
            where: { org_id: parsedOrgId },
        });
        if (!existing) throw new ApiError(404, "Organization not found");
        if (existing.status !== "pending") {
            throw new ApiError(
                409,
                `Cannot reject an organization with status "${existing.status}"`
            );
        }

        const org = await prisma.orgUser.update({
            where: { org_id: parsedOrgId },
            data: { status: "rejected", reject_reason: reason.trim() },
        });

        const cleanOrg = { ...org, id: org.org_id, name: org.org_name };
        delete cleanOrg.password_hash;

        return new ApiResponse(
            200,
            cleanOrg,
            `Organization '${org.org_name}' rejected`
        ).send(res);
    } catch (error) {
        console.error("Error in rejectOrgRequest:", error);
        if (error instanceof ApiError) return error.send(res);
        return new ApiError(500, error.message).send(res);
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
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
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
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
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
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
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

        let finalVehicleNumbers = vehicle_numbers;

        if (vehicle_numbers && typeof vehicle_numbers === "string") {
            try {
                let parsedVehicles = JSON.parse(vehicle_numbers);
                if (Array.isArray(parsedVehicles)) {
                    // Fetch existing user to preserve statuses of untouched vehicles
                    let existingUser = await prisma.user.findUnique({
                        where: { user_id: id },
                    });
                    let existingVehicles = [];
                    if (existingUser && existingUser.vehicle_numbers) {
                        try {
                            if (existingUser.vehicle_numbers.startsWith("[")) {
                                existingVehicles = JSON.parse(
                                    existingUser.vehicle_numbers
                                );
                            }
                        } catch (_) {}
                    }

                    const processedVehicles = [];
                    for (let i = 0; i < parsedVehicles.length; i++) {
                        const rawV = parsedVehicles[i];
                        let vNumber =
                            typeof rawV === "string"
                                ? rawV.trim().toUpperCase()
                                : (rawV.number || "").trim().toUpperCase();
                        if (!vNumber) continue;

                        const existing = existingVehicles.find(
                            (ev) =>
                                (typeof ev === "string" ? ev : ev.number)
                                    .trim()
                                    .toUpperCase() === vNumber
                        );

                        let docList = [];
                        let hadNewDocs = false;

                        // Process documents array (up to 3 documents)
                        if (Array.isArray(rawV.documents)) {
                            for (let d = 0; d < rawV.documents.length; d++) {
                                const doc = rawV.documents[d];
                                if (doc.base64) {
                                    hadNewDocs = true;
                                    const savedDoc = saveBase64File(
                                        doc.base64,
                                        "vehicle",
                                        `vehicle_${id}_${Date.now()}_${d}`
                                    );
                                    if (savedDoc) {
                                        docList.push({
                                            name:
                                                doc.name || `Document ${d + 1}`,
                                            url: savedDoc.replace(
                                                /^uploads\//,
                                                ""
                                            ),
                                        });
                                    }
                                } else if (doc.url) {
                                    docList.push({
                                        name: doc.name || `Document ${d + 1}`,
                                        url: doc.url,
                                    });
                                }
                            }
                        } else if (rawV.documentBase64) {
                            hadNewDocs = true;
                            const savedDoc = saveBase64File(
                                rawV.documentBase64,
                                "vehicle",
                                `vehicle_${id}_${Date.now()}_0`
                            );
                            if (savedDoc) {
                                docList.push({
                                    name: rawV.documentName || "Document 1",
                                    url: savedDoc.replace(/^uploads\//, ""),
                                });
                            }
                        } else if (rawV.documentUrl) {
                            docList.push({
                                name: rawV.documentName || "Document 1",
                                url: rawV.documentUrl,
                            });
                        }

                        // Determine status
                        let vStatus = "pending";
                        let rejectionReason = null;
                        let createdAt =
                            rawV.created_at ||
                            (existing && existing.created_at) ||
                            new Date().toISOString();
                        let approvedAt = null;

                        if (existing && typeof existing === "object") {
                            if (existing.status === "approved" && !hadNewDocs) {
                                vStatus = "approved";
                                rejectionReason = null;
                                approvedAt =
                                    existing.approved_at ||
                                    existing.approvedAt ||
                                    null;
                                if (
                                    docList.length === 0 &&
                                    existing.documents
                                ) {
                                    docList = existing.documents;
                                }
                            } else if (
                                existing.status === "rejected" &&
                                !hadNewDocs
                            ) {
                                vStatus = "rejected";
                                rejectionReason =
                                    existing.rejection_reason || null;
                                if (
                                    docList.length === 0 &&
                                    existing.documents
                                ) {
                                    docList = existing.documents;
                                }
                            } else {
                                // New vehicle or re-submitted with new documents
                                vStatus = "pending";
                                rejectionReason = null;
                            }
                        } else if (existing && typeof existing === "string") {
                            if (!hadNewDocs) {
                                vStatus = "approved";
                            }
                        }

                        processedVehicles.push({
                            number: vNumber,
                            status: vStatus,
                            documents: docList,
                            rejection_reason: rejectionReason,
                            created_at: createdAt,
                            approved_at: approvedAt,
                        });
                    }
                    finalVehicleNumbers = JSON.stringify(processedVehicles);
                }
            } catch (e) {
                console.error(
                    "Error parsing vehicle_numbers for documents:",
                    e
                );
            }
        }

        let updatedData;

        if (role === "agency_admin") {
            const {
                org_name,
                org_address,
                latitude,
                longitude,
                profile_photo,
                verification_document,
                aadhaar_card,
                trade_license_document,
                two_wheeler_capacity,
                three_wheeler_capacity,
                car_capacity,
                suv_capacity,
                van_capacity,
                pickup_capacity,
                ev_capacity,
                ev_charging_support,
                two_wheeler_rate,
                three_wheeler_rate,
                car_rate,
                suv_rate,
                van_rate,
                pickup_rate,
                ev_rate,
                cctv_available,
                trade_license,
                zoning_clearance,
                shops_establishment_license,
                gst_registration,
                parking_length,
                parking_width,
                parking_height,
                dimension_unit,
            } = req.body;

            const orgUpdateData = {};
            if (org_name !== undefined) orgUpdateData.org_name = org_name;
            if (phone_number !== undefined)
                orgUpdateData.phone_number = phone_number;
            if (org_address !== undefined || user_address !== undefined) {
                orgUpdateData.org_address =
                    org_address !== undefined ? org_address : user_address;
            }
            if (landmark !== undefined) orgUpdateData.landmark = landmark;
            if (latitude !== undefined && latitude !== null)
                orgUpdateData.latitude = parseFloat(latitude);
            if (longitude !== undefined && longitude !== null)
                orgUpdateData.longitude = parseFloat(longitude);

            // Handle Base64 document / photo uploads
            if (profile_photo) {
                const saved = saveBase64File(
                    profile_photo,
                    "profile",
                    `profile_${id}_${Date.now()}`
                );
                if (saved)
                    orgUpdateData.profile_photo_path = saved.replace(
                        /^uploads\//,
                        ""
                    );
            }
            if (verification_document) {
                const saved = saveBase64File(
                    verification_document,
                    "documents",
                    `doc_${id}_${Date.now()}`
                );
                if (saved)
                    orgUpdateData.verification_document_path = saved.replace(
                        /^uploads\//,
                        ""
                    );
            }
            if (aadhaar_card) {
                const saved = saveBase64File(
                    aadhaar_card,
                    "documents",
                    `aadhaar_${id}_${Date.now()}`
                );
                if (saved)
                    orgUpdateData.aadhaar_card_path = saved.replace(
                        /^uploads\//,
                        ""
                    );
            }
            if (trade_license_document) {
                const saved = saveBase64File(
                    trade_license_document,
                    "documents",
                    `trade_license_${id}_${Date.now()}`
                );
                if (saved)
                    orgUpdateData.trade_license_document_path = saved.replace(
                        /^uploads\//,
                        ""
                    );
            }

            // Capacities
            if (two_wheeler_capacity !== undefined)
                orgUpdateData.two_wheeler_capacity =
                    parseInt(two_wheeler_capacity) || 0;
            if (three_wheeler_capacity !== undefined)
                orgUpdateData.three_wheeler_capacity =
                    parseInt(three_wheeler_capacity) || 0;
            if (car_capacity !== undefined)
                orgUpdateData.car_capacity = parseInt(car_capacity) || 0;
            if (suv_capacity !== undefined)
                orgUpdateData.suv_capacity = parseInt(suv_capacity) || 0;
            if (van_capacity !== undefined)
                orgUpdateData.van_capacity = parseInt(van_capacity) || 0;
            if (pickup_capacity !== undefined)
                orgUpdateData.pickup_capacity = parseInt(pickup_capacity) || 0;
            if (ev_capacity !== undefined)
                orgUpdateData.ev_capacity = parseInt(ev_capacity) || 0;
            if (ev_charging_support !== undefined) {
                orgUpdateData.ev_charging_support =
                    ev_charging_support === true ||
                    ev_charging_support === "true" ||
                    ev_charging_support === "yes";
            }

            // Rates
            if (two_wheeler_rate !== undefined)
                orgUpdateData.two_wheeler_rate =
                    parseFloat(two_wheeler_rate) || 0;
            if (three_wheeler_rate !== undefined)
                orgUpdateData.three_wheeler_rate =
                    parseFloat(three_wheeler_rate) || 0;
            if (car_rate !== undefined)
                orgUpdateData.car_rate = parseFloat(car_rate) || 0;
            if (suv_rate !== undefined)
                orgUpdateData.suv_rate = parseFloat(suv_rate) || 0;
            if (van_rate !== undefined)
                orgUpdateData.van_rate = parseFloat(van_rate) || 0;
            if (pickup_rate !== undefined)
                orgUpdateData.pickup_rate = parseFloat(pickup_rate) || 0;
            if (ev_rate !== undefined)
                orgUpdateData.ev_rate = parseFloat(ev_rate) || 0;

            // Compliance
            if (cctv_available !== undefined) {
                orgUpdateData.cctv_available =
                    cctv_available === true ||
                    cctv_available === "true" ||
                    cctv_available === "yes";
            }
            if (trade_license !== undefined) {
                orgUpdateData.trade_license =
                    trade_license === true ||
                    trade_license === "true" ||
                    trade_license === "yes";
            }
            if (zoning_clearance !== undefined) {
                orgUpdateData.zoning_clearance =
                    zoning_clearance === true ||
                    zoning_clearance === "true" ||
                    zoning_clearance === "yes";
            }
            if (shops_establishment_license !== undefined) {
                orgUpdateData.shops_establishment_license =
                    shops_establishment_license === true ||
                    shops_establishment_license === "true" ||
                    shops_establishment_license === "yes";
            }
            if (gst_registration !== undefined) {
                orgUpdateData.gst_registration =
                    gst_registration === true ||
                    gst_registration === "true" ||
                    gst_registration === "yes";
            }

            // Parking Dimensions
            if (parking_length !== undefined) {
                orgUpdateData.parking_length =
                    parking_length !== "" && parking_length !== null
                        ? parseFloat(parking_length)
                        : null;
            }
            if (parking_width !== undefined) {
                orgUpdateData.parking_width =
                    parking_width !== "" && parking_width !== null
                        ? parseFloat(parking_width)
                        : null;
            }
            if (parking_height !== undefined) {
                orgUpdateData.parking_height =
                    parking_height !== "" && parking_height !== null
                        ? parseFloat(parking_height)
                        : null;
            }
            if (dimension_unit !== undefined) {
                orgUpdateData.dimension_unit = dimension_unit || "meters";
            }

            // Agency Admin / OrgUser profile update
            updatedData = await prisma.orgUser.update({
                where: { org_id: id },
                data: orgUpdateData,
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
            const { profile_photo } = req.body;
            const customerUpdateData = {
                phone_number:
                    phone_number !== undefined ? phone_number : undefined,
                user_address:
                    user_address !== undefined ? user_address : undefined,
                landmark: landmark !== undefined ? landmark : undefined,
                vehicle_numbers:
                    finalVehicleNumbers !== undefined
                        ? finalVehicleNumbers
                        : undefined,
                driving_licence:
                    driving_licence !== undefined ? driving_licence : undefined,
            };

            if (profile_photo) {
                const saved = saveBase64File(
                    profile_photo,
                    "profile",
                    `profile_${id}_${Date.now()}`
                );
                if (saved)
                    customerUpdateData.profile_photo_path = saved.replace(
                        /^uploads\//,
                        ""
                    );
            }

            // Customer or other user profile update
            updatedData = await prisma.user.update({
                where: { user_id: id },
                data: customerUpdateData,
            });
            if (updatedData) {
                updatedData = {
                    ...updatedData,
                    id: updatedData.user_id,
                    name: updatedData.full_name,
                    agencyId: updatedData.agency_id,
                };
                if (updatedData.role === "user") {
                    userData = updatedData;
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
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

// const parseVehicleNumbers = (raw) => {
//     if (!raw) return [];
//     const trimmed = String(raw).trim();
//     if (trimmed.startsWith("[")) {
//         try {
//             const parsed = JSON.parse(trimmed);
//             if (Array.isArray(parsed)) {
//                 return parsed.map((v) => String(v).trim()).filter(Boolean);
//             }
//         } catch {
//             // fall through to comma-split below
//         }
//     }
//     return trimmed
//         .split(",")
//         .map((v) => v.trim())
//         .filter(Boolean);
// };
const parseVehicleNumbers = (raw) => {
    if (!raw) return [];
    const trimmed = String(raw).trim();
    if (trimmed.startsWith("[")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                // return parsed.map((v) => String(v).trim()).filter(Boolean);

                return parsed
                    .map((v) => (typeof v === "string" ? v.trim() : v))
                    .filter((v) =>
                        typeof v === "string" ? v.length > 0 : v?.number
                    );
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

// const listAllUsersDirectory = async (req, res) => {
//     try {
//         const { status, search } = req.query;

//         // Remove the "blocked" exclusion - fetch ALL users
//         const customers = await prisma.user.findMany({
//             where: {
//                 role: "user",
//                 // REMOVE THIS LINE: status: { not: "blocked" },
//             },
//             orderBy: { created_at: "desc" },
//         });

//         let normalizedUsers = customers.map((u) => ({
//             id: u.user_id,
//             name: u.full_name,
//             username: u.username,
//             email: u.email,
//             phoneNumber: u.phone_number,
//             status: u.status,
//             walletBalance: u.wallet_balance ? parseFloat(u.wallet_balance) : 0,
//             vehicleNumbers: parseVehicleNumbers(u.vehicle_numbers),
//             drivingLicence: u.driving_licence || null,
//             address: u.user_address || null,
//             landmark: u.landmark || null,
//             latitude: u.latitude ? parseFloat(u.latitude) : null,
//             longitude: u.longitude ? parseFloat(u.longitude) : null,
//             profilePhotoPath: u.profile_photo_path || null,
//             createdAt: u.created_at,
//         }));

//         // Apply status filter if provided (including "blocked")
//         if (status) {
//             normalizedUsers = normalizedUsers.filter(
//                 (u) => u.status === status
//             );
//         }

//         // Apply search filter if provided
//         if (search) {
//             const term = search.toLowerCase();
//             normalizedUsers = normalizedUsers.filter(
//                 (u) =>
//                     u.name?.toLowerCase().includes(term) ||
//                     u.username?.toLowerCase().includes(term) ||
//                     u.email?.toLowerCase().includes(term) ||
//                     u.phoneNumber?.includes(term)
//             );
//         }

//         const summary = {
//             totalUsers: normalizedUsers.length,
//             totalWalletBalance: normalizedUsers.reduce(
//                 (sum, u) => sum + (u.walletBalance || 0),
//                 0
//             ),
//         };

//         return res
//             .status(200)
//             .json(
//                 new ApiResponse(
//                     200,
//                     { users: normalizedUsers, summary },
//                     "Customer directory fetched successfully"
//                 )
//             );
//     } catch (error) {
//         console.error("Error in listAllUsersDirectory:", error);
//         return res.status(500).json(new ApiError(500, error.message));
//     }
// };

const listAllUsersDirectory = async (req, res) => {
    try {
        const { status, search, startDate, endDate, dataType } = req.query;

        // Build where clause
        const whereClause = {
            role: "user",
        };

        if (dataType === "test") {
            whereClause.is_test_data = true;
        } else if (dataType === "real") {
            whereClause.is_test_data = false;
        }

        // Add date filtering
        if (startDate || endDate) {
            whereClause.created_at = {};
            if (startDate) {
                const start = new Date(startDate);
                start.setHours(0, 0, 0, 0);
                whereClause.created_at.gte = start;
            }
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                whereClause.created_at.lte = end;
            }
        }

        // Add search filtering
        if (search && search.trim()) {
            const searchTerm = search.trim();
            whereClause.OR = [
                { full_name: { contains: searchTerm } },
                { username: { contains: searchTerm } },
                { email: { contains: searchTerm } },
                { phone_number: { contains: searchTerm } },
            ];
        }

        const customers = await prisma.user.findMany({
            where: whereClause,
            orderBy: { created_at: "desc" },
        });

        // Format the response
        const normalizedUsers = customers.map((u) => ({
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
            isTestData: Boolean(u.is_test_data),
            createdAt: u.created_at,
        }));

        // Apply additional status filter if provided (for cases where we want to filter after the DB query)
        let filteredUsers = normalizedUsers;
        if (status) {
            filteredUsers = normalizedUsers.filter((u) => u.status === status);
        }

        const summary = {
            totalUsers: filteredUsers.length,
            totalWalletBalance: filteredUsers.reduce(
                (sum, u) => sum + (u.walletBalance || 0),
                0
            ),
        };

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    { users: filteredUsers, summary },
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
            is_test_data,
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
        if (driving_licence !== undefined)
            updateData.driving_licence = driving_licence || null;
        if (status !== undefined) updateData.status = status;

        if (is_test_data !== undefined) {
            updateData.is_test_data =
                is_test_data === true ||
                is_test_data === "true" ||
                is_test_data === "test";
        }

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
            isTestData: Boolean(updated.is_test_data),
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
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
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

/**
 * Super Admin: Get all pending vehicle registration requests
 */
const getPendingVehicleRequests = async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            where: {
                vehicle_numbers: { not: null },
            },
            select: {
                user_id: true,
                full_name: true,
                username: true,
                email: true,
                phone_number: true,
                vehicle_numbers: true,
                created_at: true,
                updated_at: true,
            },
        });

        const pendingList = [];
        users.forEach((u) => {
            if (!u.vehicle_numbers) return;
            try {
                let parsed = [];
                if (u.vehicle_numbers.startsWith("[")) {
                    parsed = JSON.parse(u.vehicle_numbers);
                }
                if (Array.isArray(parsed)) {
                    parsed.forEach((v) => {
                        if (typeof v === "object" && v.status === "pending") {
                            pendingList.push({
                                requestId: `${u.user_id}_${v.number}`,
                                userId: u.user_id,
                                userName: u.full_name,
                                userUsername: u.username,
                                userEmail: u.email,
                                userPhone: u.phone_number,
                                vehicleNumber: v.number,
                                documents: Array.isArray(v.documents)
                                    ? v.documents
                                    : v.documentUrl
                                      ? [
                                            {
                                                name:
                                                    v.documentName ||
                                                    "Document",
                                                url: v.documentUrl,
                                            },
                                        ]
                                      : [],
                                status: v.status,
                                createdAt: v.created_at || u.updated_at,
                            });
                        }
                    });
                }
            } catch (err) {
                console.error("Error parsing user vehicle numbers:", err);
            }
        });

        // Sort by createdAt descending
        pendingList.sort(
            (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
        );

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    pendingList,
                    "Pending vehicle requests fetched successfully"
                )
            );
    } catch (error) {
        console.error("Error in getPendingVehicleRequests:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Approve a vehicle number for a user
 */
const approveVehicleRequest = async (req, res) => {
    try {
        const { userId, vehicleNumber } = req.body;
        const targetUserId = parseInt(userId || req.params.userId);
        const targetVehicleNum = (
            vehicleNumber ||
            req.params.vehicleNumber ||
            ""
        )
            .trim()
            .toUpperCase();

        if (!targetUserId || !targetVehicleNum) {
            throw new ApiError(400, "User ID and vehicle number are required.");
        }

        const user = await prisma.user.findUnique({
            where: { user_id: targetUserId },
        });

        if (!user) {
            throw new ApiError(404, "User not found.");
        }

        let parsedVehicles = [];
        if (user.vehicle_numbers) {
            try {
                if (user.vehicle_numbers.startsWith("[")) {
                    parsedVehicles = JSON.parse(user.vehicle_numbers);
                }
            } catch (_) {}
        }

        let vehicleFound = false;
        parsedVehicles = parsedVehicles.map((v) => {
            const vNum = typeof v === "string" ? v : v.number;
            if (vNum && vNum.toUpperCase() === targetVehicleNum) {
                vehicleFound = true;
                if (typeof v === "string") {
                    return {
                        number: vNum,
                        status: "approved",
                        documents: [],
                        approved_at: new Date().toISOString(),
                    };
                }
                return {
                    ...v,
                    status: "approved",
                    approved_at: new Date().toISOString(),
                    rejection_reason: null,
                };
            }
            return v;
        });

        if (!vehicleFound) {
            throw new ApiError(
                404,
                `Vehicle number ${targetVehicleNum} not found for this user.`
            );
        }

        await prisma.user.update({
            where: { user_id: targetUserId },
            data: {
                vehicle_numbers: JSON.stringify(parsedVehicles),
            },
        });

        // Send Firebase push notification to user's registered devices
        try {
            const devices = await prisma.userDevice.findMany({
                where: { user_id: targetUserId },
                select: { fcm_token: true },
            });
            if (devices && devices.length > 0) {
                const tokens = devices.map((d) => d.fcm_token).filter(Boolean);
                if (tokens.length > 0) {
                    await sendPushNotificationToDevices(tokens, {
                        title: "Vehicle Number Approved",
                        message: `Your vehicle number ${targetVehicleNum} has been approved. You can now use it to book parking spots!`,
                        data: {
                            type: "vehicle_approval",
                            vehicleNumber: targetVehicleNum,
                            status: "approved",
                        },
                    });
                }
            }
        } catch (fcmErr) {
            console.error(
                "Error sending Firebase vehicle approval push notification:",
                fcmErr
            );
        }

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    { vehicleNumber: targetVehicleNum, status: "approved" },
                    "Vehicle approved successfully"
                )
            );
    } catch (error) {
        console.error("Error in approveVehicleRequest:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Reject a vehicle number with mandatory reason
 */
const rejectVehicleRequest = async (req, res) => {
    try {
        const { userId, vehicleNumber, rejection_reason } = req.body;
        const targetUserId = parseInt(userId || req.params.userId);
        const targetVehicleNum = (
            vehicleNumber ||
            req.params.vehicleNumber ||
            ""
        )
            .trim()
            .toUpperCase();
        const reason = (rejection_reason || "").trim();

        if (!targetUserId || !targetVehicleNum) {
            throw new ApiError(400, "User ID and vehicle number are required.");
        }
        if (!reason) {
            throw new ApiError(400, "A rejection reason is mandatory.");
        }

        const user = await prisma.user.findUnique({
            where: { user_id: targetUserId },
        });

        if (!user) {
            throw new ApiError(404, "User not found.");
        }

        let parsedVehicles = [];
        if (user.vehicle_numbers) {
            try {
                if (user.vehicle_numbers.startsWith("[")) {
                    parsedVehicles = JSON.parse(user.vehicle_numbers);
                }
            } catch (_) {}
        }

        let vehicleFound = false;
        parsedVehicles = parsedVehicles.map((v) => {
            const vNum = typeof v === "string" ? v : v.number;
            if (vNum && vNum.toUpperCase() === targetVehicleNum) {
                vehicleFound = true;
                if (typeof v === "string") {
                    return {
                        number: vNum,
                        status: "rejected",
                        documents: [],
                        rejection_reason: reason,
                        rejected_at: new Date().toISOString(),
                    };
                }
                return {
                    ...v,
                    status: "rejected",
                    rejection_reason: reason,
                    rejected_at: new Date().toISOString(),
                };
            }
            return v;
        });

        if (!vehicleFound) {
            throw new ApiError(
                404,
                `Vehicle number ${targetVehicleNum} not found for this user.`
            );
        }

        await prisma.user.update({
            where: { user_id: targetUserId },
            data: {
                vehicle_numbers: JSON.stringify(parsedVehicles),
            },
        });

        // Send Firebase push notification to user's registered devices
        try {
            const devices = await prisma.userDevice.findMany({
                where: { user_id: targetUserId },
                select: { fcm_token: true },
            });
            if (devices && devices.length > 0) {
                const tokens = devices.map((d) => d.fcm_token).filter(Boolean);
                if (tokens.length > 0) {
                    await sendPushNotificationToDevices(tokens, {
                        title: "Vehicle Registration Rejected",
                        message: `Your vehicle number ${targetVehicleNum} was rejected. Reason: ${reason}`,
                        data: {
                            type: "vehicle_rejection",
                            vehicleNumber: targetVehicleNum,
                            status: "rejected",
                            reason,
                        },
                    });
                }
            }
        } catch (fcmErr) {
            console.error(
                "Error sending Firebase vehicle rejection push notification:",
                fcmErr
            );
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    vehicleNumber: targetVehicleNum,
                    status: "rejected",
                    rejection_reason: reason,
                },
                "Vehicle rejected successfully"
            )
        );
    } catch (error) {
        console.error("Error in rejectVehicleRequest:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Handle Google Sign-in / Auth
 * Verifies email or Google idToken
 * If account exists -> returns JWT token & user data (logs in)
 * If account does not exist -> returns exists: false with Google name, email, photoUrl
 */
const googleAuth = async (req, res) => {
    try {
        const {
            idToken,
            email: rawEmail,
            name: rawName,
            photo: rawPhoto,
            photoUrl: rawPhotoUrl,
        } = req.body;

        let email = rawEmail ? String(rawEmail).trim().toLowerCase() : null;
        let name = rawName ? String(rawName).trim() : null;
        let photoUrl = rawPhoto || rawPhotoUrl || null;

        // Verify ID token if provided
        if (idToken) {
            try {
                const ticket = await googleClient.verifyIdToken({
                    idToken: idToken,
                    audience: [
                        process.env.GOOGLE_CLIENT_ID,
                        "196392862520-nq7una9ib2t866dtf7tgmtr3rkcd6jr7.apps.googleusercontent.com",
                    ].filter(Boolean),
                });
                const payload = ticket.getPayload();
                if (payload) {
                    if (payload.email)
                        email = payload.email.trim().toLowerCase();
                    if (payload.name) name = payload.name;
                    if (payload.picture) photoUrl = payload.picture;
                }
            } catch (tokenErr) {
                console.warn("Google verifyIdToken note:", tokenErr.message);
                // Fallback to body email if idToken verification has local audience mismatch
            }
        }

        if (!email) {
            throw new ApiError(400, "Google email address is required");
        }

        // Check if user exists in standard users table
        let user = await prisma.user.findFirst({
            where: {
                email: email,
            },
        });

        let role = null;
        let isOrgUser = false;

        if (user) {
            role = user.role || "user";
        } else {
            // Check in org_users
            user = await prisma.orgUser.findFirst({
                where: {
                    email: email,
                },
            });
            if (user) {
                role = "agency_admin";
                isOrgUser = true;
            }
        }

        // If user does not exist in DB:
        if (!user) {
            return res.status(200).json(
                new ApiResponse(
                    200,
                    {
                        exists: false,
                        email: email,
                        name: name || "",
                        photoUrl: photoUrl || null,
                    },
                    "Account does not exist. Please complete registration."
                )
            );
        }

        // Check user status
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

        // Build token & user payload
        const agencyId = isOrgUser ? user.org_id : user.agency_id || null;
        const resolvedUserId = isOrgUser ? user.org_id : user.user_id;

        const token = jwt.sign(
            {
                id: resolvedUserId,
                username: user.username,
                role: role,
                agencyId: agencyId,
                agency_id: agencyId,
                org_id: isOrgUser ? user.org_id : undefined,
                is_test_data: Boolean(user.is_test_data),
            },
            process.env.JWT_SECRET || "your_secret_key",
            { expiresIn: "7d" }
        );

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

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    exists: true,
                    user: userData,
                    token,
                    role,
                },
                "Login successful"
            )
        );
    } catch (error) {
        console.error("Error in googleAuth:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Controller: Reset Password using OTP Verification Token
 */
const resetPassword = async (req, res) => {
    try {
        const {
            phone_number,
            otp_verification_token,
            new_password,
            confirm_password,
        } = req.body;

        if (!phone_number || !otp_verification_token || !new_password) {
            throw new ApiError(
                400,
                "Phone number, OTP verification token, and new password are required"
            );
        }

        if (confirm_password && new_password !== confirm_password) {
            throw new ApiError(400, "Passwords do not match");
        }

        if (String(new_password).length < 6) {
            throw new ApiError(
                400,
                "New password must be at least 6 characters long"
            );
        }

        const cleanPhone = String(phone_number)
            .trim()
            .replace(/[^0-9+]/g, "");
        const phoneSuffix =
            cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
        const phoneFilter = {
            OR: [
                { phone_number: cleanPhone },
                { phone_number: phoneSuffix },
                { phone_number: `+91${phoneSuffix}` },
                { phone_number: `91${phoneSuffix}` },
            ],
        };

        // Find user by phone number (in users or org_users)
        let user = await prisma.user.findFirst({
            where: phoneFilter,
        });
        let isOrg = false;

        if (!user) {
            user = await prisma.orgUser.findFirst({
                where: phoneFilter,
            });
            if (user) isOrg = true;
        }

        if (!user) {
            throw new ApiError(
                404,
                "No registered account found with this phone number"
            );
        }

        // Validate and consume the OTP token inside a transaction
        await prisma.$transaction(async (tx) => {
            await consumeVerificationToken(
                cleanPhone,
                otp_verification_token,
                tx
            );

            // Hash new password
            const newPasswordHash = await bcrypt.hash(new_password, 10);

            if (isOrg) {
                await tx.orgUser.update({
                    where: { org_id: user.org_id },
                    data: { password_hash: newPasswordHash },
                });
            } else {
                await tx.user.update({
                    where: { user_id: user.user_id },
                    data: { password_hash: newPasswordHash },
                });
            }
        });

        // Clear any login attempt lockout
        const userIdentifier =
            user.email || user.username || String(user.user_id || user.org_id);
        loginAttemptTracker.clearAttempts(userIdentifier);

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    null,
                    "Password reset successfully. You can now login with your new password."
                )
            );
    } catch (error) {
        console.error("Error in resetPassword:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

module.exports = {
    registerUser,
    loginUser,
    loginUserSuperAdmin,
    googleAuth,
    resetPassword,
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
    listAllUsersDirectory,
    updateCustomerDetails,
    getUserStatusHistory,
    getPendingVehicleRequests,
    approveVehicleRequest,
    rejectVehicleRequest,
};
