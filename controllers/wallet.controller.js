const { prisma } = require("../utils/db");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const { saveBase64File } = require("../utils/helperFunctions");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const { notifyUser, notifyUserWithFCM } = require("../utils/notifications");
const {
    approveAgencySettlement,
    rejectAgencySettlement,
} = require("../utils/commission");

/**
 * Add money request (creates pending deposit transaction with screenshot and transaction number)
 */
const addMoneyRequest = async (req, res) => {
    try {
        const { amount, transaction_number, screenshot } = req.body;
        const userId = req.user.id;

        if (!amount || parseFloat(amount) <= 0) {
            throw new ApiError(400, "Invalid amount");
        }

        if (!transaction_number || transaction_number.trim() === "") {
            throw new ApiError(
                400,
                "Transaction number / Reference ID is required"
            );
        }

        if (!screenshot || screenshot.trim() === "") {
            throw new ApiError(400, "Payment screenshot upload is required");
        }

        /* Save Base64 Files (Commented Out)
        let screenshotPath = null;
        if (screenshot) {
            screenshotPath = saveBase64File(
                screenshot,
                "screenshots",
                "screenshot"
            );
        }
        */

        // Save Files from FormData (Multer) or Base64 Fallback
        let screenshotPath = req.file?.path
            ? req.file.path.replace(/\\/g, "/").replace(/^uploads\//, "")
            : screenshot
              ? saveBase64File(screenshot, "screenshots", "screenshot")
              : null;

        const requesterUser = await prisma.user.findUnique({
            where: { user_id: userId },
            select: { full_name: true, username: true, wallet_balance: true },
        });

        const currentBal = requesterUser
            ? parseFloat(requesterUser.wallet_balance || 0)
            : 0;
        const parsedAmt = parseFloat(amount);
        const expectedBal = parseFloat((currentBal + parsedAmt).toFixed(2));

        const transaction = await prisma.walletTransaction.create({
            data: {
                user_id: userId,
                amount: parsedAmt,
                previous_balance: currentBal,
                new_balance: expectedBal,
                type: "deposit",
                status: "pending",
                transaction_number: transaction_number,
                screenshot_path: screenshotPath,
            },
        });

        // notify all super_admins that a new wallet request is pending
        try {
            const requester = requesterUser;

            const admins = await prisma.user.findMany({
                where: { role: "super_admin" },
                select: { user_id: true },
            });

            const notification = {
                type: "wallet_request_created",
                title: "New Wallet Top-up Request",
                message: `${requester?.full_name || "A user"} requested ₹${parseFloat(amount).toFixed(2)} to be added to wallet.`,
                data: {
                    transactionId: transaction.transaction_id,
                    userId,
                    amount: parseFloat(amount),
                },
            };

            // admins.forEach((admin) => {
            //     // sendNotificationToUser(admin.user_id, notification);
            //     await notifyUser(admin.user_id, notification);
            // });

            for (const admin of admins) {
                await notifyUser(admin.user_id, notification);
            }
        } catch (notifyErr) {
            // Never let a notification failure break the actual request
            console.error(
                "Error sending wallet request notification:",
                notifyErr
            );
        }

        // Map database snake_case fields to React Native frontend expectations
        const cleanTx = {
            id: transaction.transaction_id.toString(),
            type: "credit",
            amount: parseFloat(transaction.amount),
            description: "Added to Wallet",
            status: transaction.status,
            date: transaction.created_at,
        };

        return res
            .status(201)
            .json(
                new ApiResponse(
                    201,
                    cleanTx,
                    "Wallet deposit request submitted successfully. Pending admin approval."
                )
            );
    } catch (error) {
        console.error("Error in addMoneyRequest:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Get transaction history for current user
 */
const getWalletHistory = async (req, res) => {
    try {
        const userId = req.user.id;
        const role = req.user.role;

        if (role === "agency_admin") {
            const agencyTransactions = await prisma.agencyTransaction.findMany({
                where: { agency_id: userId },
                orderBy: { created_at: "desc" },
            });

            const mappedTransactions = await Promise.all(
                agencyTransactions.map(async (t) => {
                    const booking = await prisma.booking.findUnique({
                        where: { booking_id: t.booking_id },
                        select: { booking_code: true },
                    });
                    const code = booking?.booking_code || "Unknown";
                    return {
                        id: `agency_tx_${t.transaction_id}`,
                        type: "credit",
                        amount:
                            t.status === "approved"
                                ? parseFloat(t.agency_share)
                                : parseFloat(
                                      (
                                          (t.total_amount *
                                              (100 -
                                                  parseFloat(
                                                      t.commission_rate
                                                  ))) /
                                          100
                                      ).toFixed(2)
                                  ),
                        description: `Parking Revenue (${code}) - ${parseFloat(t.commission_rate)}% Admin Split`,
                        status: t.status || "approved",
                        date: t.created_at,
                    };
                })
            );

            return res
                .status(200)
                .json(
                    new ApiResponse(
                        200,
                        mappedTransactions,
                        "Agency transaction history fetched successfully"
                    )
                );
        }

        const transactions = await prisma.walletTransaction.findMany({
            where: { user_id: userId },
            orderBy: { created_at: "desc" },
        });

        const mappedTransactions = transactions.map((t) => {
            let description = "Wallet Payment";
            if (t.type === "deposit") {
                description = "Added to Wallet";
            } else if (t.transaction_number) {
                if (t.transaction_number.startsWith("CANCEL-")) {
                    const code = t.transaction_number.replace("CANCEL-", "");
                    description = `Cancellation Fee (${code})`;
                } else if (t.transaction_number.startsWith("PARKING-")) {
                    const code = t.transaction_number.replace("PARKING-", "");
                    description = `Parking Fee (${code})`;
                } else if (t.transaction_number.startsWith("COMMISSION-")) {
                    const code = t.transaction_number.replace(
                        "COMMISSION-",
                        ""
                    );
                    description = `Commission Split (${code})`;
                } else {
                    description = t.transaction_number;
                }
            }
            return {
                id: t.transaction_id.toString(),
                type: t.type === "deposit" ? "credit" : "debit",
                amount: parseFloat(t.amount),
                previousBalance:
                    t.previous_balance !== null &&
                    t.previous_balance !== undefined
                        ? parseFloat(t.previous_balance)
                        : null,
                newBalance:
                    t.new_balance !== null && t.new_balance !== undefined
                        ? parseFloat(t.new_balance)
                        : null,
                description,
                status: t.status,
                date: t.created_at,
                transactionNumber: t.transaction_number || null,
                rejectionReason: t.rejection_reason || null,
            };
        });

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    mappedTransactions,
                    "Wallet history fetched successfully"
                )
            );
    } catch (error) {
        console.error("Error in getWalletHistory:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Get wallet balance for current user
 */
const getWalletBalance = async (req, res) => {
    try {
        const userId = req.user.id;
        const role = req.user.role;

        if (role === "agency_admin") {
            const org = await prisma.orgUser.findUnique({
                where: { org_id: userId },
                select: { wallet_balance: true },
            });

            if (!org) {
                throw new ApiError(404, "Agency not found");
            }

            return res.status(200).json(
                new ApiResponse(
                    200,
                    {
                        walletBalance: Math.max(
                            0,
                            parseFloat(org.wallet_balance || 0)
                        ),
                        reservedBalance: 0.0,
                    },
                    "Agency balance fetched successfully"
                )
            );
        }

        const user = await prisma.user.findUnique({
            where: { user_id: userId },
            select: { wallet_balance: true },
        });

        if (!user) {
            throw new ApiError(404, "User not found");
        }

        // Calculate reserved balance from active bookings (status: booked, checked_in, pending_approval)
        const activeBookings = await prisma.booking.findMany({
            where: {
                user_id: userId,
                status: { in: ["booked", "checked_in", "pending_approval"] },
            },
            select: {
                booked_duration: true,
                hourly_rate: true,
            },
        });

        const reservedBalance = activeBookings.reduce((sum, b) => {
            return (
                sum +
                parseFloat(b.booked_duration || 0) *
                    parseFloat(b.hourly_rate || 0)
            );
        }, 0);

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    walletBalance: parseFloat(user.wallet_balance || 0),
                    reservedBalance: parseFloat(reservedBalance.toFixed(2)),
                },
                "Wallet balance fetched successfully"
            )
        );
    } catch (error) {
        console.error("Error in getWalletBalance:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Get generated QR payload from backend
 */
const getWalletQr = async (req, res) => {
    try {
        const { amount } = req.query;
        if (!amount || parseFloat(amount) <= 0) {
            throw new ApiError(400, "Invalid amount parameter");
        }

        // Fetch upi_id from configurations
        const upiConfig = await prisma.configuration.findUnique({
            where: { config_key: "upi_id" },
        });

        const upiId = upiConfig?.config_value;
        if (!upiId) {
            throw new ApiError(404, "UPI ID not found in configurations");
        }
        const upiUri = `upi://pay?pa=${upiId}&pn=Parking%20Locator&am=${parseFloat(amount).toFixed(2)}&cu=INR&tn=Wallet%20Recharge`;

        const qrCodeUrl = await QRCode.toDataURL(upiUri, { margin: 1 });

        // Save high-resolution QR code image to disk for user download
        const qrDirectory = path.join(__dirname, "..", "uploads", "qrcodes");
        if (!fs.existsSync(qrDirectory)) {
            fs.mkdirSync(qrDirectory, { recursive: true });
        }

        const userId = req.user.id;
        const filename = `qr-${userId}-${parseFloat(amount)}.png`;
        const absolutePath = path.join(qrDirectory, filename);

        await QRCode.toFile(absolutePath, upiUri, { margin: 1, scale: 10 });

        const protocol = req.protocol;
        const host = req.get("host");
        const qrDownloadUrl = `${protocol}://${host}/images/qrcodes/${filename}`;

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    upiId,
                    upiUri,
                    qrCodeUrl,
                    qrDownloadUrl,
                    amount: parseFloat(amount),
                },
                "QR code generated successfully"
            )
        );
    } catch (error) {
        console.error("Error in getWalletQr:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: List all pending wallet requests
 */
const getPendingWalletRequests = async (req, res) => {
    try {
        const requests = await prisma.walletTransaction.findMany({
            where: { status: "pending" },
            orderBy: { created_at: "desc" },
        });

        const requestsWithUsers = await Promise.all(
            requests.map(async (reqItem) => {
                const user = await prisma.user.findUnique({
                    where: { user_id: reqItem.user_id },
                    select: { full_name: true, username: true, email: true },
                });
                return {
                    id: reqItem.transaction_id,
                    userId: reqItem.user_id,
                    userName: user?.full_name || "Unknown",
                    username: user?.username || "Unknown",
                    email: user?.email || "Unknown",
                    amount: parseFloat(reqItem.amount),
                    type: reqItem.type,
                    status: reqItem.status,
                    transactionNumber: reqItem.transaction_number || "",
                    screenshotPath: reqItem.screenshot_path || null,
                    rejectionReason: reqItem.rejection_reason || null, // ✅ Add this
                    createdAt: reqItem.created_at,
                };
            })
        );

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    requestsWithUsers,
                    "Pending wallet requests fetched successfully"
                )
            );
    } catch (error) {
        console.error("Error in getPendingWalletRequests:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Get wallet transaction log
 */
const getWalletTransactionsLog = async (req, res) => {
    try {
        const requests = await prisma.walletTransaction.findMany({
            where: { status: { in: ["approved", "rejected"] } },
            orderBy: { updated_at: "desc" },
        });

        const requestsWithUsers = await Promise.all(
            requests.map(async (reqItem) => {
                const user = await prisma.user.findUnique({
                    where: { user_id: reqItem.user_id },
                    select: { full_name: true, username: true, email: true },
                });
                return {
                    id: reqItem.transaction_id,
                    userId: reqItem.user_id,
                    userName: user?.full_name || "Unknown",
                    username: user?.username || "Unknown",
                    email: user?.email || "Unknown",
                    amount: parseFloat(reqItem.amount),
                    previousBalance:
                        reqItem.previous_balance !== null &&
                        reqItem.previous_balance !== undefined
                            ? parseFloat(reqItem.previous_balance)
                            : null,
                    newBalance:
                        reqItem.new_balance !== null &&
                        reqItem.new_balance !== undefined
                            ? parseFloat(reqItem.new_balance)
                            : null,
                    type: reqItem.type,
                    status: reqItem.status,
                    transactionNumber: reqItem.transaction_number || "",
                    screenshotPath: reqItem.screenshot_path || null,
                    rejectionReason: reqItem.rejection_reason || null,
                    createdAt: reqItem.created_at,
                    decidedAt: reqItem.updated_at,
                };
            })
        );

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    requestsWithUsers,
                    "Wallet transaction log fetched successfully"
                )
            );
    } catch (error) {
        console.error("Error in getWalletTransactionsLog:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Approve wallet request
 */
const approveWalletRequest = async (req, res) => {
    try {
        const { transactionId } = req.params;
        const parsedTxId = parseInt(transactionId);
        if (isNaN(parsedTxId)) {
            throw new ApiError(400, "Invalid transaction ID");
        }

        const transaction = await prisma.walletTransaction.findUnique({
            where: { transaction_id: parsedTxId },
        });

        if (!transaction) {
            throw new ApiError(404, "Transaction request not found");
        }

        if (transaction.status !== "pending") {
            throw new ApiError(
                400,
                `Request has already been ${transaction.status}`
            );
        }

        let updatedUserBalance = null;
        await prisma.$transaction(async (tx) => {
            if (transaction.type === "deposit") {
                const user = await tx.user.findUnique({
                    where: { user_id: transaction.user_id },
                });

                if (!user) {
                    throw new ApiError(
                        404,
                        "User associated with transaction not found"
                    );
                }

                const currentBalance = parseFloat(user.wallet_balance || 0);
                const newBalance = parseFloat(
                    (currentBalance + parseFloat(transaction.amount)).toFixed(2)
                );
                updatedUserBalance = newBalance;

                await tx.walletTransaction.update({
                    where: { transaction_id: parsedTxId },
                    data: {
                        status: "approved",
                        previous_balance: currentBalance,
                        new_balance: newBalance,
                    },
                });

                await tx.user.update({
                    where: { user_id: transaction.user_id },
                    data: { wallet_balance: newBalance },
                });
            } else {
                await tx.walletTransaction.update({
                    where: { transaction_id: parsedTxId },
                    data: { status: "approved" },
                });
            }
        });

        // 1. Notify the user via Firebase Cloud Messaging push notification (and socket/DB)
        try {
            const formattedAmount = parseFloat(transaction.amount).toFixed(2);
            const balanceText =
                updatedUserBalance !== null
                    ? ` Your updated wallet balance is ₹${updatedUserBalance.toFixed(2)}.`
                    : "";
            const userNotification = {
                type: "wallet_request_approved",
                title: "Wallet Balance Added",
                message: `Your wallet top-up request of ₹${formattedAmount} has been approved.${balanceText}`,
                data: {
                    type: "wallet_request_approved",
                    transactionId: transaction.transaction_id.toString(),
                    amount: formattedAmount,
                    newBalance:
                        updatedUserBalance !== null
                            ? updatedUserBalance.toFixed(2)
                            : "",
                    status: "approved",
                },
            };

            await notifyUserWithFCM(transaction.user_id, userNotification);
        } catch (userNotifyErr) {
            console.error(
                "Error sending wallet approval notification to user:",
                userNotifyErr
            );
        }

        // 2. Notify other super_admins that this request has been handled
        try {
            const admins = await prisma.user.findMany({
                where: { role: "super_admin" },
                select: { user_id: true },
            });

            const notification = {
                type: "wallet_request_approved",
                title: "Wallet Request Approved",
                message: `Transaction #${transaction.transaction_id} (₹${parseFloat(transaction.amount).toFixed(2)}) was approved by ${req.user.username || req.user.id}.`,
                data: {
                    transactionId: transaction.transaction_id,
                    userId: transaction.user_id,
                    amount: parseFloat(transaction.amount),
                    decidedBy: req.user.id,
                },
            };

            // admins
            //     // .filter((admin) => admin.user_id !== req.user.id)
            //     .forEach((admin) => {
            //         // sendNotificationToUser(admin.user_id, notification);
            //         await notifyUser(admin.user_id, notification);
            //     });

            for (const admin of admins) {
                await notifyUser(admin.user_id, notification);
            }
        } catch (notifyErr) {
            console.error(
                "Error sending wallet-approved notification:",
                notifyErr
            );
        }

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    null,
                    "Wallet request approved and balance updated."
                )
            );
    } catch (error) {
        console.error("Error in approveWalletRequest:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Reject wallet request
 */
const rejectWalletRequest = async (req, res) => {
    try {
        const { transactionId } = req.params;
        const { rejection_reason } = req.body;

        const parsedTxId = parseInt(transactionId);
        if (isNaN(parsedTxId)) {
            throw new ApiError(400, "Invalid transaction ID");
        }

        const transaction = await prisma.walletTransaction.findUnique({
            where: { transaction_id: parsedTxId },
        });

        if (!transaction) {
            throw new ApiError(404, "Transaction request not found");
        }

        if (transaction.status !== "pending") {
            throw new ApiError(
                400,
                `Request has already been ${transaction.status}`
            );
        }

        // Validate rejection reason
        const reason = (rejection_reason || "").trim();
        if (!reason) {
            throw new ApiError(400, "A rejection reason is mandatory.");
        }

        await prisma.walletTransaction.update({
            where: { transaction_id: parsedTxId },
            data: {
                status: "rejected",
                rejection_reason: reason,
            },
        });

        // 1. Notify the user via Firebase Cloud Messaging push notification
        try {
            const formattedAmount = parseFloat(transaction.amount).toFixed(2);
            const userNotification = {
                type: "wallet_request_rejected",
                title: "Wallet Top-up Rejected",
                message: `Your wallet top-up request for ₹${formattedAmount} was rejected. Reason: ${reason}`,
                data: {
                    type: "wallet_request_rejected",
                    transactionId: transaction.transaction_id.toString(),
                    amount: formattedAmount,
                    status: "rejected",
                    reason: reason,
                },
            };

            await notifyUserWithFCM(transaction.user_id, userNotification);
        } catch (userNotifyErr) {
            console.error(
                "Error sending wallet rejection notification to user:",
                userNotifyErr
            );
        }

        // 2. Notify other super_admins
        try {
            const admins = await prisma.user.findMany({
                where: { role: "super_admin" },
                select: { user_id: true },
            });

            const notification = {
                type: "wallet_request_rejected",
                title: "Wallet Request Rejected",
                message: `Transaction #${transaction.transaction_id} (₹${parseFloat(transaction.amount).toFixed(2)}) was rejected by ${req.user.username || req.user.id}. Reason: ${reason}`,
                data: {
                    transactionId: transaction.transaction_id,
                    userId: transaction.user_id,
                    amount: parseFloat(transaction.amount),
                    decidedBy: req.user.id,
                    reason: reason,
                },
            };

            for (const admin of admins) {
                await notifyUser(admin.user_id, notification);
            }
        } catch (notifyErr) {
            console.error(
                "Error sending wallet-rejected notification:",
                notifyErr
            );
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    transactionId: transaction.transaction_id,
                    status: "rejected",
                    rejection_reason: reason,
                },
                "Wallet request rejected successfully."
            )
        );
    } catch (error) {
        console.error("Error in rejectWalletRequest:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Get wallet UPI configuration
 */
const getWalletConfig = async (req, res) => {
    try {
        const config = await prisma.configuration.findUnique({
            where: { config_key: "upi_id" },
        });
        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    { upiId: config?.config_value || "gbt@upi" },
                    "Configuration fetched successfully"
                )
            );
    } catch (error) {
        console.error("Error in getWalletConfig:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Update wallet UPI configuration
 */
const updateWalletConfig = async (req, res) => {
    try {
        const { upiId } = req.body;
        if (!upiId || upiId.trim() === "") {
            throw new ApiError(400, "UPI ID is required");
        }

        const config = await prisma.configuration.upsert({
            where: { config_key: "upi_id" },
            update: { config_value: upiId },
            create: { config_key: "upi_id", config_value: upiId },
        });

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    { upiId: config.config_value },
                    "Configuration updated successfully"
                )
            );
    } catch (error) {
        console.error("Error in updateWalletConfig:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Agency Admin: Initiate cash withdrawal request
 */
const requestAgencyWithdrawal = async (req, res) => {
    try {
        const role = req.user.role;
        const agencyId = req.user.agencyId;

        if (role !== "agency_admin" || !agencyId) {
            throw new ApiError(
                403,
                "Access denied: Only Agency Admin can request cash withdrawal"
            );
        }

        const { amount } = req.body;
        const numericAmount = parseFloat(amount);
        if (isNaN(numericAmount) || numericAmount <= 0) {
            throw new ApiError(400, "Invalid withdrawal amount");
        }

        const parsedAgencyId = parseInt(agencyId);
        const org = await prisma.orgUser.findUnique({
            where: { org_id: parsedAgencyId },
        });

        if (!org) {
            throw new ApiError(404, "Agency not found");
        }

        const pendingAgg = await prisma.walletTransaction.aggregate({
            where: {
                agency_id: parsedAgencyId,
                type: "withdrawal",
                status: "pending",
            },
            _sum: { amount: true },
        });

        const pendingAmount = parseFloat(pendingAgg._sum.amount || 0);
        const currentBalance = parseFloat(org.wallet_balance || 0);
        const usableBalance = currentBalance - pendingAmount;

        if (numericAmount > usableBalance) {
            throw new ApiError(
                400,
                `Insufficient available balance. Total: ₹${currentBalance.toFixed(2)}${pendingAmount > 0 ? ` (with ₹${pendingAmount.toFixed(2)} pending withdrawal)` : ""}. Usable balance: ₹${usableBalance.toFixed(2)}.`
            );
        }

        const transaction = await prisma.walletTransaction.create({
            data: {
                user_id: 0,
                agency_id: parsedAgencyId,
                amount: numericAmount,
                type: "withdrawal",
                status: "pending",
                transaction_number: null,
                screenshot_path: null,
            },
        });

        return res.status(201).json(
            new ApiResponse(
                201,
                {
                    id: transaction.transaction_id.toString(),
                    agencyId: parsedAgencyId,
                    amount: parseFloat(transaction.amount),
                    status: transaction.status,
                    createdAt: transaction.created_at,
                },
                "Withdrawal request submitted successfully. Pending Super Admin approval."
            )
        );
    } catch (error) {
        console.error("Error in requestAgencyWithdrawal:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Get pending agency withdrawal requests
 */
const getPendingAgencyWithdrawalRequests = async (req, res) => {
    try {
        const requests = await prisma.walletTransaction.findMany({
            where: {
                agency_id: { not: null },
                type: "withdrawal",
                status: "pending",
            },
            orderBy: { created_at: "desc" },
        });

        const formatted = await Promise.all(
            requests.map(async (r) => {
                const agency = await prisma.orgUser.findUnique({
                    where: { org_id: r.agency_id },
                    select: {
                        org_name: true,
                        username: true,
                        email: true,
                        phone_number: true,
                        wallet_balance: true,
                    },
                });
                return {
                    id: r.transaction_id,
                    agencyId: r.agency_id,
                    agencyName: agency?.org_name || "Unknown Agency",
                    username: agency?.username || "Unknown",
                    email: agency?.email || "Unknown",
                    phoneNumber: agency?.phone_number || "N/A",
                    walletBalance: parseFloat(agency?.wallet_balance || 0),
                    amount: parseFloat(r.amount),
                    type: "agency_withdrawal",
                    status: r.status,
                    createdAt: r.created_at,
                };
            })
        );

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    formatted,
                    "Pending agency withdrawal requests fetched successfully"
                )
            );
    } catch (error) {
        console.error("Error in getPendingAgencyWithdrawalRequests:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Approve agency withdrawal request
 */
const approveAgencyWithdrawalRequest = async (req, res) => {
    try {
        const { transactionId } = req.params;
        const parsedTxId = parseInt(transactionId);
        if (isNaN(parsedTxId)) {
            throw new ApiError(400, "Invalid transaction ID");
        }

        const { transaction_number, transactionNumber, screenshot } = req.body;
        const resolvedTxNum = (
            transaction_number ||
            transactionNumber ||
            ""
        ).trim();

        if (!resolvedTxNum) {
            throw new ApiError(
                400,
                "Transaction ID / Reference Number is required to approve withdrawal"
            );
        }

        const transaction = await prisma.walletTransaction.findUnique({
            where: { transaction_id: parsedTxId },
        });

        if (!transaction) {
            throw new ApiError(404, "Withdrawal request not found");
        }

        if (transaction.status !== "pending") {
            throw new ApiError(
                400,
                `Request has already been ${transaction.status}`
            );
        }

        /* Save Base64 Files (Commented Out)
        let screenshotPath = null;
        if (screenshot && screenshot.trim() !== "") {
            screenshotPath = saveBase64File(
                screenshot,
                "withdrawal_screenshots",
                "proof"
            );
        }
        */

        // Save Files from FormData (Multer) or Base64 Fallback
        let screenshotPath = req.file?.path
            ? req.file.path.replace(/\\/g, "/").replace(/^uploads\//, "")
            : screenshot && screenshot.trim() !== ""
              ? saveBase64File(screenshot, "withdrawal_screenshots", "proof")
              : null;

        await prisma.$transaction(async (tx) => {
            let prevBal = null;
            let nextBal = null;

            if (transaction.agency_id) {
                const org = await tx.orgUser.findUnique({
                    where: { org_id: transaction.agency_id },
                });

                if (!org) {
                    throw new ApiError(
                        404,
                        "Agency associated with transaction not found"
                    );
                }

                prevBal = parseFloat(org.wallet_balance || 0);
                nextBal = parseFloat(
                    (prevBal - parseFloat(transaction.amount)).toFixed(2)
                );

                await tx.orgUser.update({
                    where: { org_id: transaction.agency_id },
                    data: { wallet_balance: Math.max(0, nextBal) },
                });
            } else if (transaction.user_id) {
                const user = await tx.user.findUnique({
                    where: { user_id: transaction.user_id },
                });

                if (user) {
                    prevBal = parseFloat(user.wallet_balance || 0);
                    nextBal = parseFloat(
                        (prevBal - parseFloat(transaction.amount)).toFixed(2)
                    );

                    await tx.user.update({
                        where: { user_id: transaction.user_id },
                        data: { wallet_balance: Math.max(0, nextBal) },
                    });
                }
            }

            await tx.walletTransaction.update({
                where: { transaction_id: parsedTxId },
                data: {
                    status: "approved",
                    transaction_number: resolvedTxNum,
                    screenshot_path: screenshotPath,
                    previous_balance: prevBal,
                    new_balance: nextBal,
                },
            });
        });

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    null,
                    "Agency cash withdrawal approved and wallet updated."
                )
            );
    } catch (error) {
        console.error("Error in approveAgencyWithdrawalRequest:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Reject agency withdrawal request
 */
const rejectAgencyWithdrawalRequest = async (req, res) => {
    try {
        const { transactionId } = req.params;
        const parsedTxId = parseInt(transactionId);
        if (isNaN(parsedTxId)) {
            throw new ApiError(400, "Invalid transaction ID");
        }

        const { rejection_reason, comment, reason } = req.body;
        const resolvedReason = (
            rejection_reason ||
            comment ||
            reason ||
            ""
        ).trim();

        if (!resolvedReason) {
            throw new ApiError(
                400,
                "A mandatory comment / reason is required for rejection"
            );
        }

        const transaction = await prisma.walletTransaction.findUnique({
            where: { transaction_id: parsedTxId },
        });

        if (!transaction) {
            throw new ApiError(404, "Withdrawal request not found");
        }

        if (transaction.status !== "pending") {
            throw new ApiError(
                400,
                `Request has already been ${transaction.status}`
            );
        }

        await prisma.walletTransaction.update({
            where: { transaction_id: parsedTxId },
            data: {
                status: "rejected",
                rejection_reason: resolvedReason,
            },
        });

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    null,
                    "Agency cash withdrawal request rejected."
                )
            );
    } catch (error) {
        console.error("Error in rejectAgencyWithdrawalRequest:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Agency Admin: Get agency withdrawal history
 */
const getAgencyWithdrawalHistory = async (req, res) => {
    try {
        const agencyId = req.user.agencyId || req.query.agencyId;
        if (!agencyId) {
            throw new ApiError(400, "Agency ID is required");
        }

        const parsedAgencyId = parseInt(agencyId);
        const transactions = await prisma.walletTransaction.findMany({
            where: {
                agency_id: parsedAgencyId,
                type: "withdrawal",
            },
            orderBy: { created_at: "desc" },
        });

        const mapped = transactions.map((t) => ({
            id: t.transaction_id.toString(),
            amount: parseFloat(t.amount),
            type: "debit",
            description: "Cash Withdrawal",
            status: t.status,
            transactionNumber: t.transaction_number || null,
            screenshotPath: t.screenshot_path || null,
            rejectionReason: t.rejection_reason || null,
            date: t.created_at,
        }));

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    mapped,
                    "Agency withdrawal history fetched successfully"
                )
            );
    } catch (error) {
        console.error("Error in getAgencyWithdrawalHistory:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Get all transaction history (system-wide or agency-wise filter)
 */
const getAdminTransactionHistory = async (req, res) => {
    try {
        const { agencyId } = req.query;

        let agencyTxWhere = {};
        let walletTxWhere = {};

        if (agencyId) {
            const parsedAgencyId = parseInt(agencyId);
            if (!isNaN(parsedAgencyId)) {
                agencyTxWhere.agency_id = parsedAgencyId;
                walletTxWhere.agency_id = parsedAgencyId;
            }
        }

        const agencyTransactions = await prisma.agencyTransaction.findMany({
            where: agencyTxWhere,
            orderBy: { created_at: "desc" },
        });

        const walletTransactions = await prisma.walletTransaction.findMany({
            where: walletTxWhere,
            orderBy: { created_at: "desc" },
        });

        const formattedAgencyTxs = await Promise.all(
            agencyTransactions.map(async (t) => {
                const booking = await prisma.booking.findUnique({
                    where: { booking_id: t.booking_id },
                    select: {
                        booking_code: true,
                        agency_name: true,
                        user_name: true,
                    },
                });
                return {
                    id: `agency_tx_${t.transaction_id}`,
                    category: "revenue_split",
                    agencyId: t.agency_id,
                    agencyName: booking?.agency_name || "Agency",
                    customerName: booking?.user_name || "Customer",
                    bookingCode: booking?.booking_code || "N/A",
                    totalAmount: parseFloat(t.total_amount),
                    approvedAmount: t.approved_amount
                        ? parseFloat(t.approved_amount)
                        : parseFloat(t.total_amount),
                    commissionRate: parseFloat(t.commission_rate),
                    adminShare: parseFloat(t.admin_share),
                    agencyShare: parseFloat(t.agency_share),
                    status: t.status || "approved",
                    date: t.created_at,
                };
            })
        );

        const formattedWalletTxs = await Promise.all(
            walletTransactions.map(async (t) => {
                let entityName = "Unknown";
                if (t.agency_id) {
                    const org = await prisma.orgUser.findUnique({
                        where: { org_id: t.agency_id },
                        select: { org_name: true },
                    });
                    entityName = org?.org_name || `Agency #${t.agency_id}`;
                } else if (t.user_id) {
                    const user = await prisma.user.findUnique({
                        where: { user_id: t.user_id },
                        select: { full_name: true, username: true },
                    });
                    entityName =
                        user?.full_name ||
                        user?.username ||
                        `User #${t.user_id}`;
                }

                return {
                    id: `wallet_tx_${t.transaction_id}`,
                    category: t.agency_id
                        ? "agency_withdrawal"
                        : t.type === "deposit"
                          ? "customer_deposit"
                          : "customer_debit",
                    agencyId: t.agency_id || null,
                    userId: t.user_id || null,
                    entityName,
                    amount: parseFloat(t.amount),
                    previousBalance:
                        t.previous_balance !== null &&
                        t.previous_balance !== undefined
                            ? parseFloat(t.previous_balance)
                            : null,
                    newBalance:
                        t.new_balance !== null && t.new_balance !== undefined
                            ? parseFloat(t.new_balance)
                            : null,
                    type: t.type,
                    status: t.status,
                    transactionNumber: t.transaction_number || null,
                    screenshotPath: t.screenshot_path || null,
                    rejectionReason: t.rejection_reason || null,
                    date: t.created_at,
                };
            })
        );

        const combined = [...formattedAgencyTxs, ...formattedWalletTxs].sort(
            (a, b) => new Date(b.date) - new Date(a.date)
        );

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    combined,
                    "Admin transaction history fetched successfully"
                )
            );
    } catch (error) {
        console.error("Error in getAdminTransactionHistory:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Get pending agency settlement requests (where money deducted from user is pending payout to agency)
 */
const getPendingAgencySettlements = async (req, res) => {
    try {
        const pendingSettlements = await prisma.agencyTransaction.findMany({
            where: { status: "pending" },
            orderBy: { created_at: "desc" },
        });

        const formatted = await Promise.all(
            pendingSettlements.map(async (st) => {
                const booking = await prisma.booking.findUnique({
                    where: { booking_id: st.booking_id },
                    select: {
                        booking_code: true,
                        user_name: true,
                        agency_name: true,
                        vehicle_type: true,
                        vehicle_number: true,
                    },
                });
                const agency = await prisma.orgUser.findUnique({
                    where: { org_id: st.agency_id },
                    select: {
                        org_name: true,
                        commission_percentage: true,
                    },
                });

                const totalAmount = parseFloat(st.total_amount);
                const commissionRate = agency?.commission_percentage
                    ? parseFloat(agency.commission_percentage)
                    : parseFloat(st.commission_rate || 0);

                const estimatedAdminShare = parseFloat(
                    ((totalAmount * commissionRate) / 100).toFixed(2)
                );
                const estimatedAgencyShare = parseFloat(
                    (totalAmount - estimatedAdminShare).toFixed(2)
                );

                return {
                    id: st.transaction_id,
                    bookingId: st.booking_id,
                    bookingCode: booking?.booking_code || "N/A",
                    agencyId: st.agency_id,
                    agencyName:
                        agency?.org_name ||
                        booking?.agency_name ||
                        "Unknown Agency",
                    customerName: booking?.user_name || "Customer",
                    totalAmount,
                    commissionRate,
                    estimatedAdminShare,
                    estimatedAgencyShare,
                    status: st.status,
                    createdAt: st.created_at,
                };
            })
        );

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    formatted,
                    "Pending agency settlements fetched successfully"
                )
            );
    } catch (error) {
        console.error("Error in getPendingAgencySettlements:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Approve an agency settlement (with optional customAmount)
 */
const approveAgencySettlementHandler = async (req, res) => {
    try {
        const { transactionId } = req.params;
        const { customAmount } = req.body;
        const adminId = req.user.id;

        const updatedTx = await prisma.$transaction(async (tx) => {
            return await approveAgencySettlement(tx, {
                transactionId,
                customAmount,
                adminId,
            });
        });

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    updatedTx,
                    "Agency settlement approved successfully"
                )
            );
    } catch (error) {
        console.error("Error in approveAgencySettlementHandler:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

/**
 * Super Admin: Reject an agency settlement
 */
const rejectAgencySettlementHandler = async (req, res) => {
    try {
        const { transactionId } = req.params;
        const { rejectionReason } = req.body;
        const adminId = req.user.id;

        const updatedTx = await prisma.$transaction(async (tx) => {
            return await rejectAgencySettlement(tx, {
                transactionId,
                rejectionReason,
                adminId,
            });
        });

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    updatedTx,
                    "Agency settlement rejected successfully"
                )
            );
    } catch (error) {
        console.error("Error in rejectAgencySettlementHandler:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};
const getAgencyWalletSummary = async (req, res) => {
    try {
        const { id } = req.params;
        const parsedAgencyId = parseInt(id);
        if (isNaN(parsedAgencyId)) {
            throw new ApiError(400, "Invalid agency ID");
        }

        const agency = await prisma.orgUser.findUnique({
            where: { org_id: parsedAgencyId },
            select: { wallet_balance: true, org_name: true },
        });

        if (!agency) {
            throw new ApiError(404, "Agency not found");
        }

        const agencyTransactions = await prisma.agencyTransaction.findMany({
            where: { agency_id: parsedAgencyId },
            orderBy: { created_at: "desc" },
        });

        const walletTransactions = await prisma.walletTransaction.findMany({
            where: { agency_id: parsedAgencyId, type: "withdrawal" },
            orderBy: { created_at: "desc" },
        });

        const formattedRevenue = await Promise.all(
            agencyTransactions.map(async (t) => {
                const booking = await prisma.booking.findUnique({
                    where: { booking_id: t.booking_id },
                    select: { booking_code: true, user_name: true },
                });
                return {
                    id: `agency_tx_${t.transaction_id}`,
                    category: "revenue_split",
                    type: "credit",
                    bookingCode: booking?.booking_code || "N/A",
                    customerName: booking?.user_name || "Customer",
                    totalAmount: parseFloat(t.total_amount),
                    commissionRate: parseFloat(t.commission_rate),
                    adminShare: parseFloat(t.admin_share),
                    amount: parseFloat(t.agency_share),
                    status: "approved",
                    date: t.created_at,
                };
            })
        );

        const formattedWithdrawals = walletTransactions.map((t) => ({
            id: `wallet_tx_${t.transaction_id}`,
            category: "withdrawal",
            type: "debit",
            amount: parseFloat(t.amount),
            status: t.status,
            transactionNumber: t.transaction_number || null,
            screenshotPath: t.screenshot_path || null,
            rejectionReason: t.rejection_reason || null,
            date: t.created_at,
        }));

        const combined = [...formattedRevenue, ...formattedWithdrawals].sort(
            (a, b) => new Date(b.date) - new Date(a.date)
        );

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    agencyId: parsedAgencyId,
                    agencyName: agency.org_name,
                    walletBalance: Math.max(
                        0,
                        parseFloat(agency.wallet_balance || 0)
                    ),
                    transactions: combined,
                },
                "Agency wallet summary fetched successfully"
            )
        );
    } catch (error) {
        console.error("Error in getAgencyWalletSummary:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

const getAgencySettlementsAuditTrail = async (req, res) => {
    try {
        const completedSettlements = await prisma.agencyTransaction.findMany({
            where: { status: { in: ["approved", "rejected"] } },
            orderBy: { created_at: "desc" },
        });

        const formatted = await Promise.all(
            completedSettlements.map(async (st) => {
                const booking = await prisma.booking.findUnique({
                    where: { booking_id: st.booking_id },
                    select: {
                        booking_code: true,
                        user_name: true,
                        agency_name: true,
                    },
                });
                const agency = await prisma.orgUser.findUnique({
                    where: { org_id: st.agency_id },
                    select: { org_name: true },
                });

                // approved_by stores the acting admin's user_id. NOTE: this
                // schema has no separate "admin" model — super_admin and
                // authority_admin are assumed to be rows in the `User`
                // table (role-based), consistent with the rest of this app.
                // If admins actually live somewhere else, point this lookup
                // there instead.
                let approvedByName = null;
                if (st.approved_by) {
                    const approver = await prisma.user.findUnique({
                        where: { user_id: st.approved_by },
                        select: { full_name: true },
                    });
                    approvedByName = approver?.full_name || null;
                }

                return {
                    id: st.transaction_id,
                    bookingId: st.booking_id,
                    bookingCode: booking?.booking_code || "N/A",
                    agencyId: st.agency_id,
                    agencyName:
                        agency?.org_name ||
                        booking?.agency_name ||
                        "Unknown Agency",
                    customerName: booking?.user_name || "Customer",
                    totalAmount: parseFloat(st.total_amount),
                    approvedAmount:
                        st.approved_amount !== null &&
                        st.approved_amount !== undefined
                            ? parseFloat(st.approved_amount)
                            : null,
                    commissionRate: parseFloat(st.commission_rate),
                    adminShare: parseFloat(st.admin_share),
                    agencyShare: parseFloat(st.agency_share),
                    status: st.status,
                    rejectionReason: st.rejection_reason,
                    approvedBy: approvedByName,
                    approvedAt: st.approved_at,
                    createdAt: st.created_at,
                };
            })
        );

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    formatted,
                    "Agency settlements audit trail fetched successfully"
                )
            );
    } catch (error) {
        console.error("Error in getAgencySettlementsAuditTrail:", error);
        return res.status(500).json(new ApiError(500, error.message));
    }
};

module.exports = {
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
    getAgencyWalletSummary,
    getAgencySettlementsAuditTrail,
};
