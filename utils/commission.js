const { ApiError } = require("./ApiError");
const { notifyUser } = require("./notifications");

/**
 * Stage 1: Collect full amount from user into Super Admin wallet and record pending AgencyTransaction
 * 
 * @param {Object} tx - Prisma transaction or client instance
 * @param {Object} params
 * @param {number} params.agencyId
 * @param {number} params.bookingId
 * @param {string} params.bookingCode
 * @param {number} params.amount
 * @returns {Promise<Object>}
 */
const distributePaymentCommission = async (
    tx,
    { agencyId, bookingId, bookingCode, amount }
) => {
    const totalAmount = parseFloat(amount || 0);
    if (totalAmount <= 0) {
        return { commissionRate: 0, adminShare: 0, agencyShare: 0 };
    }

    const parsedAgencyId = parseInt(agencyId);
    const parsedBookingId = parseInt(bookingId);

    // Fetch agency to get commission rate
    const agency = await tx.orgUser.findUnique({
        where: { org_id: parsedAgencyId },
        select: { org_id: true, org_name: true, commission_percentage: true },
    });

    const commissionRate = agency?.commission_percentage
        ? parseFloat(agency.commission_percentage)
        : 0;

    // Credit full amount to Super Admin wallet first
    const superAdmin = await tx.user.findFirst({
        where: { role: "super_admin" },
    });

    if (superAdmin) {
        const currentAdminBalance = parseFloat(superAdmin.wallet_balance || 0);
        const newAdminBalance = parseFloat((currentAdminBalance + totalAmount).toFixed(2));
        
        await tx.user.update({
            where: { user_id: superAdmin.user_id },
            data: { wallet_balance: newAdminBalance },
        });

        // Log deposit transaction for super admin
        await tx.walletTransaction.create({
            data: {
                user_id: superAdmin.user_id,
                amount: totalAmount,
                previous_balance: currentAdminBalance,
                new_balance: newAdminBalance,
                type: "deposit",
                status: "approved",
                transaction_number: `SUPERADMIN-COLLECT-${bookingCode}`,
            },
        });
    }

    // Record the agency transaction with status "pending"
    const agencyTx = await tx.agencyTransaction.create({
        data: {
            agency_id: parsedAgencyId,
            booking_id: parsedBookingId,
            total_amount: totalAmount,
            commission_rate: commissionRate,
            admin_share: 0,
            agency_share: 0,
            status: "pending",
        },
    });

    // Notify super admins that a revenue settlement is pending approval
    try {
        if (superAdmin) {
            await notifyUser(superAdmin.user_id, {
                type: "agency_settlement_pending",
                title: "New Agency Settlement Pending",
                message: `Revenue of ₹${totalAmount.toFixed(2)} collected for booking #${bookingCode} is awaiting settlement approval for agency ${agency?.org_name || parsedAgencyId}.`,
                data: {
                    transactionId: agencyTx.transaction_id,
                    bookingId: parsedBookingId,
                    bookingCode,
                    amount: totalAmount,
                    agencyId: parsedAgencyId,
                },
            });
        }
    } catch (e) {
        console.error("Notification error in distributePaymentCommission:", e);
    }

    return {
        transactionId: agencyTx.transaction_id,
        commissionRate,
        totalAmount,
        status: "pending",
    };
};

/**
 * Stage 2: Super Admin approves an agency settlement transaction (with optional custom amount override)
 * 
 * @param {Object} tx - Prisma transaction or client instance
 * @param {Object} params
 * @param {number} params.transactionId
 * @param {number} [params.customAmount]
 * @param {number} params.adminId
 * @returns {Promise<Object>}
 */
