const express = require("express");
const router = express.Router();
const {
    registerUser,
    loginUser,
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
    loginUserSuperAdmin,
    listAllUsersDirectory,
    updateCustomerDetails,
    getUserStatusHistory,
} = require("../controllers/user.controller");
const { registerOrg } = require("../controllers/org.controller");
const { upload } = require("../middlewares/multer.middleware");
const { verifyJWT, authorizeRoles } = require("../middlewares/auth.middleware");

// Registration routes
router.post("/register", upload.single("profile_photo"), registerUser);

/* Base64 JSON routes (Commented Out)
router.post("/userregister", registerUser);
router.post("/orgregister", registerOrg);
*/

// FormData / Multer Multipart Upload Routes
router.post("/userregister", upload.single("profile_photo"), registerUser);
router.post(
    "/orgregister",
    upload.fields([
        { name: "profile_photo", maxCount: 1 },
        { name: "verification_document", maxCount: 1 },
        { name: "aadhaar_card", maxCount: 1 },
        { name: "org_media", maxCount: 10 },
    ]),
    registerOrg
);

// Auth & Dashboard routes
router.post("/login/super", loginUserSuperAdmin);
router.post("/login", loginUser);
router.get("/profile", verifyJWT, getProfile);
router.put("/profile", verifyJWT, updateProfile);
router.get("/dashboard-stats", verifyJWT, getDashboardStats);

// Super Admin request approvals
router.get(
    "/requests",
    verifyJWT,
    authorizeRoles("super_admin"),
    getPendingRequests
);
router.post(
    "/requests/:orgId/approve",
    verifyJWT,
    authorizeRoles("super_admin"),
    approveOrgRequest
);
router.post(
    "/requests/:orgId/reject",
    verifyJWT,
    authorizeRoles("super_admin"),
    rejectOrgRequest
);

// Agency Admin staff management routes
router.post(
    "/staff/register",
    verifyJWT,
    authorizeRoles("agency_admin", "super_admin"),
    registerStaff
);
router.get(
    "/staff",
    verifyJWT,
    authorizeRoles("agency_admin", "super_admin"),
    listStaff
);
router.get(
    "/staff/:agencyId",
    verifyJWT,
    authorizeRoles("agency_admin", "super_admin"),
    listStaff
);
router.put(
    "/staff/:userId",
    verifyJWT,
    authorizeRoles("agency_admin", "super_admin"),
    updateStaff
);
router.delete(
    "/staff/:userId",
    verifyJWT,
    authorizeRoles("agency_admin", "super_admin"),
    deleteStaff
);
router.post(
    "/staff/:userId/toggle-status",
    verifyJWT,
    authorizeRoles("agency_admin", "super_admin"),
    toggleStaffStatus
);
router.get(
    "/directory",
    verifyJWT,
    authorizeRoles("super_admin", "authority_admin"),
    listAllUsersDirectory
);

router.put(
    "/directory/:id",
    verifyJWT,
    authorizeRoles("super_admin", "authority_admin"),
    updateCustomerDetails
);

router.get(
    "/directory/:id/status-history",
    verifyJWT,
    authorizeRoles("super_admin", "authority_admin"),
    getUserStatusHistory
);

module.exports = router;
