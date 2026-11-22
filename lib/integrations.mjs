import { randomUUID } from 'node:crypto';

/** QR encodes a store URL. The browser can open the landing route directly. */
export function resolveStoreEntry(url, shop) {
  const storeId = url.searchParams.get('store');
  return !storeId || storeId === shop.id ? shop : null;
}

/** Contract for a real provider: create on the server, confirm via verified callback. */
export const paymentAdapter = Object.freeze({
  mode: 'simulation',
  create(order) {
    return { mode: 'simulation', orderId: order.id, amountCents: order.totalCents };
  },
  confirmSimulation(payment) {
    return {
      orderId: payment.orderId,
      amountCents: payment.amountCents,
      transactionId: `simulation-${payment.orderId}`,
      paidAt: new Date().toISOString(),
    };
  },
});

/** The transport can later send this persisted job to a printer provider's API. */
export const printAdapter = Object.freeze({
  mode: 'simulation',
  createJob(order, reason = 'paid') {
    return {
      id: randomUUID(),
      orderId: order.id,
      reason,
      status: 'simulated',
      createdAt: new Date().toISOString(),
      label: {
        shopId: order.shopId,
        pickupNumber: order.pickupNumber,
        items: order.items.map(({ name, quantity }) => ({ name, quantity })),
        note: order.note,
      },
    };
  },
});