const approveAgencySettlement = async (tx, { transactionId, customAmount, adminId }) => {
    const parsedTxId = parseInt(transactionId);
    const agencyTx = await tx.agencyTransaction.findUnique({
        where: { transaction_id: parsedTxId },
    });

    if (!agencyTx) {
        throw new ApiError(404, "Agency settlement transaction not found");
    }

    if (agencyTx.status !== "pending") {
        throw new ApiError(400, `Settlement transaction has already been ${agencyTx.status}`);
    }

    const effectiveTotal = customAmount !== undefined && customAmount !== null && parseFloat(customAmount) > 0
        ? parseFloat(customAmount)
        : parseFloat(agencyTx.total_amount);

    const agency = await tx.orgUser.findUnique({
        where: { org_id: agencyTx.agency_id },
        select: { org_id: true, org_name: true, commission_percentage: true, wallet_balance: true },
    });

    if (!agency) {
        throw new ApiError(404, "Agency associated with settlement transaction not found");
    }

    const commissionRate = agency.commission_percentage
        ? parseFloat(agency.commission_percentage)
        : parseFloat(agencyTx.commission_rate || 0);

    const adminShare = parseFloat(((effectiveTotal * commissionRate) / 100).toFixed(2));
    const agencyShare = parseFloat((effectiveTotal - adminShare).toFixed(2));

    // Find Super Admin
    const superAdmin = await tx.user.findFirst({
        where: { role: "super_admin" },
    });

    if (superAdmin) {
        const currentAdminBal = parseFloat(superAdmin.wallet_balance || 0);
        // Super Admin keeps the full amount collected minus the agency share being released
        const newAdminBal = Math.max(0, parseFloat((currentAdminBal - agencyShare).toFixed(2)));

        await tx.user.update({
            where: { user_id: superAdmin.user_id },
            data: { wallet_balance: newAdminBal },
        });

        // Record payout withdrawal from Super Admin
        await tx.walletTransaction.create({
            data: {
                user_id: superAdmin.user_id,
                amount: agencyShare,
                previous_balance: currentAdminBal,
                new_balance: newAdminBal,
                type: "withdrawal",
                status: "approved",
                transaction_number: `AGENCY-PAYOUT-${agencyTx.transaction_id}`,
            },
        });
    }

    // Credit Agency owner wallet
    const currentAgencyBal = parseFloat(agency.wallet_balance || 0);
    const newAgencyBal = parseFloat((currentAgencyBal + agencyShare).toFixed(2));

    await tx.orgUser.update({
        where: { org_id: agencyTx.agency_id },
        data: { wallet_balance: newAgencyBal },
    });

    // Record deposit for Agency
    await tx.walletTransaction.create({
        data: {
            user_id: 0,
            agency_id: agencyTx.agency_id,
            amount: agencyShare,
            previous_balance: currentAgencyBal,
            new_balance: newAgencyBal,
            type: "deposit",
            status: "approved",
            transaction_number: `REVENUE-SETTLED-${agencyTx.transaction_id}`,
        },
    });

    // Update AgencyTransaction status to approved
    const updatedTx = await tx.agencyTransaction.update({
        where: { transaction_id: parsedTxId },
        data: {
            status: "approved",
            approved_amount: effectiveTotal,
            admin_share: adminShare,
            agency_share: agencyShare,
            approved_by: adminId,
            approved_at: new Date(),
        },
    });

    // Notify agency owner
    try {
        await notifyUser(agencyTx.agency_id, {
            type: "agency_settlement_approved",
            title: "Wallet Credit Approved",
            message: `Super Admin has approved your parking revenue settlement. ₹${agencyShare.toFixed(2)} has been credited to your wallet (Total Settled: ₹${effectiveTotal.toFixed(2)}, Commission Rate: ${commissionRate}%).`,
            data: {
                transactionId: parsedTxId,
                agencyShare,
                effectiveTotal,
                commissionRate,
            },
        });
    } catch (e) {
        console.error("Notification error in approveAgencySettlement:", e);
    }

    return updatedTx;
};

/**
 * Super Admin rejects an agency settlement transaction
 * 
 * @param {Object} tx - Prisma transaction or client instance
 * @param {Object} params
 * @param {number} params.transactionId
 * @param {string} [params.rejectionReason]
 * @param {number} params.adminId
 * @returns {Promise<Object>}
 */
const rejectAgencySettlement = async (tx, { transactionId, rejectionReason, adminId }) => {
    const parsedTxId = parseInt(transactionId);
    const agencyTx = await tx.agencyTransaction.findUnique({
        where: { transaction_id: parsedTxId },
    });

    if (!agencyTx) {
        throw new ApiError(404, "Agency settlement transaction not found");
    }

    if (agencyTx.status !== "pending") {
        throw new ApiError(400, `Settlement transaction has already been ${agencyTx.status}`);
    }

    const updatedTx = await tx.agencyTransaction.update({
        where: { transaction_id: parsedTxId },
        data: {
            status: "rejected",
            rejection_reason: rejectionReason || "Rejected by Super Admin",
            approved_by: adminId,
            approved_at: new Date(),
        },
    });

    // Notify agency owner
    try {
        await notifyUser(agencyTx.agency_id, {
            type: "agency_settlement_rejected",
            title: "Settlement Request Rejected",
            message: `Super Admin rejected the revenue settlement for transaction #${parsedTxId}. Reason: ${rejectionReason || "No reason specified"}.`,
            data: {
                transactionId: parsedTxId,
                rejectionReason,
            },
        });
    } catch (e) {
        console.error("Notification error in rejectAgencySettlement:", e);
    }

    return updatedTx;
};

module.exports = {
    distributePaymentCommission,
    approveAgencySettlement,
    rejectAgencySettlement,
};
