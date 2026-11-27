import { and, asc, desc, eq, lte, notInArray, sql, type SQL } from "drizzle-orm";
import { db } from "../../database/connection.js";
import {
  commitments,
  customers,
  invoices,
  payments,
  recoveryAssignments,
} from "../../database/schema.js";

/** `coalesce(sum(<expr>), 0)` as a JS number (Postgres returns bigint/numeric sums as strings). */
function sumOf(expression: SQL) {
  return sql<number>`coalesce(sum(${expression}), 0)`.mapWith(Number);
}

/** Sum of `value` over rows matching `condition` (Mongo `$sum: { $cond: [...] }`). */
function sumWhen(condition: SQL, value: SQL | number) {
  const then = typeof value === "number" ? sql.raw(String(Math.trunc(value))) : value;
  return sumOf(sql`case when ${condition} then ${then} else 0 end`);
}

export async function getDashboardMetrics(organizationId: string) {
  const todayStr = new Date().toISOString().slice(0, 10);

  const [year, month, day] = todayStr.split("-").map(Number);
  const next7Days = new Date(Date.UTC(year, month - 1, day + 7)).toISOString().slice(0, 10);

  const outstandingPositive = sql`${invoices.outstandingMinor} > 0`;

  const [[invoiceMetrics], [paymentMetrics], openRecoveryTasks, commitmentsDue, missedCommitments] = await Promise.all([
    // 1. Invoice totals: issued invoices
    db
      .select({
        totalInvoicedMinor: sumOf(sql`${invoices.amountMinor}`),
        totalOutstandingMinor: sumOf(sql`${invoices.outstandingMinor}`),
        totalOverdueMinor: sumWhen(
          sql`${outstandingPositive} and ${invoices.dueDate} < ${todayStr}`,
          sql`${invoices.outstandingMinor}`,
        ),
        dueTodayMinor: sumWhen(
          sql`${outstandingPositive} and ${invoices.dueDate} = ${todayStr}`,
          sql`${invoices.outstandingMinor}`,
        ),
        upcomingDue7DaysMinor: sumWhen(
          sql`${outstandingPositive} and ${invoices.dueDate} > ${todayStr} and ${invoices.dueDate} <= ${next7Days}`,
          sql`${invoices.outstandingMinor}`,
        ),
        partiallyPaidCount: sumWhen(
          sql`${outstandingPositive} and ${invoices.outstandingMinor} < ${invoices.amountMinor}`,
          1,
        ),
      })
      .from(invoices)
      .where(and(eq(invoices.organizationId, organizationId), eq(invoices.documentStatus, "issued"))),

    // 2. Payments: total collected
    db
      .select({ totalCollectedMinor: sumOf(sql`${payments.amountMinor}`) })
      .from(payments)
      .where(and(eq(payments.organizationId, organizationId), eq(payments.kind, "collection"))),

    // 3. Open recovery assignments
    db.$count(
      recoveryAssignments,
      and(
        eq(recoveryAssignments.organizationId, organizationId),
        notInArray(recoveryAssignments.status, ["closed", "fully_recovered"]),
      ),
    ),

    // 4. Commitments
    db.$count(
      commitments,
      and(
        eq(commitments.organizationId, organizationId),
        eq(commitments.status, "upcoming"),
        lte(commitments.promisedDate, next7Days),
      ),
    ),
    db.$count(commitments, and(eq(commitments.organizationId, organizationId), eq(commitments.status, "missed"))),
  ]);

  return {
    totalInvoicedMinor: invoiceMetrics?.totalInvoicedMinor ?? 0,
    totalReceivedMinor: paymentMetrics?.totalCollectedMinor ?? 0,
    totalOutstandingMinor: invoiceMetrics?.totalOutstandingMinor ?? 0,
    totalOverdueMinor: invoiceMetrics?.totalOverdueMinor ?? 0,
    dueTodayMinor: invoiceMetrics?.dueTodayMinor ?? 0,
    upcomingDue7DaysMinor: invoiceMetrics?.upcomingDue7DaysMinor ?? 0,
    partiallyPaidCount: invoiceMetrics?.partiallyPaidCount ?? 0,
    openRecoveryTasks,
    commitmentsDue,
    missedCommitments,
  };
}

