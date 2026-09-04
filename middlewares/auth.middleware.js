const jwt = require("jsonwebtoken");
const { ApiError } = require("../utils/ApiError");
const { prisma } = require("../utils/db");

const verifyJWT = async (req, res, next) => {
    try {
        const token = req.cookies?.token || req.header("Authorization")?.replace("Bearer ", "");

        if (!token) {
            throw new ApiError(401, "Unauthorized request - No token provided");
        }

        const decodedToken = jwt.verify(token, process.env.JWT_SECRET || "your_secret_key");

        req.user = decodedToken;
        next();
    } catch (error) {
        console.error("verifyJWT Error:", error);
        return res.status(401).json(new ApiError(401, error.message || "Invalid access token"));
    }
};

const optionalJWT = (req, res, next) => {
    try {
        const token = req.cookies?.token || req.header("Authorization")?.replace("Bearer ", "");
        if (token) {
            const decodedToken = jwt.verify(token, process.env.JWT_SECRET || "your_secret_key");
            req.user = decodedToken;
        }
    } catch (error) {
        // Soft fail for optional JWT
    }
    next();
};

const getIsTestUser = async (req) => {
    if (!req || !req.user) return false;
    if (typeof req.user.is_test_data === "boolean") {
        return req.user.is_test_data;
    }
    try {
        if (req.user.role === "agency_admin" || req.user.role === "agency_user") {
            const org = await prisma.orgUser.findUnique({
                where: { org_id: req.user.id || req.user.org_id },
                select: { is_test_data: true }
            });
            return org ? Boolean(org.is_test_data) : false;
        } else {
            const userId = req.user.id || req.user.user_id;
            if (!userId) return false;
            const user = await prisma.user.findUnique({
                where: { user_id: userId },
                select: { is_test_data: true }
            });
            return user ? Boolean(user.is_test_data) : false;
        }
    } catch (err) {
        return false;
    }
};

const authorizeRoles = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json(new ApiError(403, "Access forbidden: Insufficient permissions"));
        }
        next();
    };
};

module.exports = {
    verifyJWT,
    optionalJWT,
    getIsTestUser,
    authorizeRoles,
};

