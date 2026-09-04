// controllers/excel.controller.js
const { prisma } = require("../utils/db");
const ExcelJS = require("exceljs");
const { ApiError } = require("../utils/ApiError");

// ============= HEADER DEFINITIONS =============
const customerHeaders = [
    { header: "Customer ID", key: "id", width: 15 },
    { header: "Full Name", key: "name", width: 25 },
    { header: "Username", key: "username", width: 20 },
    { header: "Email", key: "email", width: 30 },
    { header: "Phone Number", key: "phoneNumber", width: 18 },
    { header: "Status", key: "status", width: 15 },
    { header: "Wallet Balance", key: "walletBalance", width: 18 },
    { header: "Driving Licence", key: "drivingLicence", width: 20 },
    { header: "Address", key: "address", width: 35 },
    { header: "Landmark", key: "landmark", width: 25 },
    { header: "Registered Vehicles", key: "vehicles", width: 30 },
    { header: "Registered On", key: "createdAt", width: 22 },
];

// Parking owner (agency) export columns
const agencyHeaders = [
    { header: "Agency ID", key: "id", width: 12 },
    { header: "Agency Name", key: "orgName", width: 28 },
    { header: "Owner Username", key: "username", width: 20 },
    { header: "Email", key: "email", width: 30 },
    { header: "Phone Number", key: "phoneNumber", width: 18 },
    { header: "Status", key: "status", width: 15 },
    { header: "Commission %", key: "commissionPercentage", width: 15 },
    { header: "Wallet Balance", key: "walletBalance", width: 18 },
    { header: "Total Bookings", key: "totalBookings", width: 15 },
    { header: "EV Charging", key: "evCharging", width: 13 },
    { header: "Address", key: "address", width: 35 },
    { header: "Registered On", key: "createdAt", width: 22 },
];

// Wallet records sheet columns (agency revenue settlements + withdrawals combined)
const walletRecordHeaders = [
    { header: "Agency Name", key: "agencyName", width: 28 },
    { header: "Record Type", key: "type", width: 20 },
    { header: "Reference", key: "reference", width: 20 },
    { header: "Amount", key: "amount", width: 16 },
    { header: "Status", key: "status", width: 14 },
    { header: "Date", key: "date", width: 22 },
];

// ============= HELPER FUNCTIONS =============
const parseVehicleNumbers = (raw) => {
    if (!raw) return [];
    const trimmed = String(raw).trim();
    if (trimmed.startsWith("[")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed.map((v) => {
                    if (typeof v === "string") return v;
                    if (typeof v === "object" && v.number) {
                        const statusLabel = v.status || "approved";
                        return `${v.number} (${statusLabel})`;
                    }
                    return String(v);
                });
            }
        } catch {
            // fall through to comma-split below
        }
    }
    return trimmed
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
};

const buildWhereClause = (query) => {
    const { status, search, startDate, endDate } = query;
    const where = { role: "user" };

    // Status filter
    if (status && status !== "all") {
        where.status = status;
    }

    // Date filter
    if (startDate && endDate) {
        where.created_at = {
            gte: new Date(startDate),
            lte: new Date(endDate),
        };
    }

    // Search filter
    if (search) {
        const term = String(search).toLowerCase();
        where.OR = [
            { full_name: { contains: term } },
            { username: { contains: term } },
            { email: { contains: term } },
            { phone_number: { contains: term } },
        ];
    }

    return where;
};

// Same shape as buildWhereClause, but for OrgUser (agencies) — no `role`
// field on this table, so that filter is simply omitted.
const buildAgencyWhereClause = (query) => {
    const { status, search, startDate, endDate } = query;
    const where = {};

    if (status && status !== "all") {
        where.status = status;
    }

    if (startDate && endDate) {
        where.created_at = {
            gte: new Date(startDate),
            lte: new Date(endDate),
        };
    }

    if (search) {
        const term = String(search).toLowerCase();
        where.OR = [
            { org_name: { contains: term } },
            { username: { contains: term } },
            { email: { contains: term } },
            { phone_number: { contains: term } },
        ];
    }

    return where;
};

