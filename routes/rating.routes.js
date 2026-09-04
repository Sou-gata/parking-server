const express = require("express");
const router = express.Router();
const {
    submitRating,
    getBookingRatings,
    getAgencyRatings,
    getUserRatings,
    deleteRating,
} = require("../controllers/rating.controller");
const { verifyJWT, optionalJWT, authorizeRoles } = require("../middlewares/auth.middleware");

router.get("/agency/:agencyId", optionalJWT, getAgencyRatings);
router.get("/booking/:bookingId", verifyJWT, getBookingRatings);
router.get("/user/:userId", verifyJWT, getUserRatings);
router.post(
    "/",
    verifyJWT,
    authorizeRoles("user", "agency_admin", "agency_user", "super_admin"),
    submitRating
);
router.delete("/:ratingId", verifyJWT, deleteRating);

module.exports = router;
