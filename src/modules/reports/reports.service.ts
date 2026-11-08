import mongoose from "mongoose";
import { InvoiceModel } from "../invoices/invoice.model.js";
import { PaymentModel } from "../payments/payment.model.js";
import { RecoveryAssignmentModel } from "../recovery/recovery-assignment.model.js";
import { CommitmentModel } from "../commitments/commitment.model.js";
import { CustomerModel } from "../customers/customer.model.js";

export async function getDashboardMetrics(organizationId: string) {
  const orgObjId = new mongoose.Types.ObjectId(organizationId);
  const todayStr = new Date().toISOString().slice(0, 10);

  const [year, month, day] = todayStr.split("-").map(Number);
  const next7Days = new Date(Date.UTC(year, month - 1, day + 7)).toISOString().slice(0, 10);

  // 1. Invoice totals: issued invoices
  const [invoiceMetrics] = await InvoiceModel.aggregate([
    {
      $match: {
        organizationId: orgObjId,
        documentStatus: "issued",
      },
    },
    {
      $group: {
        _id: null,
        totalInvoicedMinor: { $sum: "$amountMinor" },
        totalOutstandingMinor: { $sum: "$outstandingMinor" },
        totalOverdueMinor: {
          $sum: {
            $cond: [
              { $and: [{ $gt: ["$outstandingMinor", 0] }, { $lt: ["$dueDate", todayStr] }] },
              "$outstandingMinor",
              0,
            ],
          },
        },
        dueTodayMinor: {
          $sum: {
            $cond: [
              { $and: [{ $gt: ["$outstandingMinor", 0] }, { $eq: ["$dueDate", todayStr] }] },
              "$outstandingMinor",
              0,
            ],
          },
        },
        upcomingDue7DaysMinor: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $gt: ["$outstandingMinor", 0] },
                  { $gt: ["$dueDate", todayStr] },
                  { $lte: ["$dueDate", next7Days] },
                ],
              },
              "$outstandingMinor",
              0,
            ],
          },
        },
        partiallyPaidCount: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $gt: ["$outstandingMinor", 0] },
                  { $lt: ["$outstandingMinor", "$amountMinor"] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);

  // 2. Payments: total collected
  const [paymentMetrics] = await PaymentModel.aggregate([
    {
      $match: {
        organizationId: orgObjId,
        kind: "collection",
      },
    },
    {
      $group: {
        _id: null,
        totalCollectedMinor: { $sum: "$amountMinor" },
      },
    },
  ]);

  // 3. Open recovery assignments
  const openRecoveryTasks = await RecoveryAssignmentModel.countDocuments({
    organizationId: orgObjId,
    status: { $nin: ["closed", "fully_recovered"] },
  });

  // 4. Commitments
  const commitmentsDue = await CommitmentModel.countDocuments({
    organizationId: orgObjId,
    status: "upcoming",
    promisedDate: { $lte: next7Days },
  });

  const missedCommitments = await CommitmentModel.countDocuments({
    organizationId: orgObjId,
    status: "missed",
  });

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
  const orgObjId = new mongoose.Types.ObjectId(organizationId);
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

  const [aging] = await InvoiceModel.aggregate([
    {
      $match: {
        organizationId: orgObjId,
        documentStatus: "issued",
        outstandingMinor: { $gt: 0 },
      },
    },
    {
      $group: {
        _id: null,
        currentCount: { $sum: { $cond: [{ $gte: ["$dueDate", todayStr] }, 1, 0] } },
        currentAmountMinor: {
          $sum: { $cond: [{ $gte: ["$dueDate", todayStr] }, "$outstandingMinor", 0] },
        },
        bucket1To30Count: {
          $sum: {
            $cond: [
              { $and: [{ $lt: ["$dueDate", todayStr] }, { $gte: ["$dueDate", day30Ago] }] },
              1,
              0,
            ],
          },
        },
        bucket1To30AmountMinor: {
          $sum: {
            $cond: [
              { $and: [{ $lt: ["$dueDate", todayStr] }, { $gte: ["$dueDate", day30Ago] }] },
              "$outstandingMinor",
              0,
            ],
          },
        },
        bucket31To60Count: {
          $sum: {
            $cond: [
              { $and: [{ $lt: ["$dueDate", day30Ago] }, { $gte: ["$dueDate", day60Ago] }] },
              1,
              0,
            ],
          },
        },
        bucket31To60AmountMinor: {
          $sum: {
            $cond: [
              { $and: [{ $lt: ["$dueDate", day30Ago] }, { $gte: ["$dueDate", day60Ago] }] },
              "$outstandingMinor",
              0,
            ],
          },
        },
        bucket61To90Count: {
          $sum: {
            $cond: [
              { $and: [{ $lt: ["$dueDate", day60Ago] }, { $gte: ["$dueDate", day90Ago] }] },
              1,
              0,
            ],
          },
        },
        bucket61To90AmountMinor: {
          $sum: {
            $cond: [
              { $and: [{ $lt: ["$dueDate", day60Ago] }, { $gte: ["$dueDate", day90Ago] }] },
              "$outstandingMinor",
              0,
            ],
          },
        },
        bucket91PlusCount: {
          $sum: { $cond: [{ $lt: ["$dueDate", day90Ago] }, 1, 0] },
        },
        bucket91PlusAmountMinor: {
          $sum: { $cond: [{ $lt: ["$dueDate", day90Ago] }, "$outstandingMinor", 0] },
        },
      },
    },
  ]);

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
  const orgObjId = new mongoose.Types.ObjectId(organizationId);
  const todayStr = new Date().toISOString().slice(0, 10);

  const customers = await CustomerModel.aggregate([
    {
      $match: { organizationId: orgObjId, status: "active" },
    },
    {
      $lookup: {
        from: "invoices",
        let: { custId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$customerId", "$$custId"] },
                  { $eq: ["$documentStatus", "issued"] },
                ],
              },
            },
          },
        ],
        as: "invoices",
      },
    },
    {
      $project: {
        id: "$_id",
        displayName: 1,
        companyName: 1,
        phone: 1,
        email: 1,
        totalInvoicedMinor: { $sum: "$invoices.amountMinor" },
        outstandingMinor: { $sum: "$invoices.outstandingMinor" },
        overdueMinor: {
          $sum: {
            $map: {
              input: {
                $filter: {
                  input: "$invoices",
                  as: "inv",
                  cond: {
                    $and: [
                      { $gt: ["$$inv.outstandingMinor", 0] },
                      { $lt: ["$$inv.dueDate", todayStr] },
                    ],
                  },
                },
              },
              as: "overdueInv",
              in: "$$overdueInv.outstandingMinor",
            },
          },
        },
        activeInvoiceCount: {
          $size: {
            $filter: {
              input: "$invoices",
              as: "inv",
              cond: { $gt: ["$$inv.outstandingMinor", 0] },
            },
          },
        },
      },
    },
    { $sort: { outstandingMinor: -1 } },
  ]);

  return customers;
}