const formatUsersForExcel = (users) => {
    return users.map((u) => {
        const vehicles = parseVehicleNumbers(u.vehicle_numbers);

        return {
            id: u.user_id,
            name: u.full_name || "",
            username: u.username || "",
            email: u.email || "",
            phoneNumber: u.phone_number || "",
            status: u.status || "unknown",
            walletBalance: u.wallet_balance ? parseFloat(u.wallet_balance) : 0,
            drivingLicence: u.driving_licence || "",
            address: u.user_address || "",
            landmark: u.landmark || "",
            vehicles: vehicles.length > 0 ? vehicles.join(", ") : "None",
            createdAt: u.created_at
                ? u.created_at.toISOString().split("T")[0]
                : "",
        };
    });
};

// Maps raw OrgUser rows + a bookingCountMap (org_id -> count, fetched
// separately since Prisma can't aggregate across a relation in one findMany)
// into export-ready rows matching agencyHeaders.
const formatAgenciesForExcel = (agencies, bookingCountMap) => {
    return agencies.map((a) => ({
        id: a.org_id,
        orgName: a.org_name || "",
        username: a.username || "",
        email: a.email || "",
        phoneNumber: a.phone_number || "",
        status: a.status || "unknown",
        commissionPercentage: a.commission_percentage
            ? parseFloat(a.commission_percentage)
            : 0,
        walletBalance: a.wallet_balance ? parseFloat(a.wallet_balance) : 0,
        totalBookings: bookingCountMap.get(a.org_id) || 0,
        evCharging: a.ev_charging_support ? "Yes" : "No",
        address: a.org_address || "",
        createdAt: a.created_at ? a.created_at.toISOString().split("T")[0] : "",
    }));
};

// Combines agency_transactions (booking revenue settlements) and
// wallet_transactions (type: withdrawal, agency_id set) into one
// chronological ledger per agency — an agency's wallet balance is fed by
// both flows, unlike a customer's single-table wallet history.
const fetchWalletRecordsForAgencies = async (agencyIds, agencyNameMap) => {
    if (!agencyIds.length) return [];

    const [settlements, withdrawals] = await Promise.all([
        prisma.agencyTransaction.findMany({
            where: { agency_id: { in: agencyIds } },
            orderBy: { created_at: "desc" },
            include: { booking: { select: { booking_id: true } } },
        }),
        prisma.walletTransaction.findMany({
            where: { agency_id: { in: agencyIds }, type: "withdrawal" },
            orderBy: { created_at: "desc" },
        }),
    ]);

    const settlementRows = settlements.map((s) => ({
        agencyName: agencyNameMap.get(s.agency_id) || `Agency #${s.agency_id}`,
        type: "Revenue Settlement",
        reference: s.booking?.booking_id
            ? `Booking #${s.booking.booking_id}`
            : `TXN-${s.transaction_id}`,
        amount: s.agency_share
            ? parseFloat(s.agency_share)
            : s.approved_amount
              ? parseFloat(s.approved_amount)
              : s.total_amount
                ? parseFloat(s.total_amount)
                : 0,
        status: s.status || "unknown",
        date: s.approved_at || s.created_at,
    }));

    const withdrawalRows = withdrawals.map((w) => ({
        agencyName: agencyNameMap.get(w.agency_id) || `Agency #${w.agency_id}`,
        type: "Withdrawal",
        reference: `TXN-${w.transaction_id}`,
        amount: w.amount ? parseFloat(w.amount) : 0,
        status: w.status || "unknown",
        date: w.updated_at || w.created_at,
    }));

    return [...settlementRows, ...withdrawalRows].sort(
        (a, b) => new Date(b.date) - new Date(a.date)
    );
};

