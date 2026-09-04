const express = require("express");
const router = express.Router();
const {
    getOperatorDashboardStats,
    getAuthorityDashboardStats,
    getDashboardStats,
} = require("../controllers/dashboard.controller");
const { verifyJWT, authorizeRoles } = require("../middlewares/auth.middleware");

// super_admin's operational overview: bookings, agencies, users, approval queues.
router.get(
    "/stats",
    verifyJWT,
    authorizeRoles("super_admin"),
    getOperatorDashboardStats
);

// authority_admin's ownership overview: wallet, spaces, commission revenue.
router.get(
    "/authority-stats",
    verifyJWT,
    authorizeRoles("authority_admin"),
    getAuthorityDashboardStats
);

// General user dashboard statistics
router.get("/dashboard-stats", verifyJWT, getDashboardStats);

module.exports = router;
