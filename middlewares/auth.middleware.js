const jwt = require("jsonwebtoken");
const { ApiError } = require("../utils/ApiError");

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
    authorizeRoles,
};
