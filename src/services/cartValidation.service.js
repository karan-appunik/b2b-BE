const AgentCart = require("../models/agentCart.model");
const OverrideRequest = require("../models/overrideRequest.model");
const CustomerGroup = require("../models/customerGroup.model");
const { ensureBaseGroup } = require("./customerGroup.service");
const { getSettings, usableForCart } = require("./override.service");

// "Run full commercial validation" on a cart (spec §7.2). This server knows the
// cart's lines, the customer's account and the exceptions; it does NOT know
// prices, stock or tax (those come from Shopify at checkout), so it says what it
// checked and what is left for checkout rather than pretending to be complete.

const CHECKED = ["cart not empty", "account approved for ordering", "no exception waiting for approval", "order quantity limits"];
const LEFT_FOR_CHECKOUT = ["prices", "stock", "tax", "shipping", "credit", "payment"];

async function effectiveOrderLimits(shop, customer) {
  const base = await ensureBaseGroup(shop);
  const group = customer.customerGroup ? await CustomerGroup.findOne({ _id: customer.customerGroup, shop }) : null;
  const limits = (group && group.orderLimits) || base.orderLimits;
  return limits && limits.quantity ? limits.quantity : { min: null, max: null, increment: null };
}

async function validateCart({ shop, agent, customer }) {
  const issues = [];
  const cart = await AgentCart.findOne({ shop, agent: agent._id, customer: customer._id });
  const totalQuantity = cart ? cart.items.reduce((sum, i) => sum + i.quantity, 0) : 0;

  if (!cart || cart.items.length === 0) {
    issues.push({ code: "EMPTY_CART", severity: "error", message: "The cart is empty" });
  }

  const settings = await getSettings(shop);
  if (customer.provisional && settings.provisionalOrdering === "block") {
    issues.push({ code: "ACCOUNT_PENDING_APPROVAL", severity: "error", message: "This new customer is waiting for approval" });
  }

  const pending = await OverrideRequest.countDocuments({ shop, agent: agent._id, customer: customer._id, status: "PENDING_APPROVAL" });
  if (pending > 0) {
    issues.push({ code: "APPROVAL_PENDING", severity: "error", message: `${pending} exception(s) still waiting for approval` });
  }

  if (cart && cart.items.length) {
    const limits = await effectiveOrderLimits(shop, customer);
    // An approved quantity-rule exception lowers the minimum for this order.
    const usable = await usableForCart({ shop, agent, customer });
    const accepted = usable.filter((o) => o.type === "QUANTITY_RULE" && o.rule !== "INCREMENT").map((o) => o.proposed.amount);
    const min = limits.min != null && accepted.length ? Math.min(limits.min, ...accepted) : limits.min;

    if (min != null && totalQuantity < min) {
      issues.push({ code: "BELOW_MINIMUM_QUANTITY", severity: "error", message: `Minimum order quantity is ${min}`, minimum: min, quantity: totalQuantity });
    }
    // The pack size: the order must be a multiple of it, unless an approved
    // exception waives that for this order.
    const incrementWaived = usable.some((o) => o.type === "QUANTITY_RULE" && o.rule === "INCREMENT");
    if (limits.increment && !incrementWaived && totalQuantity % limits.increment !== 0) {
      issues.push({ code: "NOT_IN_PACK_SIZE", severity: "error", message: `Orders must be in multiples of ${limits.increment}`, increment: limits.increment, quantity: totalQuantity });
    }
    if (limits.max != null && totalQuantity > limits.max) {
      issues.push({ code: "ABOVE_MAXIMUM_QUANTITY", severity: "error", message: `Maximum order quantity is ${limits.max}`, maximum: limits.max, quantity: totalQuantity });
    }
  }

  return {
    valid: !issues.some((i) => i.severity === "error"),
    issues,
    quantity: totalQuantity,
    checked: CHECKED,
    leftForCheckout: LEFT_FOR_CHECKOUT,
  };
}

module.exports = { validateCart };
