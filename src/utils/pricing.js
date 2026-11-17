/** Aturan komisi & pembulatan. Komisi di-snapshot saat pekerjaan selesai. */
export function commissionFor(gross, percent) {
  const amount = Number(gross) || 0;
  const pct = Number(percent) || 0;
  const platformFee = Math.round((amount * pct) / 100);
  return {
    percent: pct,
    platformFee,
    technicianEarning: amount - platformFee,
  };
}

export function bookingTotals(serviceOrders) {
  return (serviceOrders || []).reduce((sum, order) => sum + Number(order.price) * Number(order.qty || 1), 0);
}

export function bookingStatusFromOrders(orders, currentStatus) {
  if (currentStatus === 'cancelled') return 'cancelled';
  const list = (orders || []).filter((order) => order.status !== 'cancelled');
  if (list.length === 0) return currentStatus === 'completed' ? 'completed' : 'cancelled';
  if (list.every((order) => order.status === 'completed')) return 'completed';
  if (list.some((order) => order.status === 'in_progress')) return 'in_progress';
  if (list.some((order) => order.status === 'assigned')) return 'processing';
  return 'processing';
}
