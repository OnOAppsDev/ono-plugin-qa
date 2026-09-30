import { useCart } from "../cart/useCart";
import { chargeCard } from "../payments/paymentService";
export function PayButton() { const cart = useCart(); return chargeCard(cart); }
