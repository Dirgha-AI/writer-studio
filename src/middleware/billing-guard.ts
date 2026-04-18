/**
 * Billing guard — stub implementation.
 * In production, replace with your own credit/billing check.
 */

export interface BillingResult {
  allowed: boolean;
  costUsd: number;
  remainingUsd: number;
  message?: string;
  error?: string;
  code?: string;
}

export async function checkBilling(userId: string, model: string): Promise<BillingResult> {
  // Stub: always allow. Wire your billing system here.
  return { allowed: true, costUsd: 0, remainingUsd: 999 };
}

export function getModelCost(_model: string): number {
  return 0;
}
