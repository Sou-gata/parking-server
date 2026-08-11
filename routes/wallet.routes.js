const express = require("express");
const router = express.Router();
const {
    addMoneyRequest,
    getWalletHistory,
    getWalletBalance,
    getWalletQr,
    getPendingWalletRequests,
    approveWalletRequest,
    rejectWalletRequest,
    getWalletConfig,
    updateWalletConfig,
    requestAgencyWithdrawal,
    getPendingAgencyWithdrawalRequests,
    approveAgencyWithdrawalRequest,
    rejectAgencyWithdrawalRequest,
    getAgencyWithdrawalHistory,
    getAdminTransactionHistory,
    getWalletTransactionsLog,
    getPendingAgencySettlements,
    approveAgencySettlementHandler,
    rejectAgencySettlementHandler,
} = require("../controllers/wallet.controller");
const { verifyJWT, authorizeRoles } = require("../middlewares/auth.middleware");
const { upload } = require("../middlewares/multer.middleware");

// Customer & Super Admin wallet routes
router.post(
    "/add",
    verifyJWT,
    authorizeRoles("user", "super_admin"),
    upload.single("screenshot"),
    addMoneyRequest
);
router.get(
    "/transactions",
    verifyJWT,
    authorizeRoles("super_admin", "authority_admin"),
    getWalletTransactionsLog
);
router.get(
    "/history",
    verifyJWT,
    authorizeRoles("user", "agency_admin", "super_admin"),
    getWalletHistory
);
router.get(
    "/balance",
    verifyJWT,
    authorizeRoles("user", "agency_admin", "super_admin"),
    getWalletBalance
);
router.get(
    "/qr",
    verifyJWT,
    authorizeRoles("user", "super_admin"),
    getWalletQr
);

// Agency Admin cash withdrawal routes
router.post(
    "/agency/withdraw",
    verifyJWT,
    authorizeRoles("agency_admin"),
    requestAgencyWithdrawal
);
router.get(
    "/agency/withdrawals",
    verifyJWT,
    authorizeRoles("agency_admin"),
    getAgencyWithdrawalHistory
);

// Super Admin wallet management & withdrawal approvals
router.get(
    "/requests",
    verifyJWT,
    authorizeRoles("super_admin", "authority_admin"),
    getPendingWalletRequests
);
router.post(
    "/requests/:transactionId/approve",
    verifyJWT,
    authorizeRoles("super_admin"),
    approveWalletRequest
);
router.post(
    "/requests/:transactionId/reject",
    verifyJWT,
    authorizeRoles("super_admin"),
    rejectWalletRequest
);

// Super Admin agency withdrawal requests management
router.get(
    "/agency/requests",
    verifyJWT,
    authorizeRoles("super_admin"),
    getPendingAgencyWithdrawalRequests
);
router.post(
    "/agency/requests/:transactionId/approve",
    verifyJWT,
    authorizeRoles("super_admin"),
    upload.single("proof"),
    approveAgencyWithdrawalRequest
);
router.post(
    "/agency/requests/:transactionId/reject",
    verifyJWT,
    authorizeRoles("super_admin"),
    rejectAgencyWithdrawalRequest
);

// Super Admin agency revenue settlement management (Approval & Custom Amount)
router.get(
    "/agency/settlements/pending",
    verifyJWT,
    authorizeRoles("super_admin"),
    getPendingAgencySettlements
);
router.post(
    "/agency/settlements/:transactionId/approve",
    verifyJWT,
    authorizeRoles("super_admin"),
    approveAgencySettlementHandler
);
router.post(
    "/agency/settlements/:transactionId/reject",
    verifyJWT,
    authorizeRoles("super_admin"),
    rejectAgencySettlementHandler
);

// Super Admin all & agency-wise transaction history
router.get(
    "/admin/history",
    verifyJWT,
    authorizeRoles("super_admin"),
    getAdminTransactionHistory
);

router.get(
    "/config",
    verifyJWT,
    authorizeRoles("super_admin", "authority_admin"),
    getWalletConfig
);
router.post(
    "/config",
    verifyJWT,
    authorizeRoles("super_admin", "authority_admin"),
    updateWalletConfig
);

module.exports = router;
