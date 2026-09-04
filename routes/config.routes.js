const express = require("express");
const router = express.Router();
const {
    getTerms,
    updateTerms,
    checkAppUpdate,
    getOvertimeSettings,
    updateOvertimeSettings,
} = require("../controllers/config.controller");
const { verifyJWT, authorizeRoles } = require("../middlewares/auth.middleware");

// Public route to check app updates
router.get("/check-update", checkAppUpdate);

// Secured routes for Overtime Notification Settings (placed before /:type)
router.get(
    "/overtime-settings",
    verifyJWT,
    authorizeRoles("super_admin", "authority_admin", "admin"),
    getOvertimeSettings
);
router.put(
    "/overtime-settings",
    verifyJWT,
    authorizeRoles("super_admin", "authority_admin"),
    updateOvertimeSettings
);

// Public route to fetch terms and conditions ("user" or "agency")
router.get("/:type", getTerms);

// Secured Super Admin route to update terms and conditions
router.put(
    "/:type",
    verifyJWT,
    authorizeRoles("super_admin", "authority_admin"),
    updateTerms
);

module.exports = router;