const styleWorkbook = (worksheet, title) => {
    const colCount = worksheet.columns.length;

    // Title row
    worksheet.insertRow(1, [title]);
    worksheet.mergeCells(1, 1, 1, colCount);
    const titleCell = worksheet.getCell("A1");
    titleCell.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
    titleCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF0A1025" },
    };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    worksheet.getRow(1).height = 30;

    // Header row (row 2)
    const headerRow = worksheet.getRow(2);
    headerRow.eachCell((cell) => {
        cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFD3D3D3" },
        };
        cell.font = { color: { argb: "FF000000" }, bold: true };
        cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    // Column headers that should be left-aligned in their data rows (long
    // free-text fields read better left-aligned than centered). Extended to
    // cover the agency and wallet-records sheets too, alongside the original
    // customer columns.
    const leftAlignHeaders = [
        "Full Name",
        "Address",
        "Registered Vehicles",
        "Landmark",
        "Agency Name",
        "Owner Username",
        "Reference",
    ];

    // Align data rows
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return; // Skip title row

        row.eachCell((cell, colNumber) => {
            const header = worksheet.getRow(2).getCell(colNumber).value;
            if (leftAlignHeaders.includes(header)) {
                cell.alignment = { horizontal: "left", vertical: "middle" };
            } else {
                cell.alignment = { horizontal: "center", vertical: "middle" };
            }
        });
    });

    // Format currency/date columns wherever present on this sheet.
    // IMPORTANT: worksheet.getColumn(key) only does a proper key lookup if
    // that key was actually defined on this sheet's columns. If it wasn't,
    // ExcelJS falls back to treating the string as a spreadsheet column
    // *letter* address (e.g. "amount" parsed like "AMOUNT") — which is a
    // column index far past Excel's 16384 limit, and throws. So each call
    // below is guarded on the key actually existing on this worksheet first.
    const definedKeys = new Set(worksheet.columns.map((c) => c.key));

    if (definedKeys.has("walletBalance")) {
        worksheet.getColumn("walletBalance").numFmt = '"₹"#,##0.00';
    }
    if (definedKeys.has("createdAt")) {
        worksheet.getColumn("createdAt").numFmt = "yyyy-mm-dd";
    }
    if (definedKeys.has("commissionPercentage")) {
        worksheet.getColumn("commissionPercentage").numFmt = '0.00"%"';
    }
    if (definedKeys.has("amount")) {
        worksheet.getColumn("amount").numFmt = '"₹"#,##0.00';
    }
    if (definedKeys.has("date")) {
        worksheet.getColumn("date").numFmt = "yyyy-mm-dd hh:mm";
    }
};

