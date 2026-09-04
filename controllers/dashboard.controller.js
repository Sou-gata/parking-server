const { prisma } = require("../utils/db");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

const CAPACITY_FIELDS = [
    "two_wheeler_capacity",
    "three_wheeler_capacity",
    "car_capacity",
    "suv_capacity",
    "van_capacity",
    "pickup_capacity",
    "ev_capacity",
];

const sumCapacity = (org) =>
    CAPACITY_FIELDS.reduce((sum, field) => sum + (org[field] || 0), 0);

const startOfDay = (d = new Date()) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};

const startOfMonth = (d = new Date()) =>
    new Date(d.getFullYear(), d.getMonth(), 1);

const lastNDays = (n) => {
    const days = [];
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        d.setHours(0, 0, 0, 0);
        const key = d.toISOString().slice(0, 10);
        const label = d.toLocaleDateString("en-IN", {
            weekday: "short",
        });
        days.push({ key, label, date: d });
    }
    return days;
};

const lastNMonths = (n) => {
    const months = [];
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(1);
        d.setMonth(d.getMonth() - i);
        d.setHours(0, 0, 0, 0);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const label = d.toLocaleDateString("en-IN", { month: "short" });
        months.push({ key, label, date: d });
    }
    return months;
};

const dayKey = (date) => new Date(date).toISOString().slice(0, 10);
const monthKey = (date) => {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const last24HoursWindow = () => {
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    return { start, end };
};

const MONTH_NAMES = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

// Builds a fixed month window (e.g. "?month=8" -> all of August, current
// year unless ?year= is also given) with one bucket per calendar day.
// Returns null when no valid month was requested, so callers can fall back
// to the existing Today/7d/30d/90d range behaviour untouched.
const getMonthWindow = (monthParam, yearParam) => {
    const monthNum = parseInt(monthParam, 10);
    if (!monthNum || monthNum < 1 || monthNum > 12) return null;

    const now = new Date();
    const year = yearParam ? parseInt(yearParam, 10) : now.getFullYear();
    if (!year || Number.isNaN(year)) return null;

    const start = new Date(year, monthNum - 1, 1, 0, 0, 0, 0);
    const end = new Date(year, monthNum, 1, 0, 0, 0, 0); // exclusive upper bound
    const daysInMonth = new Date(year, monthNum, 0).getDate();

    const buckets = [];
    for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(year, monthNum - 1, d, 0, 0, 0, 0);
        if (date > now) break; // don't create buckets for days that haven't happened yet
        buckets.push({
            key: dayKey(date),
            label: String(d),
            date,
        });
    }

    return {
        start,
        end,
        buckets,
        label: `${MONTH_NAMES[monthNum - 1]} ${year}`,
        bucketKey: (date) => dayKey(date),
    };
};

const RANGE_VALUES = ["today", "7d", "30d", "90d"];

const getRangeConfig = (rangeParam) => {
    const range = RANGE_VALUES.includes(rangeParam) ? rangeParam : "7d";
    const now = new Date();

    if (range === "today") {
        const start = startOfDay(now);
        const currentHour = now.getHours();
        const buckets = [];
        for (let h = 0; h <= currentHour; h++) {
            const d = new Date(start);
            d.setHours(h);
            buckets.push({
                key: `h${h}`,
                label: d
                    .toLocaleTimeString("en-IN", {
                        hour: "numeric",
                        hour12: true,
                    })
                    .replace(" ", ""),
                date: d,
            });
        }
        return {
            range,
            start,
            buckets,
            bucketKey: (date) => `h${new Date(date).getHours()}`,
        };
    }

    if (range === "30d") {
        const dayBuckets = lastNDays(30);
        return {
            range,
            start: dayBuckets[0].date,
            buckets: dayBuckets,
            bucketKey: (date) => dayKey(date),
        };
    }

    if (range === "90d") {
        const weeks = [];
        for (let i = 12; i >= 0; i--) {
            const end = startOfDay();
            end.setDate(end.getDate() - i * 7);
            const start = new Date(end);
            start.setDate(start.getDate() - 6);
            weeks.push({
                key: start.toISOString().slice(0, 10),
                label: start.toLocaleDateString("en-IN", {
                    month: "short",
                    day: "numeric",
                }),
                start,
                end,
            });
        }
        return {
            range,
            start: weeks[0].start,
            buckets: weeks,
            bucketKey: (date) => {
                const d = new Date(date);
                const match = weeks.find((w) => d >= w.start && d <= w.end);
                return match ? match.key : weeks[weeks.length - 1].key;
            },
        };
    }

    const dayBuckets = lastNDays(7);
    return {
        range: "7d",
        start: dayBuckets[0].date,
        buckets: dayBuckets,
        bucketKey: (date) => dayKey(date),
    };
};

const formatBucketDate = (bucket, range) => {
    if (range === "today") {
        return bucket.date.toLocaleDateString("en-IN", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
        });
    }
    if (range === "90d") {
        return `${bucket.start.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} – ${bucket.end.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} (week)`;
    }
    return bucket.date.toLocaleDateString("en-IN", {
        weekday: "long",
        day: "numeric",
        month: "short",
        year: "numeric",
    });
};

// ===========================================================================
// TEST / LIVE DATA FILTERING
// ===========================================================================
// Only User and OrgUser carry is_test_data directly. Every other table
// (bookings, wallet transactions, agency transactions) is filtered
// indirectly by joining through user_id / agency_id against the resolved ID
// sets below. Default mode is "all" — nothing is hidden unless the caller
// explicitly narrows to "live" or "test".
const DATA_MODES = ["all", "live", "test"];

const getDataMode = (modeParam) =>
    DATA_MODES.includes(modeParam) ? modeParam : "all";

// Resolves the set of user_ids and org_ids matching the requested data mode.
// Returns null for either set when mode is "all" (meaning: no filter needed).
const resolveTestDataFilters = async (mode) => {
    if (mode === "all") {
        return { userIdFilter: null, agencyIdFilter: null };
    }

    const wantTestData = mode === "test";

    const [testUsers, testAgencies] = await Promise.all([
        prisma.user.findMany({
            where: { is_test_data: wantTestData },
            select: { user_id: true },
        }),
        prisma.orgUser.findMany({
            where: { is_test_data: wantTestData },
            select: { org_id: true },
        }),
    ]);

    return {
        userIdFilter: testUsers.map((u) => u.user_id),
        agencyIdFilter: testAgencies.map((a) => a.org_id),
    };
};

// Merges a data-mode ID filter into a Prisma where-clause for a field like
// user_id or agency_id. If idList is null, no filter is applied (mode="all").
// If idList is an empty array, Prisma's `in: []` correctly returns zero rows
// (mode="test" but zero test records currently exist).
const applyIdFilter = (where, field, idList) => {
    if (idList === null) return where;
    return { ...where, [field]: { in: idList } };
};

// Convenience for orgUser/user queries, which carry is_test_data directly.
const applyDirectTestFilter = (where, dataMode) =>
    dataMode !== "all"
        ? { ...where, is_test_data: dataMode === "test" }
        : where;

