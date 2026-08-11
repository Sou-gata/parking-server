const express = require("express");
const router = express.Router();
const {
    getWorkingHours,
    updateWorkingHours,
    getPendingWorkingHoursRequests,
    approveWorkingHoursRequest,
    rejectWorkingHoursRequest,
} = require("../controllers/workingHours.controller");
const { verifyJWT, authorizeRoles } = require("../middlewares/auth.middleware");

// Public route to fetch active working hours of an agency
router.get("/agency/:id", getWorkingHours);

// Secured Super Admin routes to manage pending requests
router.get(
    "/pending",
    verifyJWT,
    authorizeRoles("super_admin"),
    getPendingWorkingHoursRequests
);

router.post(
    "/agency/:id/approve",
    verifyJWT,
    authorizeRoles("super_admin"),
    approveWorkingHoursRequest
);

router.post(
    "/agency/:id/reject",
    verifyJWT,
    authorizeRoles("super_admin"),
    rejectWorkingHoursRequest
);

// Secured Agency Admin or Super Admin update route
router.put(
    "/agency/:id",
    verifyJWT,
    authorizeRoles("agency_admin", "super_admin"),
    updateWorkingHours
);

module.exports = router;
