const express = require("express");
const router = express.Router();
const {
    createComplaint,
    getUserBookingComplaintStatus,
    getUserComplaints,
    getAgencyComplaints,
    getAllComplaints,
    getComplaintById,
    addComplaintStep,
    updateComplaintStatus,
} = require("../controllers/complaint.controller");
const { verifyJWT, authorizeRoles } = require("../middlewares/auth.middleware");

// Submit complaint (User or Agency)
router.post(
    "/",
    verifyJWT,
    authorizeRoles("user", "agency_admin", "agency_user", "org", "super_admin"),
    createComplaint
);

// Get user's complained booking IDs
router.get(
    "/user-status",
    verifyJWT,
    getUserBookingComplaintStatus
);

// Get user's complaints list with step timeline
router.get(
    "/user",
    verifyJWT,
    authorizeRoles("user", "super_admin"),
    getUserComplaints
);

// Get complaints for agency
router.get(
    "/agency",
    verifyJWT,
    authorizeRoles("agency_admin", "agency_user", "org", "super_admin"),
    getAgencyComplaints
);

// Get all complaints for super admin
router.get(
    "/admin",
    verifyJWT,
    authorizeRoles("super_admin"),
    getAllComplaints
);

// Get single complaint details & timeline
router.get(
    "/:complaintId",
    verifyJWT,
    authorizeRoles("user", "agency_admin", "agency_user", "org", "super_admin"),
    getComplaintById
);

// Add a step / comment / status transition to a complaint (Agency/Admin, or User if status is waiting_for_user)
router.post(
    "/:complaintId/steps",
    verifyJWT,
    authorizeRoles("user", "agency_admin", "agency_user", "org", "super_admin"),
    addComplaintStep
);

// Update complaint status & resolution notes (backward-compatible wrapper)
router.put(
    "/:complaintId/status",
    verifyJWT,
    authorizeRoles("agency_admin", "agency_user", "org", "super_admin"),
    updateComplaintStatus
);

module.exports = router;