const getOperatorDashboardStats = async (req, res) => {
    try {
        const today = startOfDay();
        const now = new Date();
        const {
            range,
            start: rangeStart,
            buckets,
            bucketKey,
        } = getRangeConfig(req.query.range);

        // Optional month filter — e.g. ?month=8 (&year=2026, defaults to the
        // current year). Takes priority over the range buttons for the
        // revenue/bookings trend, bookings-by-status, and recent activity
        // sections only.
        const monthWindow = getMonthWindow(req.query.month, req.query.year);
        const effectiveStart = monthWindow ? monthWindow.start : rangeStart;
        const effectiveEnd = monthWindow ? monthWindow.end : undefined;
        const effectiveBuckets = monthWindow ? monthWindow.buckets : buckets;
        const effectiveBucketKey = monthWindow
            ? monthWindow.bucketKey
            : bucketKey;

        // Status filter (default "all")
        const statusFilter = req.query.status || "all";

        // Test/Live data filter (default "all")
        const dataMode = getDataMode(req.query.dataMode);
        const { userIdFilter, agencyIdFilter } =
            await resolveTestDataFilters(dataMode);

        // Bookings are agency-scoped (every booking has an agency_id, unlike
        // user_id which can be null for guest bookings) — so agency_id is the
        // primary join used to classify a booking as test/live.
        const bookingWhereClause = applyIdFilter(
            {
                created_at: {
                    gte: effectiveStart,
                    ...(effectiveEnd ? { lt: effectiveEnd } : {}),
                },
                ...(statusFilter !== "all" ? { status: statusFilter } : {}),
            },
            "agency_id",
            agencyIdFilter
        );

        const activityWindowClause = {
            created_at: {
                gte: effectiveStart,
                ...(effectiveEnd ? { lt: effectiveEnd } : {}),
            },
        };

        const [
            totalBookings,
            activeBookings,
            completedBookings,
            totalAgencies,
            pendingAgencyApprovals,
            totalUsers,
            pendingWalletRequests,
            pendingComplaints,
            overdueBookings,
            unreadNotifications,
            todaysBookings,
            todaysRevenueAgg,
            bookingsByStatusRaw,
            rangeBookings,
            rangeBookingsRevenue,
            recentBookings,
            recentWalletRequests,
            recentAgencyRegistrations,
            recentComplaints,
            attentionAgencies,
            attentionWalletRequests,
            attentionComplaints,
            activeAgenciesForCapacity,
        ] = await Promise.all([
            prisma.booking.count({
                where: applyIdFilter({}, "agency_id", agencyIdFilter),
            }),
            prisma.booking.count({
                where: applyIdFilter(
                    { status: { in: ["booked", "checked_in"] } },
                    "agency_id",
                    agencyIdFilter
                ),
            }),
            prisma.booking.count({
                where: applyIdFilter(
                    { status: "completed" },
                    "agency_id",
                    agencyIdFilter
                ),
            }),
            prisma.orgUser.count({
                where: applyDirectTestFilter(
                    { status: { in: ["active", "approved"] } },
                    dataMode
                ),
            }),
            prisma.orgUser.count({
                where: applyDirectTestFilter({ status: "pending" }, dataMode),
            }),
            prisma.user.count({
                where: applyDirectTestFilter({ role: "user" }, dataMode),
            }),
            prisma.walletTransaction.count({
                where: applyIdFilter(
                    { status: "pending" },
                    "user_id",
                    userIdFilter
                ),
            }),
            prisma.complaint.count({
                where: applyIdFilter(
                    { status: "pending" },
                    "agency_id",
                    agencyIdFilter
                ),
            }),
            prisma.booking.count({
                where: applyIdFilter(
                    {
                        status: "checked_in",
                        booking_end_time: { lt: now },
                    },
                    "agency_id",
                    agencyIdFilter
                ),
            }),
            req.user?.id
                ? prisma.notification.count({
                      where: { recipient_id: req.user.id, is_read: false },
                  })
                : Promise.resolve(0),
            prisma.booking.count({
                where: applyIdFilter(
                    { created_at: { gte: today } },
                    "agency_id",
                    agencyIdFilter
                ),
            }),
            prisma.booking.aggregate({
                _sum: { total_bill: true },
                where: applyIdFilter(
                    { created_at: { gte: today } },
                    "agency_id",
                    agencyIdFilter
                ),
            }),
            // Status breakdown with filter
            prisma.booking.groupBy({
                by: ["status"],
                _count: { status: true },
                where: bookingWhereClause,
            }),
            // Bookings with total_bill for revenue trend
            prisma.booking.findMany({
                where: bookingWhereClause,
                select: {
                    created_at: true,
                    total_bill: true,
                    status: true,
                },
            }),
            // Revenue aggregated by bucket
            prisma.booking.groupBy({
                by: ["status"],
                _sum: { total_bill: true },
                where: applyIdFilter(
                    {
                        created_at: {
                            gte: effectiveStart,
                            ...(effectiveEnd ? { lt: effectiveEnd } : {}),
                        },
                    },
                    "agency_id",
                    agencyIdFilter
                ),
            }),
            // Activity feed sources — bounded to the same window as the trend
            // chart above, plus the data-mode filter.
            prisma.booking.findMany({
                where: applyIdFilter(
                    activityWindowClause,
                    "agency_id",
                    agencyIdFilter
                ),
                orderBy: { created_at: "desc" },
                take: 10,
                select: {
                    booking_id: true,
                    vehicle_number: true,
                    agency_name: true,
                    status: true,
                    created_at: true,
                    total_bill: true,
                },
            }),
            prisma.walletTransaction.findMany({
                where: applyIdFilter(
                    activityWindowClause,
                    "user_id",
                    userIdFilter
                ),
                orderBy: { created_at: "desc" },
                take: 10,
                select: {
                    transaction_id: true,
                    type: true,
                    amount: true,
                    status: true,
                    created_at: true,
                },
            }),
            prisma.orgUser.findMany({
                where: applyDirectTestFilter(activityWindowClause, dataMode),
                orderBy: { created_at: "desc" },
                take: 10,
                select: {
                    org_id: true,
                    org_name: true,
                    status: true,
                    created_at: true,
                },
            }),
            prisma.complaint.findMany({
                where: applyIdFilter(
                    activityWindowClause,
                    "agency_id",
                    agencyIdFilter
                ),
                orderBy: { created_at: "desc" },
                take: 10,
                select: {
                    complaint_id: true,
                    subject: true,
                    status: true,
                    created_at: true,
                },
            }),
            // "Needs Attention" queues stay pending-status based — an
            // always-current action list, not a historical report — but
            // still respect the data-mode filter so test-mode admins aren't
            // pinged about live approvals and vice versa.
            prisma.orgUser.findMany({
                where: applyDirectTestFilter({ status: "pending" }, dataMode),
                orderBy: { created_at: "desc" },
                take: 5,
                select: { org_id: true, org_name: true, created_at: true },
            }),
            prisma.walletTransaction.findMany({
                where: applyIdFilter(
                    { status: "pending" },
                    "user_id",
                    userIdFilter
                ),
                orderBy: { created_at: "desc" },
                take: 5,
                select: {
                    transaction_id: true,
                    type: true,
                    amount: true,
                    created_at: true,
                },
            }),
            prisma.complaint.findMany({
                where: applyIdFilter(
                    { status: "pending" },
                    "agency_id",
                    agencyIdFilter
                ),
                orderBy: { created_at: "desc" },
                take: 5,
                select: {
                    complaint_id: true,
                    subject: true,
                    description: true,
                    created_at: true,
                },
            }),
            prisma.orgUser.findMany({
                where: applyDirectTestFilter(
                    { status: { in: ["active", "approved"] } },
                    dataMode
                ),
                select: Object.fromEntries(
                    CAPACITY_FIELDS.map((f) => [f, true])
                ),
            }),
        ]);

        // Bookings trend with revenue — bucketed to the selected month (if
        // any), otherwise the selected quick range.
        const bucketCounts = Object.fromEntries(
            effectiveBuckets.map((b) => [b.key, { bookings: 0, revenue: 0 }])
        );
        rangeBookings.forEach((b) => {
            const k = effectiveBucketKey(b.created_at);
            if (k in bucketCounts) {
                bucketCounts[k].bookings += 1;
                bucketCounts[k].revenue += parseFloat(b.total_bill || 0);
            }
        });

        const bookingsTrend = effectiveBuckets.map((b) => ({
            label: b.label,
            dateLabel: monthWindow
                ? b.date.toLocaleDateString("en-IN", {
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                  })
                : formatBucketDate(b, range),
            bookings: bucketCounts[b.key].bookings,
            revenue: Math.round(bucketCounts[b.key].revenue),
        }));

        // Distinct statuses for filter options — scoped to the data mode too,
        // so the dropdown doesn't offer statuses that only exist in the
        // hidden data set.
        const allStatuses = await prisma.booking.groupBy({
            by: ["status"],
            where: applyIdFilter({}, "agency_id", agencyIdFilter),
            select: {
                status: true,
            },
        });
        const availableStatuses = allStatuses.map((s) => s.status);

        const bookingsByStatus = bookingsByStatusRaw.map((row) => ({
            status: row.status,
            count: row._count.status,
        }));

        const statusRangeLabel = monthWindow
            ? monthWindow.label
            : range === "today"
              ? now.toLocaleDateString("en-IN", {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                })
              : `${rangeStart.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} – ${now.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`;

        const bookingsByStatusWithRange = bookingsByStatus.map((row) => ({
            ...row,
            dateRangeLabel: statusRangeLabel,
        }));

        const totalCapacity = activeAgenciesForCapacity.reduce(
            (sum, org) => sum + sumCapacity(org),
            0
        );
        const occupancyRate =
            totalCapacity > 0
                ? Math.round((activeBookings / totalCapacity) * 100)
                : 0;

        // Activity feed
        const activityFeed = [
            ...recentBookings.map((b) => ({
                id: `booking-${b.booking_id}`,
                type: "booking",
                title:
                    b.status === "completed"
                        ? "Booking completed"
                        : b.status === "checked_in"
                          ? "Vehicle checked in"
                          : "New booking created",
                detail: `${b.agency_name} • Vehicle ${b.vehicle_number}`,
                amount: b.total_bill ? parseFloat(b.total_bill) : null,
                status: b.status,
                timestamp: b.created_at,
            })),
            ...recentWalletRequests.map((w) => ({
                id: `wallet-${w.transaction_id}`,
                type: "wallet",
                title:
                    w.type === "deposit"
                        ? "Wallet deposit requested"
                        : "Wallet withdrawal requested",
                detail: `₹${parseFloat(w.amount).toFixed(2)}`,
                amount: parseFloat(w.amount),
                status: w.status,
                timestamp: w.created_at,
            })),
            ...recentAgencyRegistrations.map((a) => ({
                id: `agency-${a.org_id}`,
                type: "agency",
                title: "Agency registered",
                detail: a.org_name,
                amount: null,
                status: a.status,
                timestamp: a.created_at,
            })),
            ...recentComplaints.map((c) => ({
                id: `complaint-${c.complaint_id}`,
                type: "complaint",
                title: "Complaint filed",
                detail: c.subject || "No subject",
                amount: null,
                status: c.status,
                timestamp: c.created_at,
            })),
        ]
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .slice(0, 12);

        const needsAttention = {
            pendingAgencies: attentionAgencies.map((a) => ({
                id: a.org_id,
                title: a.org_name,
                timestamp: a.created_at,
            })),
            pendingWalletRequests: attentionWalletRequests.map((w) => ({
                id: w.transaction_id,
                title: `${w.type === "deposit" ? "Deposit" : "Withdrawal"} — ₹${parseFloat(w.amount).toFixed(2)}`,
                timestamp: w.created_at,
            })),
            pendingComplaints: attentionComplaints.map((c) => ({
                id: c.complaint_id,
                title: c.subject || c.description?.slice(0, 60) || "Complaint",
                timestamp: c.created_at,
            })),
        };

        // =====================================================================
        // Vehicle owner / parking owner reports, 7-day trends, rankings, zone
        // + time-of-day breakdowns, and transaction status queues. These are
        // intentionally NOT affected by the month/range filter above (fixed
        // today/last-7-days snapshots by design), but ARE affected by the
        // data-mode filter.
        // =====================================================================
        const sevenDayBuckets = lastNDays(7);
        const sevenDayStart = sevenDayBuckets[0].date;

        const [
            vehicleOwnerStatusRaw,
            parkingOwnerStatusRaw,
            sevenDayBookingRows,
            sevenDayRevenueRows,
            todaysAmountPaidAgg,
            todaysPlatformRevenueAgg,
            paymentStatusRaw,
            depositStatusRaw,
            withdrawalStatusRaw,
            topUsersByAmount,
            bottomUsersByAmount,
            topAgenciesByAmount,
            bottomAgenciesByAmount,
            agencyRevenueRaw,
            agencyBookingCounts,
            agencyLookup,
            hourOfDayRaw,
        ] = await Promise.all([
            // 1. Vehicle owner / driver status breakdown
            prisma.user.groupBy({
                by: ["status"],
                where: applyDirectTestFilter({ role: "user" }, dataMode),
                _count: true,
            }),
            // 2. Parking owner status breakdown
            prisma.orgUser.groupBy({
                by: ["status"],
                where: applyDirectTestFilter({}, dataMode),
                _count: true,
            }),
            // 3/4/5. Raw rows for the last-7-days trend charts
            prisma.booking.findMany({
                where: applyIdFilter(
                    { created_at: { gte: sevenDayStart } },
                    "agency_id",
                    agencyIdFilter
                ),
                select: {
                    created_at: true,
                    total_bill: true,
                    payment_status: true,
                },
            }),
            prisma.agencyTransaction.findMany({
                where: applyIdFilter(
                    { created_at: { gte: sevenDayStart } },
                    "agency_id",
                    agencyIdFilter
                ),
                select: { created_at: true, admin_share: true },
            }),
            // 4. Today's amount paid (gross, payment_status = paid)
            prisma.booking.aggregate({
                _sum: { total_bill: true },
                where: applyIdFilter(
                    { created_at: { gte: today }, payment_status: "paid" },
                    "agency_id",
                    agencyIdFilter
                ),
            }),
            // 5. Today's platform revenue (commission earned)
            prisma.agencyTransaction.aggregate({
                _sum: { admin_share: true },
                where: applyIdFilter(
                    { created_at: { gte: today } },
                    "agency_id",
                    agencyIdFilter
                ),
            }),
            // 13. Booking payment status breakdown
            prisma.booking.groupBy({
                by: ["payment_status"],
                where: applyIdFilter({}, "agency_id", agencyIdFilter),
                _count: true,
                _sum: { total_bill: true },
            }),
            // 14. Funding (deposit) approval status breakdown
            prisma.walletTransaction.groupBy({
                by: ["status"],
                where: applyIdFilter(
                    { type: "deposit" },
                    "user_id",
                    userIdFilter
                ),
                _count: true,
                _sum: { amount: true },
            }),
            // 15. Withdrawal request status breakdown
            prisma.walletTransaction.groupBy({
                by: ["status"],
                where: applyIdFilter(
                    { type: { not: "deposit" } },
                    "user_id",
                    userIdFilter
                ),
                _count: true,
                _sum: { amount: true },
            }),
            // 6. Top 5 vehicle owners by amount paid
            prisma.booking.groupBy({
                by: ["user_id"],
                where: applyIdFilter(
                    { user_id: { not: null } },
                    "agency_id",
                    agencyIdFilter
                ),
                _count: true,
                _sum: { total_bill: true },
                orderBy: { _sum: { total_bill: "desc" } },
                take: 5,
            }),
            // 7. Last 5 vehicle owners by amount paid
            prisma.booking.groupBy({
                by: ["user_id"],
                where: applyIdFilter(
                    { user_id: { not: null } },
                    "agency_id",
                    agencyIdFilter
                ),
                _count: true,
                _sum: { total_bill: true },
                orderBy: { _sum: { total_bill: "asc" } },
                take: 5,
            }),
            // 8. Top 5 parking owners by amount paid
            prisma.booking.groupBy({
                by: ["agency_id"],
                where: applyIdFilter({}, "agency_id", agencyIdFilter),
                _count: true,
                _sum: { total_bill: true },
                orderBy: { _sum: { total_bill: "desc" } },
                take: 5,
            }),
            // 9. Last 5 parking owners by amount paid
            prisma.booking.groupBy({
                by: ["agency_id"],
                where: applyIdFilter({}, "agency_id", agencyIdFilter),
                _count: true,
                _sum: { total_bill: true },
                orderBy: { _sum: { total_bill: "asc" } },
                take: 5,
            }),
            // Commission revenue per agency
            prisma.agencyTransaction.groupBy({
                by: ["agency_id"],
                where: applyIdFilter({}, "agency_id", agencyIdFilter),
                _sum: { admin_share: true },
            }),
            // 11. Booking counts per agency, for the zone/location graph
            prisma.booking.groupBy({
                by: ["agency_id"],
                where: applyIdFilter({}, "agency_id", agencyIdFilter),
                _count: true,
                orderBy: { _count: { agency_id: "desc" } },
            }),
            // Name/landmark lookup for agencies referenced above
            prisma.orgUser.findMany({
                where: applyDirectTestFilter({}, dataMode),
                select: { org_id: true, org_name: true, landmark: true },
            }),
            // 12. Time-of-day breakdown (hour extracted in SQL). Data-mode
            // filtering here uses a raw IN(...) clause against the resolved
            // agency IDs, since Prisma's $queryRaw can't reuse applyIdFilter.
            agencyIdFilter === null
                ? prisma.$queryRaw`SELECT HOUR(created_at) AS hour, COUNT(*) AS count FROM bookings GROUP BY HOUR(created_at) ORDER BY hour`
                : agencyIdFilter.length === 0
                  ? Promise.resolve([])
                  : prisma.$queryRawUnsafe(
                        `SELECT HOUR(created_at) AS hour, COUNT(*) AS count FROM bookings WHERE agency_id IN (${agencyIdFilter.join(",")}) GROUP BY HOUR(created_at) ORDER BY hour`
                    ),
        ]);

        // ---- 1 & 2: status breakdowns, plus their combined overview (10) ----
        const vehicleOwnerStatus = vehicleOwnerStatusRaw.map((r) => ({
            status: r.status,
            count: r._count,
        }));
        const parkingOwnerStatus = parkingOwnerStatusRaw.map((r) => ({
            status: r.status,
            count: r._count,
        }));
        const vMap = Object.fromEntries(
            vehicleOwnerStatus.map((s) => [s.status, s.count])
        );
        const pMap = Object.fromEntries(
            parkingOwnerStatus.map((s) => [s.status, s.count])
        );
        const statusOverview = [
            ...new Set([
                ...vehicleOwnerStatus.map((s) => s.status),
                ...parkingOwnerStatus.map((s) => s.status),
            ]),
        ].map((status) => ({
            status,
            vehicleOwners: vMap[status] || 0,
            parkingOwners: pMap[status] || 0,
        }));

        // ---- 3/4/5: today summary + last-7-days trend ----
        const sevenDayMap = Object.fromEntries(
            sevenDayBuckets.map((b) => [b.key, { bookings: 0, amountPaid: 0 }])
        );
        sevenDayBookingRows.forEach((b) => {
            const k = dayKey(b.created_at);
            if (k in sevenDayMap) {
                sevenDayMap[k].bookings += 1;
                if (b.payment_status === "paid") {
                    sevenDayMap[k].amountPaid += parseFloat(b.total_bill || 0);
                }
            }
        });
        const bookingsLast7Days = sevenDayBuckets.map((b) => ({
            label: b.label,
            bookings: sevenDayMap[b.key].bookings,
        }));
        const amountPaidLast7Days = sevenDayBuckets.map((b) => ({
            label: b.label,
            amountPaid: Math.round(sevenDayMap[b.key].amountPaid),
        }));

        const revenueMap = Object.fromEntries(
            sevenDayBuckets.map((b) => [b.key, 0])
        );
        sevenDayRevenueRows.forEach((r) => {
            const k = dayKey(r.created_at);
            if (k in revenueMap)
                revenueMap[k] += parseFloat(r.admin_share || 0);
        });
        const revenueLast7Days = sevenDayBuckets.map((b) => ({
            label: b.label,
            revenue: Math.round(revenueMap[b.key]),
        }));

        const amountPaidToday = parseFloat(
            todaysAmountPaidAgg._sum.total_bill || 0
        );
        const revenueToday = parseFloat(
            todaysPlatformRevenueAgg._sum.admin_share || 0
        );

        // ---- 13/14/15: transaction status queues ----
        const bookingPaymentStatus = paymentStatusRaw.map((r) => ({
            status: r.payment_status,
            count: r._count,
            amount: Math.round(parseFloat(r._sum.total_bill || 0)),
        }));
        const fundingApprovalStatus = depositStatusRaw.map((r) => ({
            status: r.status,
            count: r._count,
            amount: Math.round(parseFloat(r._sum.amount || 0)),
        }));
        const withdrawalRequestStatus = withdrawalStatusRaw.map((r) => ({
            status: r.status,
            count: r._count,
            amount: Math.round(parseFloat(r._sum.amount || 0)),
        }));

        // ---- name/landmark lookups ----
        const involvedUserIds = [
            ...new Set(
                [...topUsersByAmount, ...bottomUsersByAmount].map(
                    (r) => r.user_id
                )
            ),
        ];
        const userNameRows = involvedUserIds.length
            ? await prisma.booking.findMany({
                  where: { user_id: { in: involvedUserIds } },
                  select: { user_id: true, user_name: true },
                  distinct: ["user_id"],
              })
            : [];
        const userNameMap = Object.fromEntries(
            userNameRows.map((r) => [r.user_id, r.user_name])
        );

        const agencyNameMap = Object.fromEntries(
            agencyLookup.map((a) => [a.org_id, a.org_name])
        );
        const agencyZoneMap = Object.fromEntries(
            agencyLookup.map((a) => [a.org_id, a.landmark || a.org_name])
        );
        const agencyRevenueMap = Object.fromEntries(
            agencyRevenueRaw.map((r) => [
                r.agency_id,
                parseFloat(r._sum.admin_share || 0),
            ])
        );

        // ---- 6/7: top & bottom 5 vehicle owners ----
        const toVehicleOwnerRow = (r) => ({
            userId: r.user_id,
            name: userNameMap[r.user_id] || `User #${r.user_id}`,
            bookings: r._count,
            amountPaid: Math.round(parseFloat(r._sum.total_bill || 0)),
        });
        const topVehicleOwners = topUsersByAmount.map(toVehicleOwnerRow);
        const bottomVehicleOwners = bottomUsersByAmount.map(toVehicleOwnerRow);

        // ---- 8/9: top & bottom 5 parking owners ----
        const toParkingOwnerRow = (r) => ({
            agencyId: r.agency_id,
            name: agencyNameMap[r.agency_id] || `Agency #${r.agency_id}`,
            bookings: r._count,
            amountPaid: Math.round(parseFloat(r._sum.total_bill || 0)),
            revenue: Math.round(agencyRevenueMap[r.agency_id] || 0),
        });
        const topParkingOwners = topAgenciesByAmount.map(toParkingOwnerRow);
        const bottomParkingOwners =
            bottomAgenciesByAmount.map(toParkingOwnerRow);

        // ---- 11: location/zone-wise bookings (top 10) ----
        const zoneCounts = {};
        agencyBookingCounts.forEach((r) => {
            const zone = agencyZoneMap[r.agency_id] || `Agency #${r.agency_id}`;
            zoneCounts[zone] = (zoneCounts[zone] || 0) + r._count;
        });
        const zoneWiseBookings = Object.entries(zoneCounts)
            .map(([zone, bookings]) => ({ zone, bookings }))
            .sort((a, b) => b.bookings - a.bookings)
            .slice(0, 10);

        // ---- 12: time-of-day breakdown (all 24 hours, zero-filled) ----
        const hourOfDayBookings = Array.from({ length: 24 }, (_, h) => ({
            hour: h,
            label: `${h}:00`,
            bookings: 0,
        }));
        hourOfDayRaw.forEach((row) => {
            const h = Number(row.hour);
            const count = Number(row.count);
            if (hourOfDayBookings[h]) hourOfDayBookings[h].bookings = count;
        });

        const stats = {
            range,
            dataMode,
            selectedMonth: monthWindow ? Number(req.query.month) : null,
            selectedYear: monthWindow
                ? req.query.year
                    ? parseInt(req.query.year, 10)
                    : new Date().getFullYear()
                : null,
            monthLabel: monthWindow ? monthWindow.label : null,
            totalBookings,
            activeBookings,
            completedBookings,
            totalAgencies,
            pendingAgencyApprovals,
            totalUsers,
            pendingWalletRequests,
            pendingComplaints,
            overdueBookings,
            unreadNotifications,
            todaysBookings,
            todaysRevenue: parseFloat(todaysRevenueAgg._sum.total_bill || 0),
            occupancyRate,
            bookingsTrend,
            bookingsByStatus: bookingsByStatusWithRange,
            activityFeed,
            needsAttention,
            availableStatuses,
            currentStatusFilter: statusFilter,

            vehicleOwnerStatus, // 1
            parkingOwnerStatus, // 2
            bookingsLast7Days, // 3
            amountPaidToday, // 4 (today)
            amountPaidLast7Days, // 4 (7-day graph)
            revenueToday, // 5 (today)
            revenueLast7Days, // 5 (7-day graph)
            topVehicleOwners, // 6
            bottomVehicleOwners, // 7
            topParkingOwners, // 8
            bottomParkingOwners, // 9
            statusOverview, // 10
            zoneWiseBookings, // 11
            hourOfDayBookings, // 12
            bookingPaymentStatus, // 13
            fundingApprovalStatus, // 14
            withdrawalRequestStatus, // 15
        };

        return new ApiResponse(
            200,
            stats,
            "Dashboard stats fetched successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in getOperatorDashboardStats:", error);
        return new ApiError(500, error.message).send(res);
    }
};