export async function getAgingBuckets(organizationId: string) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // Helper date subtraction in UTC
  const daysAgo = (d: number) => {
    const dt = new Date(today.getTime() - d * 24 * 60 * 60 * 1000);
    return dt.toISOString().slice(0, 10);
  };

  const day30Ago = daysAgo(30);
  const day60Ago = daysAgo(60);
  const day90Ago = daysAgo(90);

  const dueDate = invoices.dueDate;
  const outstanding = sql`${invoices.outstandingMinor}`;
  const current = sql`${dueDate} >= ${todayStr}`;
  const bucket1To30 = sql`${dueDate} < ${todayStr} and ${dueDate} >= ${day30Ago}`;
  const bucket31To60 = sql`${dueDate} < ${day30Ago} and ${dueDate} >= ${day60Ago}`;
  const bucket61To90 = sql`${dueDate} < ${day60Ago} and ${dueDate} >= ${day90Ago}`;
  const bucket91Plus = sql`${dueDate} < ${day90Ago}`;

  const [aging] = await db
    .select({
      currentCount: sumWhen(current, 1),
      currentAmountMinor: sumWhen(current, outstanding),
      bucket1To30Count: sumWhen(bucket1To30, 1),
      bucket1To30AmountMinor: sumWhen(bucket1To30, outstanding),
      bucket31To60Count: sumWhen(bucket31To60, 1),
      bucket31To60AmountMinor: sumWhen(bucket31To60, outstanding),
      bucket61To90Count: sumWhen(bucket61To90, 1),
      bucket61To90AmountMinor: sumWhen(bucket61To90, outstanding),
      bucket91PlusCount: sumWhen(bucket91Plus, 1),
      bucket91PlusAmountMinor: sumWhen(bucket91Plus, outstanding),
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.documentStatus, "issued"),
        sql`${invoices.outstandingMinor} > 0`,
      ),
    );

  return {
    current: {
      count: aging?.currentCount ?? 0,
      amountMinor: aging?.currentAmountMinor ?? 0,
    },
    days1to30: {
      count: aging?.bucket1To30Count ?? 0,
      amountMinor: aging?.bucket1To30AmountMinor ?? 0,
    },
    days31to60: {
      count: aging?.bucket31To60Count ?? 0,
      amountMinor: aging?.bucket31To60AmountMinor ?? 0,
    },
    days61to90: {
      count: aging?.bucket61To90Count ?? 0,
      amountMinor: aging?.bucket61To90AmountMinor ?? 0,
    },
    days91Plus: {
      count: aging?.bucket91PlusCount ?? 0,
      amountMinor: aging?.bucket91PlusAmountMinor ?? 0,
    },
  };
}

export async function getCustomerOutstandingReport(organizationId: string) {
  const todayStr = new Date().toISOString().slice(0, 10);

  // Left join keeps customers without issued invoices (Mongo $lookup produced an empty array → 0 sums).
  const outstandingMinor = sumOf(sql`${invoices.outstandingMinor}`);
  const rows = await db
    .select({
      id: customers.id,
      displayName: customers.displayName,
      companyName: customers.companyName,
      phone: customers.phone,
      email: customers.email,
      totalInvoicedMinor: sumOf(sql`${invoices.amountMinor}`),
      outstandingMinor,
      overdueMinor: sumWhen(
        sql`${invoices.outstandingMinor} > 0 and ${invoices.dueDate} < ${todayStr}`,
        sql`${invoices.outstandingMinor}`,
      ),
      activeInvoiceCount: sql<number>`count(*) filter (where ${invoices.outstandingMinor} > 0)`.mapWith(Number),
    })
    .from(customers)
    .leftJoin(
      invoices,
      and(eq(invoices.customerId, customers.id), eq(invoices.documentStatus, "issued")),
    )
    .where(and(eq(customers.organizationId, organizationId), eq(customers.status, "active")))
    .groupBy(customers.id)
    .orderBy(desc(sql`coalesce(sum(${invoices.outstandingMinor}), 0)`), asc(customers.createdAt));

  // The aggregation used to return raw documents, which carried `_id` alongside the projected `id`.
  return rows.map((row) => ({ _id: row.id, ...row }));
}

