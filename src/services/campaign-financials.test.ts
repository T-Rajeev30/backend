import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCampaignFinancials } from './campaign-financials.js';

test('campaign financials use catalog costs, discounts, and scaled control outcomes', () => {
  const result = calculateCampaignFinancials({
    treatmentPurchases: [
      { spentAmount: 100, costAmount: 40, discountAmount: 10 },
      { spentAmount: 60, costAmount: 20, discountAmount: 0 },
    ],
    controlPurchases: [{ spentAmount: 30, costAmount: 20 }],
    treatmentGroupSize: 4,
    controlGroupSize: 2,
    contactedCount: 4,
  });

  assert.deepEqual(result, {
    treatmentRevenue: 160,
    controlRevenue: 30,
    treatmentGrossProfit: 100,
    controlGrossProfit: 10,
    incrementalRevenue: 100,
    totalCampaignCost: 18,
    incrementalGrossProfit: 62,
    merchantRoi: 344.4,
  });
});

test('campaign financials preserve negative incremental gross profit', () => {
  const result = calculateCampaignFinancials({
    treatmentPurchases: [{ spentAmount: 10, costAmount: 20 }],
    controlPurchases: [{ spentAmount: 10, costAmount: 2 }],
    treatmentGroupSize: 2,
    controlGroupSize: 2,
    contactedCount: 2,
  });

  assert.equal(result.incrementalGrossProfit, -22);
  assert.equal(result.merchantRoi, -550);
});

test('campaign financials reject an empty control group', () => {
  assert.throws(() => calculateCampaignFinancials({
    treatmentPurchases: [],
    controlPurchases: [],
    treatmentGroupSize: 1,
    controlGroupSize: 0,
    contactedCount: 1,
  }), /Control group must contain at least one customer/);
});