const getAuthorityDashboardStats = async (req, res) => {
    try {
        const monthStart = startOfMonth();
        const sixMonthsAgo = lastNMonths(6)[0].date;
        const today = startOfDay();
        const { start: last24hStart } = last24HoursWindow();
        const sevenDayBuckets = lastNDays(7);
        const sevenDayStart = sevenDayBuckets[0].date;

        const authorityUserId = req.user?.id;

        // Test/Live data filter (default "all")
        const dataMode = getDataMode(req.query.dataMode);
        const { userIdFilter, agencyIdFilter } =
            await resolveTestDataFilters(dataMode);

        const [
            totalOperators,
            activeAgencies,
            authorityWalletBalance,
            allTimeCommissionAgg,
            monthlyRevenueAgg,
            avgCommissionAgg,
            pendingAgencyCount,
            pendingWalletCount,
            recentPendingAgencies,
            recentPendingWallets,
            last6MonthsTransactions,
            revenueByAgencyRaw,
            totalBookings,
            activeBookings,
            overdueBookings,
            unreadNotifications,

            // ---- shared report sections (mirrors operator dashboard) ----
            vehicleOwnerStatusRaw,
            parkingOwnerStatusRaw,
            todaysBookingsCount,
            sevenDayBookingRows,
            sevenDayRevenueRows,
            todaysAmountPaidAgg,
            todaysPlatformRevenueAgg,
            paymentStatusRaw,
            depositStatusRaw,
            withdrawalStatusRaw,
            topUsersByAmount,
            bottomUsersByAmount,
            topAgenciesByAmount,
            bottomAgenciesByAmount,
            agencyRevenueRaw,
            agencyBookingCounts,
            agencyLookup,
            hourOfDayRaw,

            // ---- authority-only additions ----
            totalRevenueSoFarAgg,
            withdrawalLast24hAgg,
            depositLast24hAgg,
        ] = await Promise.all([
            prisma.orgUser.count({
                where: applyDirectTestFilter(
                    { status: { in: ["active", "approved"] } },
                    dataMode
                ),
            }),
            prisma.orgUser.findMany({
                where: applyDirectTestFilter(
                    { status: { in: ["active", "approved"] } },
                    dataMode
                ),
                select: {
                    org_id: true,
                    org_name: true,
                    commission_percentage: true,
                    ...Object.fromEntries(
                        CAPACITY_FIELDS.map((f) => [f, true])
                    ),
                },
            }),
            prisma.user.findUnique({
                where: { user_id: authorityUserId },
                select: { wallet_balance: true },
            }),
            prisma.agencyTransaction.aggregate({
                _sum: { admin_share: true },
                where: applyIdFilter({}, "agency_id", agencyIdFilter),
            }),
            prisma.agencyTransaction.aggregate({
                _sum: { total_amount: true, admin_share: true },
                where: applyIdFilter(
                    { created_at: { gte: monthStart } },
                    "agency_id",
                    agencyIdFilter
                ),
            }),
            prisma.orgUser.aggregate({
                _avg: { commission_percentage: true },
                where: applyDirectTestFilter(
                    { status: { in: ["active", "approved"] } },
                    dataMode
                ),
            }),
            prisma.orgUser.count({
                where: applyDirectTestFilter({ status: "pending" }, dataMode),
            }),
            prisma.walletTransaction.count({
                where: applyIdFilter(
                    { status: "pending" },
                    "user_id",
                    userIdFilter
                ),
            }),
            prisma.orgUser.findMany({
                where: applyDirectTestFilter({ status: "pending" }, dataMode),
                orderBy: { created_at: "desc" },
                take: 4,
                select: { org_id: true, org_name: true, created_at: true },
            }),
            prisma.walletTransaction.findMany({
                where: applyIdFilter(
                    { status: "pending" },
                    "user_id",
                    userIdFilter
                ),
                orderBy: { created_at: "desc" },
                take: 4,
                select: {
                    transaction_id: true,
                    type: true,
                    amount: true,
                    created_at: true,
                },
            }),
            prisma.agencyTransaction.findMany({
                where: applyIdFilter(
                    { created_at: { gte: sixMonthsAgo } },
                    "agency_id",
                    agencyIdFilter
                ),
                select: {
                    total_amount: true,
                    admin_share: true,
                    agency_share: true,
                    created_at: true,
                },
            }),
            prisma.agencyTransaction.groupBy({
                by: ["agency_id"],
                where: applyIdFilter({}, "agency_id", agencyIdFilter),
                _sum: { total_amount: true, admin_share: true },
            }),
            prisma.booking.count({
                where: applyIdFilter({}, "agency_id", agencyIdFilter),
            }),
            prisma.booking.count({
                where: applyIdFilter(
                    { status: { in: ["booked", "checked_in"] } },
                    "agency_id",
                    agencyIdFilter
                ),
            }),
            prisma.booking.count({
                where: applyIdFilter(
                    {
                        status: "checked_in",
                        booking_end_time: { lt: new Date() },
                    },
                    "agency_id",
                    agencyIdFilter
                ),
            }),
            authorityUserId
                ? prisma.notification.count({
                      where: { recipient_id: authorityUserId, is_read: false },
                  })
                : Promise.resolve(0),

            // ---- shared report sections ----
            prisma.user.groupBy({
                by: ["status"],
                where: applyDirectTestFilter({ role: "user" }, dataMode),
                _count: true,
            }),
            prisma.orgUser.groupBy({
                by: ["status"],
                where: applyDirectTestFilter({}, dataMode),
                _count: true,
            }),
            prisma.booking.count({
                where: applyIdFilter(
                    { created_at: { gte: today } },
                    "agency_id",
                    agencyIdFilter
                ),
            }),
            prisma.booking.findMany({
                where: applyIdFilter(
                    { created_at: { gte: sevenDayStart } },
                    "agency_id",
                    agencyIdFilter
                ),
                select: {
                    created_at: true,
                    total_bill: true,
                    payment_status: true,
                },
            }),
            prisma.agencyTransaction.findMany({
                where: applyIdFilter(
                    { created_at: { gte: sevenDayStart } },
                    "agency_id",
                    agencyIdFilter
                ),
                select: { created_at: true, admin_share: true },
            }),
            prisma.booking.aggregate({
                _sum: { total_bill: true },
                where: applyIdFilter(
                    { created_at: { gte: today }, payment_status: "paid" },
                    "agency_id",
                    agencyIdFilter
                ),
            }),
            prisma.agencyTransaction.aggregate({
                _sum: { admin_share: true },
                where: applyIdFilter(
                    { created_at: { gte: today } },
                    "agency_id",
                    agencyIdFilter
                ),
            }),
            prisma.booking.groupBy({
                by: ["payment_status"],
                where: applyIdFilter({}, "agency_id", agencyIdFilter),
                _count: true,
                _sum: { total_bill: true },
            }),
            prisma.walletTransaction.groupBy({
                by: ["status"],
                where: applyIdFilter(
                    { type: "deposit" },
                    "user_id",
                    userIdFilter
                ),
                _count: true,
                _sum: { amount: true },
            }),
            prisma.walletTransaction.groupBy({
                by: ["status"],
                where: applyIdFilter(
                    { type: { not: "deposit" } },
                    "user_id",
                    userIdFilter
                ),
                _count: true,
                _sum: { amount: true },
            }),
            prisma.booking.groupBy({
                by: ["user_id"],
                where: applyIdFilter(
                    { user_id: { not: null } },
                    "agency_id",
                    agencyIdFilter
                ),
                _count: true,
                _sum: { total_bill: true },
                orderBy: { _sum: { total_bill: "desc" } },
                take: 5,
            }),
            prisma.booking.groupBy({
                by: ["user_id"],
                where: applyIdFilter(
                    { user_id: { not: null } },
                    "agency_id",
                    agencyIdFilter
                ),
                _count: true,
                _sum: { total_bill: true },
                orderBy: { _sum: { total_bill: "asc" } },
                take: 5,
            }),
            prisma.booking.groupBy({
                by: ["agency_id"],
                where: applyIdFilter({}, "agency_id", agencyIdFilter),
                _count: true,
                _sum: { total_bill: true },
                orderBy: { _sum: { total_bill: "desc" } },
                take: 5,
            }),
            prisma.booking.groupBy({
                by: ["agency_id"],
                where: applyIdFilter({}, "agency_id", agencyIdFilter),
                _count: true,
                _sum: { total_bill: true },
                orderBy: { _sum: { total_bill: "asc" } },
                take: 5,
            }),
            prisma.agencyTransaction.groupBy({
                by: ["agency_id"],
                where: applyIdFilter({}, "agency_id", agencyIdFilter),
                _sum: { admin_share: true },
            }),
            prisma.booking.groupBy({
                by: ["agency_id"],
                where: applyIdFilter({}, "agency_id", agencyIdFilter),
                _count: true,
                orderBy: { _count: { agency_id: "desc" } },
            }),
            prisma.orgUser.findMany({
                where: applyDirectTestFilter({}, dataMode),
                select: { org_id: true, org_name: true, landmark: true },
            }),
            agencyIdFilter === null
                ? prisma.$queryRaw`SELECT HOUR(created_at) AS hour, COUNT(*) AS count FROM bookings GROUP BY HOUR(created_at) ORDER BY hour`
                : agencyIdFilter.length === 0
                  ? Promise.resolve([])
                  : prisma.$queryRawUnsafe(
                        `SELECT HOUR(created_at) AS hour, COUNT(*) AS count FROM bookings WHERE agency_id IN (${agencyIdFilter.join(",")}) GROUP BY HOUR(created_at) ORDER BY hour`
                    ),

            // ---- authority-only additions ----
            // Authority #1: total revenue so far (all-time platform commission)
            prisma.agencyTransaction.aggregate({
                _sum: { admin_share: true },
                where: applyIdFilter({}, "agency_id", agencyIdFilter),
            }),
            // Authority #4: total amount withdrawn in last 24h
            prisma.walletTransaction.aggregate({
                _sum: { amount: true },
                where: applyIdFilter(
                    {
                        type: { not: "deposit" },
                        status: "approved",
                        created_at: { gte: last24hStart },
                    },
                    "user_id",
                    userIdFilter
                ),
            }),
            // Authority #5: total amount deposited in last 24h
            prisma.walletTransaction.aggregate({
                _sum: { amount: true },
                where: applyIdFilter(
                    {
                        type: "deposit",
                        status: "approved",
                        created_at: { gte: last24hStart },
                    },
                    "user_id",
                    userIdFilter
                ),
            }),
        ]);

        const totalSpaces = activeAgencies.reduce(
            (sum, org) => sum + sumCapacity(org),
            0
        );

        // ---- Monthly commission revenue trend ----
        const monthBuckets = lastNMonths(6);
        const monthTotals = Object.fromEntries(
            monthBuckets.map((m) => [
                m.key,
                { total: 0, adminShare: 0, agencyShare: 0 },
            ])
        );
        last6MonthsTransactions.forEach((t) => {
            const k = monthKey(t.created_at);
            if (k in monthTotals) {
                monthTotals[k].total += parseFloat(t.total_amount || 0);
                monthTotals[k].adminShare += parseFloat(t.admin_share || 0);
                monthTotals[k].agencyShare += parseFloat(t.agency_share || 0);
            }
        });
        const monthlyRevenueTrend = monthBuckets.map((m) => ({
            label: m.label,
            total: Math.round(monthTotals[m.key].total),
            commission: Math.round(monthTotals[m.key].adminShare),
            agencyPayout: Math.round(monthTotals[m.key].agencyShare),
        }));

        const capacityByAgencyId = Object.fromEntries(
            activeAgencies.map((org) => [org.org_id, sumCapacity(org)])
        );
        const nameByAgencyId = Object.fromEntries(
            activeAgencies.map((org) => [org.org_id, org.org_name])
        );

        const revenueByAgency = revenueByAgencyRaw
            .map((row) => ({
                agencyId: row.agency_id,
                agencyName:
                    nameByAgencyId[row.agency_id] || `Agency #${row.agency_id}`,
                spaces: capacityByAgencyId[row.agency_id] || 0,
                revenue: Math.round(parseFloat(row._sum.total_amount || 0)),
                commissionEarned: Math.round(
                    parseFloat(row._sum.admin_share || 0)
                ),
            }))
            .filter((row) => row.agencyId in nameByAgencyId);

        const spacesVsRevenue = revenueByAgency.map((row) => ({
            spaces: row.spaces,
            revenue: row.revenue,
        }));

        const topOperatorRevenue = [...revenueByAgency]
            .sort((a, b) => b.revenue - a.revenue)
            .slice(0, 5)
            .map((row) => ({
                operator: row.agencyName,
                revenue: row.revenue,
            }));

        const pendingApprovalsList = [
            ...recentPendingAgencies.map((a) => ({
                id: `agency-${a.org_id}`,
                title: `New operator onboarding — ${a.org_name}`,
                category: "operational",
                timestamp: a.created_at,
            })),
            ...recentPendingWallets.map((w) => ({
                id: `wallet-${w.transaction_id}`,
                title: `Wallet ${w.type} request — ₹${parseFloat(w.amount).toFixed(2)}`,
                category: "transactional",
                timestamp: w.created_at,
            })),
        ]
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .slice(0, 6);

        // ==================================================================
        // Shared report sections — identical logic to getOperatorDashboardStats
        // ==================================================================
        const vehicleOwnerStatus = vehicleOwnerStatusRaw.map((r) => ({
            status: r.status,
            count: r._count,
        }));
        const parkingOwnerStatus = parkingOwnerStatusRaw.map((r) => ({
            status: r.status,
            count: r._count,
        }));
        const vMap = Object.fromEntries(
            vehicleOwnerStatus.map((s) => [s.status, s.count])
        );
        const pMap = Object.fromEntries(
            parkingOwnerStatus.map((s) => [s.status, s.count])
        );
        const statusOverview = [
            ...new Set([
                ...vehicleOwnerStatus.map((s) => s.status),
                ...parkingOwnerStatus.map((s) => s.status),
            ]),
        ].map((status) => ({
            status,
            vehicleOwners: vMap[status] || 0,
            parkingOwners: pMap[status] || 0,
        }));

        const sevenDayMap = Object.fromEntries(
            sevenDayBuckets.map((b) => [b.key, { bookings: 0, amountPaid: 0 }])
        );
        sevenDayBookingRows.forEach((b) => {
            const k = dayKey(b.created_at);
            if (k in sevenDayMap) {
                sevenDayMap[k].bookings += 1;
                if (b.payment_status === "paid") {
                    sevenDayMap[k].amountPaid += parseFloat(b.total_bill || 0);
                }
            }
        });
        const bookingsLast7Days = sevenDayBuckets.map((b) => ({
            label: b.label,
            bookings: sevenDayMap[b.key].bookings,
        }));
        const amountPaidLast7Days = sevenDayBuckets.map((b) => ({
            label: b.label,
            amountPaid: Math.round(sevenDayMap[b.key].amountPaid),
        }));

        const revenueMap = Object.fromEntries(
            sevenDayBuckets.map((b) => [b.key, 0])
        );
        sevenDayRevenueRows.forEach((r) => {
            const k = dayKey(r.created_at);
            if (k in revenueMap)
                revenueMap[k] += parseFloat(r.admin_share || 0);
        });
        const revenueLast7Days = sevenDayBuckets.map((b) => ({
            label: b.label,
            revenue: Math.round(revenueMap[b.key]),
        }));

        const amountPaidToday = parseFloat(
            todaysAmountPaidAgg._sum.total_bill || 0
        );
        const revenueToday = parseFloat(
            todaysPlatformRevenueAgg._sum.admin_share || 0
        );

        const bookingPaymentStatus = paymentStatusRaw.map((r) => ({
            status: r.payment_status,
            count: r._count,
            amount: Math.round(parseFloat(r._sum.total_bill || 0)),
        }));
        const fundingApprovalStatus = depositStatusRaw.map((r) => ({
            status: r.status,
            count: r._count,
            amount: Math.round(parseFloat(r._sum.amount || 0)),
        }));
        const withdrawalRequestStatus = withdrawalStatusRaw.map((r) => ({
            status: r.status,
            count: r._count,
            amount: Math.round(parseFloat(r._sum.amount || 0)),
        }));

        const involvedUserIds = [
            ...new Set(
                [...topUsersByAmount, ...bottomUsersByAmount].map(
                    (r) => r.user_id
                )
            ),
        ];
        const userNameRows = involvedUserIds.length
            ? await prisma.booking.findMany({
                  where: { user_id: { in: involvedUserIds } },
                  select: { user_id: true, user_name: true },
                  distinct: ["user_id"],
              })
            : [];
        const userNameMap = Object.fromEntries(
            userNameRows.map((r) => [r.user_id, r.user_name])
        );

        const agencyNameMap = Object.fromEntries(
            agencyLookup.map((a) => [a.org_id, a.org_name])
        );
        const agencyZoneMap = Object.fromEntries(
            agencyLookup.map((a) => [a.org_id, a.landmark || a.org_name])
        );
        const agencyRevenueMap = Object.fromEntries(
            agencyRevenueRaw.map((r) => [
                r.agency_id,
                parseFloat(r._sum.admin_share || 0),
            ])
        );

        const toVehicleOwnerRow = (r) => ({
            userId: r.user_id,
            name: userNameMap[r.user_id] || `User #${r.user_id}`,
            bookings: r._count,
            amountPaid: Math.round(parseFloat(r._sum.total_bill || 0)),
        });
        const topVehicleOwners = topUsersByAmount.map(toVehicleOwnerRow);
        const bottomVehicleOwners = bottomUsersByAmount.map(toVehicleOwnerRow);

        const toParkingOwnerRow = (r) => ({
            agencyId: r.agency_id,
            name: agencyNameMap[r.agency_id] || `Agency #${r.agency_id}`,
            bookings: r._count,
            amountPaid: Math.round(parseFloat(r._sum.total_bill || 0)),
            revenue: Math.round(agencyRevenueMap[r.agency_id] || 0),
        });
        const topParkingOwners = topAgenciesByAmount.map(toParkingOwnerRow);
        const bottomParkingOwners =
            bottomAgenciesByAmount.map(toParkingOwnerRow);

        const zoneCounts = {};
        agencyBookingCounts.forEach((r) => {
            const zone = agencyZoneMap[r.agency_id] || `Agency #${r.agency_id}`;
            zoneCounts[zone] = (zoneCounts[zone] || 0) + r._count;
        });
        const zoneWiseBookings = Object.entries(zoneCounts)
            .map(([zone, bookings]) => ({ zone, bookings }))
            .sort((a, b) => b.bookings - a.bookings)
            .slice(0, 10);

        const hourOfDayBookings = Array.from({ length: 24 }, (_, h) => ({
            hour: h,
            label: `${h}:00`,
            bookings: 0,
        }));
        hourOfDayRaw.forEach((row) => {
            const h = Number(row.hour);
            const count = Number(row.count);
            if (hourOfDayBookings[h]) hourOfDayBookings[h].bookings = count;
        });

        const totalRevenueSoFar = parseFloat(
            totalRevenueSoFarAgg._sum.admin_share || 0
        );

        const parkingOwnerWiseRevenue = [...revenueByAgency]
            .sort((a, b) => b.revenue - a.revenue)
            .map((row) => ({
                name: row.agencyName,
                revenue: row.revenue,
            }));

        const vehicleOwnerRevenueRaw = await prisma.booking.groupBy({
            by: ["user_id"],
            where: applyIdFilter(
                { user_id: { not: null }, payment_status: "paid" },
                "agency_id",
                agencyIdFilter
            ),
            _sum: { total_bill: true },
            orderBy: { _sum: { total_bill: "desc" } },
        });
        const vehicleOwnerIdsForRevenue = vehicleOwnerRevenueRaw.map(
            (r) => r.user_id
        );
        const vehicleOwnerRevenueNames = vehicleOwnerIdsForRevenue.length
            ? await prisma.booking.findMany({
                  where: { user_id: { in: vehicleOwnerIdsForRevenue } },
                  select: { user_id: true, user_name: true },
                  distinct: ["user_id"],
              })
            : [];
        const vehicleOwnerRevenueNameMap = Object.fromEntries(
            vehicleOwnerRevenueNames.map((r) => [r.user_id, r.user_name])
        );
        const vehicleOwnerWiseRevenue = vehicleOwnerRevenueRaw.map((r) => ({
            name: vehicleOwnerRevenueNameMap[r.user_id] || `User #${r.user_id}`,
            revenue: Math.round(parseFloat(r._sum.total_bill || 0)),
        }));

        const withdrawalAmountLast24h = parseFloat(
            withdrawalLast24hAgg._sum.amount || 0
        );
        const depositAmountLast24h = parseFloat(
            depositLast24hAgg._sum.amount || 0
        );
        const transactionAmountLast24h =
            withdrawalAmountLast24h + depositAmountLast24h;

        const stats = {
            dataMode,
            totalOperators: activeAgencies.length,
            totalSpaces,
            authorityWalletBalance: parseFloat(
                authorityWalletBalance?.wallet_balance || 0
            ),
            allTimeCommissionEarned: parseFloat(
                allTimeCommissionAgg._sum.admin_share || 0
            ),
            monthlyRevenue: parseFloat(
                monthlyRevenueAgg._sum.total_amount || 0
            ),
            monthlyCommission: parseFloat(
                monthlyRevenueAgg._sum.admin_share || 0
            ),
            averageCommissionRate: parseFloat(
                avgCommissionAgg._avg.commission_percentage || 0
            ),
            pendingApprovalsCount: pendingAgencyCount + pendingWalletCount,
            pendingAgencyCount,
            pendingWalletCount,
            pendingApprovalsList,
            monthlyRevenueTrend,
            spacesVsRevenue,
            topOperatorRevenue,
            totalBookings,
            activeBookings,
            overdueBookings,
            unreadNotifications,

            vehicleOwnerStatus,
            parkingOwnerStatus,
            todaysBookings: todaysBookingsCount,
            bookingsLast7Days,
            amountPaidToday,
            amountPaidLast7Days,
            revenueToday,
            revenueLast7Days,
            topVehicleOwners,
            bottomVehicleOwners,
            topParkingOwners,
            bottomParkingOwners,
            statusOverview,
            zoneWiseBookings,
            hourOfDayBookings,
            bookingPaymentStatus,
            fundingApprovalStatus,
            withdrawalRequestStatus,

            totalRevenueSoFar,
            parkingOwnerWiseRevenue,
            vehicleOwnerWiseRevenue,
            withdrawalAmountLast24h,
            depositAmountLast24h,
            transactionAmountLast24h,
        };

        return new ApiResponse(
            200,
            stats,
            "Authority dashboard stats fetched successfully"
        ).send(res);
    } catch (error) {
        console.error("Error in getAuthorityDashboardStats:", error);
        return new ApiError(500, error.message).send(res);
    }
};

