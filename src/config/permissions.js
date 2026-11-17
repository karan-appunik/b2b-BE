// The permission keys a role can grant (spec §2.2) and the roles every shop
// starts with. Access is deny-by-default: a role can do only what it lists.
//
// `highRisk` marks permissions that can also be given to one agent for a
// limited time (see PermissionGrant).
//
// `constraint` describes the optional limits a permission can carry; the
// role editor renders these and the server evaluates them.

const PERMISSION_CATALOG = [
  {
    key: "customer.search",
    group: "Customers",
    label: "Search accounts",
    description: "Find the customers this person has been given access to.",
  },
  {
    key: "customer.context.enter",
    group: "Customers",
    label: "Order for a customer",
    description: "Enter a customer's account to browse, build carts and order on their behalf.",
    constraint: { field: "scope", type: "select", options: ["assigned", "all"], default: "assigned" },
  },
  {
    key: "customer.notes.read",
    group: "Customers",
    label: "See internal notes about a customer",
    description: "Read the notes the team keeps about a customer. Customers never see them.",
  },
  {
    key: "customer.create",
    highRisk: true,
    group: "Customers",
    label: "Create new customers",
    description: "Add new customer records to the platform.",
  },
  {
    key: "address.create",
    group: "Customers",
    label: "Edit addresses",
    description: "Add shipping and billing addresses on a customer's account.",
  },
  {
    key: "cart.create",
    group: "Orders",
    label: "Open carts",
    description: "Open and resume the cart built for a customer.",
  },
  {
    key: "cart.write",
    group: "Orders",
    label: "Edit carts",
    description: "Add, change and remove lines in a customer's cart.",
  },
  {
    key: "address.override",
    highRisk: true,
    group: "Orders",
    label: "Ship to a one-off address",
    description: "Send one order to an address that isn't in the customer's address book, without saving it.",
  },
  {
    key: "credit.override",
    highRisk: true,
    group: "Orders",
    label: "Allow an order over the credit limit",
    description: "Let one order go past the customer's available credit.",
    constraint: { field: "maxOverPercent", type: "number", label: "Largest amount over the limit (%)" },
  },
  {
    key: "quote.create",
    group: "Orders",
    label: "Create quotes",
    description: "Create quotes for a customer.",
  },
  {
    key: "order.submit",
    constraint: { field: "mode", type: "select", options: ["direct", "approval_first"], default: "direct" },
    group: "Orders",
    label: "Complete checkout",
    description: "Place orders via the normal checkout process.",
  },
  {
    key: "payment_link.send",
    group: "Orders",
    label: "Send payment links",
    description: "Send a customer a secure link to pay for an order or quote.",
  },
  {
    key: "price.override",
    highRisk: true,
    group: "Orders",
    label: "Edit quoted prices",
    description: "Change the price of items for a customer.",
    constraint: { field: "maxDeltaPercent", type: "number", label: "Largest allowed change (%)" },
  },
  {
    key: "discount.override",
    highRisk: true,
    group: "Orders",
    label: "Apply extra discounts",
    description: "Give an extra discount on an order.",
    constraint: { field: "maxPercent", type: "number", label: "Largest allowed discount (%)" },
  },
  {
    key: "quantity_rule.override",
    highRisk: true,
    group: "Orders",
    label: "Override product settings",
    description: "Bypass product-level rules like minimum order quantities or increments.",
  },
  {
    key: "shipping.override",
    highRisk: true,
    group: "Orders",
    label: "Edit custom shipping",
    description: "Override the shipping method or cost on an order.",
  },
  {
    key: "custom_line.create",
    highRisk: true,
    group: "Orders",
    label: "Edit custom items",
    description: "Add or modify custom line items on an order.",
  },
  {
    key: "approval.decide",
    highRisk: true,
    group: "Orders",
    label: "Approve exceptions",
    description: "Approve or reject price, discount and other exceptions that agents request.",
    constraint: { field: "maxDeltaPercent", type: "number", label: "Largest exception they can approve (%)" },
  },
  {
    key: "audit.read",
    group: "Reporting",
    label: "View activity",
    description: "Read the activity log of what agents did for which customers.",
    constraint: { field: "scope", type: "select", options: ["own", "all"], default: "all" },
  },
];

