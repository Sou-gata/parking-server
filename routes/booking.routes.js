const express = require("express");
const router = express.Router();
const {
    createBooking,
    getUserBookings,
    getAgencyBookings,
    getBookingDetailsByCode,
    checkIn,
    checkOut,
    cancelBooking,
    forceCancelBooking,
    previewCancelBooking,
    processBookingRefund,
    updateBookingApprovalStatus,
} = require("../controllers/booking.controller");
const { verifyJWT, authorizeRoles } = require("../middlewares/auth.middleware");

// Secured endpoints for users/staff
router.post("/", verifyJWT, createBooking);
router.post("/create", verifyJWT, createBooking);
router.get("/user/:userId", verifyJWT, getUserBookings);
router.get("/agency/:agencyId", verifyJWT, getAgencyBookings);
router.get("/code/:bookingCode", verifyJWT, getBookingDetailsByCode);
router.get("/cancel-preview/:bookingCode", verifyJWT, previewCancelBooking);

// Staff/Admin operations (check-in, check-out, refund, force-cancel, approve/reject)
router.post(
    "/approval-status",
    verifyJWT,
    authorizeRoles("agency_user", "agency_admin", "org", "agency_owner", "super_admin"),
    updateBookingApprovalStatus
);

// Staff/Admin operations (check-in, check-out, refund, force-cancel)
router.post(
    "/checkin",
    verifyJWT,
    authorizeRoles("agency_user", "agency_admin", "org", "agency_owner", "super_admin"),
    checkIn
);
router.post(
    "/checkout",
    verifyJWT,
    authorizeRoles("agency_user", "agency_admin", "org", "agency_owner", "super_admin"),
    checkOut
);
router.post("/cancel", verifyJWT, cancelBooking);
router.post(
    "/force-cancel",
    verifyJWT,
    authorizeRoles("agency_user", "agency_admin", "org", "agency_owner", "super_admin"),
    forceCancelBooking
);
router.post(
    "/refund",
    verifyJWT,
    authorizeRoles("agency_user", "agency_admin", "org", "agency_owner", "super_admin"),
    processBookingRefund
);

module.exports = router;
