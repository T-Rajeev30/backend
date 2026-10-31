// Smoke test: hits every API endpoint and reports pass/fail.
// Usage: npm run smoke
import { config } from 'dotenv';
config();

const BASE = process.env.API_BASE || 'http://localhost:3001';

interface Check {
  name: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: any;
  expect?: (r: any) => boolean;
}

async function run(c: Check, merchantId: string, cookie: string, csrfToken: string, origin: string): Promise<{ pass: boolean; detail: string }> {
  const start = Date.now();
  try {
    const headers: Record<string, string> = {};
    headers['x-merchant-id'] = merchantId; // Selection only; backend also checks the session membership.
    headers.cookie = cookie;
    headers.origin = origin;
    if (c.method !== 'GET') headers['x-csrf-token'] = csrfToken;
    if (c.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${c.path}`, {
      method: c.method,
      headers,
      body: c.body ? JSON.stringify(c.body) : undefined,
    });
    const ms = Date.now() - start;
    if (!res.ok) return { pass: false, detail: `HTTP ${res.status} in ${ms}ms` };
    const data = await res.json();
    if (c.expect && !c.expect(data)) return { pass: false, detail: `assertion failed (${ms}ms): ${JSON.stringify(data).slice(0, 100)}` };
    return { pass: true, detail: `OK in ${ms}ms` };
  } catch (e: any) {
    return { pass: false, detail: `exception: ${e.message}` };
  }
}

async function main() {
  const email = process.env.SMOKE_EMAIL;
  const password = process.env.SMOKE_PASSWORD;
  if (!email || !password) {
    console.error('Configure SMOKE_EMAIL and SMOKE_PASSWORD for an authorized test account.');
    process.exit(1);
  }
  const origin = process.env.FRONTEND_URL || 'http://localhost:3000';
  const loginResponse = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin },
    body: JSON.stringify({ email, password }),
  });
  if (!loginResponse.ok) {
    console.error(`✗ Login — HTTP ${loginResponse.status}`);
    process.exit(1);
  }
  const login = await loginResponse.json() as { csrfToken: string };
  const cookie = loginResponse.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  if (!cookie || !login.csrfToken) {
    console.error('✗ Login — session cookie or CSRF token missing');
    process.exit(1);
  }
  const merchantResponse = await fetch(`${BASE}/api/merchants`, { headers: { cookie, origin } });
  if (!merchantResponse.ok) {
    console.error(`✗ Merchants list — HTTP ${merchantResponse.status}`);
    process.exit(1);
  }
  const merchantData = await merchantResponse.json() as { merchants?: Array<{ id: string }> };
  const merchantId = process.env.TEST_MERCHANT_ID || merchantData.merchants?.[0]?.id;
  if (!merchantId) {
    console.error('✗ No merchant available. Configure TEST_MERCHANT_ID or create demo data first.');
    process.exit(1);
  }

  const checks: Check[] = [
    { name: 'Health', method: 'GET', path: '/api/health', expect: (d) => d.status === 'ok' },
    { name: 'Merchants list', method: 'GET', path: '/api/merchants', expect: (d) => Array.isArray(d.merchants) && d.merchants.length > 0 },
    { name: 'Selected merchant profile', method: 'GET', path: '/api/merchants/profile', expect: (d) => typeof d.merchant?.name === 'string' },
    { name: 'Dashboard stats', method: 'GET', path: '/api/dashboard/stats', expect: (d) => typeof d.totalRevenue === 'number' },
    { name: 'Sales chart', method: 'GET', path: '/api/dashboard/sales-chart', expect: (d) => Array.isArray(d) },
    { name: 'Hourly distribution', method: 'GET', path: '/api/dashboard/hourly-distribution', expect: (d) => Array.isArray(d) },
    { name: 'Top products', method: 'GET', path: '/api/dashboard/top-products', expect: (d) => Array.isArray(d) },
    { name: 'Customer segments', method: 'GET', path: '/api/dashboard/customer-segments', expect: (d) => Array.isArray(d) },
    { name: 'Opportunities list', method: 'GET', path: '/api/opportunities', expect: (d) => Array.isArray(d.recommendations) },
    { name: 'Opportunity detect', method: 'POST', path: '/api/opportunities/detect', expect: (d) => Array.isArray(d.opportunities) },
    { name: 'Campaigns list', method: 'GET', path: '/api/campaigns', expect: (d) => Array.isArray(d.campaigns) },
    { name: 'Translate languages', method: 'GET', path: '/api/translate/languages', expect: (d) => Array.isArray(d) && d.length > 5 },
    { name: 'Translate hi-IN preserves ₹', method: 'POST', path: '/api/translate', body: { text: 'Revenue is ₹1,250', target: 'hi-IN' }, expect: (d) => d.translatedText.includes('₹1,250') },
    { name: 'TTS English', method: 'POST', path: '/api/voice/speak', body: { text: 'Hello world', language: 'en-IN' }, expect: (d) => typeof d.audioBase64 === 'string' && d.audioBase64.length > 100 },
    { name: 'Daily briefing', method: 'GET', path: '/api/insights/briefing?language=en-IN', expect: (d) => typeof d.briefing === 'string' && d.facts },
    { name: 'Demand forecast', method: 'GET', path: '/api/operations/forecast', expect: (d) => Array.isArray(d.forecast) },
    { name: 'Customer segments count', method: 'GET', path: '/api/customers/segments', expect: (d) => d.total > 0 },
    { name: 'Merchant customer directory', method: 'GET', path: '/api/customers?page=1&pageSize=10', expect: (d) => Array.isArray(d.customers) && d.pagination?.pageSize === 10 },
    { name: 'Customer message compose', method: 'POST', path: '/api/customers/message', body: { segment: 'inactive', language: 'en-IN' }, expect: (d) => typeof d.message === 'string' && typeof d.whatsappUrl === 'string' },
    { name: 'AI Ops metrics', method: 'GET', path: '/api/ops/ai-metrics', expect: (d) => typeof d.totalCalls === 'number' },
    { name: 'AI chat', method: 'POST', path: '/api/ai/chat', body: { message: 'How is my business doing?' }, expect: (d) => typeof d.response === 'string' },
  ];

  let pass = 0, fail = 0;
  for (const c of checks) {
    const r = await run(c, merchantId, cookie, login.csrfToken, origin);
    const mark = r.pass ? '✓' : '✗';
    console.log(`${mark} ${c.name} — ${r.detail}`);
    if (r.pass) pass += 1; else fail += 1;
  }

  console.log(`\n${pass}/${checks.length} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
