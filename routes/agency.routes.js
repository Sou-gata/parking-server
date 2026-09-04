const express = require("express");
const router = express.Router();
const {
    listAgencies,
    getAgencyDetails,
    updateAgencyDetails,
    updateAgencyCapacities,
    updateAgencyRates,
    getRouteGeometry,
    updateCancellationPolicy,
    updateAgencyCommissionRate,
    toggleBookingApprovalSetting,
    getAgencyMedia,
    addAgencyMedia,
    updateAgencyMedia,
    deleteAgencyMedia,
    updateMediaStatus,
    updateAgencyStatus,
    getAgencyStatusHistory,
} = require("../controllers/agency.controller");
const { verifyJWT, optionalJWT, authorizeRoles } = require("../middlewares/auth.middleware");
const { upload } = require("../middlewares/multer.middleware");

// Public & Secured Media endpoints
router.get("/:id/media", optionalJWT, getAgencyMedia);
router.get("/:id/all-media", verifyJWT, getAgencyMedia);

// Public endpoints
router.get("/", optionalJWT, listAgencies);
router.get("/route", optionalJWT, getRouteGeometry);
router.get("/:id", optionalJWT, getAgencyDetails);

// Secured endpoints
router.put(
    "/:id",
    verifyJWT,
    authorizeRoles("agency_admin", "super_admin"),
    updateAgencyDetails
);
router.put(
    "/:id/capacities",
    verifyJWT,
    authorizeRoles("agency_admin", "super_admin"),
    updateAgencyCapacities
);
router.put(
    "/:id/rates",
    verifyJWT,
    authorizeRoles("agency_admin", "super_admin"),
    updateAgencyRates
);
router.put(
    "/:id/cancellation-policy",
    verifyJWT,
    authorizeRoles("super_admin"),
    updateCancellationPolicy
);
router.put(
    "/:id/commission",
    verifyJWT,
    authorizeRoles("super_admin"),
    updateAgencyCommissionRate
);
router.patch(
    "/:id/approval-setting",
    verifyJWT,
    authorizeRoles("super_admin"),
    toggleBookingApprovalSetting
);

// Agency Media Endpoints
router.post(
    "/:id/media",
    verifyJWT,
    authorizeRoles("agency_admin", "super_admin"),
    upload.single("media"),
    addAgencyMedia
);
router.put(
    "/media/:mediaId",
    verifyJWT,
    authorizeRoles("agency_admin", "super_admin"),
    upload.single("media"),
    updateAgencyMedia
);
router.delete(
    "/media/:mediaId",
    verifyJWT,
    authorizeRoles("agency_admin", "super_admin"),
    deleteAgencyMedia
);
router.patch(
    "/media/:mediaId/status",
    verifyJWT,
    authorizeRoles("super_admin"),
    updateMediaStatus
);
router.put(
    "/:id/status",
    verifyJWT,
    authorizeRoles("super_admin"),
    updateAgencyStatus
);
router.get(
    "/:id/status-history",
    verifyJWT,
    authorizeRoles("super_admin"),
    getAgencyStatusHistory
);

module.exports = router;
