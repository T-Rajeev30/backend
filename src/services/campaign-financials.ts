export interface CampaignPurchase {
  spentAmount: number;
  costAmount: number;
  discountAmount?: number;
}

export interface CampaignFinancialInput {
  treatmentPurchases: readonly CampaignPurchase[];
  controlPurchases: readonly CampaignPurchase[];
  treatmentGroupSize: number;
  controlGroupSize: number;
  contactedCount: number;
  contactCostPerCustomer?: number;
}

export function calculateCampaignFinancials(input: CampaignFinancialInput) {
  const { treatmentGroupSize, controlGroupSize, contactedCount } = input;
  if (!Number.isInteger(treatmentGroupSize) || treatmentGroupSize < 1) {
    throw new Error('Treatment group must contain at least one customer');
  }
  if (!Number.isInteger(controlGroupSize) || controlGroupSize < 1) {
    throw new Error('Control group must contain at least one customer');
  }
  if (!Number.isInteger(contactedCount) || contactedCount < 0) {
    throw new Error('Contacted count must be a non-negative integer');
  }

  const sum = (purchases: readonly CampaignPurchase[], selector: (purchase: CampaignPurchase) => number) =>
    purchases.reduce((total, purchase) => total + selector(purchase), 0);

  const treatmentRevenue = sum(input.treatmentPurchases, (purchase) => purchase.spentAmount);
  const controlRevenue = sum(input.controlPurchases, (purchase) => purchase.spentAmount);
  const treatmentGrossProfit = sum(input.treatmentPurchases, (purchase) => purchase.spentAmount - purchase.costAmount);
  const controlGrossProfit = sum(input.controlPurchases, (purchase) => purchase.spentAmount - purchase.costAmount);
  const scaleFactor = treatmentGroupSize / controlGroupSize;
  const incrementalRevenue = Math.round(treatmentRevenue - controlRevenue * scaleFactor);
  const contactCost = contactedCount * (input.contactCostPerCustomer ?? 2);
  const discountCost = sum(input.treatmentPurchases, (purchase) => purchase.discountAmount ?? 0);
  const totalCampaignCost = Math.round(contactCost + discountCost);
  const incrementalGrossProfit = Math.round(
    treatmentGrossProfit - controlGrossProfit * scaleFactor - totalCampaignCost,
  );
  const merchantRoi = totalCampaignCost > 0
    ? Number(((incrementalGrossProfit / totalCampaignCost) * 100).toFixed(1))
    : 0;

  return {
    treatmentRevenue: Math.round(treatmentRevenue),
    controlRevenue: Math.round(controlRevenue),
    treatmentGrossProfit: Math.round(treatmentGrossProfit),
    controlGrossProfit: Math.round(controlGrossProfit),
    incrementalRevenue,
    totalCampaignCost,
    incrementalGrossProfit,
    merchantRoi,
  };
}