/** Month key (YYYY-MM) for `monthsBack` months before the current UTC month. */
function monthKey(monthsBack: number) {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
  return date.toISOString().slice(0, 7);
}

/** Six-month invoiced vs collected trend plus recovery and commitment pipelines for the overview screen. */
export async function getOverviewInsights(organizationId: string) {
  const months = Array.from({ length: 6 }, (_, index) => monthKey(5 - index));
  const fromDate = `${months[0]}-01`;
  const todayStr = new Date().toISOString().slice(0, 10);

  const [invoiceMonths, paymentMonths, recoveryStatuses, commitmentStatuses, draftCount] = await Promise.all([
    db
      .select({
        month: sql<string>`substr(${invoices.invoiceDate}, 1, 7)`,
        invoicedMinor: sumOf(sql`${invoices.amountMinor}`),
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(invoices)
      .where(and(eq(invoices.organizationId, organizationId), eq(invoices.documentStatus, "issued"), sql`${invoices.invoiceDate} >= ${fromDate}`))
      .groupBy(sql`substr(${invoices.invoiceDate}, 1, 7)`),
    db
      .select({
        month: sql<string>`substr(${payments.paymentDate}, 1, 7)`,
        collectedMinor: sumOf(sql`case when ${payments.kind} = 'collection' then ${payments.amountMinor} else -${payments.amountMinor} end`),
        count: sql<number>`count(*) filter (where ${payments.kind} = 'collection')`.mapWith(Number),
      })
      .from(payments)
      .where(and(eq(payments.organizationId, organizationId), sql`${payments.paymentDate} >= ${fromDate}`))
      .groupBy(sql`substr(${payments.paymentDate}, 1, 7)`),
    db
      .select({ status: recoveryAssignments.status, count: sql<number>`count(*)`.mapWith(Number) })
      .from(recoveryAssignments)
      .where(eq(recoveryAssignments.organizationId, organizationId))
      .groupBy(recoveryAssignments.status),
    db
      .select({
        status: commitments.status,
        count: sql<number>`count(*)`.mapWith(Number),
        amountMinor: sumOf(sql`${commitments.promisedAmountMinor}`),
        overdueCount: sql<number>`count(*) filter (where ${commitments.promisedDate} < ${todayStr})`.mapWith(Number),
      })
      .from(commitments)
      .where(eq(commitments.organizationId, organizationId))
      .groupBy(commitments.status),
    db.$count(invoices, and(eq(invoices.organizationId, organizationId), eq(invoices.documentStatus, "draft"))),
  ]);

  const invoicedByMonth = new Map(invoiceMonths.map((row) => [row.month, row]));
  const collectedByMonth = new Map(paymentMonths.map((row) => [row.month, row]));

  return {
    monthly: months.map((month) => ({
      month,
      invoicedMinor: invoicedByMonth.get(month)?.invoicedMinor ?? 0,
      invoiceCount: invoicedByMonth.get(month)?.count ?? 0,
      collectedMinor: collectedByMonth.get(month)?.collectedMinor ?? 0,
      paymentCount: collectedByMonth.get(month)?.count ?? 0,
    })),
    recoveryByStatus: Object.fromEntries(recoveryStatuses.map((row) => [row.status, row.count])),
    commitmentsByStatus: Object.fromEntries(commitmentStatuses.map((row) => [row.status, { count: row.count, amountMinor: row.amountMinor, overdueCount: row.overdueCount }])),
    draftInvoices: draftCount,
  };
}