/**
 * Get dashboard statistics according to user role
 * (Per-user/per-agency views — not affected by the test/live filter, since
 * these already scope to the logged-in user's own account.)
 */
const getDashboardStats = async (req, res) => {
    try {
        const { id, role, agency_id, org_id } = req.user;
        const userRole = role || "user";

        let stats = { role: userRole };

        if (userRole === "user") {
            const user = await prisma.user.findUnique({
                where: { user_id: id },
                select: { wallet_balance: true, full_name: true },
            });

            const bookings = await prisma.booking.findMany({
                where: { user_id: id },
                orderBy: { created_at: "desc" },
                take: 5,
            });

            const totalBookingsCount = await prisma.booking.count({
                where: { user_id: id },
            });

            const activeBookingsCount = await prisma.booking.count({
                where: {
                    user_id: id,
                    status: { in: ["booked", "checked_in"] },
                },
            });

            const completedBookingsCount = await prisma.booking.count({
                where: {
                    user_id: id,
                    status: "completed",
                },
            });

            const activeBooking = await prisma.booking.findFirst({
                where: {
                    user_id: id,
                    status: { in: ["booked", "checked_in"] },
                },
                orderBy: { created_at: "desc" },
            });

            const totalSpentAggregate = await prisma.booking.aggregate({
                where: { user_id: id, payment_status: "paid" },
                _sum: { total_bill: true },
            });

            stats = {
                role: "user",
                walletBalance: user?.wallet_balance
                    ? Math.max(0, parseFloat(user.wallet_balance))
                    : 0,
                totalBookings: totalBookingsCount,
                activeBookings: activeBookingsCount,
                completedBookings: completedBookingsCount,
                totalSpent: totalSpentAggregate._sum.total_bill
                    ? Math.max(
                          0,
                          parseFloat(totalSpentAggregate._sum.total_bill)
                      )
                    : 0,
                activeBooking: activeBooking || null,
                recentBookings: bookings,
            };
        } else if (userRole === "agency_admin" || userRole === "agency_user") {
            const agencyIdToUse = agency_id || org_id || id;

            const agency = await prisma.orgUser.findUnique({
                where: { org_id: agencyIdToUse },
            });

            const activeBookingsCount = await prisma.booking.count({
                where: {
                    agency_id: agencyIdToUse,
                    status: { in: ["booked", "checked_in"] },
                },
            });

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const todayBookingsCount = await prisma.booking.count({
                where: {
                    agency_id: agencyIdToUse,
                    created_at: { gte: today },
                },
            });

            const totalBookingsCount = await prisma.booking.count({
                where: { agency_id: agencyIdToUse },
            });

            const staffCount = await prisma.user.count({
                where: { agency_id: agencyIdToUse },
            });

            const recentBookings = await prisma.booking.findMany({
                where: { agency_id: agencyIdToUse },
                orderBy: { created_at: "desc" },
                take: 5,
            });

            const pendingWithdrawalsCount =
                await prisma.walletTransaction.count({
                    where: {
                        agency_id: agencyIdToUse,
                        type: "agency_withdrawal",
                        status: "pending",
                    },
                });

            const forceCancelsCount = await prisma.booking.count({
                where: {
                    agency_id: agencyIdToUse,
                    is_force_cancelled: true,
                },
            });

            stats = {
                role: userRole,
                agencyName: agency?.org_name || "Parking Agency",
                status: agency?.status || "active",
                walletBalance: agency?.wallet_balance
                    ? Math.max(0, parseFloat(agency.wallet_balance))
                    : 0,
                commissionPercentage: agency?.commission_percentage
                    ? parseFloat(agency.commission_percentage)
                    : 0,
                twoWheelerCapacity: agency?.two_wheeler_capacity || 0,
                carCapacity: agency?.car_capacity || 0,
                suvCapacity: agency?.suv_capacity || 0,
                evCapacity: agency?.ev_capacity || 0,
                totalCapacity:
                    (agency?.two_wheeler_capacity || 0) +
                    (agency?.car_capacity || 0) +
                    (agency?.suv_capacity || 0) +
                    (agency?.ev_capacity || 0) +
                    (agency?.three_wheeler_capacity || 0) +
                    (agency?.van_capacity || 0) +
                    (agency?.pickup_capacity || 0),
                activeBookings: activeBookingsCount,
                todayBookings: todayBookingsCount,
                totalBookings: totalBookingsCount,
                forceCancelsCount,
                staffCount,
                pendingWithdrawalsCount,
                recentBookings,
            };
        } else if (userRole === "super_admin") {
            const totalUsers = await prisma.user.count({
                where: { role: "user" },
            });

            const totalAgencies = await prisma.orgUser.count();

            const pendingAgenciesCount = await prisma.orgUser.count({
                where: { status: "pending" },
            });

            const pendingTopupsCount = await prisma.walletTransaction.count({
                where: {
                    status: "pending",
                    type: { not: "agency_withdrawal" },
                },
            });

            const pendingWithdrawalsCount =
                await prisma.walletTransaction.count({
                    where: { status: "pending", type: "agency_withdrawal" },
                });

            const pendingSettlementsCount =
                await prisma.agencyTransaction.count({
                    where: { status: "pending" },
                });

            const totalBookings = await prisma.booking.count();

            const forceCancelsCount = await prisma.booking.count({
                where: {
                    is_force_cancelled: true,
                },
            });

            const platformRevenueAggregate =
                await prisma.agencyTransaction.aggregate({
                    where: { status: "approved" },
                    _sum: { admin_share: true, total_amount: true },
                });

            const recentAgencies = await prisma.orgUser.findMany({
                orderBy: { created_at: "desc" },
                take: 5,
                select: {
                    org_id: true,
                    org_name: true,
                    email: true,
                    phone_number: true,
                    status: true,
                    created_at: true,
                },
            });

            stats = {
                role: "super_admin",
                totalUsers,
                totalAgencies,
                pendingAgenciesCount,
                pendingTopupsCount,
                pendingWithdrawalsCount,
                pendingSettlementsCount,
                totalBookings,
                forceCancelsCount,
                totalAdminRevenue: platformRevenueAggregate._sum.admin_share
                    ? parseFloat(platformRevenueAggregate._sum.admin_share)
                    : 0,
                totalVolume: platformRevenueAggregate._sum.total_amount
                    ? parseFloat(platformRevenueAggregate._sum.total_amount)
                    : 0,
                recentAgencies,
            };
        }

        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    stats,
                    "Dashboard statistics retrieved successfully"
                )
            );
    } catch (error) {
        console.error("Error in getDashboardStats:", error);
        if (error instanceof ApiError) {
            return res
                .status(error.statusCode)
                .json({ ...error, message: error.message });
        }
        return res.status(500).json(new ApiError(500, error.message));
    }
};

module.exports = {
    getOperatorDashboardStats,
    getAuthorityDashboardStats,
    getDashboardStats,
};
