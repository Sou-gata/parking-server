const express = require("express");
const router = express.Router();
const { getTerms, updateTerms } = require("../controllers/config.controller");
const { verifyJWT, authorizeRoles } = require("../middlewares/auth.middleware");

// Public route to fetch terms and conditions ("user" or "agency")
router.get("/:type", getTerms);

// Secured Super Admin route to update terms and conditions
router.put("/:type", verifyJWT, authorizeRoles("super_admin"), updateTerms);

module.exports = router;
