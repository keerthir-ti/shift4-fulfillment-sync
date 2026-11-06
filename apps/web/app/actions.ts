"use server";

import { approveOrder, createOrder, type CreateOrderInput } from "../lib/flow";

export async function createOrderAction(input: CreateOrderInput) {
  return createOrder(input);
}

export async function approveOrderAction(input: { headerId: string; orderNumber: string }) {
  return approveOrder(input);
}
