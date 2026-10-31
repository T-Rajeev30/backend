import { Campaign, Customer, CampaignTarget, CampaignResult, Product } from '../db/models.js';
import type { Types } from 'mongoose';
import { calculateCampaignFinancials } from './campaign-financials.js';

/**
 * Simulates campaign outcomes with randomized treatment/control purchases.
 * Calculations use catalog prices, catalog costs, and simulated campaign costs.
 * No messaging provider is called and no customer is contacted.
 */
export async function simulateCampaign(campaignId: string, merchantId: Types.ObjectId) {
  const campaign = await Campaign.findOneAndUpdate(
    { _id: campaignId, merchantId, status: 'approved' },
    { status: 'running' },
    { new: false },
  ).lean();

  if (!campaign) {
    throw Object.assign(new Error('Campaign not found or not approved for simulation'), { statusCode: 409 });
  }

  const filter: Record<string, any> = { merchantId: campaign.merchantId, consentSms: true };
  if (campaign.targetSegment && campaign.targetSegment !== 'all') {
    filter.segment = campaign.targetSegment;
  }

  const customers = await Customer.find(filter).lean();
  const products = await Product.find({ merchantId, isActive: true }).lean();

  if (customers.length < 2 || products.length === 0) {
    await Campaign.findOneAndUpdate({ _id: campaignId, merchantId }, {
      status: 'completed',
      actualCost: 0,
      actualRevenue: 0,
      actualProfit: 0,
    });
    return { error: 'Simulation needs at least two consented customers and one active product' };
  }

  // Split into treatment (80%) and control (20%)
  const shuffled = customers.sort(() => Math.random() - 0.5);
  const splitIndex = Math.floor(shuffled.length * 0.8);
  const treatmentGroup = shuffled.slice(0, splitIndex);
  const controlGroup = shuffled.slice(splitIndex);

  const targetRecords = [
    ...treatmentGroup.map((c) => ({
      campaignId,
      customerId: c._id.toString(),
      groupType: 'treatment' as const,
      contacted: true,
      responded: Math.random() < 0.35,
      purchased: false,
      spentAmount: null as number | null,
      costAmount: null as number | null,
      discountAmount: 0,
    })),
    ...controlGroup.map((c) => ({
      campaignId,
      customerId: c._id.toString(),
      groupType: 'control' as const,
      contacted: false,
      responded: false,
      purchased: false,
      spentAmount: null as number | null,
      costAmount: null as number | null,
      discountAmount: 0,
    })),
  ];

  const discountFactor = campaign.discountPercent ? (1 - campaign.discountPercent / 100) : 1;

  for (const target of targetRecords) {
    if (target.groupType === 'treatment' && target.responded) {
      target.purchased = Math.random() < 0.60;
      if (target.purchased) {
        const product = products[Math.floor(Math.random() * products.length)];
        const quantity = Math.random() < 0.4 ? 2 : 1;
        const grossRevenue = product.price * quantity;
        target.spentAmount = Math.round(grossRevenue * discountFactor);
        target.costAmount = product.cost * quantity;
        target.discountAmount = grossRevenue - (target.spentAmount || 0);
      }
    } else if (target.groupType === 'control') {
      target.purchased = Math.random() < 0.15;
      if (target.purchased) {
        const product = products[Math.floor(Math.random() * products.length)];
        const quantity = Math.random() < 0.2 ? 2 : 1;
        target.spentAmount = product.price * quantity;
        target.costAmount = product.cost * quantity;
      }
    }
  }

  await CampaignTarget.insertMany(targetRecords);

  const treatmentTargets = targetRecords.filter((t) => t.groupType === 'treatment');
  const controlTargets = targetRecords.filter((t) => t.groupType === 'control');

  const treatmentPurchased = treatmentTargets.filter((t) => t.purchased);
  const controlPurchased = controlTargets.filter((t) => t.purchased);

  const financials = calculateCampaignFinancials({
    treatmentPurchases: treatmentPurchased.map((target) => ({
      spentAmount: target.spentAmount || 0,
      costAmount: target.costAmount || 0,
      discountAmount: target.discountAmount || 0,
    })),
    controlPurchases: controlPurchased.map((target) => ({
      spentAmount: target.spentAmount || 0,
      costAmount: target.costAmount || 0,
    })),
    treatmentGroupSize: treatmentTargets.length,
    controlGroupSize: controlTargets.length,
    contactedCount: treatmentTargets.filter((t) => t.contacted).length,
  });
  const { treatmentRevenue, controlRevenue, treatmentGrossProfit, controlGrossProfit,
    incrementalRevenue, totalCampaignCost, incrementalGrossProfit: incrementalProfit, merchantRoi } = financials;

  const result = await CampaignResult.create({
    campaignId,
    totalTargeted: treatmentTargets.length + controlTargets.length,
    totalContacted: treatmentTargets.filter((t) => t.contacted).length,
    totalResponded: treatmentTargets.filter((t) => t.responded).length,
    totalPurchased: treatmentPurchased.length + controlPurchased.length,
    controlGroupSize: controlTargets.length,
    controlGroupPurchased: controlPurchased.length,
    totalCampaignCost,
    treatmentRevenue,
    controlRevenue,
    treatmentGrossProfit,
    controlGrossProfit,
    incrementalRevenue,
    incrementalProfit,
    merchantRoi,
  });

  await Campaign.findOneAndUpdate({ _id: campaignId, merchantId }, {
    status: 'completed',
    actualCost: totalCampaignCost,
    actualRevenue: treatmentRevenue,
    actualProfit: incrementalProfit,
    completedAt: new Date(),
  });

  return {
    campaignId,
    status: 'completed',
    result: {
      totalTargeted: result.totalTargeted,
      treatmentGroup: treatmentTargets.length,
      controlGroup: controlTargets.length,
      contacted: result.totalContacted,
      responded: result.totalResponded,
      purchased: result.totalPurchased,
      treatmentRevenue,
      controlRevenue,
      incrementalRevenue,
      totalCampaignCost,
      incrementalProfit,
      merchantRoi,
      treatmentConversionRate: parseFloat(
        ((treatmentPurchased.length / treatmentTargets.length) * 100).toFixed(1)
      ),
      controlConversionRate: parseFloat(
        ((controlPurchased.length / controlTargets.length) * 100).toFixed(1)
      ),
    },
  };
}
