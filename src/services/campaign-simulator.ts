import { Campaign, Customer, CampaignTarget, CampaignResult } from '../db/models.js';

/**
 * Simulates campaign execution with control group methodology.
 * All financial calculations are deterministic — no LLM involvement.
 */
export async function simulateCampaign(campaignId: string) {
  const campaign = await Campaign.findById(campaignId).lean();

  if (!campaign || campaign.status !== 'approved') {
    throw new Error('Campaign must be approved before simulation');
  }

  await Campaign.findByIdAndUpdate(campaignId, { status: 'running' });

  const filter: Record<string, any> = { merchantId: campaign.merchantId, consentSms: true };
  if (campaign.targetSegment && campaign.targetSegment !== 'all') {
    filter.segment = campaign.targetSegment;
  }

  const customers = await Customer.find(filter).lean();

  if (customers.length === 0) {
    await Campaign.findByIdAndUpdate(campaignId, {
      status: 'completed',
      actualCost: 0,
      actualRevenue: 0,
      actualProfit: 0,
    });
    return { error: 'No eligible customers found' };
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
    })),
    ...controlGroup.map((c) => ({
      campaignId,
      customerId: c._id.toString(),
      groupType: 'control' as const,
      contacted: false,
      responded: false,
      purchased: false,
      spentAmount: null as number | null,
    })),
  ];

  const avgProductPrice = 200;
  const discountFactor = campaign.discountPercent ? (1 - campaign.discountPercent / 100) : 1;

  for (const target of targetRecords) {
    if (target.groupType === 'treatment' && target.responded) {
      target.purchased = Math.random() < 0.60;
      if (target.purchased) {
        const items = Math.random() < 0.4 ? 2 : 1;
        target.spentAmount = Math.round(avgProductPrice * items * discountFactor);
      }
    } else if (target.groupType === 'control') {
      target.purchased = Math.random() < 0.15;
      if (target.purchased) {
        target.spentAmount = Math.round(avgProductPrice * (Math.random() < 0.2 ? 2 : 1));
      }
    }
  }

  await CampaignTarget.insertMany(targetRecords);

  // Deterministic calculation
  const treatmentTargets = targetRecords.filter((t) => t.groupType === 'treatment');
  const controlTargets = targetRecords.filter((t) => t.groupType === 'control');

  const treatmentPurchased = treatmentTargets.filter((t) => t.purchased);
  const controlPurchased = controlTargets.filter((t) => t.purchased);

  const treatmentRevenue = treatmentPurchased.reduce((s, t) => s + (t.spentAmount || 0), 0);
  const controlRevenue = controlPurchased.reduce((s, t) => s + (t.spentAmount || 0), 0);

  const scaleFactor = treatmentTargets.length / controlTargets.length;
  const scaledControlRevenue = controlRevenue * scaleFactor;
  const incrementalRevenue = Math.round(treatmentRevenue - scaledControlRevenue);

  const contactCost = treatmentTargets.filter((t) => t.contacted).length * 2;
  const discountCost = campaign.discountPercent
    ? Math.round(treatmentPurchased.reduce((s, t) => s + (t.spentAmount || 0), 0) * (campaign.discountPercent / 100) / discountFactor)
    : 0;
  const totalCampaignCost = contactCost + discountCost;

  const grossMarginRate = 0.60;
  const incrementalProfit = Math.round(incrementalRevenue * grossMarginRate - totalCampaignCost);
  const merchantRoi = totalCampaignCost > 0
    ? parseFloat(((incrementalProfit / totalCampaignCost) * 100).toFixed(1))
    : 0;

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
    incrementalRevenue: Math.max(0, incrementalRevenue),
    incrementalProfit: Math.max(0, incrementalProfit),
    merchantRoi,
  });

  await Campaign.findByIdAndUpdate(campaignId, {
    status: 'completed',
    actualCost: totalCampaignCost,
    actualRevenue: treatmentRevenue,
    actualProfit: Math.max(0, incrementalProfit),
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
      incrementalRevenue: Math.max(0, incrementalRevenue),
      totalCampaignCost,
      incrementalProfit: Math.max(0, incrementalProfit),
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