const generateUserExcel = async (req, res) => {
    try {
        const whereClause = buildWhereClause(req.query);

        const users = await prisma.user.findMany({
            where: whereClause,
            orderBy: { created_at: "desc" },
        });

        const formattedUsers = formatUsersForExcel(users);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Customers");

        // Set columns
        worksheet.columns = customerHeaders.map((col) => ({
            header: col.header,
            key: col.key,
            width: col.width,
        }));

        // Style and add data
        styleWorkbook(worksheet, "CUSTOMERS / DRIVERS DIRECTORY");
        formattedUsers.forEach((row) => worksheet.addRow(row));

        const buffer = await workbook.xlsx.writeBuffer();

        const filename = `customers_${new Date().toISOString().split("T")[0]}.xlsx`;
        res.set({
            "Content-Length": buffer.length,
            "Content-Disposition": `attachment; filename=${filename}`,
            "Content-Type":
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });

        res.send(buffer);
    } catch (error) {
        console.error("Error generating user Excel:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const generateUserExcelWithSummary = async (req, res) => {
    try {
        const whereClause = buildWhereClause(req.query);

        const users = await prisma.user.findMany({
            where: whereClause,
            orderBy: { created_at: "desc" },
        });

        // Calculate summary stats
        const totalUsers = users.length;
        const totalWalletBalance = users.reduce(
            (sum, u) =>
                sum + (u.wallet_balance ? parseFloat(u.wallet_balance) : 0),
            0
        );

        const statusCounts = {};
        users.forEach((u) => {
            statusCounts[u.status] = (statusCounts[u.status] || 0) + 1;
        });

        const formattedUsers = formatUsersForExcel(users);

        const workbook = new ExcelJS.Workbook();

        // ===== SUMMARY SHEET =====
        const summarySheet = workbook.addWorksheet("Summary");
        summarySheet.columns = [
            { header: "Metric", key: "metric", width: 35 },
            { header: "Value", key: "value", width: 30 },
        ];

        const summaryData = [
            { metric: "Total Customers", value: totalUsers },
            {
                metric: "Total Wallet Balance",
                value: `₹${totalWalletBalance.toFixed(2)}`,
            },
            {
                metric: "Average Wallet Balance",
                value:
                    totalUsers > 0
                        ? `₹${(totalWalletBalance / totalUsers).toFixed(2)}`
                        : "₹0.00",
            },
            ...Object.entries(statusCounts).map(([status, count]) => ({
                metric: `Status: ${status.charAt(0).toUpperCase() + status.slice(1)}`,
                value: count,
            })),
            { metric: "Export Date", value: new Date().toLocaleString() },
            {
                metric: "Filters Applied",
                value: req.query.status
                    ? `Status: ${req.query.status}`
                    : "None",
            },
        ];

        summaryData.forEach((row) => summarySheet.addRow(row));

        // Style summary sheet
        summarySheet.getRow(1).eachCell((cell) => {
            cell.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: "FF0A1025" },
            };
            cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
            cell.alignment = { horizontal: "center", vertical: "middle" };
        });

        summarySheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return;
            row.eachCell((cell) => {
                cell.alignment = { horizontal: "left", vertical: "middle" };
            });
        });

        // ===== CUSTOMERS SHEET =====
        const customerSheet = workbook.addWorksheet("Customers");
        customerSheet.columns = customerHeaders.map((col) => ({
            header: col.header,
            key: col.key,
            width: col.width,
        }));

        styleWorkbook(customerSheet, "CUSTOMERS / DRIVERS DIRECTORY");
        formattedUsers.forEach((row) => customerSheet.addRow(row));

        const buffer = await workbook.xlsx.writeBuffer();

        const filename = `customers_${new Date().toISOString().split("T")[0]}.xlsx`;
        res.set({
            "Content-Length": buffer.length,
            "Content-Disposition": `attachment; filename=${filename}`,
            "Content-Type":
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });

        res.send(buffer);
    } catch (error) {
        console.error("Error generating user Excel with summary:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const exportAllCustomers = async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            where: { role: "user" },
            orderBy: { created_at: "desc" },
        });

        const formattedUsers = formatUsersForExcel(users);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("All Customers");

        worksheet.columns = customerHeaders.map((col) => ({
            header: col.header,
            key: col.key,
            width: col.width,
        }));

        styleWorkbook(worksheet, "ALL CUSTOMERS / DRIVERS DIRECTORY");
        formattedUsers.forEach((row) => worksheet.addRow(row));

        const buffer = await workbook.xlsx.writeBuffer();

        const filename = `all_customers_${new Date().toISOString().split("T")[0]}.xlsx`;
        res.set({
            "Content-Length": buffer.length,
            "Content-Disposition": `attachment; filename=${filename}`,
            "Content-Type":
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });

        res.send(buffer);
    } catch (error) {
        console.error("Error exporting all customers:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const exportCustomersByStatus = async (req, res) => {
    try {
        const { status } = req.params;

        if (
            !status ||
            !["active", "suspended", "blocked", "pending"].includes(status)
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Invalid status. Allowed: active, suspended, blocked, pending",
            });
        }

        const users = await prisma.user.findMany({
            where: {
                role: "user",
                status: status,
            },
            orderBy: { created_at: "desc" },
        });

        const formattedUsers = formatUsersForExcel(users);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet(`Customers_${status}`);

        worksheet.columns = customerHeaders.map((col) => ({
            header: col.header,
            key: col.key,
            width: col.width,
        }));

        styleWorkbook(worksheet, `${status.toUpperCase()} CUSTOMERS`);
        formattedUsers.forEach((row) => worksheet.addRow(row));

        const buffer = await workbook.xlsx.writeBuffer();

        const filename = `customers_${status}_${new Date().toISOString().split("T")[0]}.xlsx`;
        res.set({
            "Content-Length": buffer.length,
            "Content-Disposition": `attachment; filename=${filename}`,
            "Content-Type":
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });

        res.send(buffer);
    } catch (error) {
        console.error("Error exporting customers by status:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const exportCustomersWithVehicleDetails = async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            where: {
                role: "user",
                vehicle_numbers: { not: null },
            },
            orderBy: { created_at: "desc" },
        });

        // Detailed headers with vehicle info
        const detailedHeaders = [
            { header: "Customer ID", key: "id", width: 15 },
            { header: "Full Name", key: "name", width: 25 },
            { header: "Email", key: "email", width: 30 },
            { header: "Phone Number", key: "phoneNumber", width: 18 },
            { header: "Status", key: "status", width: 15 },
            { header: "Wallet Balance", key: "walletBalance", width: 18 },
            { header: "Vehicle Number", key: "vehicleNumber", width: 20 },
            { header: "Vehicle Status", key: "vehicleStatus", width: 15 },
            { header: "Vehicle Documents", key: "documents", width: 30 },
            { header: "Approved Date", key: "approvedAt", width: 20 },
            { header: "Registered On", key: "createdAt", width: 22 },
        ];

        const formattedData = [];
        users.forEach((u) => {
            let vehicles = [];
            if (u.vehicle_numbers) {
                try {
                    if (u.vehicle_numbers.startsWith("[")) {
                        vehicles = JSON.parse(u.vehicle_numbers);
                    } else {
                        vehicles = u.vehicle_numbers.split(",").map((v) => ({
                            number: v.trim(),
                            status: "approved",
                        }));
                    }
                } catch {
                    vehicles = [];
                }
            }

            if (Array.isArray(vehicles)) {
                vehicles.forEach((v) => {
                    const vehicleNumber =
                        typeof v === "string" ? v : v.number || "N/A";
                    const vehicleStatus =
                        typeof v === "object"
                            ? v.status || "approved"
                            : "approved";
                    const documents =
                        typeof v === "object" && Array.isArray(v.documents)
                            ? v.documents
                                  .map((d) => d.name || "Document")
                                  .join(", ")
                            : "None";
                    const approvedAt =
                        typeof v === "object" && v.approved_at
                            ? v.approved_at.split("T")[0]
                            : "";

                    formattedData.push({
                        id: u.user_id,
                        name: u.full_name || "",
                        email: u.email || "",
                        phoneNumber: u.phone_number || "",
                        status: u.status || "unknown",
                        walletBalance: u.wallet_balance
                            ? parseFloat(u.wallet_balance)
                            : 0,
                        vehicleNumber: vehicleNumber,
                        vehicleStatus: vehicleStatus,
                        documents: documents,
                        approvedAt: approvedAt,
                        createdAt: u.created_at
                            ? u.created_at.toISOString().split("T")[0]
                            : "",
                    });
                });
            }
        });

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Vehicle Details");

        worksheet.columns = detailedHeaders.map((col) => ({
            header: col.header,
            key: col.key,
            width: col.width,
        }));

        styleWorkbook(worksheet, "CUSTOMER VEHICLE DETAILS");
        formattedData.forEach((row) => worksheet.addRow(row));

        const buffer = await workbook.xlsx.writeBuffer();

        const filename = `customer_vehicles_${new Date().toISOString().split("T")[0]}.xlsx`;
        res.set({
            "Content-Length": buffer.length,
            "Content-Disposition": `attachment; filename=${filename}`,
            "Content-Type":
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });

        res.send(buffer);
    } catch (error) {
        console.error("Error exporting customer vehicle details:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ============= PARKING OWNER (AGENCY) EXPORTS =============

/**
 * GET /api/v1/excel/agencies
 * Same filter contract as generateUserExcel: ?status, ?search, ?startDate,
 * ?endDate. Single "Parking Owners" sheet — profile, status, commission
 * rate, wallet balance snapshot, booking count.
 */
const generateAgencyExcel = async (req, res) => {
    try {
        const whereClause = buildAgencyWhereClause(req.query);

        const agencies = await prisma.orgUser.findMany({
            where: whereClause,
            orderBy: { created_at: "desc" },
        });

        const agencyIds = agencies.map((a) => a.org_id);
        // Booking's FK to OrgUser is named agency_id, not org_id (org_id is only
        // OrgUser's own primary key) — confirmed against the real Booking model.
        const bookingCounts = agencyIds.length
            ? await prisma.booking.groupBy({
                  by: ["agency_id"],
                  where: { agency_id: { in: agencyIds } },
                  _count: { booking_id: true },
              })
            : [];
        const bookingCountMap = new Map(
            bookingCounts.map((b) => [b.agency_id, b._count.booking_id])
        );

        const formattedAgencies = formatAgenciesForExcel(
            agencies,
            bookingCountMap
        );

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Parking Owners");

        worksheet.columns = agencyHeaders.map((col) => ({
            header: col.header,
            key: col.key,
            width: col.width,
        }));

        styleWorkbook(worksheet, "PARKING OWNERS DIRECTORY");
        formattedAgencies.forEach((row) => worksheet.addRow(row));

        const buffer = await workbook.xlsx.writeBuffer();

        const filename = `parking_owners_${new Date().toISOString().split("T")[0]}.xlsx`;
        res.set({
            "Content-Length": buffer.length,
            "Content-Disposition": `attachment; filename=${filename}`,
            "Content-Type":
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });

        res.send(buffer);
    } catch (error) {
        console.error("Error generating agency Excel:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/v1/excel/agencies/summary
 * Adds a Summary sheet (status breakdown, combined wallet balance, total
 * revenue credited, total withdrawn) and a Wallet Records sheet combining
 * agency_transactions (revenue settlements) + wallet_transactions
 * (withdrawals) for every agency in the filtered set — mirrors
 * generateUserExcelWithSummary's structure, extended with the extra sheet
 * since an agency's wallet is fed by two tables instead of one.
 */
const generateAgencyExcelWithSummary = async (req, res) => {
    try {
        const whereClause = buildAgencyWhereClause(req.query);

        const agencies = await prisma.orgUser.findMany({
            where: whereClause,
            orderBy: { created_at: "desc" },
        });

        const agencyIds = agencies.map((a) => a.org_id);
        // Same agency_id vs org_id fix as generateAgencyExcel above.
        const bookingCounts = agencyIds.length
            ? await prisma.booking.groupBy({
                  by: ["agency_id"],
                  where: { agency_id: { in: agencyIds } },
                  _count: { booking_id: true },
              })
            : [];
        const bookingCountMap = new Map(
            bookingCounts.map((b) => [b.agency_id, b._count.booking_id])
        );

        const agencyNameMap = new Map(
            agencies.map((a) => [a.org_id, a.org_name])
        );
        const walletRecords = await fetchWalletRecordsForAgencies(
            agencyIds,
            agencyNameMap
        );

        // Calculate summary stats
        const totalAgencies = agencies.length;
        const totalWalletBalance = agencies.reduce(
            (sum, a) =>
                sum + (a.wallet_balance ? parseFloat(a.wallet_balance) : 0),
            0
        );
        const totalRevenueCredited = walletRecords
            .filter(
                (r) =>
                    r.type === "Revenue Settlement" && r.status === "approved"
            )
            .reduce((sum, r) => sum + r.amount, 0);
        const totalWithdrawn = walletRecords
            .filter((r) => r.type === "Withdrawal" && r.status === "approved")
            .reduce((sum, r) => sum + r.amount, 0);

        const statusCounts = {};
        agencies.forEach((a) => {
            statusCounts[a.status] = (statusCounts[a.status] || 0) + 1;
        });

        const formattedAgencies = formatAgenciesForExcel(
            agencies,
            bookingCountMap
        );

        const workbook = new ExcelJS.Workbook();

        // ===== SUMMARY SHEET =====
        const summarySheet = workbook.addWorksheet("Summary");
        summarySheet.columns = [
            { header: "Metric", key: "metric", width: 35 },
            { header: "Value", key: "value", width: 30 },
        ];

        const summaryData = [
            { metric: "Total Parking Owners", value: totalAgencies },
            {
                metric: "Combined Wallet Balance",
                value: `₹${totalWalletBalance.toFixed(2)}`,
            },
            {
                metric: "Total Revenue Credited",
                value: `₹${totalRevenueCredited.toFixed(2)}`,
            },
            {
                metric: "Total Withdrawn",
                value: `₹${totalWithdrawn.toFixed(2)}`,
            },
            ...Object.entries(statusCounts).map(([status, count]) => ({
                metric: `Status: ${status.charAt(0).toUpperCase() + status.slice(1)}`,
                value: count,
            })),
            { metric: "Export Date", value: new Date().toLocaleString() },
            {
                metric: "Filters Applied",
                value: req.query.status
                    ? `Status: ${req.query.status}`
                    : "None",
            },
        ];

        summaryData.forEach((row) => summarySheet.addRow(row));

        // Style summary sheet — identical treatment to generateUserExcelWithSummary
        summarySheet.getRow(1).eachCell((cell) => {
            cell.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: "FF0A1025" },
            };
            cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
            cell.alignment = { horizontal: "center", vertical: "middle" };
        });

        summarySheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return;
            row.eachCell((cell) => {
                cell.alignment = { horizontal: "left", vertical: "middle" };
            });
        });

        // ===== PARKING OWNERS SHEET =====
        const agencySheet = workbook.addWorksheet("Parking Owners");
        agencySheet.columns = agencyHeaders.map((col) => ({
            header: col.header,
            key: col.key,
            width: col.width,
        }));

        styleWorkbook(agencySheet, "PARKING OWNERS DIRECTORY");
        formattedAgencies.forEach((row) => agencySheet.addRow(row));

        // ===== WALLET RECORDS SHEET =====
        const walletSheet = workbook.addWorksheet("Wallet Records");
        walletSheet.columns = walletRecordHeaders.map((col) => ({
            header: col.header,
            key: col.key,
            width: col.width,
        }));

        styleWorkbook(walletSheet, "PARKING OWNER WALLET RECORDS");
        walletRecords.forEach((row) => walletSheet.addRow(row));

        // Color-code credits vs debits for quick scanning
        walletSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber <= 2) return; // skip title + header rows
            const typeCell = row.getCell(2); // "Record Type" column
            const amountCell = row.getCell(4); // "Amount" column
            if (typeCell.value === "Withdrawal") {
                amountCell.font = { color: { argb: "FFE11D48" } };
            } else if (typeCell.value === "Revenue Settlement") {
                amountCell.font = { color: { argb: "FF059669" } };
            }
        });

        const buffer = await workbook.xlsx.writeBuffer();

        const filename = `parking_owners_summary_${new Date().toISOString().split("T")[0]}.xlsx`;
        res.set({
            "Content-Length": buffer.length,
            "Content-Disposition": `attachment; filename=${filename}`,
            "Content-Type":
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });

        res.send(buffer);
    } catch (error) {
        console.error("Error generating agency Excel with summary:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    generateUserExcel,
    generateUserExcelWithSummary,
    exportAllCustomers,
    exportCustomersByStatus,
    exportCustomersWithVehicleDetails,
    generateAgencyExcel,
    generateAgencyExcelWithSummary,
};