const PERMISSION_KEYS = PERMISSION_CATALOG.map((p) => p.key);

const allow = (key, constraints) => ({ key, effect: "allow", ...(constraints ? { constraints } : {}) });

// Spec §11.1: agents use MFA. Built-in sales roles therefore require it from the
// start; set AGENT_MFA_DEFAULT=false to create them with it off (development).
// Only affects roles created from now on — existing roles keep their setting.
const REQUIRE_MFA_BY_DEFAULT = process.env.AGENT_MFA_DEFAULT !== "false";

const SYSTEM_ROLES = [
  {
    key: "sales_agent",
    requireMfa: REQUIRE_MFA_BY_DEFAULT,
    name: "Sales agent",
    description:
      "Can place orders and manage addresses, shopping lists, and company access on behalf of customers.",
    permissions: [
      allow("customer.search"),
      allow("customer.context.enter", { scope: "assigned" }),
      allow("address.create"),
      allow("cart.create"),
      allow("cart.write"),
      allow("quote.create"),
      allow("order.submit"),
      allow("payment_link.send"),
      allow("audit.read", { scope: "own" }),
    ],
  },
  {
    key: "sales_manager",
    requireMfa: REQUIRE_MFA_BY_DEFAULT,
    name: "Sales manager",
    description: "Approves exceptions, monitors team activity, and reassigns accounts.",
    permissions: [
      allow("customer.search"),
      allow("customer.context.enter", { scope: "assigned" }),
      allow("address.create"),
      allow("cart.create"),
      allow("cart.write"),
      allow("quote.create"),
      allow("order.submit"),
      allow("payment_link.send"),
      allow("price.override", { maxDeltaPercent: 20 }),
      allow("discount.override", { maxPercent: 20 }),
      allow("quantity_rule.override"),
      allow("shipping.override"),
      allow("address.override"),
      allow("credit.override", { maxOverPercent: 10 }),
      allow("customer.notes.read"),
      allow("approval.decide", { maxDeltaPercent: 30 }),
      allow("audit.read"),
    ],
  },
  {
    key: "sales_admin",
    requireMfa: REQUIRE_MFA_BY_DEFAULT,
    name: "Sales administrator",
    description:
      "All sales agent permissions, plus the ability to edit order prices and create new customers.",
    permissions: [
      allow("customer.search"),
      allow("customer.context.enter", { scope: "all" }),
      allow("customer.create"),
      allow("address.create"),
      allow("cart.create"),
      allow("cart.write"),
      allow("quote.create"),
      allow("order.submit"),
      allow("payment_link.send"),
      allow("price.override"),
      allow("discount.override"),
      allow("quantity_rule.override"),
      allow("shipping.override"),
      allow("custom_line.create"),
      allow("customer.notes.read"),
      allow("address.override"),
      allow("credit.override"),
      allow("approval.decide"),
      allow("audit.read"),
    ],
  },
];

// Version of the built-in role defaults, and when each permission was added to
// them. Roles that already exist are brought up to date by adding only the
// permissions introduced since they were created, and only if the role has no
// entry for that permission — an administrator's choices are never overwritten.
const DEFAULTS_VERSION = 6;
const PERMISSION_ADDED_IN = { "approval.decide": 2, "payment_link.send": 3, "audit.read": 4, "address.override": 5, "credit.override": 5, "customer.notes.read": 6 };

// The role every non-agent customer has; never an agent role.
const CUSTOMER_ROLE = "customer";

module.exports = {
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
  SYSTEM_ROLES,
  CUSTOMER_ROLE,
  DEFAULTS_VERSION,
  PERMISSION_ADDED_IN,
};
