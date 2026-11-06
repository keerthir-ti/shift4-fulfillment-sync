import type { FixtureItem, ReferenceData } from "@shift4/contracts";

export type SplitPlan = { quantity: number; readyOffsetMs: number };

export function findCustomer(reference: ReferenceData, name: string) {
  return reference.customers.find((customer) => customer.name === name);
}

export function findOrganization(reference: ReferenceData, code: string) {
  return reference.organizations.find((organization) => organization.code === code);
}

export function findItem(reference: ReferenceData, productNumber: string): FixtureItem | undefined {
  return reference.items.find((item) => item.productNumber === productNumber);
}

export function splitsFor(item: FixtureItem | undefined, orderedQuantity: number, processingMs: number): SplitPlan[] {
  if (!item?.splits?.length) return [{ quantity: orderedQuantity, readyOffsetMs: processingMs }];
  return item.splits;
}
