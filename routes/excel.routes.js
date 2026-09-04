// routes/excel.routes.js
const express = require("express");
const router = express.Router();
const { verifyJWT, authorizeRoles } = require("../middlewares/auth.middleware");
const {
    generateUserExcel,
    generateUserExcelWithSummary,
    generateAgencyExcel,
    generateAgencyExcelWithSummary,
} = require("../controllers/excel.controller");

/**
 * @route   GET /api/v1/excel/customers
 * @desc    Export customers/drivers directory to Excel
 * @access  Super Admin, Authority Admin
 * @query   status - Filter by user status (active, suspended, blocked, all)
 * @query   search - Search by name, username, email, phone
 * @query   startDate - Filter by registration date range (start)
 * @query   endDate - Filter by registration date range (end)
 */
router.get(
    "/customers",
    verifyJWT,
    authorizeRoles("super_admin", "authority_admin"),
    generateUserExcel
);

/**
 * @route   GET /api/v1/excel/customers/summary
 * @desc    Export customers/drivers directory with summary sheet
 * @access  Super Admin, Authority Admin
 * @query   status - Filter by user status (active, suspended, blocked, all)
 * @query   search - Search by name, username, email, phone
 * @query   startDate - Filter by registration date range (start)
 * @query   endDate - Filter by registration date range (end)
 */
router.get(
    "/customers/summary",
    verifyJWT,
    authorizeRoles("super_admin", "authority_admin"),
    generateUserExcelWithSummary
);

/**
 * @route   GET /api/v1/excel/customers/status/:status
 * @desc    Export customers by specific status
 * @access  Super Admin, Authority Admin
 */
router.get(
    "/customers/status/:status",
    verifyJWT,
    authorizeRoles("super_admin", "authority_admin"),
    async (req, res) => {
        // Reuse the generateUserExcel with status param
        req.query.status = req.params.status;
        return generateUserExcel(req, res);
    }
);

/**
 * @route   GET /api/v1/excel/agencies
 * @desc    Export parking owners (agencies) directory to Excel — profile,
 *          status, commission rate, and wallet balance snapshot
 * @access  Super Admin, Authority Admin
 * @query   status - Filter by agency status (active, suspended, blocked, all)
 * @query   search - Search by org name, username, email, phone
 * @query   startDate - Filter by registration date range (start)
 * @query   endDate - Filter by registration date range (end)
 */
router.get(
    "/agencies",
    verifyJWT,
    authorizeRoles("super_admin", "authority_admin"),
    generateAgencyExcel
);

/**
 * @route   GET /api/v1/excel/agencies/summary
 * @desc    Export parking owners with a Summary sheet (status breakdown,
 *          combined wallet balance, revenue/withdrawal totals) and a full
 *          Wallet Records sheet (agency_transactions + wallet_transactions)
 * @access  Super Admin, Authority Admin
 * @query   status - Filter by agency status (active, suspended, blocked, all)
 * @query   search - Search by org name, username, email, phone
 * @query   startDate - Filter by registration date range (start)
 * @query   endDate - Filter by registration date range (end)
 */
router.get(
    "/agencies/summary",
    verifyJWT,
    authorizeRoles("super_admin", "authority_admin"),
    generateAgencyExcelWithSummary
);

/**
 * @route   GET /api/v1/excel/agencies/status/:status
 * @desc    Export parking owners by specific status
 * @access  Super Admin, Authority Admin
 */
router.get(
    "/agencies/status/:status",
    verifyJWT,
    authorizeRoles("super_admin", "authority_admin"),
    async (req, res) => {
        req.query.status = req.params.status;
        return generateAgencyExcel(req, res);
    }
);

module.exports = router;
